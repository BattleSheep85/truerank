/**
 * Sliding window rate limiter.
 * Tracks request timestamps per key (e.g. salted IP hash), enforces max requests per window.
 *
 * With a D1 handle the window is atomic (CP-808): one conditional INSERT on the
 * single D1 primary, so a parallel burst from any number of colos passes at most
 * `maxRequests`. Without one (or while migration 021 is not applied) it falls back
 * to the KV window, which is read-then-write and lets a parallel burst through;
 * the RL_BURST binding (worker/lib/burst-gate.js) still caps that per colo.
 */

import { hashIp } from './ip-hash.js';

/**
 * Builds a rate-limit key with a salted IP hash, avoiding raw IP storage.
 */
export async function ipRateKey(prefix, ip, env) {
    try {
        const hashed = await hashIp(ip, env);
        return `${prefix}:${hashed}`;
    } catch (err) {
        console.log('[rate-limit] IP hashing failed (missing IP_HASH_SALT / WORKER_SECRET), falling back to raw IP');
        return `${prefix}:${ip}`;
    }
}

// Insert the hit only while the bucket holds fewer than ?4 hits inside the
// window. A single statement on D1's one primary, so concurrent calls serialize.
const INSERT_IF_UNDER_SQL = `INSERT INTO rate_limit_hits (bucket, ts, expires_at)
    SELECT ?1, ?2, ?5
     WHERE (SELECT COUNT(*) FROM rate_limit_hits WHERE bucket = ?1 AND ts > ?3) < ?4`;
const WINDOW_STATS_SQL = `SELECT COUNT(*) AS n, MIN(ts) AS oldest
    FROM rate_limit_hits WHERE bucket = ?1 AND ts > ?2`;

/**
 * Check if a request is rate-limited.
 * Pass `db` (env.DB) for the atomic D1 window; omit it for the KV window.
 * Returns { allowed: boolean, remaining: number, resetAt: number }
 */
export async function checkRateLimit(kv, key, maxRequests, windowSeconds, db) {
    if (db) {
        try {
            return await checkRateLimitD1(db, key, maxRequests, windowSeconds);
        } catch (err) {
            console.error('[rate-limit] D1 window failed, using KV:', err instanceof Error ? err.message : String(err));
        }
    }
    return checkRateLimitKv(kv, key, maxRequests, windowSeconds);
}

async function checkRateLimitD1(db, key, maxRequests, windowSeconds) {
    const bucket = `ratelimit:${key}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;
    // A D1 batch runs as one transaction, so the stats read sees exactly the
    // state the insert decided on.
    const [insert, stats] = await db.batch([
        db.prepare(INSERT_IF_UNDER_SQL).bind(bucket, now, windowStart, maxRequests, now + windowMs),
        db.prepare(WINDOW_STATS_SQL).bind(bucket, windowStart),
    ]);
    const row = stats.results?.[0] ?? { n: 0, oldest: null };
    if ((insert.meta?.changes ?? 0) === 1) {
        return { allowed: true, remaining: Math.max(0, maxRequests - row.n), resetAt: now + windowMs };
    }
    return { allowed: false, remaining: 0, resetAt: (row.oldest ?? now) + windowMs };
}

/**
 * Delete hits past their window (cron). Returns the number of rows removed.
 */
export async function pruneRateLimitHits(db, now = Date.now()) {
    const result = await db.prepare('DELETE FROM rate_limit_hits WHERE expires_at < ?1').bind(now).run();
    return result.meta?.changes ?? 0;
}

async function checkRateLimitKv(kv, key, maxRequests, windowSeconds) {
    const storageKey = `ratelimit:${key}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const windowStart = now - windowMs;

    // Get existing timestamps
    const stored = await kv.get(storageKey, 'json');
    const timestamps = (stored || []).filter(ts => ts > windowStart);

    if (timestamps.length >= maxRequests) {
        const oldestInWindow = Math.min(...timestamps);
        const resetAt = oldestInWindow + windowMs;
        return {
            allowed: false,
            remaining: 0,
            resetAt,
        };
    }

    // Add current timestamp and store
    const updated = [...timestamps, now];
    await kv.put(storageKey, JSON.stringify(updated), { expirationTtl: windowSeconds + 60 });

    return {
        allowed: true,
        remaining: maxRequests - updated.length,
        resetAt: now + windowMs,
    };
}
