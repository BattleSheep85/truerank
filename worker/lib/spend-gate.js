/**
 * SITE-WIDE hourly ceiling on genuinely-new PAID research runs.
 *
 * Third, independent layer next to the per-IP velocity cap in
 * worker/handlers/research.js and the monthly budget governor in
 * worker/pipeline/orchestrator.js.
 *
 * Why the other two layers are not enough:
 *   - The per-IP cap (20/hour) cannot see a distributed source by
 *     construction. The affiliate surface already proved this: incident
 *     2026-08-14/15 put 1,232 clicks on the site from 1,232 DISTINCT
 *     addresses, about one hit per address, so no address came near its cap.
 *     The same shape against POST /api/research costs about $0.10 a run and
 *     drains the whole month.
 *   - The monthly governor is the backstop, not a defense. It only refuses
 *     work AFTER the money is gone, and its refusal is a 503 for every real
 *     visitor until the month rolls over.
 *
 * Mechanism: the KV sliding-window limiter counts per key string. A CONSTANT
 * key makes one counter the whole site shares, which is exactly a site-wide
 * throttle. The KV limiter is used rather than the native binding because the
 * native binding only supports a 10 s or 60 s window, and the thing worth
 * bounding here is spend per hour, not requests per minute.
 *
 * FAIL-OPEN: a missing KV binding or a KV error never blocks a run. The per-IP
 * cap and the monthly governor stay behind it.
 */

import { checkRateLimit } from './rate-limit.js';

// One counter for the whole site. The constant (not IP-derived) key IS the
// mechanism: make it per-visitor and this stops being global.
export const RESEARCH_GLOBAL_KEY = 'research:global';

// Sizing. A run costs about $0.10, so this ceiling is a dollar ceiling:
// 40/hour is about $4/hour, and the worst case a single actor can force in a
// day is bounded well inside MONTHLY_BUDGET_USD instead of draining it in one
// sitting. It is also far above real demand at today's scale: the flywheel
// cron starts at most FLYWHEEL_DAILY_MAX (12) runs a DAY, and organic paid
// runs (cache and cluster hits never reach this gate) sit far below that.
export const RESEARCH_GLOBAL_LIMIT = 40;
export const RESEARCH_GLOBAL_WINDOW_SECONDS = 3600;

/**
 * Consume one token from the site-wide new-paid-run counter.
 *
 * Call this ONLY on the path that is about to start a genuinely new paid run.
 * Cache hits, cluster hits and rejected queries must not consume a token, or
 * ordinary browsing would exhaust the ceiling.
 *
 * @param {{ KV?: { get: Function, put: Function } }} env
 * @returns {Promise<{allowed: boolean, retryAfterSeconds: number}>}
 *   allowed=false means site-wide new-run volume is over the hourly ceiling.
 */
export async function checkGlobalResearchSpend(env) {
    if (!env?.KV) return { allowed: true, retryAfterSeconds: 0 };
    try {
        const result = await checkRateLimit(
            env.KV,
            RESEARCH_GLOBAL_KEY,
            RESEARCH_GLOBAL_LIMIT,
            RESEARCH_GLOBAL_WINDOW_SECONDS,
        );
        if (result.allowed) return { allowed: true, retryAfterSeconds: 0 };

        const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        // Tuning data. One structured line per trip, so the owner can see
        // whether the ceiling is being reached by an attack or by real demand.
        console.log(JSON.stringify({
            where: 'spend-gate',
            event: 'global-throttle',
            key: RESEARCH_GLOBAL_KEY,
            limit: RESEARCH_GLOBAL_LIMIT,
            windowSeconds: RESEARCH_GLOBAL_WINDOW_SECONDS,
            retryAfterSeconds,
        }));
        return { allowed: false, retryAfterSeconds };
    } catch (err) {
        console.error('[spend-gate] check failed:', err instanceof Error ? err.message : String(err));
        return { allowed: true, retryAfterSeconds: 0 };
    }
}
