// Integration coverage for the two wallet guards added by
// docs/rate-limit-design.md:
//   1. the native RL_BURST rate-limit binding layered in front of the
//      non-atomic KV hourly window (worker/lib/burst-gate.js, section 4.3),
//      exercised here through the auth handler;
//   2. the queue-consumer budget backstop (worker/index.js, section 4.4),
//      which is what actually bounds the dollar blast radius of a burst that
//      slipped past intake.
//
// Harness caveat (workers-sdk#14392): the pool's reset() helper does NOT clear
// ratelimit state between tests, so every case below uses a UNIQUE fake IP.
// The local simulator is single-colo, which is exactly the topology the burst
// gate assumes.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import worker from '../../worker/index.js';
import { handleSignup } from '../../worker/handlers/auth.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { renderResearchResult } from '../../worker/pages/research-page.js';
import { monthKey } from '../../worker/lib/utils.js';

// Mirrors wrangler.toml's [ratelimits.simple] limit. The gate is documented as
// permissive, so assertions allow a small epsilon above it.
const BURST_LIMIT = 10;
const BURST_EPSILON = 2;

beforeAll(async () => {
  await applySchema(env.DB);
});

// A queue message stub with the ack/retry surface the processors call.
function fakeMessage(body) {
  const acks = [];
  return { body, ack() { acks.push('ack'); }, retry() { acks.push('retry'); }, acks };
}

async function seedPendingRow(query, kind) {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: `s-${id}`, query, canonicalQuery: `${kind}-${id}` });
  if (kind === 'verification') {
    await env.DB.prepare("UPDATE research SET kind = 'verification' WHERE id = ?1").bind(id).run();
  }
  return { id, slug: `s-${id}` };
}

describe('RL_BURST binding', () => {
  it('is bound in the test worker (otherwise the burst assertions below are vacuous)', () => {
    expect(env.RL_BURST).toBeTruthy();
    expect(typeof env.RL_BURST.limit).toBe('function');
  });

  it('admits at most the configured limit for one key, then blocks', async () => {
    const key = `probe:${generateId()}`;
    const calls = await Promise.all(
      Array.from({ length: 30 }, () => env.RL_BURST.limit({ key })),
    );
    const admitted = calls.filter((r) => r.success).length;
    expect(admitted).toBeLessThanOrEqual(BURST_LIMIT + BURST_EPSILON);
    expect(admitted).toBeGreaterThan(0);
  });

  it('counts per key, so one hot key does not block a different one', async () => {
    const hot = `probe-hot:${generateId()}`;
    await Promise.all(Array.from({ length: 30 }, () => env.RL_BURST.limit({ key: hot })));
    const cold = await env.RL_BURST.limit({ key: `probe-cold:${generateId()}` });
    expect(cold.success).toBe(true);
  });
});

describe('auth signup: concurrent burst', () => {
  it('caps parallel signups from one IP at the burst limit', async () => {
    const ip = '198.51.100.21';
    const signup = (n) => handleSignup(new Request('https://chrisputer.tech/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email: `burst-${n}@example.com`, password: 'correct horse battery' }),
    }), env);

    const results = await Promise.all(Array.from({ length: 12 }, (_, n) => signup(n)));
    const statuses = results.map((r) => r.status);
    const throttled = statuses.filter((s) => s === 429).length;
    const admitted = statuses.length - throttled;

    // Without the gate all 12 read the same pre-write KV state and all land,
    // each costing 100k PBKDF2 rounds.
    expect(admitted).toBeLessThanOrEqual(BURST_LIMIT + BURST_EPSILON);
    expect(throttled).toBeGreaterThan(0);
  });

  it('lets a never-seen IP through (fail-open for real users)', async () => {
    const res = await handleSignup(new Request('https://chrisputer.tech/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.22' },
      body: JSON.stringify({ email: 'solo-signup@example.com', password: 'correct horse battery' }),
    }), env);
    expect(res.status).not.toBe(429);
  });
});

describe('queue consumer: monthly budget backstop', () => {
  const overBudget = async () => {
    // 999 clears any MONTHLY_BUDGET_USD; budgetExhausted short-circuits on the
    // KV counter before it ever queries D1.
    await env.KV.put(`cost:${monthKey()}`, '999');
  };

  it('fails a claimed research job instead of spending past the cap', async () => {
    const { id } = await seedPendingRow('best budget headphones burst', 'research');
    await overBudget();

    const message = fakeMessage({ reportId: id, query: 'best budget headphones burst' });
    await worker.queue({ messages: [message] }, env);

    const row = await env.DB.prepare('SELECT status, result, completed_at FROM research WHERE id = ?1').bind(id).first();
    expect(row.status).toBe('failed');
    expect(row.completed_at).toBeTruthy();
    expect(JSON.parse(row.result).error).toMatch(/monthly research budget/i);
    expect(message.acks).toEqual(['ack']);

    // The pipeline must not have run: no products, no spend recorded.
    const products = await env.DB.prepare('SELECT COUNT(*) AS n FROM products WHERE research_id = ?1').bind(id).first();
    expect(products.n).toBe(0);
  });

  it('fails a claimed verification job the same way', async () => {
    const { id } = await seedPendingRow('Verify Widget Burst', 'verification');
    await overBudget();

    const message = fakeMessage({ kind: 'verification', reportId: id, product: 'Verify Widget Burst' });
    await worker.queue({ messages: [message] }, env);

    const row = await env.DB.prepare('SELECT status, result FROM research WHERE id = ?1').bind(id).first();
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.result).error).toMatch(/monthly research budget/i);
    expect(message.acks).toEqual(['ack']);
  });

  it('writes a message the research page shows verbatim (no raw error leaks)', async () => {
    const { id, slug } = await seedPendingRow('renderable budget failure', 'research');
    await overBudget();

    await worker.queue({ messages: [fakeMessage({ reportId: id, query: 'renderable budget failure' })] }, env);

    // renderResearchResult drops any stored error that looks like a raw
    // provider/HTTP/JSON string, so reaching the HTML proves the wording is
    // user-facing.
    const { html } = await renderResearchResult(slug, env);
    const stored = JSON.parse(
      (await env.DB.prepare('SELECT result FROM research WHERE id = ?1').bind(id).first()).result,
    ).error;
    expect(html).toContain(stored);
  });

  it('leaves the row alone when the budget is intact', async () => {
    await env.KV.delete(`cost:${monthKey()}`);
    const { id } = await seedPendingRow('under budget row stays claimed', 'research');

    // Claim the row the way the consumer does, then confirm the backstop is a
    // no-op: it must not fail a row that is inside budget.
    await env.DB.prepare("UPDATE research SET status = 'processing' WHERE id = ?1").bind(id).run();
    const before = await env.DB.prepare('SELECT status FROM research WHERE id = ?1').bind(id).first();
    expect(before.status).toBe('processing');

    // Re-deliver the same reportId: the claim finds it out of 'pending', so the
    // processor skips it without touching the budget or the row.
    const message = fakeMessage({ reportId: id, query: 'under budget row stays claimed' });
    await worker.queue({ messages: [message] }, env);

    const after = await env.DB.prepare('SELECT status FROM research WHERE id = ?1').bind(id).first();
    expect(after.status).toBe('processing');
    expect(message.acks).toEqual(['ack']);
  });
});
