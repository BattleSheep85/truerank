// Refocus 2026-10, plan piece 3 (spec D2, R3): a retired report URL answers
// 410 Gone with a noindex page that carries no ads. The guard runs before the
// KV page cache, and a lookup error serves the report as before (fail-open).
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { completeResearch, insertProductV2 } from './_helpers.js';
import { CACHE_VERSION } from '../../worker/lib/flags.js';
import { isRetiredResearchSlug, retiredReportResponse } from '../../worker/lib/retired.js';

const BASE = 'https://chrisputer.tech';
const RETIRED_SLUG = 'best-retired-widget-flywheel';
const CACHED_RETIRED_SLUG = 'best-cached-retired-widget';
const LIVE_SLUG = 'best-live-widget-report';

async function seedReport(db, { slug, query, canonicalQuery, retired }) {
  const id = generateId();
  await insertResearch(db, { id, slug, query, canonicalQuery });
  await completeResearch(db, {
    id, status: 'complete', summary: 'Roundup.', category: 'Widgets',
    result: JSON.stringify({ source_count: 4 }), sources: '[]',
  });
  for (let i = 1; i <= 3; i++) {
    await insertProductV2(db, { researchId: id, name: `${slug} product ${i}`, rank: i, rating: 4.4 });
  }
  if (retired) {
    await db.prepare(
      "UPDATE research SET retired_at = strftime('%s','now'), retired_reason = 'seo-flywheel' WHERE id = ?1",
    ).bind(id).run();
  }
  return id;
}

beforeAll(async () => {
  await applySchema(env.DB);
  await seedReport(env.DB, { slug: RETIRED_SLUG, query: 'best retired widget flywheel', canonicalQuery: 'retired widget', retired: true });
  await seedReport(env.DB, { slug: CACHED_RETIRED_SLUG, query: 'best cached retired widget', canonicalQuery: 'cached retired widget', retired: true });
  await seedReport(env.DB, { slug: LIVE_SLUG, query: 'best live widget report', canonicalQuery: 'live widget', retired: false });
});

describe('GET /research/:slug for a retired report', () => {
  it('answers 410 with a noindex HTML page, no ads, and security headers', async () => {
    const res = await SELF.fetch(`${BASE}/research/${RETIRED_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(410);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('href="/"');
    expect(body).toContain('href="/best/"');
    expect(body).toContain('noindex');
    expect(body).not.toContain('googlesyndication');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
  });

  it('answers 410 to HEAD', async () => {
    const res = await SELF.fetch(`${BASE}/research/${RETIRED_SLUG}`, { method: 'HEAD' });
    expect(res.status).toBe(410);
  });

  it('answers 410 text/plain "Gone" without an Accept header', async () => {
    const res = await SELF.fetch(`${BASE}/research/${RETIRED_SLUG}`);
    expect(res.status).toBe(410);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toContain('Gone');
  });

  it('still answers 410 when a KV page-cache copy exists', async () => {
    await env.KV.put(`page:${CACHE_VERSION}:${CACHED_RETIRED_SLUG}`, '<html><body>cached retired report</body></html>');
    const res = await SELF.fetch(`${BASE}/research/${CACHED_RETIRED_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain('cached retired report');
  });
});

describe('GET /research/:slug for other rows', () => {
  it('serves a live report (retired_at NULL) with 200', async () => {
    const res = await SELF.fetch(`${BASE}/research/${LIVE_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
  });

  it('keeps 404 for an unknown slug', async () => {
    const res = await SELF.fetch(`${BASE}/research/no-such-retired-slug-here`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
  });
});

describe('isRetiredResearchSlug', () => {
  it('is true for a retired row and false for a live or missing row', async () => {
    expect(await isRetiredResearchSlug(env.DB, RETIRED_SLUG)).toBe(true);
    expect(await isRetiredResearchSlug(env.DB, LIVE_SLUG)).toBe(false);
    expect(await isRetiredResearchSlug(env.DB, 'no-such-retired-slug-here')).toBe(false);
  });

  it('fails open: a db whose prepare throws gives false', async () => {
    const throwingDb = { prepare() { throw new Error('D1 unavailable'); } };
    expect(await isRetiredResearchSlug(throwingDb, RETIRED_SLUG)).toBe(false);
  });
});

describe('retiredReportResponse', () => {
  it('builds a 410 HTML page for an HTML request', async () => {
    const res = retiredReportResponse(new Request(`${BASE}/research/${RETIRED_SLUG}`, { headers: { Accept: 'text/html' } }));
    expect(res.status).toBe(410);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('This report is gone.');
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).not.toContain('googlesyndication');
  });

  it('builds a 410 text/plain "Gone" for a non-HTML request', async () => {
    const res = retiredReportResponse(new Request(`${BASE}/research/${RETIRED_SLUG}`));
    expect(res.status).toBe(410);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe('Gone');
  });
});
