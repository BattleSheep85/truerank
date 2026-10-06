// Integration coverage for the 2026-10 refocus kill switch (plan piece 1,
// spec D3): the SEO flywheel is off unless env.SEO_FLYWHEEL_ENABLED is set.
// With the flag absent, runFlywheelTick must return before it touches the
// keyword queue, the research table, or the KV daily counter, even when
// SERPER_API_KEY is set. The cron reaper must keep working.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import worker from '../../worker/index.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { seoFlywheelEnabled, runFlywheelTick } from '../../worker/lib/keywords.js';

const STALE_PROCESSING_AGE_S = 30 * 60; // older than the 20-minute reaper cutoff

beforeAll(async () => {
  await applySchema(env.DB);
});

// Same shape as scheduled-fallback.spec.js: waitUntil collects the promises
// so the test can await them before it checks post-conditions.
function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(p); },
    async flush() { await Promise.all(pending); },
  };
}

function dayKey(nowMs) {
  return `flywheel:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

async function countResearch() {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM research').first();
  return row.n;
}

describe('runFlywheelTick with the flag absent', () => {
  it('skips with reason disabled and changes nothing', async () => {
    const keyword = 'best flywheel-off widget ' + generateId();
    await env.DB.prepare(
      "INSERT INTO keyword_queue (keyword, priority, status, created_at) VALUES (?1, 50, 'pending', ?2)"
    ).bind(keyword, Math.floor(Date.now() / 1000)).run();
    const before = await countResearch();
    const now = Date.now();

    // Recording queue stub: a missing guard must not leak a real queue message
    // (the consumer would then run outside this test's isolated storage).
    const sent = [];
    const RESEARCH_QUEUE = { async send(msg) { sent.push(msg); } };

    const tick = await runFlywheelTick({ ...env, SERPER_API_KEY: 'test-key', RESEARCH_QUEUE }, now);

    expect(tick).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(sent).toEqual([]);
    const kw = await env.DB.prepare('SELECT status FROM keyword_queue WHERE keyword = ?').bind(keyword).first();
    expect(kw.status).toBe('pending');
    expect(await countResearch()).toBe(before);
    expect(await env.KV.get(dayKey(now))).toBeNull();
  });
});

describe('seoFlywheelEnabled', () => {
  it.each([['true'], [true], ['1']])('returns true for %j', (value) => {
    expect(seoFlywheelEnabled({ SEO_FLYWHEEL_ENABLED: value })).toBe(true);
  });

  it.each([[undefined], ['false'], [''], ['0'], ['TRUE']])('returns false for %j', (value) => {
    expect(seoFlywheelEnabled({ SEO_FLYWHEEL_ENABLED: value })).toBe(false);
  });

  it('returns false when the key is absent or env is undefined', () => {
    expect(seoFlywheelEnabled({})).toBe(false);
    expect(seoFlywheelEnabled(undefined)).toBe(false);
  });
});

describe('scheduled() with the flywheel off', () => {
  it('does not throw and still reaps a stale processing row', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: 's-' + id, query: 'reaper check ' + id, canonicalQuery: 'flywheel-off-reap-' + id });
    const staleTs = Math.floor(Date.now() / 1000) - STALE_PROCESSING_AGE_S;
    await env.DB.prepare(
      "UPDATE research SET status = 'processing', created_at = ?1, processing_started_at = ?1 WHERE id = ?2"
    ).bind(staleTs, id).run();

    const ctx = makeCtx();
    // A throw here (or from a waitUntil promise) fails the test.
    await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
    await ctx.flush();

    const row = await env.DB.prepare('SELECT status FROM research WHERE id = ?').bind(id).first();
    expect(row.status).toBe('failed');
  });
});
