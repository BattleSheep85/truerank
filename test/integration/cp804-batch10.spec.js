// CP-804 (batch 10): retired rows stay hidden on every route, retiring a row
// counts as a change for the 304 signal, the /verify form works without
// JavaScript, the homepage verdicts skip test names, and the productUrl error
// says https.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { insertProductV2 } from './_helpers.js';
import { generateId, getResearchById } from '../../worker/lib/db.js';
import { getUserSearches } from '../../worker/lib/auth.js';
import { getLatestResearchLastmod } from '../../worker/lib/sitemap.js';
import { handleStartVerify, handleVerifyForm } from '../../worker/handlers/verify.js';
import { recentVerdictsSection } from '../../worker/pages/home.js';
import { renderVerifyEntryPage } from '../../worker/pages/verify-page.js';

const BASE = 'https://chrisputer.tech';
const NOW = Math.floor(Date.now() / 1000);

let sent = [];
const testEnv = { ...env, RESEARCH_QUEUE: { send: async (msg) => { sent.push(msg); } } };

async function seedResearch({ slug, query, kind = 'ranking', status = 'complete', retiredAt = null, completedAt = NOW - 3600, result = null }) {
  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO research (id, slug, query, status, kind, result, summary, category, created_at, completed_at, retired_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'A summary.', 'Widgets', ?7, ?8, ?9)`,
  ).bind(id, slug, query, status, kind, result, completedAt - 60, completedAt, retiredAt).run();
  return id;
}

const jsonPost = (body, ip) => new Request(`${BASE}/api/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify(body),
});

const formPost = (fields, { ip = '198.51.100.10', origin = BASE } = {}) => {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return new Request(`${BASE}/verify`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
};

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('item 1: resubmit of a retired verification row', () => {
  it('answers like a missing row and neither queues a run nor revives the row', async () => {
    for (const status of ['failed', 'needs_input']) {
      sent = [];
      const id = await seedResearch({ slug: `cp804-retired-resubmit-${status.replace('_', '-')}`, query: 'Retired Resubmit Widget', kind: 'verification', status, retiredAt: NOW - 10 });
      const res = await handleStartVerify(jsonPost({ product: 'Retired Resubmit Widget', reportId: id, productUrl: 'https://maker.example/widget' }, `198.51.100.${status === 'failed' ? 1 : 2}`), testEnv);
      const missing = await handleStartVerify(jsonPost({ product: 'Retired Resubmit Widget', reportId: 'no-such-row', productUrl: 'https://maker.example/widget' }, '198.51.100.3'), testEnv);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(await missing.text());
      expect(sent).toEqual([]);
      const row = await getResearchById(env.DB, id);
      expect(row.status).toBe(status);
      expect(row.retired_at).not.toBeNull();
    }
  });

  it('still resubmits a live failed row', async () => {
    sent = [];
    const id = await seedResearch({ slug: 'cp804-live-resubmit', query: 'Live Resubmit Widget', kind: 'verification', status: 'failed' });
    const res = await handleStartVerify(jsonPost({ product: 'Live Resubmit Widget', reportId: id, productUrl: 'https://maker.example/live' }, '198.51.100.4'), testEnv);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('item 2: retired reports on the side routes', () => {
  const RETIRED_SLUG = 'cp804-best-retired-gadget';
  const RETIRED_QUERY = 'best retired gadget secret title';
  let retiredId;

  beforeAll(async () => {
    retiredId = await seedResearch({ slug: RETIRED_SLUG, query: RETIRED_QUERY, retiredAt: NOW - 100, result: '{}' });
    for (let p = 1; p <= 3; p++) await insertProductV2(env.DB, { researchId: retiredId, name: `retired gadget ${p}`, rank: p, rating: 4 });
  });

  it('og.svg serves the generic card, not the report title', async () => {
    const res = await SELF.fetch(`${BASE}/research/${RETIRED_SLUG}/og.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).not.toContain('retired gadget secret title');
    expect(svg).toContain('AI-Powered Product Research');
  });

  it('/api/report answers 404 by id and by slug', async () => {
    for (const key of [retiredId, RETIRED_SLUG]) {
      const res = await SELF.fetch(`${BASE}/api/report/${key}`);
      expect(res.status).toBe(404);
    }
  });

  it('/api/research status and events answer 404', async () => {
    for (const path of [`/api/research/${retiredId}`, `/api/research/${RETIRED_SLUG}`, `/api/research/${RETIRED_SLUG}/events`]) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
    }
  });

  it('/api/research stream sends not found', async () => {
    const res = await SELF.fetch(`${BASE}/api/research/${retiredId}/stream`);
    const text = await res.text();
    expect(text).toContain('Report not found');
    expect(text).not.toContain('retired gadget');
  });

  it('/api/chat answers 404 for a retired report', async () => {
    const res = await SELF.fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.20' },
      body: JSON.stringify({ slug: RETIRED_SLUG, messages: [{ role: 'user', content: 'Which one is best?' }] }),
    });
    expect(res.status).toBe(404);
  });

  it('getUserSearches keeps the search but drops the link to a retired report', async () => {
    const userId = generateId();
    await env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, `${userId}@example.com`, 'pbkdf2$1$x$y', NOW).run();
    const liveId = await seedResearch({ slug: 'cp804-best-live-gadget', query: 'best live gadget' });
    for (const [rid, q, t] of [[retiredId, RETIRED_QUERY, NOW - 20], [liveId, 'best live gadget', NOW - 10]]) {
      await env.DB.prepare('INSERT INTO user_searches (user_id, research_id, query, created_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(userId, rid, q, t).run();
    }
    const rows = await getUserSearches(env.DB, userId, 50);
    expect(rows.map((r) => r.slug)).toEqual(['cp804-best-live-gadget', null]);
    expect(rows[1].query).toBe(RETIRED_QUERY);
  });
});

describe('item 3: retiring a row changes the lastmod signal', () => {
  it('returns the newest retired_at when it is later than the newest completion', async () => {
    const before = await getLatestResearchLastmod(env, 'cp804-a');
    const retiredAt = (before || NOW) + 500;
    await seedResearch({ slug: 'cp804-lastmod-retired', query: 'best lastmod retired thing', retiredAt });
    expect(await getLatestResearchLastmod(env, 'cp804-b')).toBe(retiredAt);
  });
});

describe('item 4: the /verify form works without JavaScript', () => {
  it('the entry form posts to /verify', () => {
    const html = renderVerifyEntryPage('');
    expect(html).toMatch(/<form id="verify-form"[^>]*action="\/verify"[^>]*method="post"/);
  });

  it('a form post starts a check and redirects to its page', async () => {
    sent = [];
    const out = await handleVerifyForm(formPost({ product: 'Anker Soundcore Form Post' }), testEnv);
    expect(out.slug).toBeTruthy();
    expect(sent).toHaveLength(1);
    const row = await env.DB.prepare('SELECT status, kind FROM research WHERE slug = ?1').bind(out.slug).first();
    expect(row).toEqual({ status: 'pending', kind: 'verification' });
  });

  it('a bad product gives the error message and keeps the typed text', async () => {
    const out = await handleVerifyForm(formPost({ product: 'ab' }, { ip: '198.51.100.11' }), testEnv);
    expect(out.status).toBe(400);
    expect(out.error).toMatch(/at least 3 characters/);
    expect(out.product).toBe('ab');
  });

  it('a cross-site form post is refused before any work', async () => {
    sent = [];
    const out = await handleVerifyForm(formPost({ product: 'Cross Site Widget' }, { origin: 'https://evil.example' }), testEnv);
    expect(out.status).toBe(403);
    expect(sent).toEqual([]);
  });

  it('POST /verify answers 303 to the report page, or the form with the error', async () => {
    const bad = await SELF.fetch(formPost({ product: 'ab' }, { ip: '198.51.100.12' }), { redirect: 'manual' });
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toContain('at least 3 characters');
    expect(html).toContain('value="ab"');

    const cross = await SELF.fetch(formPost({ product: 'Cross Site Widget' }, { origin: 'https://evil.example' }), { redirect: 'manual' });
    expect(cross.status).toBe(403);
  });

  it('the processing page refreshes itself when JavaScript is off', async () => {
    await seedResearch({ slug: 'cp804-processing-verify', query: 'Processing Widget', kind: 'verification', status: 'pending', completedAt: NOW });
    const res = await SELF.fetch(`${BASE}/verify/cp804-processing-verify`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<noscript><meta http-equiv="refresh" content="\d+"><\/noscript>/);
  });
});

describe('item 4: a failed check does not reload forever', () => {
  it('shows the failure and has no refresh', async () => {
    await seedResearch({ slug: 'cp804-failed-verify', query: 'Failed Widget', kind: 'verification', status: 'failed', completedAt: NOW });
    const res = await SELF.fetch(`${BASE}/verify/cp804-failed-verify`, { headers: { Accept: 'text/html' } });
    const html = await res.text();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain('Verification failed');
  });
});

describe('item 5: homepage verdicts use the public name filter', () => {
  it('skips test and verify runs', async () => {
    const claims = ['verified', 'verified', 'contradicted', 'unsubstantiated'].map((status) => ({ text: `claim ${status}`, status, claimType: 'spec' }));
    const result = JSON.stringify({ claims });
    await env.DB.prepare("DELETE FROM research WHERE kind = 'verification'").run();
    for (const [slug, query] of [
      ['cp804-v-test', 'test widget diagnostics'], ['cp804-v-verify', 'verify gadget probe'],
      ['cp804-v-a', 'Sony WH-1000XM5'], ['cp804-v-b', 'Anker Liberty 4'], ['cp804-v-c', 'Antec C8 case'],
    ]) {
      await seedResearch({ slug, query, kind: 'verification', result, completedAt: NOW - 60 });
    }
    const html = await recentVerdictsSection(env);
    expect(html).toContain('/verify/cp804-v-a');
    expect(html).not.toContain('/verify/cp804-v-test');
    expect(html).not.toContain('/verify/cp804-v-verify');
  });
});

describe('item 7: the productUrl error says https', () => {
  it('rejects an http link with an https-only message', async () => {
    const res = await handleStartVerify(jsonPost({ product: 'Http Link Widget', productUrl: 'http://maker.example/widget' }, '198.51.100.30'), testEnv);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).not.toContain('http(s)');
    expect(error).toContain('https');
  });
});
