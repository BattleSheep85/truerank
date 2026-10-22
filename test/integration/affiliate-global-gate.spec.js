// Regression coverage for the SITE-WIDE affiliate throttle
// (worker/lib/affiliate-gate.js), against real D1 + KV.
//
// Incident 2026-08-14/15: 1,232 affiliate clicks on 213 report pages, every
// one from a DIFFERENT ip_hash, about one click per address. The per-IP cap of
// 30/hour never saw it, because no address ever reached 2. The test below is
// that exact evasion: 20 addresses, one click each, all far under the per-IP
// cap, and the global gate must still stop the run once the site total passes
// the limit.
//
// The RL_AFFILIATE_GLOBAL binding is replaced with an injected fake, the
// env.__mailTransport pattern used elsewhere in this suite. Two reasons: the
// gate key is a CONSTANT, so the "unique key per test" trick that keeps the
// RL_BURST specs isolated cannot work here, and the pool does not reset
// ratelimit state between tests (workers-sdk#14392).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleAffiliateClick } from '../../worker/handlers/affiliate.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { checkRateLimit, ipRateKey } from '../../worker/lib/rate-limit.js';
import {
  AFFILIATE_GLOBAL_LIMIT, AFFILIATE_GLOBAL_KEY, AFFILIATE_HOURLY_KEY, affiliateHourlyLimit,
} from '../../worker/lib/affiliate-gate.js';

const PER_IP_CLICK_LIMIT = 30; // mirrors worker/handlers/affiliate.js
const HOURLY_BUCKET = `ratelimit:${AFFILIATE_HOURLY_KEY}`;
const hourlyHits = async () => (await env.DB.prepare(
  'SELECT COUNT(*) n FROM rate_limit_hits WHERE bucket = ?1',
).bind(HOURLY_BUCKET).first()).n;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

// The native binding's counting behaviour inside one window: the first `limit`
// calls per key succeed, the rest fail. No clock, so the window never rolls,
// which is what a burst inside a single period looks like.
function windowLimiter(limit) {
  const seen = new Map();
  return {
    seen,
    async limit({ key }) {
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}

const openLimiter = { async limit() { return { success: true }; } };

const clickRequest = (pid, ip) => new Request(`https://chrisputer.tech/api/go/${pid}`, {
  headers: { 'CF-Connecting-IP': ip, 'User-Agent': BROWSER_UA },
});

// A tagged click keeps the associate tag; a flagged one is stripped of it but
// still redirects. That is the existing per-IP-limited behaviour, reused.
const isTagged = (res) => (res.headers.get('Location') || '').includes('tag=');

let rid;
let pid;
beforeAll(async () => {
  await applySchema(env.DB);
  rid = generateId();
  await insertResearch(env.DB, { id: rid, slug: 'gate-report', query: 'best gate', canonicalQuery: 'gate' });
  pid = generateId();
  await env.DB.prepare(
    'INSERT INTO products (id, research_id, name, brand, rank, affiliate_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(pid, rid, 'Gate NAS', 'Gate', 1, 'https://www.amazon.com/dp/B0GATE0001?tag=battlesheep0a-20').run();
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM affiliate_clicks WHERE product_id = ?1').bind(pid).run();
  // Storage persists across the tests in this file, so reset the site-wide
  // hourly counter (CP-353, D1 window, KV fallback): each test measures one
  // layer on a fresh hour.
  await env.DB.prepare('DELETE FROM rate_limit_hits WHERE bucket = ?1').bind(HOURLY_BUCKET).run();
  await env.KV.delete(HOURLY_BUCKET);
});

describe('site-wide affiliate gate: the binding is wired', () => {
  it('resolves RL_AFFILIATE_GLOBAL from wrangler.toml', () => {
    // Without a real binding the production gate is a no-op that fails open,
    // so this assertion is the one that proves the config actually ships.
    expect(env.RL_AFFILIATE_GLOBAL).toBeTruthy();
    expect(typeof env.RL_AFFILIATE_GLOBAL.limit).toBe('function');
  });
});

describe('rotating-IP evasion (incident 2026-08-14/15)', () => {
  it('throttles 20 different IPs at one click each, none near the per-IP cap', async () => {
    const limiter = windowLimiter(AFFILIATE_GLOBAL_LIMIT);
    env.RL_AFFILIATE_GLOBAL = limiter;

    const ips = Array.from({ length: 20 }, (_, i) => `203.0.113.${i + 1}`);
    const results = [];
    for (const ip of ips) {
      results.push(await handleAffiliateClick(pid, clickRequest(pid, ip), env));
    }

    // Every hit still redirects. A flagged request is never a broken link.
    expect(results.every((r) => r.status === 302)).toBe(true);

    // The gate trips: only the site-wide limit is tagged, the rest are not.
    const tagged = results.filter(isTagged).length;
    expect(tagged).toBe(AFFILIATE_GLOBAL_LIMIT);
    expect(results.length - tagged).toBe(20 - AFFILIATE_GLOBAL_LIMIT);

    // Throttled clicks are excluded from affiliate_clicks, so the table keeps
    // reflecting real visitors.
    const logged = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_clicks WHERE product_id = ?1').bind(pid).first();
    expect(logged.n).toBe(AFFILIATE_GLOBAL_LIMIT);

    // The evasion itself: 20 addresses, one counter. A per-IP view cannot see
    // this, which is why the per-IP cap alone missed the incident.
    expect(limiter.seen.size).toBe(1);
    expect(limiter.seen.get(AFFILIATE_GLOBAL_KEY)).toBe(20);

    // And no single address came anywhere near its own 30/hour cap: each one
    // sent exactly one click, so all 20 stay allowed per-IP.
    for (const ip of ips) {
      const perIp = await checkRateLimit(env.KV, await ipRateKey('go', ip, env), PER_IP_CLICK_LIMIT, 3600);
      expect(perIp.allowed).toBe(true);
      expect(perIp.remaining).toBeGreaterThanOrEqual(PER_IP_CLICK_LIMIT - 3);
    }
  });

  it('keeps throttling after the attacker rotates to a fresh block of IPs', async () => {
    env.RL_AFFILIATE_GLOBAL = windowLimiter(AFFILIATE_GLOBAL_LIMIT);

    // Burn the site-wide budget from one /24, then switch to a different /24.
    // A fresh address buys nothing, because the counter is not keyed on it.
    for (let i = 0; i < AFFILIATE_GLOBAL_LIMIT; i++) {
      await handleAffiliateClick(pid, clickRequest(pid, `198.51.100.${i + 1}`), env);
    }
    const afterRotation = await handleAffiliateClick(pid, clickRequest(pid, '192.0.2.77'), env);
    expect(isTagged(afterRotation)).toBe(false);
  });
});

describe('normal traffic', () => {
  it('never trips the gate at real low volume from a few IPs', async () => {
    env.RL_AFFILIATE_GLOBAL = windowLimiter(AFFILIATE_GLOBAL_LIMIT);

    // Three visitors, one click each. The busiest real minute on record
    // (production D1, 5 weeks before the incident) was 3 clicks.
    const results = [];
    for (const ip of ['198.51.100.201', '198.51.100.202', '198.51.100.203']) {
      results.push(await handleAffiliateClick(pid, clickRequest(pid, ip), env));
    }
    expect(results.every(isTagged)).toBe(true);
    const logged = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_clicks WHERE product_id = ?1').bind(pid).first();
    expect(logged.n).toBe(3);
  });

  it('fails OPEN when the binding is missing (config rollback, local runs)', async () => {
    env.RL_AFFILIATE_GLOBAL = undefined;
    const res = await handleAffiliateClick(pid, clickRequest(pid, '198.51.100.210'), env);
    expect(isTagged(res)).toBe(true);
  });
});

describe('per-IP cap is unchanged by the new layer', () => {
  it('still admits a single IP below 30/hour and flags it above', async () => {
    // Gate pinned open, so anything observed here is the per-IP cap alone.
    env.RL_AFFILIATE_GLOBAL = openLimiter;
    const ip = '198.51.100.30';

    const early = await handleAffiliateClick(pid, clickRequest(pid, ip), env);
    expect(isTagged(early)).toBe(true);

    let last;
    for (let i = 1; i < PER_IP_CLICK_LIMIT + 2; i++) {
      last = await handleAffiliateClick(pid, clickRequest(pid, ip), env);
    }
    expect(isTagged(last)).toBe(false);

    // Exactly the per-IP allowance was logged, so the new layer neither
    // tightened nor loosened it.
    const logged = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_clicks WHERE product_id = ?1').bind(pid).first();
    expect(logged.n).toBe(PER_IP_CLICK_LIMIT);
  });

  it('does not spend the site-wide budget on a self-identifying bot', async () => {
    // UA screening runs first, so a declared bot must not consume a token and
    // push real visitors over the shared limit.
    const limiter = windowLimiter(AFFILIATE_GLOBAL_LIMIT);
    env.RL_AFFILIATE_GLOBAL = limiter;
    const res = await handleAffiliateClick(pid, new Request(`https://chrisputer.tech/api/go/${pid}`, {
      headers: { 'CF-Connecting-IP': '198.51.100.40', 'User-Agent': 'python-requests/2.31.0' },
    }), env);
    expect(isTagged(res)).toBe(false);
    expect(limiter.seen.size).toBe(0);
  });
});

describe('slow, wide source under the per-minute gate (CP-353)', () => {
  beforeEach(() => {
    // The per-minute gate is pinned open: this is the shape it cannot see.
    env.RL_AFFILIATE_GLOBAL = openLimiter;
  });

  it('reads the hourly ceiling from wrangler.toml [vars]', () => {
    expect(env.AFFILIATE_GLOBAL_HOURLY_LIMIT).toBe('30');
    expect(affiliateHourlyLimit(env)).toBe(30);
  });

  it('tags only the hourly ceiling when 40 addresses send one click each', async () => {
    const limit = affiliateHourlyLimit(env);
    const results = [];
    for (let i = 0; i < 40; i++) {
      results.push(await handleAffiliateClick(pid, clickRequest(pid, `100.64.7.${i + 1}`), env));
    }
    expect(results.every((r) => r.status === 302)).toBe(true);
    expect(results.filter(isTagged).length).toBe(limit);
    const logged = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_clicks WHERE product_id = ?1').bind(pid).first();
    expect(logged.n).toBe(limit);
    // Counted on the atomic D1 window, one exact count across locations.
    expect(await hourlyHits()).toBe(limit);
  });

  it('does not spend the hourly budget on a click the per-IP cap already flagged', async () => {
    // Raise the hourly ceiling above the per-IP cap, so the hourly count can
    // only stop at 30 if flagged clicks never reach it.
    const saved = env.AFFILIATE_GLOBAL_HOURLY_LIMIT;
    env.AFFILIATE_GLOBAL_HOURLY_LIMIT = '100';
    try {
      const ip = '100.64.8.1';
      for (let i = 0; i < PER_IP_CLICK_LIMIT + 5; i++) {
        await handleAffiliateClick(pid, clickRequest(pid, ip), env);
      }
      expect(await hourlyHits()).toBe(PER_IP_CLICK_LIMIT);
    } finally {
      env.AFFILIATE_GLOBAL_HOURLY_LIMIT = saved;
    }
  });
});
