// Integration coverage for the per-IP free-tier quota gate (100 product verifies
// per UTC day before a free account is required) — worker/lib/quota.js wired into
// handleStartVerify. Mirrors verify-route.spec.js's D1/KV conventions.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleStartVerify } from '../../worker/handlers/verify.js';
import { createUser, createSession } from '../../worker/lib/auth.js';
import { FREE_VERIFIES, quotaKey } from '../../worker/lib/quota.js';

beforeAll(async () => {
  await applySchema(env.DB);
});

// Same RESEARCH_QUEUE stub pattern as verify-route.spec.js — a real queue
// send races the isolated per-file D1/KV storage this spec gets.
//
// The verify handler also has a KV rate limit of 20 per hour per IP, so these
// cases cannot send 101 requests. They seed today's quota counter in KV to
// FREE_VERIFIES - 1 (or FREE_VERIFIES) and then send a few requests.
async function seedVerifyUsage(ip, used) {
  await env.KV.put(await quotaKey('verify', ip, testEnv), String(used));
}

// RL_BURST is omitted on purpose. The cases below send several requests from one IP, and this spec fires them in milliseconds,
// which the 10-per-60s burst gate would answer with 429 before the quota gate
// ever ran. Dropping the binding is the supported fail-open configuration
// (worker/lib/burst-gate.js), so these cases measure the quota gate alone.
// The burst gate has its own coverage in burst-gate.spec.js, research.spec.js
// and verify-route.spec.js.
const { RL_BURST: _unusedBurstGate, ...envWithoutBurstGate } = env;
const testEnv = { ...envWithoutBurstGate, RESEARCH_QUEUE: { send: async () => {} } };

const verifyPost = (body, ip, cookie) => new Request('https://chrisputer.tech/api/verify', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: JSON.stringify(body),
});

describe('quota — verify (100 per day, anonymous)', () => {
  it('the 100th verify from a fresh IP succeeds, the 101st is 403 signup_required', async () => {
    const ip = '198.51.100.10';
    await seedVerifyUsage(ip, FREE_VERIFIES - 1);
    const last = await handleStartVerify(verifyPost({ product: 'Test Product Last' }, ip), testEnv);
    expect(last.status).toBe(200);
    const res = await handleStartVerify(verifyPost({ product: 'One Too Many' }, ip), testEnv);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('signup_required');
    expect(body.kind).toBe('verify');
    expect(body.limit).toBe(FREE_VERIFIES);
    expect(body.error).toMatch(/today's 100 free checks/);
  });

  it('a needs_input resubmit does not consume quota', async () => {
    const ip = '198.51.100.11';
    // Exhaust the quota: seed it one short, then spend the last check.
    await seedVerifyUsage(ip, FREE_VERIFIES - 1);
    const seedRes = await handleStartVerify(verifyPost({ product: 'Resub Seed' }, ip), testEnv);
    const lastId = (await seedRes.json()).id;
    // Force the last row into needs_input so it's eligible for resubmit.
    await env.DB.prepare("UPDATE research SET status = 'needs_input' WHERE id = ?").bind(lastId).run();

    // Resubmitting (continuation of an already-paid run) must succeed even
    // though the quota is fully exhausted.
    const resubmit = await handleStartVerify(verifyPost({
      reportId: lastId,
      product: 'Resub Seed',
      productUrl: 'https://maker.example/resub',
    }, ip), testEnv);
    expect(resubmit.status).toBe(200);

    // A genuinely new submission from the same exhausted IP is still blocked.
    const blocked = await handleStartVerify(verifyPost({ product: 'Brand New After Exhaustion' }, ip), testEnv);
    expect(blocked.status).toBe(403);
  });

  it('a signed-in user bypasses the verify quota entirely', async () => {
    const ip = '198.51.100.12';
    const userId = await createUser(env.DB, 'verifyquota@truerank.test', 'hunter2pass');
    const session = await createSession(env.DB, userId);
    const cookie = `tr_sess=${session.token}`;

    await seedVerifyUsage(ip, FREE_VERIFIES);
    for (let i = 0; i < 3; i++) {
      const res = await handleStartVerify(verifyPost({ product: `Signed In Verify ${i}` }, ip, cookie), testEnv);
      expect(res.status).toBe(200);
    }
  });
});

