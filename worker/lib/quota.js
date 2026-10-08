/**
 * Per-IP free-tier quotas for anonymous (signed-out) usage.
 *
 * - 'search': a lifetime allowance of FREE_SEARCHES. Key `quota:v2:search:<hash>`,
 *   expirationTtl 365 days so keys do not persist forever in KV.
 * - 'verify': a daily allowance of FREE_VERIFIES product checks. Key
 *   `quota:v3:verify:<hash>:<YYYY-MM-DD>` (UTC date), so each UTC day starts a
 *   fresh counter. expirationTtl is about 2 days, enough to cover the day the
 *   key is for. The v3 bump separates the daily key space from the old v2
 *   lifetime verify keys, which expire on their own.
 *
 * Uses salted IP hashes rather than raw IP addresses to honor the privacy
 * policy (public/privacy.html).
 */

import { hashIp } from './ip-hash.js';

export const FREE_SEARCHES = 5;
export const FREE_VERIFIES = 100;
// The search counter is a lifetime allowance, so 365 days lets entries expire
// eventually without resetting users on regular visits.
export const QUOTA_EXPIRATION_TTL = 365 * 24 * 60 * 60; // 365 days (in seconds)
// The verify counter is per UTC day; 2 days covers the whole day plus clock skew.
export const DAILY_QUOTA_EXPIRATION_TTL = 2 * 24 * 60 * 60; // 2 days (in seconds)

const DAILY_KINDS = new Set(['verify']);

function isDaily(kind) {
    return DAILY_KINDS.has(kind);
}

// UTC date as YYYY-MM-DD. Read at call time (Workers freeze the clock at load).
function utcDay(nowMs) {
    return new Date(nowMs).toISOString().slice(0, 10);
}

async function hashedIp(ip, env) {
    try {
        return await hashIp(ip, env);
    } catch (err) {
        console.log('[quota] IP hashing failed (missing IP_HASH_SALT / WORKER_SECRET), falling back to raw IP');
        return ip;
    }
}

/**
 * Builds the versioned KV key using a salted IP hash. Daily kinds append the
 * UTC date; `nowMs` defaults to Date.now() and exists for tests.
 */
export async function quotaKey(kind, ip, env, nowMs = Date.now()) {
    const id = await hashedIp(ip, env);
    return isDaily(kind)
        ? `quota:v3:${kind}:${id}:${utcDay(nowMs)}`
        : `quota:v2:${kind}:${id}`;
}

export function limitForKind(kind) {
    return kind === 'verify' ? FREE_VERIFIES : FREE_SEARCHES;
}

function ttlForKind(kind) {
    return isDaily(kind) ? DAILY_QUOTA_EXPIRATION_TTL : QUOTA_EXPIRATION_TTL;
}

/**
 * Returns { used, limit, remaining } for the given kind ('search' | 'verify')
 * and IP. A missing KV key means zero usage so far (for 'verify': today).
 */
export async function getQuota(kv, kind, ip, env) {
    const limit = limitForKind(kind);
    const key = await quotaKey(kind, ip, env);
    const stored = await kv.get(key);
    const used = parseInt(stored, 10) || 0;
    return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Increments the usage counter for (kind, ip) by one: lifetime for 'search',
 * today's UTC day for 'verify'.
 */
export async function consumeQuota(kv, kind, ip, env) {
    const key = await quotaKey(kind, ip, env);
    const stored = await kv.get(key);
    const used = (parseInt(stored, 10) || 0) + 1;
    await kv.put(key, String(used), { expirationTtl: ttlForKind(kind) });
    return used;
}
