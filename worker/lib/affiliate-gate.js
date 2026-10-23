/**
 * Site-wide (GLOBAL) throttle for the affiliate redirect surface.
 *
 * Second, independent layer next to the per-IP hourly cap in
 * worker/handlers/affiliate.js. A per-IP cap cannot stop an IP-rotating
 * attacker by construction: incident 2026-08-14/15 put 1,232 clicks on 213
 * report pages from 1,232 DISTINCT ip_hash values, about one click per
 * address, so no single address ever came near the 30/hour per-IP cap.
 *
 * Mechanism: the native Workers rate-limit binding counts per unique key
 * string. Calling it with a CONSTANT key makes one counter that every request
 * on the site shares, which is exactly a site-wide throttle. The binding is
 * RL_AFFILIATE_GLOBAL, separate from RL_BURST so the two can be tuned apart.
 *
 * FAIL-OPEN, inherited from checkBurstGate: a missing binding or a binding
 * error never blocks traffic. The per-IP KV cap stays behind it.
 */

import { checkBurstGate } from './burst-gate.js';
import { checkRateLimit } from './rate-limit.js';

// One counter for the whole site. The constant (not IP-derived) key IS the
// mechanism: change it to anything per-visitor and this stops being global.
export const AFFILIATE_GLOBAL_KEY = 'affiliate:global';

// These MUST match [ratelimits.simple] on the RL_AFFILIATE_GLOBAL binding in
// wrangler.toml and wrangler.dev.toml (test/unit/affiliate-gate.test.js
// asserts it). They are declared here so the trip log reports the settings the
// number was tuned against.
//
// Sizing, from production D1 before the incident (5 weeks, 2026-07-08 to
// 2026-08-13):
//   - busiest real minute, more than one visitor: 3 clicks
//   - busiest real hour, more than one visitor:   9 clicks
//   - busiest hour of any kind on record:        24 clicks
//   - median day:                                 4 clicks
// 6 per 60 s is 2x the busiest real minute, and its 360/hour ceiling is 15x
// the busiest hour ever recorded and 40x the busiest multi-visitor hour, so
// real traffic at today's scale cannot reach it. It also caps the damage: the
// worst incident hour on record (1,475 clicks, 2026-06-21) would have been
// held to 360, and the 2026-08-15 pattern (peaks of 17 to 23 clicks a minute)
// loses about two thirds of its peak minutes.
export const AFFILIATE_GLOBAL_LIMIT = 6;
export const AFFILIATE_GLOBAL_PERIOD_SECONDS = 60;

/**
 * Consume one token from the site-wide affiliate counter.
 *
 * @param {{ RL_AFFILIATE_GLOBAL?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> } }} env
 * @returns {Promise<boolean>} true when site-wide volume is over the limit and
 *   the caller must treat the request as suspicious.
 */
export async function isAffiliateFloodActive(env) {
    const gate = await checkBurstGate(env?.RL_AFFILIATE_GLOBAL, AFFILIATE_GLOBAL_KEY);
    if (gate.allowed) return false;
    // Tuning data. One line per throttled click, so the owner can see how often
    // the gate fires and whether the limit needs to move.
    console.log(JSON.stringify({
        where: 'affiliate-gate',
        event: 'global-throttle',
        key: AFFILIATE_GLOBAL_KEY,
        limit: AFFILIATE_GLOBAL_LIMIT,
        periodSeconds: AFFILIATE_GLOBAL_PERIOD_SECONDS,
        resetAt: gate.resetAt,
    }));
    return true;
}

// ─── Hourly site-wide counter (CP-353) ───────────────────────────────────────
// The native binding above only has a 10 s or 60 s window, so a source that
// stays under 6 a minute never trips it. Production D1 showed that shape from
// 2026-09-05 on: 74 to 2,897 logged clicks a day, almost all one per address,
// against a pre-incident median of 4 a day. The sliding-window limiter has no
// window restriction, so it can bound the hour. It gets env.DB: one constant
// key read and written from every Cloudflare location is exactly where the KV
// window undercounts (each location reads its own cached copy, last write
// wins), and the D1 window is one exact count (CP-808). KV stays the fallback.
export const AFFILIATE_HOURLY_KEY = 'go:global';
export const AFFILIATE_HOURLY_WINDOW_SECONDS = 3600;
// Used only when [vars] AFFILIATE_GLOBAL_HOURLY_LIMIT is missing or invalid.
// 30 is above the busiest real hour on record (24, see the sizing above).
export const DEFAULT_AFFILIATE_HOURLY_LIMIT = 30;

/**
 * The hourly ceiling from config ([vars] AFFILIATE_GLOBAL_HOURLY_LIMIT).
 * @param {{ AFFILIATE_GLOBAL_HOURLY_LIMIT?: string }} [env]
 * @returns {number} a positive integer
 */
export function affiliateHourlyLimit(env) {
    const raw = String(env?.AFFILIATE_GLOBAL_HOURLY_LIMIT ?? '').trim();
    return /^[1-9]\d*$/.test(raw) ? Number(raw) : DEFAULT_AFFILIATE_HOURLY_LIMIT;
}

/**
 * Consume one token from the site-wide hourly affiliate counter.
 * FAIL-OPEN: no KV or a KV error never flags a click.
 *
 * @param {{ KV?: { get: Function, put: Function }, DB?: object, AFFILIATE_GLOBAL_HOURLY_LIMIT?: string }} env
 * @returns {Promise<boolean>} true when this hour's site-wide clicks are over
 *   the ceiling and the caller must treat the request as suspicious.
 */
export async function isAffiliateHourlyCapHit(env) {
    if (!env?.KV) return false;
    const limit = affiliateHourlyLimit(env);
    try {
        const rate = await checkRateLimit(env.KV, AFFILIATE_HOURLY_KEY, limit, AFFILIATE_HOURLY_WINDOW_SECONDS, env.DB);
        if (rate.allowed) return false;
        console.log(JSON.stringify({
            where: 'affiliate-gate',
            event: 'global-hourly-throttle',
            key: AFFILIATE_HOURLY_KEY,
            limit,
            windowSeconds: AFFILIATE_HOURLY_WINDOW_SECONDS,
            resetAt: rate.resetAt,
        }));
        return true;
    } catch (err) {
        console.error('[affiliate-gate] hourly counter failed, allowing click:', err instanceof Error ? err.message : String(err));
        return false;
    }
}
