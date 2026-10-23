// CP-808 (batch 12): the no-JavaScript /verify form refuses a post with no
// Origin and no Sec-Fetch-Site, and test runs with the marker at the END of
// the query stay out of every public list.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId } from '../../worker/lib/db.js';
import { publicNameFilter } from '../../worker/lib/utils.js';
import { handleVerifyForm } from '../../worker/handlers/verify.js';

const BASE = 'https://chrisputer.tech';
const NOW = Math.floor(Date.now() / 1000);

let sent = [];
const testEnv = { ...env, RESEARCH_QUEUE: { send: async (msg) => { sent.push(msg); } } };

const formPost = (fields, { ip = '198.51.100.80', headers = {} } = {}) => new Request(`${BASE}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': ip, ...headers },
  body: new URLSearchParams(fields).toString(),
});

beforeAll(async () => {
  await applySchema(env.DB);
});

describe('item 2: no-JavaScript POST /verify needs a same-site signal', () => {
  it('refuses a post with neither Origin nor Sec-Fetch-Site, before any work', async () => {
    sent = [];
    const out = await handleVerifyForm(formPost({ product: 'Headerless Widget' }), testEnv);
    expect(out.status).toBe(403);
    expect(sent).toEqual([]);
    const res = await SELF.fetch(formPost({ product: 'Headerless Widget' }, { ip: '198.51.100.81' }), { redirect: 'manual' });
    expect(res.status).toBe(403);
  });

  it('still accepts the normal form: same Origin', async () => {
    sent = [];
    const out = await handleVerifyForm(formPost({ product: 'Anker Soundcore Origin Only' }, { ip: '198.51.100.82', headers: { Origin: BASE } }), testEnv);
    expect(out.slug).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it('still accepts the normal form: Sec-Fetch-Site same-origin without Origin', async () => {
    sent = [];
    const out = await handleVerifyForm(formPost({ product: 'Anker Soundcore Fetch Site' }, { ip: '198.51.100.83', headers: { 'Sec-Fetch-Site': 'same-origin' } }), testEnv);
    expect(out.slug).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it('still refuses cross-site and Origin null', async () => {
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site', Origin: BASE }, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
      const out = await handleVerifyForm(formPost({ product: 'Cross Widget' }, { ip: '198.51.100.84', headers }), testEnv);
      expect(out.status).toBe(403);
    }
  });
});

describe('item 3: a test marker at the end of the query is not public', () => {
  const visible = async (query) => {
    const id = generateId();
    await env.DB.prepare(
      `INSERT INTO research (id, slug, query, status, kind, summary, created_at, completed_at)
       VALUES (?1, ?2, ?3, 'complete', 'ranking', 'S', ?4, ?4)`,
    ).bind(id, `cp808-${id}`, query, NOW).run();
    const row = await env.DB.prepare(`SELECT id FROM research r WHERE r.id = ?1 AND ${publicNameFilter('r')}`).bind(id).first();
    return Boolean(row);
  };

  it('hides the two known shapes and other script markers', async () => {
    expect(await visible('best robot vacuum for pet hair diagnostic 20260621')).toBe(false);
    expect(await visible('best mechanical keyboards 2026 unique test 4829')).toBe(false);
    expect(await visible('Best Air Fryer Test 99231')).toBe(false);
    expect(await visible('best blender debug 123456')).toBe(false);
    expect(await visible('best blender smoke 20261019 ')).toBe(false);
  });

  it('keeps real products and searches that only look similar', async () => {
    expect(await visible('best covid test 2026')).toBe(true);
    expect(await visible('best fentanyl test strips')).toBe(true);
    expect(await visible('best car diagnostic tool')).toBe(true);
    expect(await visible('best obd2 diagnostic scanner 2025')).toBe(true);
    expect(await visible('Testo 405i')).toBe(true);
    expect(await visible('best home water test kit')).toBe(true);
    expect(await visible('best gpu for stress test 4090')).toBe(true);
  });
});

describe('item 6: GET /api/report leaves out source snippets unless asked', () => {
  const seed = async () => {
    const id = generateId();
    const slug = `cp808-report-${id}`;
    const sources = JSON.stringify([
      { url: 'https://rtings.com/a', title: 'A', snippet: 'The Acme X1 lasted 10 hours in our test.' },
      { url: 'https://example.com/b', title: 'B' },
    ]);
    await env.DB.prepare(
      `INSERT INTO research (id, slug, query, status, kind, summary, result, sources, created_at, completed_at)
       VALUES (?1, ?2, 'best acme thing', 'complete', 'ranking', 'S', ?3, ?4, ?5, ?5)`,
    ).bind(id, slug, JSON.stringify({ products: [] }), sources, NOW).run();
    return slug;
  };

  it('the default answer has the sources without snippets', async () => {
    const slug = await seed();
    const res = await SELF.fetch(`${BASE}/api/report/${slug}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources.map((s) => s.url)).toEqual(['https://rtings.com/a', 'https://example.com/b']);
    expect(body.sources[0].title).toBe('A');
    expect(body.sources.some((s) => 'snippet' in s)).toBe(false);
  });

  it('?snippets=1 keeps them (the eval groundedness check reads them)', async () => {
    const slug = await seed();
    const body = await (await SELF.fetch(`${BASE}/api/report/${slug}?snippets=1`)).json();
    expect(body.sources[0].snippet).toBe('The Acme X1 lasted 10 hours in our test.');
  });
});
