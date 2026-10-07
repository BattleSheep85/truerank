/**
 * Verification Pipeline Orchestrator: runs the Truth Audit product-claims
 * verification engine (worker/engine/verify.js) end-to-end and persists the
 * result. Mirrors worker/pipeline/orchestrator.js's status latch + idempotency
 * pattern (pending→processing claimed by the caller; guarded UPDATE on the
 * way to complete/failed so a queue redelivery never double-writes/double-spends).
 *
 * Additive / new surface only — does NOT touch the ranking pipeline.
 */

import { runVerification } from '../engine/verify.js';
import { callLLM } from '../engine/llm.js';
import { ENGINE_CONFIG } from '../lib/engine-config.js';
import { getResearchById, generateId } from '../lib/db.js';
import { nowEpoch } from '../lib/utils.js';
import { llmRouteFromEnv } from '../lib/llm-route.js';
import { incrementMonthlyCost } from './orchestrator.js';

/**
 * Run the verification pipeline for a subject product. Called by the Queue
 * consumer for `{ kind: 'verification' }` messages. reportId is the research.id;
 * by the time we get here the row is already 'processing' (claimed by the
 * queue consumer, same idempotency pattern as the ranking path).
 *
 * `opts.verify` — dependency injection point for tests (defaults to the real
 * runVerification). `opts.onProgress` — optional progress callback forwarded
 * to the engine's onEvent.
 */
// Verification needs denser evidence than ranking: each claim must be
// corroborated by an INDEPENDENT source's own testing/measurement (see
// worker/engine/verify.js's STANCE_SYSTEM), which means actually reading the
// pages that contain the specific numbers (RTINGS/teardown/measured-spec
// pages), not just a search snippet. Ranking only needs a broad opinion
// sample, so it stays on the shared ENGINE_CONFIG (engine-config.js)
// untouched — this override applies ONLY to the verification pipeline.
const VERIFICATION_CONFIG = Object.freeze({
    ...ENGINE_CONFIG,
    maxFetches: 40,
    maxSearches: 60,
    maxToolCalls: 90,
    // Biases gatherParallel's aspect list toward measurement/teardown sources
    // (see worker/engine/parallel-engine.js) — a low-risk, additive opt-in
    // that ranking's shared ENGINE_CONFIG never sets.
    measurementSeedQueries: true,
});

export async function runVerificationPipeline(env, reportId, { product, productUrl }, opts = {}) {
    const verify = opts.verify || runVerification;
    const config = VERIFICATION_CONFIG;

    try {
        const row = await getResearchById(env.DB, reportId);
        if (!row) {
            console.error(`[verify-orchestrator] research row ${reportId} not found`);
            return;
        }

        const result = await verify({
            product,
            productUrl,
            config,
            apiKey: llmRouteFromEnv(env),
            env,
            onEvent: opts.onProgress || (() => {}),
            callLLM,
        });

        if (result.status === 'needs_url') {
            await markNeedsInput(env, reportId, result.message);
            return { status: 'needs_input' };
        }

        if (result.status === 'ok') {
            return await persistVerificationResult(env, reportId, result);
        }

        // Unknown/unexpected result shape from verify() — treat as a failure
        // rather than silently leaving the row stuck in 'processing'.
        throw new Error(`runVerification returned unexpected status: ${result?.status}`);
    } catch (err) {
        console.error('Verification pipeline error:', err);
        try {
            await env.DB.prepare(
                `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2 WHERE id = ?3 AND status = 'processing'`
            ).bind(JSON.stringify({ error: err.message }), nowEpoch(), reportId).run();
            await incrementMonthlyCost(env, Number(err?.totalCostUsd) || 0);
        } catch (e) {
            console.error('Failed to mark verification failed:', e);
        }
        return { status: 'failed' };
    }
}

// The subject's own product page could not be resolved and none was supplied.
// Not a failure — the route layer prompts the user for a URL and can retry.
async function markNeedsInput(env, reportId, message) {
    await env.DB.prepare(
        `UPDATE research SET status = 'needs_input', preview = ?1 WHERE id = ?2 AND status = 'processing'`
    ).bind(message || null, reportId).run();
}

/**
 * Persist an `{status:'ok', ...}` verify() result: research row + one claims
 * row per result.claims[] + the monthly cost counter. DELETE-then-INSERT on
 * claims (like persistEngineResult does for products) so a redelivery never
 * duplicates rows. The guarded UPDATE (AND status='processing') is the
 * idempotency latch — a replayed completion changes 0 rows and skips the
 * cost increment.
 */
async function persistVerificationResult(env, reportId, result) {
    const subjectUrl = result.productUrl || result.subjectClaimSources?.[0] || null;
    const summary = buildSummary(result);
    const evidenceUrls = collectEvidenceUrls(result.claims);

    const updateStmt = env.DB.prepare(
        `UPDATE research SET kind = 'verification', subject_url = ?1, overall_verdict = ?2,
            overall_score = ?3, summary = ?4, category = ?5, result = ?6, sources = ?7,
            cost_usd = ?8, synth_model = ?9, status = 'complete', completed_at = ?10
         WHERE id = ?11 AND status = 'processing'`
    ).bind(
        subjectUrl, result.overall?.label ?? null, result.overall?.score ?? null,
        summary, result.product || null, JSON.stringify(result), JSON.stringify(evidenceUrls),
        Number.isFinite(result.costUsd) && result.costUsd > 0 ? result.costUsd : null,
        ENGINE_CONFIG.synthModel, nowEpoch(), reportId,
    );

    const deleteStale = env.DB.prepare('DELETE FROM claims WHERE research_id = ?1').bind(reportId);
    const insertStmts = (result.claims || []).map((c) => buildClaimInsert(env, reportId, c));

    const batchRes = await env.DB.batch([deleteStale, ...insertStmts, updateStmt]);
    const won = (batchRes[batchRes.length - 1]?.meta?.changes ?? 0) === 1;
    if (!won) {
        console.log(JSON.stringify({ where: 'verify-persist-duplicate', reportId }));
        return { status: 'noop' };
    }

    await incrementMonthlyCost(env, result.costUsd);
    return { status: 'complete', claims: (result.claims || []).length };
}

function buildClaimInsert(env, reportId, claim) {
    const supporting = claim.supporting || [];
    const contradicting = claim.contradicting || [];
    const firstSource = supporting[0]?.url || contradicting[0]?.url || null;
    return env.DB.prepare(
        `INSERT INTO claims (id, research_id, claim_text, claim_type, source_url, verdict,
            confidence, support_weight, contradict_weight, evidence, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(
        `${reportId}:${claim.id || generateId()}`, reportId, claim.text, claim.claimType || claim.type || null,
        firstSource, claim.status ?? null, claim.confidence ?? null, claim.support ?? null,
        claim.contradict ?? null, JSON.stringify([...supporting, ...contradicting]), nowEpoch(),
    );
}

function buildSummary(result) {
    const label = result.overall?.label;
    const score = result.overall?.score;
    if (!label) return `Verified "${result.product}".`;
    return Number.isFinite(score)
        ? `${result.product}: ${label} (${score}/100).`
        : `${result.product}: ${label}.`;
}

function collectEvidenceUrls(claims) {
    const urls = new Set();
    for (const c of claims || []) {
        for (const s of [...(c.supporting || []), ...(c.contradicting || [])]) {
            if (s?.url) urls.add(s.url);
        }
    }
    return [...urls];
}
