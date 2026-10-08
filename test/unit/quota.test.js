// Unit coverage for worker/lib/quota.js — per-IP free-tier counters
// (lifetime for 'search', per UTC day for 'verify').
// Uses a minimal in-memory KV shim (get/put only, matching the Cloudflare KV
// surface the module actually calls) rather than pulling in Miniflare.
import {
  getQuota, consumeQuota, quotaKey, FREE_SEARCHES, FREE_VERIFIES,
  QUOTA_EXPIRATION_TTL, DAILY_QUOTA_EXPIRATION_TTL,
} from '../../worker/lib/quota.js';

function fakeKv() {
  const store = new Map();
  const puts = [];
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      puts.push({ key, opts });
    },
    _store: store,
    _puts: puts,
  };
}

export async function runQuotaTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  const fakeEnv = { IP_HASH_SALT: 'test-salt-secret-quota' };

  // Constants
  eq('FREE_SEARCHES is 5', FREE_SEARCHES, 5);
  eq('FREE_VERIFIES is 100', FREE_VERIFIES, 100);

  // getQuota: missing key -> used 0, remaining = limit
  {
    const kv = fakeKv();
    const q = await getQuota(kv, 'search', '1.2.3.4', fakeEnv);
    eq('getQuota missing key: used', q.used, 0);
    eq('getQuota missing key: limit', q.limit, FREE_SEARCHES);
    eq('getQuota missing key: remaining', q.remaining, FREE_SEARCHES);
  }

  // getQuota: verify kind uses FREE_VERIFIES
  {
    const kv = fakeKv();
    const q = await getQuota(kv, 'verify', '1.2.3.4', fakeEnv);
    eq('getQuota verify limit', q.limit, FREE_VERIFIES);
  }

  // consumeQuota increments the counter, isolated per (kind, ip)
  {
    const kv = fakeKv();
    await consumeQuota(kv, 'search', '5.6.7.8', fakeEnv);
    await consumeQuota(kv, 'search', '5.6.7.8', fakeEnv);
    const q = await getQuota(kv, 'search', '5.6.7.8', fakeEnv);
    eq('consumeQuota increments used', q.used, 2);
    eq('consumeQuota reduces remaining', q.remaining, FREE_SEARCHES - 2);

    const keys = Array.from(kv._store.keys());
    eq('stored key count', keys.length, 1);
    eq('stored key does not contain raw IP', keys[0].includes('5.6.7.8'), false);
    eq('stored key has no dotted IP address', /\d+\.\d+\.\d+\.\d+/.test(keys[0]), false);
    eq('stored key starts with quota:v2:search:', keys[0].startsWith('quota:v2:search:'), true);

    const other = await getQuota(kv, 'verify', '5.6.7.8', fakeEnv);
    eq('consumeQuota does not bleed across kinds for the same IP', other.used, 0);

    const otherIp = await getQuota(kv, 'search', '9.9.9.9', fakeEnv);
    eq('consumeQuota does not bleed across IPs', otherIp.used, 0);
  }

  // Exhausting the limit drives remaining to 0, never negative
  {
    const kv = fakeKv();
    for (let i = 0; i < FREE_SEARCHES + 3; i++) await consumeQuota(kv, 'search', '10.0.0.1', fakeEnv);
    const q = await getQuota(kv, 'search', '10.0.0.1', fakeEnv);
    eq('remaining never goes negative once over the limit', q.remaining, 0);
    eq('used keeps counting past the limit', q.used, FREE_SEARCHES + 3);
  }

  // Key hashing assertions: no dotted IP and different salts produce different keys
  {
    const key1 = await quotaKey('search', '1.2.3.4', { IP_HASH_SALT: 'salt-a' });
    const key2 = await quotaKey('search', '1.2.3.4', { IP_HASH_SALT: 'salt-b' });
    eq('two different salts produce different keys for the same IP', key1 !== key2, true);
    eq('key1 contains no dotted IP address', key1.includes('1.2.3.4'), false);
    eq('key2 contains no dotted IP address', key2.includes('1.2.3.4'), false);
    eq('key1 has no dotted IPv4 pattern', /\d+\.\d+\.\d+\.\d+/.test(key1), false);
    eq('key2 has no dotted IPv4 pattern', /\d+\.\d+\.\d+\.\d+/.test(key2), false);

    // Fallback on missing salt
    const keyFallback = await quotaKey('search', '1.2.3.4', {});
    eq('quotaKey falls back to raw IP when no salt', keyFallback, 'quota:v2:search:1.2.3.4');
  }

  // Run fn with Date.now() pinned to nowMs, then restore the real clock.
  const atTime = async (nowMs, fn) => {
    const realNow = Date.now;
    Date.now = () => nowMs;
    try { return await fn(); } finally { Date.now = realNow; }
  };
  const DAY1 = Date.UTC(2026, 9, 8, 23, 59, 0);
  const DAY2 = Date.UTC(2026, 9, 9, 0, 1, 0);

  // verify: daily key carries the UTC date and a ~2 day TTL
  {
    const kv = fakeKv();
    await atTime(DAY1, () => consumeQuota(kv, 'verify', '7.7.7.7', fakeEnv));
    const [put] = kv._puts;
    eq('verify key is quota:v3:verify:<hash>:<date>', /^quota:v3:verify:[^:]+:2026-10-08$/.test(put.key), true);
    eq('verify key contains no raw IP', put.key.includes('7.7.7.7'), false);
    eq('verify TTL is the daily TTL', put.opts.expirationTtl, DAILY_QUOTA_EXPIRATION_TTL);
    eq('daily TTL is 2 days', DAILY_QUOTA_EXPIRATION_TTL, 2 * 24 * 60 * 60);
  }

  // verify: the UTC date rollover gives a fresh allowance
  {
    const kv = fakeKv();
    await atTime(DAY1, async () => {
      for (let i = 0; i < FREE_VERIFIES; i++) await consumeQuota(kv, 'verify', '8.8.4.4', fakeEnv);
    });
    const spent = await atTime(DAY1, () => getQuota(kv, 'verify', '8.8.4.4', fakeEnv));
    eq('verify exhausted on day 1', spent.remaining, 0);
    const fresh = await atTime(DAY2, () => getQuota(kv, 'verify', '8.8.4.4', fakeEnv));
    eq('verify fresh on day 2: used', fresh.used, 0);
    eq('verify fresh on day 2: remaining', fresh.remaining, FREE_VERIFIES);
    await atTime(DAY2, () => consumeQuota(kv, 'verify', '8.8.4.4', fakeEnv));
    const day2 = await atTime(DAY2, () => getQuota(kv, 'verify', '8.8.4.4', fakeEnv));
    eq('verify day 2 counts from 1', day2.used, 1);
  }

  // search: lifetime behavior unchanged across the date rollover
  {
    const kv = fakeKv();
    await atTime(DAY1, () => consumeQuota(kv, 'search', '4.4.4.4', fakeEnv));
    const later = await atTime(DAY2, () => getQuota(kv, 'search', '4.4.4.4', fakeEnv));
    eq('search usage survives the date rollover', later.used, 1);
    const [put] = kv._puts;
    eq('search key has no date suffix', /^quota:v2:search:[^:]+$/.test(put.key), true);
    eq('search TTL is the lifetime TTL', put.opts.expirationTtl, QUOTA_EXPIRATION_TTL);
    const keyFallback = await atTime(DAY1, () => quotaKey('verify', '1.2.3.4', {}));
    eq('verify quotaKey falls back to raw IP with the date', keyFallback, 'quota:v3:verify:1.2.3.4:2026-10-08');
  }

  return report;
}
