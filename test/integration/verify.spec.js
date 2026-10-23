// Integration coverage for worker/pipeline/verify-orchestrator.js — the
// verification-pipeline persist path (research row + claims rows + monthly
// cost counter). Mirrors test/integration/internal.spec.js's D1/KV conventions.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { runVerificationPipeline } from '../../worker/pipeline/verify-orchestrator.js';
import { monthKey } from '../../worker/lib/utils.js';
import { generateId, insertResearch, updateResearchStatus } from '../../worker/lib/db.js';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function seedPendingRow(query = 'Test Widget') {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: 's-' + id, query, canonicalQuery: null });
  // The queue consumer claims pending→processing before calling the pipeline;
  // mirror that here so the orchestrator's guarded UPDATEs (AND status='processing') win.
  await updateResearchStatus(env.DB, id, 'processing');
  return id;
}

const OK_VERIFY = async () => ({
  status: 'ok',
  product: 'Test Widget',
  productUrl: 'https://maker.example/widget',
  subjectClaimSources: ['https://maker.example/widget'],
  overall: { score: 65, label: 'Mostly holds up' },
  claims: [{
    id: 'c1',
    text: 'has 10h battery',
    type: 'spec',
    status: 'partially-verified',
    confidence: 0.6,
    support: 0.6,
    contradict: 0,
    supporting: [{ url: 'https://rtings.com/x', stance: 'support', credibility: 80, independence: 70, span: 'measured 10.5h' }],
    contradicting: [],
    independentCount: 1,
    claimType: 'spec',
  }],
  evidenceCount: 12,
  costUsd: 0.03,
});

describe('runVerificationPipeline — success path', () => {
  it('persists the research row as complete/verification with overall verdict + score', async () => {
    const id = await seedPendingRow();
    const res = await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify: OK_VERIFY });
    expect(res.status).toBe('complete');

    const row = await env.DB.prepare('SELECT * FROM research WHERE id = ?').bind(id).first();
    expect(row.status).toBe('complete');
    expect(row.kind).toBe('verification');
    expect(row.overall_score).toBe(65);
    expect(row.overall_verdict).toBe('Mostly holds up');
    expect(row.subject_url).toBe('https://maker.example/widget');
    expect(row.cost_usd).toBeCloseTo(0.03);
  });

  it('writes exactly one claims row with the verdict + evidence JSON', async () => {
    const id = await seedPendingRow();
    await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify: OK_VERIFY });

    const claims = (await env.DB.prepare('SELECT * FROM claims WHERE research_id = ?').bind(id).all()).results;
    expect(claims.length).toBe(1);
    expect(claims[0].verdict).toBe('partially-verified');
    expect(claims[0].claim_text).toBe('has 10h battery');
    expect(claims[0].evidence).toBeTruthy();
    const evidence = JSON.parse(claims[0].evidence);
    expect(evidence.length).toBe(1);
    expect(evidence[0].url).toBe('https://rtings.com/x');
  });

  it('increments the monthly cost counter', async () => {
    const id = await seedPendingRow();
    const before = Number(await env.KV.get(`cost:${monthKey()}`)) || 0;
    await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify: OK_VERIFY });
    const after = Number(await env.KV.get(`cost:${monthKey()}`)) || 0;
    expect(after).toBeCloseTo(before + 0.03);
  });

  it('a replayed call is a no-op (idempotency latch) and does not double-write claims', async () => {
    const id = await seedPendingRow();
    await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify: OK_VERIFY });
    // Row is now 'complete', not 'processing' — a redelivered message would hit
    // this same guarded path again (queue consumer claims pending→processing
    // first; a second delivery after success finds the row already 'complete'
    // and the claim UPDATE below changes 0 rows, so it never re-invokes verify()
    // in production. Here we simulate a raw re-run of the persist step directly.)
    const res = await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify: OK_VERIFY });
    expect(res.status).toBe('noop');

    const claims = (await env.DB.prepare('SELECT * FROM claims WHERE research_id = ?').bind(id).all()).results;
    expect(claims.length).toBe(1); // not doubled
  });
});

describe('runVerificationPipeline — cross-run claim id uniqueness', () => {
  it('persists two verify runs whose claims reuse the same claim.id (c1, c2) without a UNIQUE constraint error', async () => {
    const twoClaims = async () => ({
      status: 'ok',
      product: 'Test Widget',
      productUrl: 'https://maker.example/widget',
      subjectClaimSources: ['https://maker.example/widget'],
      overall: { score: 70, label: 'Mostly holds up' },
      claims: [
        { id: 'c1', text: 'claim one', type: 'spec', status: 'verified', confidence: 0.8, support: 0.8, contradict: 0, supporting: [], contradicting: [], claimType: 'spec' },
        { id: 'c2', text: 'claim two', type: 'spec', status: 'verified', confidence: 0.7, support: 0.7, contradict: 0, supporting: [], contradicting: [], claimType: 'spec' },
      ],
      evidenceCount: 2,
      costUsd: 0.02,
    });

    const idA = await seedPendingRow('Widget A');
    const idB = await seedPendingRow('Widget B');

    const resA = await runVerificationPipeline(env, idA, { product: 'Widget A' }, { verify: twoClaims });
    expect(resA.status).toBe('complete');

    const resB = await runVerificationPipeline(env, idB, { product: 'Widget B' }, { verify: twoClaims });
    expect(resB.status).toBe('complete');

    const claimsA = (await env.DB.prepare('SELECT * FROM claims WHERE research_id = ?').bind(idA).all()).results;
    const claimsB = (await env.DB.prepare('SELECT * FROM claims WHERE research_id = ?').bind(idB).all()).results;
    expect(claimsA.length).toBe(2);
    expect(claimsB.length).toBe(2);
    expect(claimsA.map((c) => c.claim_text).sort()).toEqual(['claim one', 'claim two']);
    expect(claimsB.map((c) => c.claim_text).sort()).toEqual(['claim one', 'claim two']);
  });
});

describe('runVerificationPipeline — needs_url path', () => {
  it('marks the row needs_input without completing or writing claims', async () => {
    const id = await seedPendingRow();
    const res = await runVerificationPipeline(env, id, { product: 'Mystery Widget' }, {
      verify: async () => ({ status: 'needs_url', message: 'Paste the product page URL to continue.' }),
    });
    expect(res.status).toBe('needs_input');

    const row = await env.DB.prepare('SELECT * FROM research WHERE id = ?').bind(id).first();
    expect(row.status).toBe('needs_input');
    expect(row.preview).toBe('Paste the product page URL to continue.');
    expect(row.completed_at).toBeNull();
    expect(row.kind).toBeNull();

    const claims = (await env.DB.prepare('SELECT * FROM claims WHERE research_id = ?').bind(id).all()).results;
    expect(claims.length).toBe(0);
  });
});

// CP-808: a hedge call still running when the verdict is in (lateCostUsd) is
// paid for, so it is added to the row and the month once it finishes.
describe('runVerificationPipeline — late judge cost', () => {
  it('adds lateCostUsd to the row and the month, and keeps it out of the saved result', async () => {
    const id = await seedPendingRow();
    const before = Number(await env.KV.get(`cost:${monthKey()}`)) || 0;
    const verify = async () => ({ ...(await OK_VERIFY()), lateCostUsd: Promise.resolve(0.004) });
    const res = await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify });
    expect(res.status).toBe('complete');
    const row = await env.DB.prepare('SELECT cost_usd, result FROM research WHERE id = ?').bind(id).first();
    expect(row.cost_usd).toBeCloseTo(0.034);
    expect(JSON.parse(row.result)).not.toHaveProperty('lateCostUsd');
    const after = Number(await env.KV.get(`cost:${monthKey()}`)) || 0;
    expect(after).toBeCloseTo(before + 0.034);
  });

  it('a late cost of 0 changes nothing', async () => {
    const id = await seedPendingRow();
    const verify = async () => ({ ...(await OK_VERIFY()), lateCostUsd: Promise.resolve(0) });
    await runVerificationPipeline(env, id, { product: 'Test Widget' }, { verify });
    const row = await env.DB.prepare('SELECT cost_usd FROM research WHERE id = ?').bind(id).first();
    expect(row.cost_usd).toBeCloseTo(0.03);
  });
});

describe('runVerificationPipeline: forceFresh (CP-789)', () => {
  it('passes forceFresh to verify only when the message set it', async () => {
    const seen = [];
    const verify = async (args) => { seen.push(args.forceFresh); return OK_VERIFY(); };
    await runVerificationPipeline(env, await seedPendingRow(), { product: 'Test Widget', forceFresh: true }, { verify });
    await runVerificationPipeline(env, await seedPendingRow(), { product: 'Test Widget' }, { verify });
    expect(seen).toEqual([true, false]);
  });
});
