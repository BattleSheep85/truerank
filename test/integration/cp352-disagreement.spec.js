// CP-352: a public caller can no longer force a paid fresh run. A report is
// re-researched only when enough different visitors say it does not match
// what they found (worker/lib/disagreement.js).
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleStartResearch } from '../../worker/handlers/research.js';
import { handleFeedback } from '../../worker/handlers/report.js';
import { renderResearchResult } from '../../worker/pages/research-page.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { canonicalizeQuery, squashQuery } from '../../worker/lib/utils.js';
import { DISAGREE_THRESHOLD } from '../../worker/lib/disagreement.js';
import { completeResearch, insertProductV2 } from './_helpers.js';

const SECRET = 'test-worker-secret-352';
const sent = [];
const testEnv = { ...env, WORKER_SECRET: SECRET, RESEARCH_QUEUE: { send: async (msg) => { sent.push(msg); } } };

beforeAll(async () => {
  await applySchema(env.DB);
});

async function seedReport(query, { status = 'complete', products = 1, clarifications = null } = {}) {
  const id = generateId();
  const q = query.toLowerCase();
  const clar = clarifications ? JSON.parse(clarifications) : {};
  await insertResearch(env.DB, {
    id, slug: `s-${id}`, query: q,
    canonicalQuery: canonicalizeQuery(q, clar), squashedQuery: squashQuery(q, clar), clarifications,
  });
  await completeResearch(env.DB, { id, status, result: JSON.stringify({ products: [] }) });
  for (let i = 0; i < products; i++) {
    await insertProductV2(env.DB, { researchId: id, name: `Widget ${i}`, rank: i + 1 });
  }
  return id;
}

const research = (body, headers = {}, ip = '203.0.113.240') => new Request('https://chrisputer.tech/api/research', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
  body: JSON.stringify(body),
});

const vote = (reportId, rating, ip) => new Request('https://chrisputer.tech/api/feedback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify({ reportId, rating }),
});

const runsFor = async (canonical) => (await env.DB.prepare(
  'SELECT COUNT(*) AS n FROM research WHERE canonical_query = ?',
).bind(canonical).first()).n;

describe('POST /api/research: fresh is internal only', () => {
  it('a public fresh request gets the cached report', async () => {
    const id = await seedReport('cp352 cached public widget');
    const res = await handleStartResearch(research({ query: 'cp352 cached public widget', fresh: true }), testEnv);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.id).toBe(id);
  });

  it('an internal fresh request still starts a new run', async () => {
    const id = await seedReport('cp352 cached internal widget');
    const res = await handleStartResearch(
      research({ query: 'cp352 cached internal widget', fresh: true }, { 'X-Worker-Secret': SECRET }),
      testEnv,
    );
    const body = await res.json();
    expect(body.status).toBe('pending');
    expect(body.id).not.toBe(id);
  });

  it('a failed run does not match the cache, so "Try again" starts a new run', async () => {
    const id = await seedReport('cp352 failed widget', { status: 'failed', products: 0 });
    const body = await (await handleStartResearch(research({ query: 'cp352 failed widget' }), testEnv)).json();
    expect(body.status).toBe('pending');
    expect(body.id).not.toBe(id);
  });

  it('a refined query does not match the cache of the original report', async () => {
    await seedReport('cp352 refine widget');
    const body = await (await handleStartResearch(
      research({ query: 'cp352 refine widget', clarifications: { budget: 'under 50' } }),
      testEnv,
    )).json();
    expect(body.status).toBe('pending');
    expect(body.cached).toBeUndefined();
  });
});

describe('report page: no public re-run buttons', () => {
  it('has no fresh form and shows the Yes / No question', async () => {
    const id = await seedReport('cp352 page widget');
    const { html } = await renderResearchResult(`s-${id}`, testEnv, 'cp352 page widget question');
    expect(html).not.toContain('name="fresh"');
    expect(html).not.toContain('Re-run fresh');
    expect(html).not.toContain('Re-research with fresh data');
    expect(html).toContain('Does this match what you found?');
    expect(html).toContain(`data-report-id="${id}"`);
  });

  it('the failed-run "Try again" form skips the clarify page instead of sending fresh', async () => {
    const id = await seedReport('cp352 page failed widget', { status: 'failed', products: 0 });
    const { html } = await renderResearchResult(`s-${id}`, testEnv);
    expect(html).toContain('Try again');
    expect(html).toContain('name="skip_clarify" value="1"');
    expect(html).not.toContain('name="fresh"');
  });
});

describe('disagreement trigger', () => {
  it(`starts one fresh run after ${DISAGREE_THRESHOLD} "No" votes from different visitors`, async () => {
    const id = await seedReport('cp352 disagree widget', { clarifications: '{"budget":"under 100"}' });
    const canonical = canonicalizeQuery('cp352 disagree widget', { budget: 'under 100' });
    sent.length = 0;
    for (let i = 0; i < DISAGREE_THRESHOLD - 1; i++) {
      const body = await (await handleFeedback(vote(id, 1, `198.51.100.${i + 1}`), testEnv)).json();
      expect(body.rerun).toBe(false);
    }
    expect(await runsFor(canonical)).toBe(1);

    const last = await (await handleFeedback(vote(id, 1, '198.51.100.50'), testEnv)).json();
    expect(last.rerun).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await runsFor(canonical)).toBe(2);
    const rerun = await env.DB.prepare(
      'SELECT query, clarifications, status FROM research WHERE canonical_query = ? AND id != ?',
    ).bind(canonical, id).first();
    expect(rerun.query).toBe('cp352 disagree widget');
    expect(rerun.clarifications).toBe('{"budget":"under 100"}');
    expect(rerun.status).toBe('pending');

    // More "No" votes inside 14 days start nothing new.
    const more = await (await handleFeedback(vote(id, 1, '198.51.100.51'), testEnv)).json();
    expect(more.rerun).toBe(false);
    expect(sent).toHaveLength(1);
    expect(await runsFor(canonical)).toBe(2);
  });

  it('the same visitor voting "No" many times counts once', async () => {
    const id = await seedReport('cp352 repeat voter widget');
    sent.length = 0;
    for (let i = 0; i < DISAGREE_THRESHOLD + 2; i++) {
      await handleFeedback(vote(id, 1, '198.51.100.60'), testEnv);
    }
    expect(sent).toHaveLength(0);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE report_id = ?').bind(id).first();
    expect(n.n).toBe(1);
  });

  it('a visitor who changes a "No" to a "Yes" no longer counts', async () => {
    const id = await seedReport('cp352 change mind widget');
    sent.length = 0;
    await handleFeedback(vote(id, 1, '198.51.100.70'), testEnv);
    await handleFeedback(vote(id, 5, '198.51.100.70'), testEnv);
    for (let i = 0; i < DISAGREE_THRESHOLD - 1; i++) {
      await handleFeedback(vote(id, 1, `198.51.100.${71 + i}`), testEnv);
    }
    expect(sent).toHaveLength(0);
  });

  it('"Yes" votes never start a run', async () => {
    const id = await seedReport('cp352 agree widget');
    sent.length = 0;
    for (let i = 0; i < DISAGREE_THRESHOLD + 1; i++) {
      await handleFeedback(vote(id, 5, `198.51.100.${80 + i}`), testEnv);
    }
    expect(sent).toHaveLength(0);
  });

  it('respects the monthly budget cap', async () => {
    const id = await seedReport('cp352 budget widget');
    sent.length = 0;
    const broke = { ...testEnv, MONTHLY_BUDGET_USD: '0' };
    for (let i = 0; i < DISAGREE_THRESHOLD; i++) {
      await handleFeedback(vote(id, 1, `198.51.100.${90 + i}`), broke);
    }
    expect(sent).toHaveLength(0);
  });

  it('does not start a run when a newer run for the same question exists', async () => {
    const oldId = await seedReport('cp352 superseded widget');
    await env.DB.prepare('UPDATE research SET created_at = created_at - 3600 WHERE id = ?').bind(oldId).run();
    await seedReport('cp352 superseded widget');
    sent.length = 0;
    for (let i = 0; i < DISAGREE_THRESHOLD; i++) {
      await handleFeedback(vote(oldId, 1, `198.51.100.${100 + i}`), testEnv);
    }
    expect(sent).toHaveLength(0);
  });
});
