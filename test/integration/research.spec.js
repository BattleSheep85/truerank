// Integration coverage for worker/handlers/research.js — the wallet-DoS
// velocity throttle on POST /api/research (2026-07-08). The shared
// MONTHLY_BUDGET_USD cap was the only backstop after the per-IP throttle was
// removed 2026-06-24, so one actor could drain the month and 503 everyone.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { applySchema } from './_schema.js';
import { handleStartResearch, handleResearchStatus } from '../../worker/handlers/research.js';
import { checkRateLimit, ipRateKey } from '../../worker/lib/rate-limit.js';
import { quotaKey } from '../../worker/lib/quota.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { canonicalizeQuery } from '../../worker/lib/utils.js';
import { completeResearch, insertProductV2 } from './_helpers.js';

const SECRET = 'test-worker-secret-123';

beforeAll(async () => {
  await applySchema(env.DB);
  env.WORKER_SECRET = SECRET; // per-test isolated env; safe to set
  testEnv.WORKER_SECRET = SECRET;
});

const post = (query, ip, extra = {}, headers = {}) => new Request('https://chrisputer.tech/api/research', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
  body: JSON.stringify({ query, ...extra }),
});

// Stub the queue for every case in this file. A real send auto-delivers to the
// worker's queue() handler, which claims the row and runs the FULL research
// pipeline against the live keys vitest loads from .dev.vars (real spend), and
// it races the isolated per-file storage stack (the "Failed to pop isolated
// storage stack frame" teardown error). Same stub as verify-route.spec.js.
const testEnv = { ...env, RESEARCH_QUEUE: { send: async () => {} } };

describe('handleStartResearch — wallet-DoS velocity throttle', () => {
  it('returns 429 + Retry-After once the per-IP hourly new-run cap (20) is hit', async () => {
    const ip = '203.0.113.7';
    // Pre-fill the SAME limiter key the handler uses so the next new run trips it.
    const key = await ipRateKey('research', ip, testEnv);
    for (let i = 0; i < 20; i++) await checkRateLimit(env.KV, key, 20, 3600, env.DB);

    const res = await handleStartResearch(
      post('best over-ear headphones for a quiet office', ip, { fresh: true }),
      testEnv,
    );

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
  });

  it('lets a fresh IP through the throttle (not 429)', async () => {
    // A never-seen IP is under the cap, so the throttle must NOT block it. It may
    // proceed to budget/enqueue and return any non-429 status.
    const res = await handleStartResearch(
      post('best mechanical keyboard for programmers', '203.0.113.9', { fresh: true }),
      testEnv,
    );
    expect(res.status).not.toBe(429);
  });
});

// The KV window above is read-then-write, so N concurrent requests all read the
// same pre-write state and all pass. That is the burst hole in docs/rate-limit-design.md
// section 1.4. The RL_BURST binding in front of it is atomic per colo, which for
// a per-IP key equals atomic per attacking source.
describe('handleStartResearch: concurrent burst gate', () => {
  const BURST_CEILING = 15; // binding limit 10, plus slack for its permissive counting

  it('admits far fewer than 30 parallel new runs from one IP', async () => {
    const ip = '203.0.113.20';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => handleStartResearch(
        post(`best junk widget number ${i} for testing`, ip, { fresh: true }),
        testEnv,
      )),
    );

    const statuses = results.map((r) => r.status);
    const throttled = statuses.filter((s) => s === 429).length;
    const admitted = statuses.length - throttled;

    // Without the burst gate this admits all 30. That is the regression proof.
    expect(admitted).toBeLessThanOrEqual(BURST_CEILING);
    expect(throttled).toBeGreaterThanOrEqual(30 - BURST_CEILING);
  });

  it('answers a burst-blocked request with 429 + a ~60s Retry-After', async () => {
    const ip = '203.0.113.21';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => handleStartResearch(
        post(`another junk widget number ${i} for testing`, ip, { fresh: true }),
        testEnv,
      )),
    );

    const blocked = results.find((r) => r.status === 429);
    expect(blocked).toBeTruthy();
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(55);
    expect(retryAfter).toBeLessThanOrEqual(61);
    const body = await blocked.json();
    expect(body.error).toMatch(/too many/i);
  });
});

describe('handleStartResearch: forceFresh (internal benchmark bypass)', () => {
  it('bypasses canonical-query clustering only when X-Worker-Secret is valid', async () => {
    const seedId = generateId();
    const query = 'best wireless earbuds for running';
    const canonical = canonicalizeQuery(query);
    await insertResearch(env.DB, {
      id: seedId,
      slug: 's-' + seedId,
      query,
      canonicalQuery: canonical,
    });
    await completeResearch(env.DB, {
      id: seedId,
      status: 'complete',
      summary: 'Earbuds compared.',
      category: 'Audio',
      result: '{}',
      sources: '[]',
    });
    await insertProductV2(env.DB, { researchId: seedId, name: 'Runner Buds Pro', rank: 1 });

    // 1. Normal public POST returns cached/clustered result
    const resPublic = await handleStartResearch(
      post(query, '203.0.113.101'),
      testEnv,
    );
    expect(resPublic.status).toBe(200);
    const bodyPublic = await resPublic.json();
    expect(bodyPublic.cached).toBe(true);
    expect(bodyPublic.clustered).toBe(true);
    expect(bodyPublic.id).toBe(seedId);

    // 2. forceFresh: true with NO X-Worker-Secret header still returns clustered (flag ignored)
    const resNoAuth = await handleStartResearch(
      post(query, '203.0.113.102', { forceFresh: true }),
      testEnv,
    );
    expect(resNoAuth.status).toBe(200);
    const bodyNoAuth = await resNoAuth.json();
    expect(bodyNoAuth.cached).toBe(true);
    expect(bodyNoAuth.clustered).toBe(true);
    expect(bodyNoAuth.id).toBe(seedId);

    // 3. forceFresh: true with valid X-Worker-Secret starts a new run (not clustered)
    const resAuthed = await handleStartResearch(
      post(query, '203.0.113.103', { forceFresh: true }, { 'X-Worker-Secret': SECRET }),
      testEnv,
    );
    expect(resAuthed.status).toBe(200);
    const bodyAuthed = await resAuthed.json();
    expect(bodyAuthed.clustered).toBeFalsy();
    expect(bodyAuthed.status).toBe('pending');
    expect(bodyAuthed.id).not.toBe(seedId);

    // Assert a new research row exists in the database
    const newRow = await env.DB.prepare('SELECT * FROM research WHERE id = ?').bind(bodyAuthed.id).first();
    expect(newRow).toBeTruthy();
    expect(newRow.id).toBe(bodyAuthed.id);
    expect(newRow.status).toBe('pending');
  });
});

describe('handleResearchStatus', () => {
  it('falls back to slug lookup when id lookup misses', async () => {
    const id = generateId();
    const slug = 'slug-research-' + id;
    await insertResearch(env.DB, {
      id,
      slug,
      query: 'best mechanical keyboard',
      canonicalQuery: 'mech-kb-slug',
    });
    await completeResearch(env.DB, {
      id,
      status: 'complete',
      summary: 'Done',
      category: 'Keyboards',
      result: '{"source_count":3}',
      sources: '[]',
    });
    const res = await handleResearchStatus(slug, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.slug).toBe(slug);
    expect(body.status).toBe('completed');
  });
});

describe('handleStartResearch: internal auth throttle and quota bypass', () => {
  it('bypasses rate limit when X-Worker-Secret is valid', async () => {
    const ip = '203.0.113.150';
    // Pre-fill rate limit to exhausted
    const rateKey = await ipRateKey('research', ip, testEnv);
    for (let i = 0; i < 20; i++) await checkRateLimit(env.KV, rateKey, 20, 3600, env.DB);

    const res = await handleStartResearch(
      post('best noise cancelling headphones for flights', ip, { fresh: true }, { 'X-Worker-Secret': SECRET }),
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(body.id).toBeTruthy();
  });

  it('refuses internal requests with 503 when the monthly budget is exhausted', async () => {
    const ip = '203.0.113.151';
    const budgetEnv = { ...testEnv, MONTHLY_BUDGET_USD: '0' };
    const res = await handleStartResearch(
      post('best budget robotic vacuum cleaner', ip, { fresh: true }, { 'X-Worker-Secret': SECRET }),
      budgetEnv,
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/monthly research budget exhausted/i);
  });

  it('still throttles callers with a wrong secret when rate limit is exceeded', async () => {
    const ip1 = '203.0.113.152';
    const rateKey1 = await ipRateKey('research', ip1, testEnv);
    for (let i = 0; i < 20; i++) await checkRateLimit(env.KV, rateKey1, 20, 3600, env.DB);

    const resThrottled = await handleStartResearch(
      post('best lightweight 4k monitor', ip1, { fresh: true }, { 'X-Worker-Secret': 'wrong-secret' }),
      testEnv,
    );
    expect(resThrottled.status).toBe(429);
    expect(Number(resThrottled.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('accepts signed-out callers even if legacy search quota in KV is exhausted', async () => {
    const ip2 = '203.0.113.153';
    const qKey2 = await quotaKey('search', ip2, testEnv);
    await env.KV.put(qKey2, '5');

    const resQuotaAccepted = await handleStartResearch(
      post('best lightweight gaming laptop', ip2, { fresh: true }),
      testEnv,
    );
    expect(resQuotaAccepted.status).toBe(200);
    const bodyQuota = await resQuotaAccepted.json();
    expect(bodyQuota.status).toBe('pending');
    expect(bodyQuota.id).toBeTruthy();
  });

  it('accepts callers with a wrong secret as public callers when not rate-limited even if legacy quota is exhausted', async () => {
    const ip3 = '203.0.113.155';
    const qKey3 = await quotaKey('search', ip3, testEnv);
    await env.KV.put(qKey3, '5');

    const resWrongSecret = await handleStartResearch(
      post('best gaming mechanical keyboard', ip3, { fresh: true }, { 'X-Worker-Secret': 'wrong-secret' }),
      testEnv,
    );
    expect(resWrongSecret.status).toBe(200);
    const bodyWrongSecret = await resWrongSecret.json();
    expect(bodyWrongSecret.status).toBe('pending');
    expect(bodyWrongSecret.id).toBeTruthy();
  });

  it('performs the secret comparison only once per request', async () => {
    const digestSpy = vi.spyOn(crypto.subtle, 'digest');
    digestSpy.mockClear();

    const ip = '203.0.113.154';
    const res = await handleStartResearch(
      post('best soundbar for home theater with dolby atmos', ip, { forceFresh: true }, { 'X-Worker-Secret': SECRET }),
      testEnv,
    );
    expect(res.status).toBe(200);
    // timingSafeEqual digests both secret and header once, resulting in exactly 2 digest calls.
    expect(digestSpy).toHaveBeenCalledTimes(2);

    digestSpy.mockRestore();
  });
});

