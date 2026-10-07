/**
 * Pipeline Orchestrator: runs the ported research engine end-to-end.
 *
 * classify (if needed) → runEngine (agent loop + synthesis) → validate →
 * persist products + research row. Progress is streamed to KV for the SSE
 * activity feed (progress:{id} + progress_log:{id}); the engine's onEvent
 * callback feeds that same updater so the agent-loop beats surface live.
 *
 * The persist half is factored into persistEngineResult() so the off-Cloudflare
 * research worker (track 2) can run the engine on its own host and hand the
 * result back to CF (POST /api/internal/complete) for ASIN/image/affiliate
 * resolution + the D1 write, where the bindings live. claimNextPendingJob()
 * lets that worker pull jobs (GET /api/internal/next-job).
 *
 * Honest-failure rule: a run that yields zero valid products is marked
 * 'failed', NOT 'complete', so it never absorbs new queries into its cluster.
 */

import { runEngine } from '../engine/engine.js';
import { classifyQuery } from '../lib/classifier.js';
import { ENGINE_CONFIG } from '../lib/engine-config.js';
import { buildAffiliateUrl, resolveAmazonTag } from '../lib/affiliate-links.js';
import { resolveAsins } from '../lib/asin-resolver.js';
import { resolveImages } from '../lib/image-resolver.js';
import { getResearchById, generateId } from '../lib/db.js';
import { sanitizeUrl, slugify, nowEpoch, parseJsonSafe } from '../lib/utils.js';
import { submitToIndexNow } from '../lib/indexnow.js';
import { notifySubscribersForResearch } from '../lib/notify.js';
import { screenQuery, rejectionMessage, classifierRejectToReason } from '../lib/safety.js';
import { purgePageCache } from '../routes/pages.js';
import { llmRouteFromEnv } from '../lib/llm-route.js';

// Monthly spend ceiling default; overridden by env.MONTHLY_BUDGET_USD.
const DEFAULT_MONTHLY_BUDGET_USD = 60;

/**
 * Run the full research pipeline for a query. Called by the Queue consumer.
 * reportId is the research.id. The idempotency claim (pending→processing) lives
 * in the queue consumer (worker/index.js); by the time we get here the row is
 * already 'processing'.
 */
export async function runResearchPipeline(env, reportId, query) {
    const progress = createProgressUpdater(env.KV, reportId);

    try {
        const row = await getResearchById(env.DB, reportId);
        if (!row) {
            console.error(`[orchestrator] research row ${reportId} not found`);
            return;
        }

        const tier = row.tier || 'full';
        const config = ENGINE_CONFIG;
        const cls = await ensureClassified(env, reportId, query, row, progress);
        if (cls.blocked) { await markRejected(env, reportId, cls.blockReason); return; }
        const { facets, topicalCategory, clarifications } = cls;

        // onEvent bridges the engine's typed events to the KV progress updater.
        const onEvent = async (_type, message, _detail) => { await progress(message); };
        await progress(`Starting ${tier} research...`);

        const engine = await runEngine(
            query, config, llmRouteFromEnv(env), env, onEvent, facets, topicalCategory, clarifications,
        );

        // Dev-only: stash the raw extractor input (notes + full source text) so we
        // can build regression fixtures from authentic messy pages. No-op in prod.
        if (env.ENVIRONMENT === 'dev') {
            try {
                await env.KV.put(`debug:extract-input:${reportId}`, JSON.stringify({
                    query, facets, topicalCategory,
                    notes: engine.notes || [],
                    sources: (engine.sources || []).map((s) => ({ url: s.url, title: s.title, credibility: s.credibility, content: s.content })),
                }), { expirationTtl: 7 * 86400 });
            } catch (e) { console.log('[dev] extract-input stash failed:', e?.message); }
        }

        await persistEngineResult(env, reportId, query, facets, topicalCategory, engine, row.slug, progress);
    } catch (err) {
        console.error('Pipeline error:', err);
        await progress(`Error: ${err.message}`);
        try {
            await env.DB.prepare(
                `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2 WHERE id = ?3 AND status = 'processing'`
            ).bind(JSON.stringify({ error: err.message }), nowEpoch(), reportId).run();
            // Record any LLM spend the run accrued before throwing so the monthly
            // governor doesn't under-count (engine attaches it to the error).
            await incrementMonthlyCost(env, Number(err?.totalCostUsd) || 0);
        } catch (e) {
            console.error('Failed to mark research failed:', e);
        }
        await setFinalReport(env.KV, reportId, { error: err.message });
    }
}

/**
 * Reuse the row's stored classifier facets/topical_category when present,
 * otherwise classify now and persist them so the report page + clustering have
 * category context. Returns { facets, topicalCategory, clarifications }.
 */
export async function ensureClassified(env, reportId, query, row, progress) {
    // CONTENT SAFETY layer 1 (deterministic, fail-closed): block clear adult/illegal queries
    // before any research. Runs even on cached-facet rows (flywheel/cron paths).
    const screen = screenQuery(query);
    if (screen.blocked) return { facets: null, topicalCategory: null, clarifications: {}, blocked: true, blockReason: screen.reason };

    let facets = parseJsonSafe(row.facets, null);
    let topicalCategory = row.topical_category || null;
    const clarifications = parseJsonSafe(row.clarifications, {}) || {};

    if (!facets) {
        if (progress) await progress('Classifying query...');
        const classification = await classifyQuery(env, query, row.canonical_query || null);
        // SAFETY layer 2: ENFORCE the LLM classifier's reject (previously the accept flag was
        // computed but ignored — adult/illegal queries got researched anyway).
        if (classification.accept === false) {
            return { facets: null, topicalCategory: null, clarifications, blocked: true, blockReason: classifierRejectToReason(classification.reject_reason) };
        }
        facets = classification.facets;
        topicalCategory = classification.topical_category;
        await env.DB.prepare(
            'UPDATE research SET facets = ?1, topical_category = ?2 WHERE id = ?3'
        ).bind(JSON.stringify(facets), topicalCategory, reportId).run();
    }
    return { facets, topicalCategory, clarifications, blocked: false, blockReason: null };
}

// Mark a research row as policy-rejected (adult/illegal) so it is never researched, published,
// or indexed. Uses 'failed' status (excluded from sitemap/browse) with a clear message.
async function markRejected(env, reportId, reason) {
    const msg = rejectionMessage(reason);
    const result = { rejected: true, reason, message: msg, summary: msg, products: [], category: '', methodology: '' };
    await env.DB.prepare(
        `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2 WHERE id = ?3 AND status = 'processing'`
    ).bind(JSON.stringify(result), nowEpoch(), reportId).run();
    try { await setFinalReport(env.KV, reportId, result); } catch { /* best-effort */ }
}

/**
 * Persist an engine result: honest-failure gate → ASIN /dp resolution → image
 * resolution → affiliate tagging → products + research D1 write → monthly cost
 * counter → KV final report → IndexNow ping. Engine-agnostic: takes the
 * { result, sources, totalCostUsd, synthModel } shape from either runEngine
 * (CF) or the off-CF parallel worker. `progress` is optional (no-op default).
 */
export async function persistEngineResult(env, reportId, query, facets, topicalCategory, engine, slug, progress) {
    const report = progress || (async () => {});
    const { result, sources, totalCostUsd, synthModel } = engine;

    // Honest-failure: zero valid products → mark failed so clustering and the
    // report page treat it as a non-result instead of an empty page.
    if (!result || !Array.isArray(result.products) || result.products.length < 1) {
        await report('No reliable products found — marking research failed.');
        const failRes = await env.DB.prepare(
            `UPDATE research SET status = 'failed', result = ?1, cost_usd = ?2,
                synth_model = ?3, completed_at = ?4 WHERE id = ?5 AND status = 'processing'`
        ).bind(
            JSON.stringify({ error: 'No reliable products found for this query.' }),
            Number.isFinite(totalCostUsd) && totalCostUsd > 0 ? totalCostUsd : null,
            synthModel || null,
            nowEpoch(),
            reportId,
        ).run();
        // Idempotency latch: only count spend if THIS call transitioned the row
        // (a replayed /complete changes 0 rows and must not double-count).
        const failWon = (failRes.meta?.changes ?? 0) === 1;
        if (failWon) await incrementMonthlyCost(env, totalCostUsd);
        // Telemetry: a lost latch here means two processors (e.g. off-CF worker +
        // CF cron fallback) both ran this job — wasted duplicate work worth watching.
        else console.log(JSON.stringify({ where: 'persist-duplicate', phase: 'fail', reportId }));
        return { status: failWon ? 'failed' : 'noop' };
    }

    // Per-product ASIN + image resolution is one Serper lookup EACH and runs
    // sequentially — on a comprehensive 24-item list that is ~48 serial subrequests,
    // which times out the queue consumer. Bound the expensive enrichment to the TOP
    // products (the ones with conversion value); the tail still shows (name/rating/
    // pros/cons), just without a resolved image/affiliate link.
    const ENRICH_TOP = 16;
    const head = result.products.slice(0, ENRICH_TOP);
    const tail = result.products.slice(ENRICH_TOP);

    // Recover direct Amazon /dp/ links for products missing/redirect-hidden URLs.
    // Skipped when the classifier says this category isn't sold on Amazon.
    const amazonViable = facets?.sold_on_amazon !== false && facets?.is_service !== true;
    let enriched = head;
    if (amazonViable) {
        await report('Resolving direct product links...');
        enriched = await resolveAsins(env, enriched, report);
    }
    // Fill product photos synthesis didn't attach (one Serper Images query each).
    enriched = await resolveImages(env, enriched, report);
    result.products = [...enriched, ...tail];

    const affiliateIds = {
        amazonTag: resolveAmazonTag(env),
        walmartImpact: env.WALMART_IMPACT_ID || undefined,
        targetImpact: env.IMPACT_TARGET_ID || undefined,
        bestbuyImpact: env.IMPACT_BESTBUY_ID || undefined,
        neweggImpact: env.IMPACT_NEWEGG_ID || undefined,
        bhphoto: env.BHPHOTO_AFFILIATE_ID || undefined,
    };

    // Persist products. DELETE-then-insert in one batch so a redelivery never
    // duplicates rows. affiliate_url stores the TAGGED url.
    const deleteStale = env.DB.prepare('DELETE FROM products WHERE research_id = ?1').bind(reportId);
    const insertStmts = result.products.map((p) => {
        const productUrl = sanitizeUrl(p.productUrl);
        const affiliateUrl = productUrl ? buildAffiliateUrl(productUrl, affiliateIds) : '';
        const metadataJson = p.metadata && Object.keys(p.metadata).length > 0 ? JSON.stringify(p.metadata) : null;
        const imageUrl = p.imageUrl ? sanitizeUrl(p.imageUrl) : null;
        return env.DB.prepare(
            `INSERT INTO products (id, research_id, name, brand, price, currency, rating,
                image_url, product_url, manufacturer_url, affiliate_url,
                pros, cons, specs, verdict, rank, best_for, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, 'USD', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
        ).bind(
            generateId(), reportId, p.name, p.brand || null,
            typeof p.price === 'number' ? p.price : null,
            typeof p.rating === 'number' ? p.rating : null,
            imageUrl, productUrl || null, sanitizeUrl(p.manufacturerUrl) || null, affiliateUrl || null,
            JSON.stringify(p.pros || []), JSON.stringify(p.cons || []), JSON.stringify(p.specs || {}),
            p.verdict || null, typeof p.rank === 'number' ? p.rank : null, p.bestFor || null, metadataJson,
        );
    });

    const resultJson = { ...result, query, source_count: sources.length, filtered_count: 0 };
    const sourcesJson = sources.map((s) => ({ url: s.url, credibility: s.credibility }));

    const updateStmt = env.DB.prepare(
        `UPDATE research SET status = 'complete', summary = ?1, category = ?2,
            result = ?3, sources = ?4, completed_at = ?5, cost_usd = ?6, synth_model = ?7
         WHERE id = ?8 AND status = 'processing'`
    ).bind(
        result.summary || '', result.category || topicalCategory || null,
        JSON.stringify(resultJson), JSON.stringify(sourcesJson), nowEpoch(),
        Number.isFinite(totalCostUsd) && totalCostUsd > 0 ? totalCostUsd : null,
        synthModel || null, reportId,
    );

    const batchRes = await env.DB.batch([deleteStale, ...insertStmts, updateStmt]);
    // The guarded updateStmt (AND status='processing') is the idempotency latch:
    // a replayed /complete changes 0 rows here, so skip cost/KV/IndexNow (the
    // DELETE-then-insert keeps products correct either way).
    const won = (batchRes[batchRes.length - 1]?.meta?.changes ?? 0) === 1;
    if (!won) {
        // Two processors raced this job to completion (off-CF worker + CF
        // fallback). The latch kept the row/cost correct; log the wasted synth.
        console.log(JSON.stringify({ where: 'persist-duplicate', phase: 'complete', reportId }));
        await report('Already finalized — skipping duplicate completion.');
        return { status: 'noop' };
    }
    await incrementMonthlyCost(env, totalCostUsd);
    await setFinalReport(env.KV, reportId, resultJson);
    await report(`Research complete: ${result.products.length} products ranked.`);
    if (slug) {
        await purgePageCache(env, slug);
        const urls = [`https://chrisputer.tech/research/${slug}`];
        // Also ping the category hub so a new/changed guide gets its /best/ hub
        // recrawled (where topical authority + internal links live). slugify
        // matches renderCategoryHub; harmless if the hub is still thin (noindex).
        const cat = result.category || topicalCategory;
        const catSlug = cat ? slugify(cat) : '';
        if (catSlug) urls.push(`https://chrisputer.tech/best/${catSlug}`);
        await submitToIndexNow(env, urls);
    }
    // Tell the confirmed subscribers of this report that it is live. Inside the
    // `won` latch, so at most one notify per completion even when two
    // processors race. notifySubscribersForResearch never throws, and this
    // try/catch is the second belt: a mail failure must not fail the run.
    try {
        await notifySubscribersForResearch(env, { researchId: reportId, query, slug });
    } catch (err) {
        console.error(JSON.stringify({ where: 'notify', error: String(err?.message || err) }));
    }
    return { status: 'complete', products: result.products.length };
}

/**
 * Atomically claim the oldest pending research row (pending→processing) and
 * return the job the off-CF worker needs. Returns null when the queue is empty.
 * D1's single-writer serialization makes the subquery-UPDATE an atomic claim,
 * so two pollers (or the legacy queue consumer) can't grab the same row.
 */
export async function claimNextPendingJob(env) {
    // Respect the monthly budget on the off-CF path too: don't claim new work
    // once the month's recorded spend hits the cap. Uses D1 SUM(cost_usd) —
    // immutable per row, so no lost-update race like the KV counter.
    if (await monthlySpendUsd(env) >= monthlyBudgetUsd(env)) return null;
    // Exclude kind='verification' rows: they are RANKING-pipeline claims only
    // (this feeds runResearchPipeline via the off-CF worker). Verification rows
    // are claimed/processed exclusively by the queue consumer's
    // processVerificationMessage → runVerificationPipeline path.
    const claimed = await env.DB.prepare(
        `UPDATE research SET status = 'processing', processing_started_at = ?1
         WHERE id = (
             SELECT id FROM research
             WHERE status = 'pending' AND (kind IS NULL OR kind != 'verification')
             ORDER BY created_at ASC LIMIT 1
         )
         RETURNING id, query, slug, tier, facets, topical_category, canonical_query, clarifications`
    ).bind(nowEpoch()).first();
    if (!claimed) return null;

    const cls = await ensureClassified(env, claimed.id, claimed.query, claimed, null);
    if (cls.blocked) { await markRejected(env, claimed.id, cls.blockReason); return null; }
    const { facets, topicalCategory, clarifications } = cls;
    const config = ENGINE_CONFIG;
    return { reportId: claimed.id, query: claimed.query, slug: claimed.slug, facets, topicalCategory, clarifications, config };
}

/**
 * Increment the month-keyed KV spend counter by this run's cost. Read-add-put
 * is fine at this volume (one writer per run, low concurrency). 30-day TTL so
 * old months age out on their own. NaN/zero costs are no-ops.
 */
export async function incrementMonthlyCost(env, cost) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    try {
        const key = `cost:${monthKey()}`;
        const current = Number(await env.KV.get(key)) || 0;
        await env.KV.put(key, String(current + cost), { expirationTtl: 30 * 86400 });
    } catch (err) {
        console.error('[orchestrator] monthly cost update failed:', err instanceof Error ? err.message : String(err));
    }
}

// Month-to-date research spend from D1 (SUM of per-row cost_usd). cost_usd is
// immutable once written, so SUM has no lost-update race under concurrent off-CF
// completions — the accurate budget source (the KV counter is a soft cache).
export async function monthlySpendUsd(env) {
    try {
        const d = new Date();
        const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
        const row = await env.DB.prepare(
            'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM research WHERE completed_at >= ?1'
        ).bind(start).first();
        return Number(row?.total) || 0;
    } catch { return 0; }
}

// Current month as 'YYYY-MM', derived from request-time clock.
export function monthKey(d = new Date()) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

export function monthlyBudgetUsd(env) {
    // An explicit MONTHLY_BUDGET_USD=0 is a kill switch: with spend always >= 0,
    // the governor's `spent >= budget` check refuses every new run (503). Only an
    // unset, empty, negative, or non-numeric value falls back to the default.
    const raw = env.MONTHLY_BUDGET_USD;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_MONTHLY_BUDGET_USD;
    }
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MONTHLY_BUDGET_USD;
}

// Authoritative budget gate for intake (POST /api/research, /api/chat). The KV
// counter (cost:YYYY-MM) is a fast soft cache that can lag or lose concurrent
// updates; D1 SUM(cost_usd) is race-free but only counts COMPLETED runs. Gating on
// MAX(KV, D1) closes the split-brain where intake trusted only the racy KV value
// while the off-CF claim path + cron fallback already gate on the accurate D1 sum.
// Short-circuits on KV to avoid a D1 query on every request when already capped.
export async function budgetExhausted(env) {
    const budget = monthlyBudgetUsd(env);
    if (budget <= 0) return true; // MONTHLY_BUDGET_USD=0 kill switch
    let kv = 0;
    try { kv = Number(await env.KV.get(`cost:${monthKey()}`)) || 0; } catch { kv = 0; }
    if (kv >= budget) return true;
    const d1 = await monthlySpendUsd(env);
    return Math.max(kv, d1) >= budget;
}

/**
 * Create a progress updater that writes to KV for SSE streaming. The pipeline is
 * the single writer for a run, so the log array lives in this closure.
 */
function createProgressUpdater(kv, reportId) {
    let stepIndex = 0;
    let log = [];
    return async function progress(message) {
        stepIndex++;
        const progressData = { step: stepIndex, message, timestamp: Date.now() };
        log = [...log, progressData];
        await Promise.all([
            kv.put(`progress:${reportId}`, JSON.stringify(progressData), { expirationTtl: 3600 }),
            kv.put(`progress_log:${reportId}`, JSON.stringify(log), { expirationTtl: 3600 }),
        ]);
    };
}

/**
 * Store the final report in KV for quick SSE retrieval (the page itself renders
 * from D1; this KV copy only short-circuits the in-flight SSE stream).
 */
async function setFinalReport(kv, reportId, report) {
    await kv.put(`report:${reportId}`, JSON.stringify(report), { expirationTtl: 86400 });
}
