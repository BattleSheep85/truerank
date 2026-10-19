/**
 * Queue + scheduled job processing: research and verification queue-message
 * handlers, and the cron `scheduled` tick body (stale-row reaper, SEO
 * flywheel, GSC ingest, external-worker fallback). Extracted from
 * worker/index.js.
 */

import { runResearchPipeline } from './pipeline/orchestrator.js';
import { monthlySpendUsd, monthlyBudgetUsd, budgetExhausted } from './lib/budget.js';
import { runVerificationPipeline } from './pipeline/verify-orchestrator.js';
import { runFlywheelTick } from './lib/keywords.js';
import { ingestGsc } from './lib/gsc.js';
import { externalWorkerEnabled } from './lib/flags.js';
import { purgeExpiredSessions } from './lib/auth.js';
import { pruneRateLimitHits } from './lib/rate-limit.js';

// How long an unconfirmed signup may sit in the table before the cron deletes
// it. The confirmation link itself dies after 7 days, so this is generous.
const UNCONFIRMED_MAX_AGE_S = 30 * 86400;

/**
 * Scheduled handler (cron every 10 min) — reap research rows stuck in
 * 'processing' longer than ~20 min. Covers the edge case where the queue
 * consumer crashed mid-pipeline after the status flip but before the final
 * UPDATE, leaving the public page spinning forever.
 */
export async function runScheduledTick(event, env, ctx) {
    const now = event?.scheduledTime ?? Date.now();
    const cutoff = Math.floor(now / 1000) - 20 * 60;
    try {
        const result = await env.DB.prepare(
            "UPDATE research SET status = 'failed' WHERE status = 'processing' AND COALESCE(processing_started_at, created_at) < ?1"
        ).bind(cutoff).run();
        const reaped = result.meta?.changes ?? 0;
        if (reaped > 0) console.log(JSON.stringify({ where: 'scheduled-reap', reaped, cutoff }));
    } catch (err) {
        console.error(JSON.stringify({ where: 'scheduled-reap', error: err instanceof Error ? err.message : String(err) }));
    }

    // Purge expired sessions (periodic delete keeps the sessions table tidy).
    // Own try/catch so it can never break the reaper above.
    try {
        const purgedSessions = await purgeExpiredSessions(env.DB, now);
        if (purgedSessions > 0) {
            console.log(JSON.stringify({ where: 'scheduled-purge-sessions', purged: purgedSessions }));
        }
    } catch (err) {
        console.error(JSON.stringify({ where: 'scheduled-purge-sessions', error: err instanceof Error ? err.message : String(err) }));
    }

    // Drop rate-limit hits past their window (CP-808). Own try/catch: before
    // migration 021 the table is missing and this only logs.
    try {
        const prunedHits = await pruneRateLimitHits(env.DB, now);
        if (prunedHits > 0) console.log(JSON.stringify({ where: 'scheduled-prune-rate-limit', pruned: prunedHits }));
    } catch (err) {
        console.error(JSON.stringify({ where: 'scheduled-prune-rate-limit', error: err instanceof Error ? err.message : String(err) }));
    }

    // Data minimization (GDPR): delete addresses that never confirmed. An
    // unconfirmed row is an unproven mailbox, so holding it forever is both a
    // privacy problem and a mail-bomb reset the purge closes. Own try/catch so
    // it can never break the reaper above.
    try {
        const staleCut = Math.floor(now / 1000) - UNCONFIRMED_MAX_AGE_S;
        const purge = await env.DB.prepare(
            `DELETE FROM subscribers
              WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL
                AND COALESCE(confirm_sent_at, created_at) < ?1`,
        ).bind(staleCut).run();
        const purged = purge.meta?.changes ?? 0;
        if (purged > 0) console.log(JSON.stringify({ where: 'scheduled-purge-unconfirmed', purged }));
    } catch (err) {
        console.error(JSON.stringify({ where: 'scheduled-purge-unconfirmed', error: err instanceof Error ? err.message : String(err) }));
    }

    // Programmatic-SEO flywheel: drain one keyword per tick into a research
    // run, behind its own budget/rate gates. Isolated in its own try/catch
    // so a flywheel failure can never break or mask the reaper above.
    try {
        const tick = await runFlywheelTick(env, now);
        if (tick && tick.status !== 'skipped') {
            console.log(JSON.stringify({ where: 'scheduled-flywheel', ...tick }));
        }
    } catch (err) {
        console.error(JSON.stringify({ where: 'scheduled-flywheel', error: err instanceof Error ? err.message : String(err) }));
    }

    // Daily Google Search Console ingest. The */10 cron fires ~144×/day, so
    // guard on a KV date stamp to run once per UTC day. Fail-SOFT: with no
    // GSC_SA_KEY it's an instant no-op (no network, stays quiet, retries next
    // tick so it self-starts the moment the secret is added). Under waitUntil
    // so the OAuth + API round-trips never slow the reaper/flywheel above.
    ctx.waitUntil((async () => {
        try {
            const today = new Date(now).toISOString().slice(0, 10);
            if (await env.KV.get('gsc:last-date') === today) return;
            const res = await ingestGsc(env);
            if (res.skipped) return;
            await env.KV.put('gsc:last-date', today);
            console.log(JSON.stringify({ where: 'scheduled-gsc', ...res }));
        } catch (err) {
            console.error(JSON.stringify({ where: 'scheduled-gsc', error: err instanceof Error ? err.message : String(err) }));
        }
    })());

    // Fallback: when the off-CF worker is primary, a row pending > ~5 min
    // means the worker is down/backlogged. Process the oldest one on CF
    // (sequential, capped, but functional) so research never stalls. One per
    // tick keeps the cron within its CPU/time budget.
    if (externalWorkerEnabled(env)) {
        // Under ctx.waitUntil + a hard cap so a slow CF fallback run can't
        // block this handler or overlap the next tick; budget-gated like
        // every other entry path.
        ctx.waitUntil((async () => {
            try {
                if (await monthlySpendUsd(env) >= monthlyBudgetUsd(env)) return;
                const staleCut = Math.floor(now / 1000) - 5 * 60;
                // Exclude kind='verification' rows — this fallback runs
                // runResearchPipeline (the RANKING pipeline). Verification
                // rows are processed only by the queue consumer's
                // processVerificationMessage → runVerificationPipeline path.
                const claimed = await env.DB.prepare(
                    `UPDATE research SET status = 'processing', processing_started_at = ?2
                     WHERE id = (
                         SELECT id FROM research
                         WHERE status = 'pending' AND created_at < ?1
                           AND (kind IS NULL OR kind != 'verification')
                         ORDER BY created_at ASC LIMIT 1
                     )
                     RETURNING id, query`
                ).bind(staleCut, Math.floor(now / 1000)).first();
                if (claimed) {
                    console.log(JSON.stringify({ where: 'scheduled-fallback', reportId: claimed.id }));
                    const cap = new Promise((_, rej) => setTimeout(() => rej(new Error('fallback-cap')), 6 * 60_000));
                    await Promise.race([runResearchPipeline(env, claimed.id, claimed.query), cap]);
                }
            } catch (err) {
                console.error(JSON.stringify({ where: 'scheduled-fallback', error: err instanceof Error ? err.message : String(err) }));
            }
        })());
    }
}

// --- Queue message processors ----------------------------------------------

// Stored on the row when the consumer refuses a claimed job. Kept short and
// plain so renderResearchResult's failReason gate surfaces it verbatim (that
// gate drops anything over 160 chars or containing braces, URLs, HTTP codes,
// or provider words).
const BUDGET_STOP_MESSAGE = 'Monthly research budget reached. This run did not start. The budget resets at the start of next month.';

/**
 * Consumer-side budget backstop. Intake gates are racy and only see spend
 * AFTER a run completes, so a burst can be admitted before any of it lands.
 * Re-checking here bounds the blast radius to "budget plus in-flight" no
 * matter what intake missed.
 *
 * Call AFTER the pending->processing claim succeeds. Returns true when the
 * job must not run; the row is then marked failed with a user-facing reason.
 * The UPDATE keeps the same `AND status = 'processing'` idempotency guard as
 * the fast-fail path, so it never clobbers a row another worker completed.
 */
async function stopForBudget(env, reportId) {
    if (!(await budgetExhausted(env))) return false;
    console.log(JSON.stringify({ where: 'queue-budget-stop', reportId }));
    await env.DB.prepare(
        `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2
           WHERE id = ?3 AND status = 'processing'`,
    ).bind(
        JSON.stringify({ error: BUDGET_STOP_MESSAGE }),
        Math.floor(Date.now() / 1000),
        reportId,
    ).run();
    return true;
}

/**
 * The env a research run searches with. A message from a worker-secret
 * forceFresh request (bypassSearchCache: true, set only by
 * handleStartResearch) gets SEARXNG_CACHE_BYPASS, so its searches skip the
 * cached SearXNG answers (worker/engine/tools.js). Anything else: env as is.
 */
export function searchEnvFor(env, body) {
    return body?.bypassSearchCache === true ? { ...env, SEARXNG_CACHE_BYPASS: true } : env;
}

// Legacy ranking-pipeline path — UNCHANGED behavior, only extracted out of the
// queue() loop body so it can sit alongside the new verification branch.
export async function processResearchMessage(message, env) {
    const { reportId, query } = message.body;
    // Phase B: the off-CF worker is the primary processor — ack without
    // processing and leave the row 'pending' for it to claim & run.
    if (externalWorkerEnabled(env)) { message.ack(); return; }
    try {
        // Idempotency guard: claim the row by flipping pending→processing
        // atomically. If 0 rows changed, the row is already processing or
        // complete/failed — a queue redelivery after success. Skip it so
        // we never double-insert products or re-spend the LLM budget.
        const claim = await env.DB.prepare(
            "UPDATE research SET status = 'processing', processing_started_at = ?2 WHERE id = ?1 AND status = 'pending'"
        ).bind(reportId, Math.floor(Date.now() / 1000)).run();
        if ((claim.meta?.changes ?? 0) === 0) {
            console.log(`[queue] skip ${reportId} — not in pending state (redelivery)`);
            message.ack();
            return;
        }

        if (await stopForBudget(env, reportId)) {
            message.ack();
            return;
        }

        await runResearchPipeline(searchEnvFor(env, message.body), reportId, query);
        message.ack();
    } catch (err) {
        console.error(`Queue processing error for ${reportId}:`, err);
        // Fast-fail the row instead of leaving it 'processing' until the
        // ~20-min scheduled reaper. runResearchPipeline already marks
        // 'failed' for errors it catches internally; this covers the
        // narrower case where an error escapes it (e.g. thrown before its
        // own try, or during the claim/redelivery path) so the public page
        // stops spinning promptly. Guarded by AND status = 'processing' so
        // we never clobber a row another worker has since completed.
        try {
            await env.DB.prepare(
                `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2
                   WHERE id = ?3 AND status = 'processing'`,
            ).bind(
                JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                Math.floor(Date.now() / 1000),
                reportId,
            ).run();
        } catch (markErr) {
            console.error(`Failed to fast-fail ${reportId}:`, markErr);
        }
        message.ack();
    }
}

// New verification-pipeline path. Same idempotency + ack/error semantics as
// the research path above: claim pending→processing here, hand off to
// runVerificationPipeline, fast-fail on an escaped error so the row never
// hangs in 'processing' until the cron reaper.
export async function processVerificationMessage(message, env) {
    const { reportId, product, productUrl } = message.body;
    try {
        const claim = await env.DB.prepare(
            "UPDATE research SET status = 'processing', processing_started_at = ?2 WHERE id = ?1 AND status = 'pending'"
        ).bind(reportId, Math.floor(Date.now() / 1000)).run();
        if ((claim.meta?.changes ?? 0) === 0) {
            console.log(`[queue] skip verification ${reportId} — not in pending state (redelivery)`);
            message.ack();
            return;
        }

        if (await stopForBudget(env, reportId)) {
            message.ack();
            return;
        }

        await runVerificationPipeline(env, reportId, { product, productUrl });
        message.ack();
    } catch (err) {
        console.error(`Queue verification error for ${reportId}:`, err);
        try {
            await env.DB.prepare(
                `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2
                   WHERE id = ?3 AND status = 'processing'`,
            ).bind(
                JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
                Math.floor(Date.now() / 1000),
                reportId,
            ).run();
        } catch (markErr) {
            console.error(`Failed to fast-fail verification ${reportId}:`, markErr);
        }
        message.ack();
    }
}
