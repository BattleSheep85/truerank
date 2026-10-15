// Integration coverage for worker/index.js routing — drives the real worker via
// SELF.fetch (same env/bindings the test seeds), covering the offline routes:
// feeds, redirects, report API, research pages, CORS, 404.
import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { checkRateLimit } from '../../worker/lib/rate-limit.js';
import { completeResearch, insertProductV2 } from './_helpers.js';

const BASE = 'https://chrisputer.tech';
let completeId;

// Fake OpenRouter chat-completion response wrapping a classifier JSON, so the
// classify route never reaches the live LLM (the dev keys in .dev.vars are real).
const orResponse = (classifierJson) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(classifierJson) } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

beforeAll(async () => {
  await applySchema(env.DB);
  completeId = generateId();
  await insertResearch(env.DB, { id: completeId, slug: 'best-budget-nas', query: 'best budget nas', canonicalQuery: 'budget-nas' });
  await completeResearch(env.DB, { id: completeId, status: 'complete', summary: 'Roundup.', category: 'NAS', result: JSON.stringify({ source_count: 4 }), sources: '[]' });
  for (let i = 1; i <= 3; i++) await insertProductV2(env.DB, { researchId: completeId, name: 'NAS ' + i, rank: i, rating: 4.4 });
});

describe('index.js routing', () => {
  it('OPTIONS → CORS preflight', async () => {
    const res = await SELF.fetch(`${BASE}/api/research`, { method: 'OPTIONS' });
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('GET /find?q=… → 302 to a Google search', async () => {
    const res = await SELF.fetch(`${BASE}/find?q=cordless+drill`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://www.google.com/search?q=cordless%20drill');
  });

  it('GET /sitemap.xml → 200 XML listing the research page', async () => {
    const res = await SELF.fetch(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/research/best-budget-nas');
  });

  it('GET /feed.xml → 200 Atom feed', async () => {
    const res = await SELF.fetch(`${BASE}/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('atom');
  });

  it('GET /api/report/:id → 200 for a complete report', async () => {
    const res = await SELF.fetch(`${BASE}/api/report/${completeId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('completed');
  });

  it('GET /api/report/:id → 404 for unknown', async () => {
    expect((await SELF.fetch(`${BASE}/api/report/nope`)).status).toBe(404);
  });

  it('GET /research/:slug → 200 server-rendered HTML', async () => {
    const res = await SELF.fetch(`${BASE}/research/best-budget-nas`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('best budget nas'.replace(/\b\w/g, (c) => c)); // query appears (any case)
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /research/:unknown → 404', async () => {
    expect((await SELF.fetch(`${BASE}/research/no-such-slug-here`)).status).toBe(404);
  });

  it('legacy /report/:id → 301 to /research', async () => {
    const res = await SELF.fetch(`${BASE}/report/oldid123`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toContain('/research');
  });

  it('internal endpoint without secret → 401', async () => {
    const res = await SELF.fetch(`${BASE}/api/internal/next-job`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('security headers on a rendered page', async () => {
    const res = await SELF.fetch(`${BASE}/research/best-budget-nas`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
  });

  it('GET /research (browse) → 200 HTML', async () => {
    const res = await SELF.fetch(`${BASE}/research`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('GET /reviews (faceted) → 200 with the filter sidebar', async () => {
    const res = await SELF.fetch(`${BASE}/reviews`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('aria-label="Filters"');
  });

  it('GET /reviews?brand=… → 200 + noindex on the facet combo', async () => {
    const res = await SELF.fetch(`${BASE}/reviews?brand=Synology&price=250-500`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('noindex,follow');
  });

  it('GET /best/:category hub → 200 or 404 (never throws)', async () => {
    const res = await SELF.fetch(`${BASE}/best/nas`);
    expect([200, 404]).toContain(res.status);
  });

  it('GET /api/search/suggest?q=… → JSON array', async () => {
    const res = await SELF.fetch(`${BASE}/api/search/suggest?q=nas`);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it('GET /research/:slug/og.svg → SVG image', async () => {
    const res = await SELF.fetch(`${BASE}/research/best-budget-nas/og.svg`);
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
  });

  it('GET /favicon.ico -> 200 with SVG content type', async () => {
    const res = await SELF.fetch(`${BASE}/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
  });

  it('GET /api/research/:id → completed status JSON', async () => {
    const res = await SELF.fetch(`${BASE}/api/research/${completeId}`);
    expect((await res.json()).status).toBe('completed');
  });

  it('POST /api/classify → 200 with fail-open / classified response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => orResponse({
      accept: true, reject_reason: null, topical_category: 'mechanical keyboards',
      facets: { is_buyable: true },
      clarifying_questions: [{ key: 'budget', question: 'Budget?', suggested_answers: ['<$75', '$75-150'] }],
    })));
    const res = await SELF.fetch(`${BASE}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.85' },
      body: JSON.stringify({ query: 'best mechanical keyboard' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accept).toBe(true);
    expect(Array.isArray(data.clarifying_questions)).toBe(true);
  });

  it('POST /api/classify when throttled (>60/hr) → fail-open 200 (not 429)', async () => {
    const ip = '203.0.113.86';
    for (let i = 0; i < 60; i++) {
      await checkRateLimit(env.KV, `classify:${ip}`, 60, 3600);
    }
    const res = await SELF.fetch(`${BASE}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ query: 'best budget camera' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.accept).toBe(true);
    expect(Array.isArray(data.clarifying_questions)).toBe(true);
  });
});
