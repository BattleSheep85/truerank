// Integration coverage for worker/lib/rate-limit.js — the KV-backed sliding
// window, exercised against a real (in-memory Miniflare) KV namespace.
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { checkRateLimit, pruneRateLimitHits } from '../../worker/lib/rate-limit.js';

describe('checkRateLimit', () => {
  it('allows up to max, then blocks; reports remaining + resetAt', async () => {
    const ip = 'ip-' + Math.floor(Date.now()).toString(36);
    const r1 = await checkRateLimit(env.KV, ip, 2, 3600);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await checkRateLimit(env.KV, ip, 2, 3600);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    const r3 = await checkRateLimit(env.KV, ip, 2, 3600);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.resetAt).toBeGreaterThan(Date.now());
  });

  it('separate IPs have independent windows', async () => {
    const a = await checkRateLimit(env.KV, 'ip-A', 1, 3600);
    const b = await checkRateLimit(env.KV, 'ip-B', 1, 3600);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

// CP-808: the KV window is read-then-write, so a parallel burst all read the
// same empty state and all pass. With a D1 handle the window is one
// conditional INSERT on the single D1 primary, so a burst can never pass more
// than the limit, from one colo or many.
import { beforeAll } from 'vitest';
import { applySchema } from './_schema.js';

describe('checkRateLimit with D1 (atomic)', () => {
  beforeAll(async () => { await applySchema(env.DB); });

  it('a parallel burst of 25 passes exactly the limit (5)', async () => {
    const key = 'burst-' + Math.random().toString(36).slice(2);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => checkRateLimit(env.KV, key, 5, 3600, env.DB)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const blocked = results.filter((r) => !r.allowed);
    expect(blocked).toHaveLength(20);
    for (const r of blocked) {
      expect(r.remaining).toBe(0);
      expect(r.resetAt).toBeGreaterThan(Date.now());
    }
  });

  it('the same burst on KV alone passes more than the limit (the old hole)', async () => {
    const key = 'kv-burst-' + Math.random().toString(36).slice(2);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => checkRateLimit(env.KV, key, 5, 3600)),
    );
    expect(results.filter((r) => r.allowed).length).toBeGreaterThan(5);
  });

  it('reports remaining like the KV window', async () => {
    const key = 'seq-' + Math.random().toString(36).slice(2);
    const r1 = await checkRateLimit(env.KV, key, 2, 3600, env.DB);
    const r2 = await checkRateLimit(env.KV, key, 2, 3600, env.DB);
    const r3 = await checkRateLimit(env.KV, key, 2, 3600, env.DB);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, false]);
    expect([r1.remaining, r2.remaining, r3.remaining]).toEqual([1, 0, 0]);
    expect(r3.resetAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it('hits older than the window no longer count', async () => {
    const key = 'old-' + Math.random().toString(36).slice(2);
    const old = Date.now() - 2 * 3600 * 1000;
    await env.DB.prepare('INSERT INTO rate_limit_hits (bucket, ts, expires_at) VALUES (?1, ?2, ?3)')
      .bind(`ratelimit:${key}`, old, old + 3600 * 1000).run();
    const r = await checkRateLimit(env.KV, key, 1, 3600, env.DB);
    expect(r.allowed).toBe(true);
  });

  it('falls back to KV when the D1 table is missing (migration not applied yet)', async () => {
    const broken = { prepare: () => { throw new Error('no such table: rate_limit_hits'); }, batch: async () => { throw new Error('no such table'); } };
    const key = 'fallback-' + Math.random().toString(36).slice(2);
    const r1 = await checkRateLimit(env.KV, key, 1, 3600, broken);
    const r2 = await checkRateLimit(env.KV, key, 1, 3600, broken);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });

  it('pruneRateLimitHits deletes only expired hits', async () => {
    const key = 'prune-' + Math.random().toString(36).slice(2);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO rate_limit_hits (bucket, ts, expires_at) VALUES (?1, ?2, ?3), (?1, ?4, ?5)')
      .bind(key, now - 7200_000, now - 3600_000, now, now + 3600_000).run();
    const removed = await pruneRateLimitHits(env.DB, now);
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ?1').bind(key).first();
    expect(left.n).toBe(1);
  });
});

describe('cron prunes rate-limit hits (CP-808)', () => {
  it('runScheduledTick removes expired hits', async () => {
    const { runScheduledTick } = await import('../../worker/jobs.js');
    const key = 'cron-' + Math.random().toString(36).slice(2);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO rate_limit_hits (bucket, ts, expires_at) VALUES (?1, ?2, ?3)')
      .bind(key, now - 7200_000, now - 3600_000).run();
    await runScheduledTick({ scheduledTime: now }, { ...env, EXTERNAL_WORKER_ENABLED: 'false', FLYWHEEL_DAILY_MAX: '0' }, { waitUntil() {} });
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket = ?1').bind(key).first();
    expect(left.n).toBe(0);
  });
});

describe('no raw IP in the D1 window (CP-808 review)', () => {
  it('feedback stores a hashed key', async () => {
    const { SELF } = await import('cloudflare:test');
    const ip = '203.0.113.211';
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'ratelimit:feedback:%'").first();
    await SELF.fetch('https://chrisputer.tech/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ reportId: 'nope', rating: 5 }),
    });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE 'ratelimit:feedback:%'").first();
    expect(after.n).toBe(before.n + 1);
    const raw = await env.DB.prepare('SELECT COUNT(*) AS n FROM rate_limit_hits WHERE bucket LIKE ?1').bind(`%${ip}%`).first();
    expect(raw.n).toBe(0);
  });
});
