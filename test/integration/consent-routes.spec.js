// Integration tests verifying consent gating and ad injection across major page routes,
// ensuring US visitors get the AdSense script, EU/EEA visitors without consent do not,
// and KV page caching preserves per-request consent neutrality.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { completeResearch, insertProductV2 } from './_helpers.js';
import { purgePageCache } from '../../worker/routes/pages.js';

const BASE = 'https://chrisputer.tech';
const ADSENSE_SCRIPT = 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
const CONSENT_BANNER = 'id="consent-banner"';

let researchSlug = 'best-budget-nas';
let verifySlug = 'verify-anker-earbuds';

beforeAll(async () => {
  await applySchema(env.DB);
  const id1 = generateId();
  await insertResearch(env.DB, {
    id: id1,
    slug: researchSlug,
    query: 'best budget nas',
    canonicalQuery: 'budget-nas',
  });
  await completeResearch(env.DB, {
    id: id1,
    status: 'complete',
    summary: 'Roundup.',
    category: 'NAS',
    result: JSON.stringify({ source_count: 4 }),
    sources: '[]',
  });
  for (let i = 1; i <= 3; i++) {
    await insertProductV2(env.DB, { researchId: id1, name: 'NAS ' + i, rank: i, rating: 4.4 });
  }

  const id2 = generateId();
  await insertResearch(env.DB, {
    id: id2,
    slug: 'best-home-nas',
    query: 'best home nas',
    canonicalQuery: 'home-nas',
  });
  await completeResearch(env.DB, {
    id: id2,
    status: 'complete',
    summary: 'Second NAS Roundup.',
    category: 'NAS',
    result: JSON.stringify({ source_count: 3 }),
    sources: '[]',
  });
  for (let i = 1; i <= 3; i++) {
    await insertProductV2(env.DB, { researchId: id2, name: 'Home NAS ' + i, rank: i, rating: 4.2 });
  }

  const id3 = generateId();
  await insertResearch(env.DB, {
    id: id3,
    slug: verifySlug,
    query: 'Anker Soundcore Liberty 4 NC',
    canonicalQuery: null,
  });
  await env.DB.prepare("UPDATE research SET kind = 'verification' WHERE id = ?").bind(id3).run();
  await completeResearch(env.DB, {
    id: id3,
    status: 'complete',
    summary: 'Verified claims.',
    category: 'Earbuds',
    result: JSON.stringify({ verified: true, overall: { score: 85, label: 'Verified' }, claims: [] }),
    sources: '[]',
  });
});

describe('Consent & AdSense gating on major page routes', () => {
  const routes = [
    { name: 'home page (static asset with recent reports)', path: '/' },
    { name: 'best index page (static asset with recent reports)', path: '/best' },
    { name: 'static guide page', path: '/best/mechanical-keyboards-under-100' },
    { name: 'server-rendered research page', path: `/research/${researchSlug}` },
    { name: 'browse page', path: '/research' },
    { name: 'reviews page', path: '/reviews' },
    { name: 'history page', path: '/history' },
    { name: 'verify entry page', path: '/verify' },
    { name: 'verify result page', path: `/verify/${verifySlug}` },
    { name: 'login page', path: '/login' },
    { name: 'frank easter-egg page', path: '/frank' },
    { name: 'generic static html asset', path: '/about.html' },
  ];

  for (const route of routes) {
    it(`US visitor receives AdSense script on ${route.name} (${route.path})`, async () => {
      const req = new Request(`${BASE}${route.path}`, {
        cf: { country: 'US' },
      });
      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(ADSENSE_SCRIPT);
      expect(body).not.toContain(CONSENT_BANNER);

      // Verify CSP header and injected AdSense script tag carry the exact same nonce
      const csp = res.headers.get('Content-Security-Policy') || '';
      const cspNonceMatch = csp.match(/'nonce-([^']+)'/);
      expect(cspNonceMatch).not.toBeNull();
      const cspNonce = cspNonceMatch[1];
      const scriptNonceMatch = body.match(/<script async nonce="([^"]+)" src="https:\/\/pagead2\.googlesyndication\.com/);
      expect(scriptNonceMatch).not.toBeNull();
      expect(scriptNonceMatch[1]).toBe(cspNonce);
    });

    it(`DE visitor without consent cookie gets consent banner and no AdSense script on ${route.name} (${route.path})`, async () => {
      const req = new Request(`${BASE}${route.path}`, {
        cf: { country: 'DE' },
      });
      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(ADSENSE_SCRIPT);
      expect(body).toContain(CONSENT_BANNER);

      // Verify CSP header and injected consent banner script tag carry the exact same nonce
      const csp = res.headers.get('Content-Security-Policy') || '';
      const cspNonceMatch = csp.match(/'nonce-([^']+)'/);
      expect(cspNonceMatch).not.toBeNull();
      const cspNonce = cspNonceMatch[1];
      const bannerNonceMatch = body.match(/<script nonce="([^"]+)">\s*document\.getElementById\('consent-accept'\)/);
      expect(bannerNonceMatch).not.toBeNull();
      expect(bannerNonceMatch[1]).toBe(cspNonce);
    });
  }

  it('DE visitor with ads_consent=1 receives AdSense script', async () => {
    const req = new Request(`${BASE}/research/${researchSlug}`, {
      headers: { Cookie: 'ads_consent=1' },
      cf: { country: 'DE' },
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(ADSENSE_SCRIPT);
    expect(body).not.toContain(CONSENT_BANNER);
  });

  it('DE visitor with ads_consent=0 gets neither AdSense script nor banner', async () => {
    const req = new Request(`${BASE}/research/${researchSlug}`, {
      headers: { Cookie: 'ads_consent=0' },
      cf: { country: 'DE' },
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(ADSENSE_SCRIPT);
    expect(body).not.toContain(CONSENT_BANNER);
  });

  it('KV page cache serves correct consent state for US hit following DE cache prime', async () => {
    await purgePageCache(env, researchSlug);

    // 1. DE visitor accesses first (primes cache with consent-neutral HTML)
    const reqDE = new Request(`${BASE}/research/${researchSlug}`, {
      cf: { country: 'DE' },
    });
    const resDE = await SELF.fetch(reqDE);
    expect(resDE.status).toBe(200);
    const bodyDE = await resDE.text();
    expect(bodyDE).not.toContain(ADSENSE_SCRIPT);
    expect(bodyDE).toContain(CONSENT_BANNER);

    // 2. US visitor hits the cached entry -> must receive AdSense script and no banner
    const reqUS = new Request(`${BASE}/research/${researchSlug}`, {
      cf: { country: 'US' },
    });
    const resUS = await SELF.fetch(reqUS);
    expect(resUS.status).toBe(200);
    const bodyUS = await resUS.text();
    expect(bodyUS).toContain(ADSENSE_SCRIPT);
    expect(bodyUS).not.toContain(CONSENT_BANNER);

    // 3. DE visitor with ads_consent=1 hits cached entry -> receives AdSense script
    const reqDEAccepted = new Request(`${BASE}/research/${researchSlug}`, {
      headers: { Cookie: 'ads_consent=1' },
      cf: { country: 'DE' },
    });
    const resDEAccepted = await SELF.fetch(reqDEAccepted);
    expect(resDEAccepted.status).toBe(200);
    const bodyDEAccepted = await resDEAccepted.text();
    expect(bodyDEAccepted).toContain(ADSENSE_SCRIPT);
    expect(bodyDEAccepted).not.toContain(CONSENT_BANNER);

    // 4. DE visitor with ads_consent=0 hits cached entry -> no AdSense script and no banner
    const reqDEDeclined = new Request(`${BASE}/research/${researchSlug}`, {
      headers: { Cookie: 'ads_consent=0' },
      cf: { country: 'DE' },
    });
    const resDEDeclined = await SELF.fetch(reqDEDeclined);
    expect(resDEDeclined.status).toBe(200);
    const bodyDEDeclined = await resDEDeclined.text();
    expect(bodyDEDeclined).not.toContain(ADSENSE_SCRIPT);
    expect(bodyDEDeclined).not.toContain(CONSENT_BANNER);
  });
});

describe('Revenue regression pinning: static home, static guide, and server-rendered pages', () => {
  const pinnedSurfaces = [
    { surface: 'home page (static asset)', path: '/' },
    { surface: 'static guide page under /best/', path: '/best/mechanical-keyboards-under-100' },
    { surface: 'server-rendered page', path: `/research/${researchSlug}` },
  ];

  for (const { surface, path } of pinnedSurfaces) {
    it(`US visitor receives AdSense loader on ${surface} (${path})`, async () => {
      const res = await SELF.fetch(new Request(`${BASE}${path}`, { cf: { country: 'US' } }));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(ADSENSE_SCRIPT);
      expect(body).not.toContain(CONSENT_BANNER);
    });

    it(`DE visitor without consent receives consent banner and NOT loader on ${surface} (${path})`, async () => {
      const res = await SELF.fetch(new Request(`${BASE}${path}`, { cf: { country: 'DE' } }));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(CONSENT_BANNER);
      expect(body).not.toContain(ADSENSE_SCRIPT);
    });
  }
});
