// Integration coverage for the user-facing handlers: subscribe (DB), image proxy
// (DB + fetch mocked), and the auth flow (signup/login/logout — DB + crypto).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect, vi, afterEach } from 'vitest';
import { applySchema } from './_schema.js';
import { handleSubscribe } from '../../worker/handlers/subscribe.js';
import { handleUnsubscribe } from '../../worker/handlers/unsubscribe.js';
import { handleProductImage } from '../../worker/handlers/image.js';
import { handleSignup, handleLogin, handleLogout } from '../../worker/handlers/auth.js';
import { createUser, findUserByEmail } from '../../worker/lib/auth.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';

// db.js has no shared products-insert helper (the pipeline writes products inline
// via raw SQL; the dead insertProductV2/completeResearch helpers were removed
// 2026-06-25). Tests do the same against the v2 schema (schema/003_research_v2.sql).
async function insertProductV2(db, { id, researchId, name, rank = null, imageUrl = null }) {
  await db.prepare(
    'INSERT INTO products (id, research_id, name, rank, image_url) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(id, researchId, name, rank, imageUrl).run();
}

beforeAll(() => applySchema(env.DB));
afterEach(() => vi.unstubAllGlobals());

// The Workers plugin does not reset D1 or KV between tests in one file. Clear
// what the subscribe and auth tests write (subscribers, users and their
// sessions, KV rate-limit timestamps), as the old isolatedStorage did.
// research and products stay: handleProductImage seeds them in a beforeAll.
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
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare('DELETE FROM user_searches').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('DELETE FROM users').run();
  await clearKv(env.KV);
});

const postJson = (body) => new Request('https://x/p', {
  method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
});

describe('handleSubscribe', () => {
  it('405 on non-POST', async () => {
    const get = new Request('https://x/p', { method: 'GET', headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    expect((await handleSubscribe(get, env)).status).toBe(405);
  });
  it('400 on invalid JSON', async () => {
    const r = new Request('https://x/p', { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' } });
    expect((await handleSubscribe(r, env)).status).toBe(400);
  });
  it('400 on invalid email', async () => {
    expect((await handleSubscribe(postJson({ email: 'not-an-email' }), env)).status).toBe(400);
  });
  it('200 + persists a valid subscription (idempotent)', async () => {
    const rid = generateId();
    expect((await (await handleSubscribe(postJson({ email: 'Fan@Example.com', researchId: rid }), env)).json()).ok).toBe(true);
    await handleSubscribe(postJson({ email: 'fan@example.com', researchId: rid }), env); // dup → INSERT OR IGNORE
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE email = 'fan@example.com'").first();
    expect(n.n).toBe(1);
  });
  it('a well-formed id is stored as given', async () => {
    const rid = generateId();
    const res = await handleSubscribe(postJson({ email: 'wellformed@example.com', researchId: rid }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const row = await env.DB.prepare("SELECT research_id FROM subscribers WHERE email = 'wellformed@example.com'").first();
    expect(row.research_id).toBe(rid);
  });
  it('a malformed researchId returns 400 with error details', async () => {
    const malformed = ['../../x', 'a'.repeat(200), 'abc'];
    for (const badId of malformed) {
      const res = await handleSubscribe(postJson({ email: 'badid@example.com', researchId: badId }), env);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        error: 'invalid_research_id',
        message: 'Invalid research ID.',
      });
    }
  });
  it('an absent researchId creates a general subscription with null research_id', async () => {
    const res = await handleSubscribe(postJson({ email: 'general@example.com' }), env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const row = await env.DB.prepare("SELECT research_id FROM subscribers WHERE email = 'general@example.com'").first();
    expect(row.research_id).toBe(null);
  });
  it('stores an unsub_token + created_at (consent timestamp) on new rows', async () => {
    await handleSubscribe(postJson({ email: 'consent@example.com' }), env);
    const row = await env.DB.prepare("SELECT unsub_token, created_at, unsubscribed_at, research_id FROM subscribers WHERE email='consent@example.com'").first();
    expect(row.unsub_token).toBeTruthy();
    expect(row.created_at).toBeGreaterThan(0);
    expect(row.unsubscribed_at).toBe(null);
    expect(row.research_id).toBe(null);
  });
});

describe('handleUnsubscribe', () => {
  it('a valid token unsubscribes every row for that email; bad/missing token 404/400', async () => {
    const ridA = generateId();
    const ridB = generateId();
    await handleSubscribe(postJson({ email: 'bye@example.com', researchId: ridA }), env);
    await handleSubscribe(postJson({ email: 'bye@example.com', researchId: ridB }), env);
    const row = await env.DB.prepare("SELECT unsub_token FROM subscribers WHERE email='bye@example.com' LIMIT 1").first();
    expect(row.unsub_token).toBeTruthy();

    const res = await handleUnsubscribe(new Request(`https://x/unsubscribe?token=${row.unsub_token}`, { method: 'GET' }), env);
    expect(res.status).toBe(200);
    const active = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE email='bye@example.com' AND unsubscribed_at IS NULL").first();
    expect(active.n).toBe(0);

    expect((await handleUnsubscribe(new Request('https://x/unsubscribe?token=nope', { method: 'GET' }), env)).status).toBe(404);
    expect((await handleUnsubscribe(new Request('https://x/unsubscribe', { method: 'GET' }), env)).status).toBe(400);
  });
});

describe('handleProductImage', () => {
  let pid;
  beforeAll(async () => {
    const rid = generateId();
    await insertResearch(env.DB, { id: rid, slug: 's-' + rid, query: 'q', canonicalQuery: 'imgq' });
    pid = generateId();
    await insertProductV2(env.DB, { id: pid, researchId: rid, name: 'P', rank: 1, imageUrl: 'https://cdn.example/photo.jpg' });
  });

  it('404 for unknown product', async () => {
    expect((await handleProductImage('nope', env)).status).toBe(404);
  });
  it('proxies a valid upstream image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('JPEGBYTES'.repeat(200), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1800' } })));
    const res = await handleProductImage(pid, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
  it('404 when upstream is not an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    expect((await handleProductImage(pid, env)).status).toBe(404);
  });
  it('404 when the upstream fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await handleProductImage(pid, env)).status).toBe(404);
  });
});

// NB: the beforeEach above clears users and sessions before every test, so
// each `it` must be self-contained (it can't see a user another `it` created).
describe('auth flow', () => {
  const email = 'user@truerank.test';
  const PW = 'hunter2pass';

  it('signup creates a user + session cookie', async () => {
    const res = await handleSignup(postJson({ email, password: PW }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(res.headers.get('Set-Cookie')).toContain('tr_sess=');
    expect(await findUserByEmail(env.DB, email)).toBeTruthy();
  });

  it('signup rejects a duplicate email with 409', async () => {
    await handleSignup(postJson({ email: 'dup@truerank.test', password: PW }), env);
    const res = await handleSignup(postJson({ email: 'dup@truerank.test', password: PW }), env);
    expect(res.status).toBe(409);
  });

  it('login succeeds with the right password, fails otherwise', async () => {
    await createUser(env.DB, email, PW); // signup disabled → create the user directly
    expect((await handleLogin(postJson({ email, password: PW }), env)).status).toBe(200);
    expect((await handleLogin(postJson({ email, password: 'wrongpass1' }), env)).status).toBe(401);
    expect((await handleLogin(postJson({ email: 'nobody@x.com', password: 'whatever1' }), env)).status).toBe(401);
  });

  it('logout returns ok + clears the cookie', async () => {
    const res = await handleLogout(postJson({}), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('=');
  });
});
