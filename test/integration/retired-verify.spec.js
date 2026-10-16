// A retired verification report (kind = 'verification', retired_at set)
// answers 410 Gone on /verify/:slug with a noindex page that links to a fresh
// check. A lookup error serves the report as before (fail-open).
import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId } from '../../worker/lib/db.js';
import { getRetiredVerification } from '../../worker/lib/retired.js';

const BASE = 'https://chrisputer.tech';
const RETIRED_SLUG = 'retired-verify-antec-c8';
const XSS_SLUG = 'retired-verify-xss-product';
const LIVE_SLUG = 'retired-verify-live-product';
const RETIRED_QUERY = 'Antec C8 Dual Chamber & Full Tower';
const XSS_QUERY = 'Widget <script>alert(1)</script>';

const nowSec = () => Math.floor(Date.now() / 1000);
const CLAIMS = [
  { text: 'claim verified', status: 'verified', claimType: 'spec' },
  { text: 'claim contradicted', status: 'contradicted', claimType: 'spec' },
];

async function seedVerification({ slug, query, retired }) {
  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO research (id, slug, query, status, kind, result, created_at, completed_at, retired_at)
     VALUES (?1, ?2, ?3, 'complete', 'verification', ?4, ?5, ?6, ?7)`
  ).bind(id, slug, query, JSON.stringify({ claims: CLAIMS }), nowSec() - 4000, nowSec() - 3600,
    retired ? nowSec() : null).run();
  return id;
}

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM research WHERE slug IN (?1, ?2, ?3)').bind(RETIRED_SLUG, XSS_SLUG, LIVE_SLUG).run();
  await seedVerification({ slug: RETIRED_SLUG, query: RETIRED_QUERY, retired: true });
  await seedVerification({ slug: XSS_SLUG, query: XSS_QUERY, retired: true });
  await seedVerification({ slug: LIVE_SLUG, query: 'Live Checked Product', retired: false });
});

describe('GET /verify/:slug for a retired verification', () => {
  it('answers 410 with a noindex HTML page that links to a fresh check', async () => {
    const res = await SELF.fetch(`${BASE}/verify/${RETIRED_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(410);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('This claim check is out of date.');
    expect(body).toContain('older version of the checker');
    expect(body).toContain(`href="/verify?product=${encodeURIComponent(RETIRED_QUERY)}"`);
    expect(body).toContain('Check this product again');
    expect(body).toContain('href="/"');
    expect(body).not.toContain('googlesyndication');
    expect(body).not.toContain('0 of 2 claims');
  });

  it('answers 410 text/plain "Gone" without an Accept header', async () => {
    const res = await SELF.fetch(`${BASE}/verify/${RETIRED_SLUG}`);
    expect(res.status).toBe(410);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(await res.text()).toBe('Gone');
  });

  it('escapes a query that holds markup', async () => {
    const res = await SELF.fetch(`${BASE}/verify/${XSS_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).not.toContain('<script>');
    expect(body).toContain(`href="/verify?product=${encodeURIComponent(XSS_QUERY)}"`);
  });
});

describe('GET /verify/:slug for other rows', () => {
  it('serves a live verification (retired_at NULL) with 200', async () => {
    const res = await SELF.fetch(`${BASE}/verify/${LIVE_SLUG}`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
  });

  it('keeps 404 for an unknown slug', async () => {
    const res = await SELF.fetch(`${BASE}/verify/no-such-retired-verify-slug`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
  });
});

describe('getRetiredVerification', () => {
  it('returns the query for a retired row and null for a live or missing row', async () => {
    expect(await getRetiredVerification(env.DB, RETIRED_SLUG)).toEqual({ query: RETIRED_QUERY });
    expect(await getRetiredVerification(env.DB, LIVE_SLUG)).toBeNull();
    expect(await getRetiredVerification(env.DB, 'no-such-retired-verify-slug')).toBeNull();
  });

  it('fails open: a db whose prepare throws gives null', async () => {
    const throwingDb = { prepare() { throw new Error('D1 unavailable'); } };
    expect(await getRetiredVerification(throwingDb, RETIRED_SLUG)).toBeNull();
  });
});
