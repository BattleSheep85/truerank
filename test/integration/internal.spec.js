// Integration coverage for worker/handlers/internal.js — the off-CF worker API:
// X-Worker-Secret auth, atomic job claim, progress feed, and failure handling.
// (The full success-persist path triggers Serper/IndexNow fetches and is covered
// separately under a fetch-mocked round.)
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleNextJob, handleProgress, handleComplete } from '../../worker/handlers/internal.js';
import { claimNextPendingJob } from '../../worker/pipeline/orchestrator.js';
import { generateId, insertResearch, updateResearchStatus } from '../../worker/lib/db.js';

const SECRET = 'test-worker-secret-123';
const authedReq = (body) => new Request('https://x/api/internal/x', {
  method: 'POST', headers: { 'X-Worker-Secret': SECRET, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const noAuthReq = (body) => new Request('https://x/api/internal/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => {
  await applySchema(env.DB);
  env.WORKER_SECRET = SECRET; // per-test isolated env; safe to set
});

// The Workers plugin does not reset D1 or KV between tests in one file. Clear
// the research queue and KV (progress feeds) so each handleNextJob test sees
// only the rows it inserts, as it did under the old isolatedStorage.
// Delete every KV key, page by page.
async function clearKv(kv) {
  let cursor;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM research').run();
  await clearKv(env.KV);
});

describe('auth gating', () => {
  it('next-job rejects without secret', async () => {
    expect((await handleNextJob(noAuthReq(), env)).status).toBe(401);
  });
  it('progress rejects without secret', async () => {
    expect((await handleProgress(noAuthReq({ reportId: 'x', message: 'm' }), env)).status).toBe(401);
  });
  it('complete rejects without secret', async () => {
    expect((await handleComplete(noAuthReq({ reportId: 'x', query: 'q' }), env)).status).toBe(401);
  });
});

describe('handleNextJob', () => {
  it('returns null job when queue empty', async () => {
    const res = await handleNextJob(authedReq(), env);
    expect(res.status).toBe(200);
    expect((await res.json()).job).toBeNull();
  });

  it('atomically claims the oldest pending row (with facets pre-set, no classifier call)', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'best nas', canonicalQuery: 'nasclaim' });
    // pre-set facets so ensureClassified skips the (network) classifier call
    await env.DB.prepare("UPDATE research SET facets = ?, topical_category = 'NAS' WHERE id = ?")
      .bind(JSON.stringify({ is_buyable: true, sold_on_amazon: true }), id).run();
    // next-job only serves jobs when the off-CF worker is ENABLED.
    const extEnv = { ...env, EXTERNAL_WORKER_ENABLED: 'true' };
    const job = (await (await handleNextJob(authedReq(), extEnv)).json()).job;
    expect(job.reportId).toBe(id);
    expect(job.query).toBe('best nas');
    // row is now 'processing' (claimed)
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first()).status).toBe('processing');
  });

  it('refuses to hand out jobs when the off-CF worker is disabled', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'best ssd', canonicalQuery: 'ssdclaim' });
    const disabledEnv = { ...env, EXTERNAL_WORKER_ENABLED: 'false' };
    expect((await (await handleNextJob(authedReq(), disabledEnv)).json()).job).toBeNull();
    // the pending row is untouched (left for the CF-side consumer to process)
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first()).status).toBe('pending');
  });

  it('skips a pending verification row and leaves it untouched (job-routing: verification rows must only be processed by the queue consumer)', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'is the anker soundcore legit', canonicalQuery: 'verifyclaim' });
    await env.DB.prepare("UPDATE research SET kind = 'verification' WHERE id = ?").bind(id).run();
    const extEnv = { ...env, EXTERNAL_WORKER_ENABLED: 'true' };
    const job = (await (await handleNextJob(authedReq(), extEnv)).json()).job;
    expect(job).toBeNull();
    // the verification row was NOT claimed — still pending for the queue consumer
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first()).status).toBe('pending');
  });

  it('claims a pending ranking row while an older pending verification row is skipped', async () => {
    const verifyId = generateId();
    await insertResearch(env.DB, { id: verifyId, slug: 's-' + verifyId, query: 'verify me', canonicalQuery: 'verifyclaim2' });
    await env.DB.prepare("UPDATE research SET kind = 'verification', created_at = created_at - 100 WHERE id = ?").bind(verifyId).run();

    const rankingId = generateId();
    await insertResearch(env.DB, { id: rankingId, slug: 's-' + rankingId, query: 'best mouse', canonicalQuery: 'rankingclaim' });
    await env.DB.prepare("UPDATE research SET facets = ?, topical_category = 'Mice' WHERE id = ?")
      .bind(JSON.stringify({ is_buyable: true, sold_on_amazon: true }), rankingId).run();

    const job = await claimNextPendingJob(env);
    expect(job.reportId).toBe(rankingId);
    // ranking row claimed (processing); verification row left pending
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(rankingId).first()).status).toBe('processing');
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(verifyId).first()).status).toBe('pending');
  });

  it('claimNextPendingJob returns null when only a verification row is pending', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'verify only', canonicalQuery: 'verifyonlyclaim' });
    await env.DB.prepare("UPDATE research SET kind = 'verification' WHERE id = ?").bind(id).run();
    const job = await claimNextPendingJob(env);
    expect(job).toBeNull();
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first()).status).toBe('pending');
  });
});

describe('handleProgress', () => {
  it('appends a beat to the KV progress feed', async () => {
    const reportId = generateId();
    const res = await handleProgress(authedReq({ reportId, step: 1, message: 'Planning...' }), env);
    expect((await res.json()).ok).toBe(true);
    const log = await env.KV.get(`progress_log:${reportId}`, 'json');
    expect(log[0].message).toBe('Planning...');
    const latest = await env.KV.get(`progress:${reportId}`, 'json');
    expect(latest.message).toBe('Planning...');
  });
  it('400 on missing message', async () => {
    expect((await handleProgress(authedReq({ reportId: 'x' }), env)).status).toBe(400);
  });
});

describe('handleComplete failure paths', () => {
  it('body.error marks the processing row failed', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'q', canonicalQuery: 'qc' });
    await updateResearchStatus(env.DB, id, 'processing');
    const res = await handleComplete(authedReq({ reportId: id, query: 'q', error: 'engine blew up' }), env);
    expect((await res.json()).status).toBe('failed');
    expect((await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first()).status).toBe('failed');
  });
  it('400 when reportId/query missing', async () => {
    expect((await handleComplete(authedReq({ reportId: 'x' }), env)).status).toBe(400);
  });
  it('invalid result payload → failed', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'q', canonicalQuery: 'qc2' });
    await updateResearchStatus(env.DB, id, 'processing');
    // result is not a valid object → validateResearchResult throws → row failed
    const res = await handleComplete(authedReq({ reportId: id, query: 'q', result: 'not-an-object' }), env);
    expect((await res.json()).status).toBe('failed');
  });
});
