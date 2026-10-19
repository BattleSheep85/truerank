/**
 * Research API handlers.
 * POST /api/research — start a new research job (canonical-query clustering)
 * GET /api/research/:id — poll for status/progress/results
 * GET /api/research/:id/stream — SSE with short-lived connection + client reconnect
 * GET /api/research/:slug/events — activity-feed poll for the server-rendered page
 */

import {
    generateId, insertResearch, findResearchByCanonicalQuery,
    getResearchById, getResearchBySlug,
} from '../lib/db.js';
import { generateSlug, canonicalizeQuery, squashQuery, parseJsonSafe, safeUserFacingError } from '../lib/utils.js';
import { screenQuery, rejectionMessage } from '../lib/safety.js';
import { budgetExhausted } from '../pipeline/orchestrator.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { checkBurstGate } from '../lib/burst-gate.js';
import { checkGlobalResearchSpend } from '../lib/spend-gate.js';
import { getSessionUser, recordUserSearch } from '../lib/auth.js';
import { apiStatus } from '../lib/status.js';
import { isWorkerAuthed } from '../lib/worker-auth.js';

/**
 * Handle POST /api/research
 * Validates input, clusters on canonical query, checks the monthly budget, enqueues job.
 */
export async function handleStartResearch(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const query = (body.query || '').trim();
    if (!query || query.length < 3) {
        return jsonResponse({ error: 'Query must be at least 3 characters' }, 400);
    }
    if (query.length > 500) {
        return jsonResponse({ error: 'Query must be under 500 characters' }, 400);
    }
    // Require real textual content: an emoji/punctuation-only query has raw length
    // >= 3 but no letters/digits — it would slugify to nothing, create a junk row +
    // sitemap entry, and burn a paid run on nonsense. Fail fast.
    if ((query.match(/[a-z0-9]/gi) || []).length < 3) {
        return jsonResponse({ error: 'Query must contain at least 3 letters or numbers' }, 400);
    }

    // CONTENT SAFETY: reject adult/illegal queries at submit — never create a row, enqueue,
    // research, or index them. Deterministic + fail-closed (ahead of the LLM classifier).
    const screen = screenQuery(query);
    if (screen.blocked) {
        return jsonResponse({ error: rejectionMessage(screen.reason), rejected: true, reason: screen.reason }, 422);
    }

    const isInternal = await isWorkerAuthed(request, env);

    const normalizedQuery = query.toLowerCase();
    // Optional 'fresh' flag bypasses clustering (re-run buttons); rate
    // limiting below still applies.
    const fresh = !!body.fresh;
    // Internal-only: an external benchmark harness measures run-to-run stability, so it must be able to force a genuinely fresh run. Honored ONLY for callers that present the same X-Worker-Secret used by /api/internal/*; a public caller's forceFresh is ignored.
    const forceFresh = body.forceFresh === true && isInternal;
    if (forceFresh) console.log('[research] forceFresh honored (internal auth)');

    // Sanitize clarifications: map of string→string, keys snake_case <=40 chars,
    // values <=80 chars, max 5 entries. Mirrors the interstitial's extraction so
    // a forged direct API call can't smuggle oversized/odd keys into clustering
    // or the synthesis prompt.
    const clarifications = {};
    if (body.clarifications && typeof body.clarifications === 'object') {
        let i = 0;
        for (const [k, v] of Object.entries(body.clarifications)) {
            if (i >= 5) break;
            if (typeof k !== 'string' || typeof v !== 'string') continue;
            const key = k.trim().slice(0, 40).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
            const val = v.trim().slice(0, 80);
            if (key && val) { clarifications[key] = val; i++; }
        }
    }
    const clarificationsJson = Object.keys(clarifications).length > 0 ? JSON.stringify(clarifications) : null;

    // Clustering: a completed run with the same canonical query within 14 days
    // is the same research — send the client to its permanent page. Clarifications
    // shift the canonical form so differently-clarified runs cluster separately
    // ("best mesh wifi $200" vs "$500").
    // Signed-in users get every submission saved to their /account history —
    // including clustered hits, which never create a new research row.
    const sessionUser = await getSessionUser(request, env);

    const canonical = canonicalizeQuery(normalizedQuery, clarifications);
    const squashed = squashQuery(normalizedQuery, clarifications);
    if (!fresh && !forceFresh) {
        const existing = await findResearchByCanonicalQuery(env.DB, canonical, 14, squashed);
        if (existing) {
            if (sessionUser) {
                await recordUserSearch(env.DB, sessionUser.id, existing.id, normalizedQuery);
            }
            return jsonResponse({
                id: existing.id,
                slug: existing.slug,
                status: 'completed',
                cached: true,
                clustered: true,
            });
        }
    }

    // Wallet-DoS defense (2026-07-08): the tight per-IP throttle was removed
    // 2026-06-24 for legit UX, leaving the SHARED MONTHLY_BUDGET_USD cap as the
    // only backstop — so one actor firing distinct junk queries (~$0.10 each)
    // could drain the whole month and 503 every user. This is a GENEROUS velocity
    // cap, not the old throttle: only genuinely new PAID runs reach here (cache /
    // cluster hits already returned above and stay free + uncounted), and 20/hr is
    // far above real human use (~$2/hr worst case) while stopping a single-source
    // budget drain. Deliberately leaky (KV limiter is non-atomic) — fine for a
    // volume ceiling.
    // The KV window is non-atomic, so N concurrent requests all read the same
    // pre-write state and all pass. The native RL_BURST binding in front of it
    // is atomic per colo, which for a per-IP key equals atomic per attacking
    // source. It admits at most 10/60s, which serializes traffic enough for the
    // KV window below to count correctly. Burst-blocked requests never touch
    // KV, so they do not consume hourly quota.
    //
    // Internal auth bypass: internal callers (such as the GatherBench
    // benchmark harness) already unlock paid fresh runs with forceFresh.
    // The rate limit exists to stop anonymous wallet drain. It does not
    // apply to a secret-holding first-party benchmark. Note that the
    // monthly budget cap deliberately still applies to prevent silent overspend.
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isInternal) {
        console.log('[research] throttles bypassed (internal auth)');
    } else {
        const rateKey = await ipRateKey('research', clientIp, env);
        const burst = await checkBurstGate(env.RL_BURST, rateKey);
        const velocity = burst.allowed
            ? await checkRateLimit(env.KV, rateKey, 20, 3600)
            : burst;
        if (!velocity.allowed) {
            const retryAfter = Math.max(1, Math.ceil((velocity.resetAt - Date.now()) / 1000));
            return jsonResponse(
                { error: 'Too many new research runs from your connection in the last hour. Please try again shortly.' },
                429,
                { 'Retry-After': String(retryAfter) },
            );
        }
    }

    // SITE-WIDE hourly ceiling on new paid runs. The per-IP cap above cannot
    // see a distributed source by construction (the affiliate surface proved
    // this in the 2026-08-14/15 incident: 1,232 hits from 1,232 addresses),
    // and the monthly governor below only refuses work after the money is
    // already spent. This bounds the hourly burn instead. Internal callers are
    // exempt for the same reason they bypass the per-IP cap: this gate exists
    // to stop anonymous wallet drain, not a secret-holding first-party
    // harness. See worker/lib/spend-gate.js for the sizing rationale.
    if (!isInternal) {
        const globalSpend = await checkGlobalResearchSpend(env);
        if (!globalSpend.allowed) {
            return jsonResponse(
                { error: 'Frank is handling an unusual number of new research runs right now. Please try again shortly, or browse the existing research.' },
                429,
                { 'Retry-After': String(globalSpend.retryAfterSeconds) },
            );
        }
    }

    // Monthly budget governor — gate on MAX(KV soft counter, D1 completed-spend)
    // so a burst of in-flight runs OR the accurate completed total can refuse new
    // work (503). Closes the split-brain where intake trusted only the racy KV.
    if (await budgetExhausted(env)) {
        return jsonResponse({ error: 'Monthly research budget exhausted — resets at the start of next month.' }, 503);
    }

    // The signup wall is deliberately gone, the per-IP velocity cap plus the shared
    // monthly budget cap are now the sole protection against a wallet drain, and
    // lowering or removing either one without a replacement would expose the whole
    // month of budget to a single actor.

    // Create the permanent research row. Slug mirrors Exhaustive's shape:
    // slugify(query) + '-' + first 8 chars of the id.
    const id = generateId();
    const slug = generateSlug(normalizedQuery, id);
    await insertResearch(env.DB, {
        id,
        slug,
        query: normalizedQuery,
        canonicalQuery: canonical,
        squashedQuery: squashed,
        clarifications: clarificationsJson,
    });

    if (sessionUser) {
        await recordUserSearch(env.DB, sessionUser.id, id, normalizedQuery);
    }

    // Enqueue research job (message shape unchanged — queue consumer keys on it).
    // If the queue send throws (transient Queues outage, binding misconfiguration),
    // flip the already-inserted row to failed so it doesn't orphan as 'pending'.
    try {
        await env.RESEARCH_QUEUE.send({
            reportId: id,
            query: normalizedQuery,
        });
    } catch (err) {
        console.error('[research] queue send failed:', err instanceof Error ? err.message : String(err));
        try {
            await env.DB.prepare("UPDATE research SET status = 'failed' WHERE id = ?").bind(id).run();
        } catch { /* best-effort cleanup */ }
        return jsonResponse({ error: 'Could not enqueue research job — please retry' }, 503);
    }

    return jsonResponse({
        id,
        slug,
        status: 'pending',
    });
}

/**
 * Handle GET /api/research/:id
 * Returns current status. Designed for polling from the client.
 */
export async function handleResearchStatus(reportId, env) {
    let row = await getResearchById(env.DB, reportId);
    if (!row) {
        row = await getResearchBySlug(env.DB, reportId);
    }
    // A retired report answers like a missing one (CP-804).
    if (!row || row.retired_at != null) {
        return jsonResponse({ error: 'Report not found' }, 404);
    }

    if (row.status === 'complete') {
        const report = parseJsonSafe(row.result, null);
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: 'completed',
            report,
            sourceCount: report?.source_count ?? parseJsonSafe(row.sources, []).length,
            filteredCount: report?.filtered_count ?? 0,
        });
    }

    if (row.status === 'failed') {
        const errMsg = parseJsonSafe(row.result, {}).error;
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: 'error',
            error: safeUserFacingError(errMsg),
        });
    }

    // Return current status + progress for polling
    const progress = await env.KV.get(`progress:${row.id}`, 'json');
    const progressLog = await env.KV.get(`progress_log:${row.id}`, 'json') || [];
    return jsonResponse({
        id: row.id,
        slug: row.slug,
        status: apiStatus(row.status),
        progress: progress || { message: 'Queued for processing...' },
        progressLog,
    });
}

/**
 * Handle GET /api/research/:id/stream
 * Short-lived SSE: flushes all current progress, then closes.
 * Client reconnects with Last-Event-ID to get new updates.
 */
export async function handleResearchStream(reportId, env, request) {
    const lastEventId = parseInt(request?.headers?.get('Last-Event-ID') || '0', 10) || 0;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const send = (id, data) => {
                controller.enqueue(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`));
            };

          try {
            let dbRow = await getResearchById(env.DB, reportId);
            if (!dbRow) {
                dbRow = await getResearchBySlug(env.DB, reportId);
            }

            if (!dbRow || dbRow.retired_at != null) {
                send(9997, { type: 'error', error: 'Report not found' });
                controller.close();
                return;
            }

            // Completion comes from D1 (permanent), not the KV report: key
            // (TTL'd): mirrors handleResearchStatus.
            if (dbRow?.status === 'complete') {
                const report = parseJsonSafe(dbRow.result, null);
                const log = await env.KV.get(`progress_log:${dbRow.id}`, 'json') || [];
                for (const entry of log) {
                    if (entry.step > lastEventId) {
                        send(entry.step, { type: 'progress', ...entry });
                    }
                }

                send(9999, {
                    type: 'complete',
                    slug: dbRow.slug || null,
                    report,
                    sourceCount: report?.source_count ?? parseJsonSafe(dbRow.sources, []).length,
                    filteredCount: report?.filtered_count ?? 0,
                });
                controller.close();
                return;
            }

            // Check for error
            if (dbRow?.status === 'failed') {
                const errMsg = parseJsonSafe(dbRow.result, {}).error;
                send(9998, { type: 'error', error: safeUserFacingError(errMsg) });
                controller.close();
                return;
            }

            // Send new progress entries since lastEventId
            const log = await env.KV.get(`progress_log:${dbRow.id}`, 'json') || [];
            let maxStep = lastEventId;
            for (const entry of log) {
                if (entry.step > lastEventId) {
                    send(entry.step, { type: 'progress', ...entry });
                    maxStep = Math.max(maxStep, entry.step);
                }
            }

            send(maxStep, { type: 'keepalive', status: apiStatus(dbRow?.status || 'pending') });
            controller.close();
          } catch (err) {
            // A D1/KV read throwing inside start() would otherwise never close the
            // controller → the SSE connection hangs until the client/edge times out.
            console.error('[research:stream] error:', err instanceof Error ? err.message : String(err));
            try { send(9998, { type: 'error', error: 'stream error, please retry' }); } catch {}
            try { controller.close(); } catch {}
          }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

/**
 * Handle GET /api/research/:slug/events?since=N
 * Activity-feed poll used by the server-rendered processing page. Phase 1
 * adapts the KV progress log into Exhaustive's events shape; phase 2 swaps in
 * a real research_events table with typed events + preview text.
 */
export async function handleResearchEvents(slug, url, env) {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const row = await getResearchBySlug(env.DB, slug);
    if (!row || row.retired_at != null) {
        return jsonResponse({ error: 'Not found' }, 404);
    }

    const log = await env.KV.get(`progress_log:${row.id}`, 'json') || [];
    const events = log
        .filter((e) => e.step > since)
        .map((e) => ({
            seq: e.step,
            event_type: 'status',
            message: e.message,
            created_at: Math.floor((e.timestamp ?? Date.now()) / 1000),
        }));

    return jsonResponse({ status: row.status, events, preview: row.preview ?? null });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        },
    });
}
