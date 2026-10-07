// Integration coverage for worker/handlers/verify.js — POST /api/verify (new
// submission + needs_input resubmit) and GET /api/verify/:id. Mirrors
// test/integration/research.spec.js's D1/KV conventions.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import * as verifyHandlers from '../../worker/handlers/verify.js';
import { generateId, getResearchById } from '../../worker/lib/db.js';
import { quotaKey } from '../../worker/lib/quota.js';
import { overallVerdict, INSUFFICIENT_EVIDENCE_LABEL } from '../../worker/lib/verdict.js';

// Namespace import: findSavedVerdict and VERIFY_REUSE_MAX_AGE_DAYS (piece 11)
// can be missing from the handler module until it lands.
const { handleStartVerify, handleVerifyStatus } = verifyHandlers;

beforeAll(async () => {
  await applySchema(env.DB);
});

// The real RESEARCH_QUEUE binding auto-delivers to the worker's queue()
// handler in the background during a test run — which races the isolated
// storage stack this spec file gets for its own D1 instance (that consumer
// invocation runs against a *different* Miniflare storage snapshot that
// never had applySchema applied, corrupting the test-runner's storage
// teardown). Stub .send() to a no-op so these intake tests exercise the row
// insert/update + status contract without a real queue delivery firing.
// verify-orchestrator.js's actual persist behavior is covered directly by
// test/integration/verify.spec.js.
const testEnv = { ...env, RESEARCH_QUEUE: { send: async () => {} } };

const post = (body, ip = '203.0.113.50') => new Request('https://chrisputer.tech/api/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
  body: JSON.stringify(body),
});

describe('handleStartVerify — new submission', () => {
  it('creates a pending verification research row and enqueues', async () => {
    const res = await handleStartVerify(post({ product: 'Anker Soundcore Liberty 4 NC' }), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.id).toBeTruthy();
    expect(data.slug).toBeTruthy();

    const row = await getResearchById(env.DB, data.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('pending');
    expect(row.kind).toBe('verification');
    expect(row.query).toBe('Anker Soundcore Liberty 4 NC');
    expect(row.subject_url).toBeNull();
  });

  it('stores subject_url when productUrl is supplied on the initial submission', async () => {
    const res = await handleStartVerify(post({
      product: 'Sony WH-1000XM5',
      productUrl: 'https://www.sony.com/wh-1000xm5',
    }, '203.0.113.51'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();

    const row = await getResearchById(env.DB, data.id);
    expect(row.subject_url).toBe('https://www.sony.com/wh-1000xm5');
  });

  it('rejects a too-short product', async () => {
    const res = await handleStartVerify(post({ product: 'ab' }, '203.0.113.52'), testEnv);
    expect(res.status).toBe(400);
  });

  it('rejects an invalid productUrl', async () => {
    const res = await handleStartVerify(post({
      product: 'Test Widget Pro',
      productUrl: 'not-a-url',
    }, '203.0.113.53'), testEnv);
    expect(res.status).toBe(400);
  });

  it('blocks a query that fails the content-safety screen', async () => {
    const res = await handleStartVerify(post({ product: 'best pornhub alternative site' }, '203.0.113.54'), testEnv);
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.rejected).toBe(true);
  });
});

describe('handleStartVerify — needs_input resubmit', () => {
  async function seedNeedsInputRow() {
    const submitRes = await handleStartVerify(post({ product: 'Mystery Gadget X1' }, '203.0.113.55'), testEnv);
    const { id, slug } = await submitRes.json();
    await env.DB.prepare("UPDATE research SET status = 'needs_input', preview = ? WHERE id = ?")
      .bind('Could not find the product page — please paste its URL.', id).run();
    return { id, slug };
  }

  it('transitions needs_input -> pending and re-enqueues with the supplied URL', async () => {
    const { id } = await seedNeedsInputRow();

    const res = await handleStartVerify(post({
      reportId: id,
      product: 'Mystery Gadget X1',
      productUrl: 'https://maker.example/gadget-x1',
    }, '203.0.113.56'), testEnv);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.id).toBe(id);

    const row = await getResearchById(env.DB, id);
    expect(row.status).toBe('pending');
    expect(row.subject_url).toBe('https://maker.example/gadget-x1');
  });

  it('rejects a resubmit for a row that is not needs_input/failed', async () => {
    const submitRes = await handleStartVerify(post({ product: 'Regular Pending Item' }, '203.0.113.57'), testEnv);
    const { id } = await submitRes.json(); // still 'pending', not needs_input

    const res = await handleStartVerify(post({
      reportId: id,
      product: 'Regular Pending Item',
      productUrl: 'https://maker.example/regular',
    }, '203.0.113.58'), testEnv);

    expect(res.status).toBe(409);
  });

  it('rejects a resubmit for a failed ranking row (kind is null)', async () => {
    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO research (id, slug, query, status, kind, created_at) VALUES (?, ?, ?, 'failed', NULL, ?)"
    ).bind(id, 'ranking-' + id, 'best headphones', Math.floor(Date.now() / 1000)).run();

    const res = await handleStartVerify(post({
      reportId: id,
      product: 'best headphones',
      productUrl: 'https://maker.example/headphones',
    }, '203.0.113.65'), testEnv);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Report is not awaiting a product URL');

    const row = await getResearchById(env.DB, id);
    expect(row.status).toBe('failed');
  });

  it('requires a productUrl when resubmitting with a reportId', async () => {
    const { id } = await seedNeedsInputRow();
    const res = await handleStartVerify(post({ reportId: id, product: 'Mystery Gadget X1' }, '203.0.113.59'), testEnv);
    expect(res.status).toBe(400);
  });
});

// Same layered guard as /api/research: the atomic RL_BURST binding caps
// concurrency in front of the non-atomic KV hourly window, so a parallel flood
// of paid verification runs cannot all read the same pre-write state and land.
describe('handleStartVerify: concurrent burst gate', () => {
  const BURST_CEILING = 15; // binding limit 10, plus slack for its permissive counting

  it('admits far fewer than 30 parallel submissions from one IP', async () => {
    const ip = '203.0.113.70';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => handleStartVerify(
        post({ product: `Junk Verify Widget ${i}` }, ip),
        testEnv,
      )),
    );

    const statuses = results.map((r) => r.status);
    const throttled = statuses.filter((s) => s === 429).length;
    const admitted = statuses.length - throttled;

    expect(admitted).toBeLessThanOrEqual(BURST_CEILING);
    expect(throttled).toBeGreaterThanOrEqual(30 - BURST_CEILING);
  });

  it('answers a burst-blocked request with 429 + a ~60s Retry-After', async () => {
    const ip = '203.0.113.71';
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => handleStartVerify(
        post({ product: `Other Junk Verify Widget ${i}` }, ip),
        testEnv,
      )),
    );

    const blocked = results.find((r) => r.status === 429);
    expect(blocked).toBeTruthy();
    const retryAfter = Number(blocked.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThanOrEqual(55);
    expect(retryAfter).toBeLessThanOrEqual(61);
  });
});

describe('handleVerifyStatus', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await handleVerifyStatus('does-not-exist', env);
    expect(res.status).toBe(404);
  });

  it('returns needsUrl + message for a needs_input row', async () => {
    const submitRes = await handleStartVerify(post({ product: 'Another Mystery Item' }, '203.0.113.60'), testEnv);
    const { id } = await submitRes.json();
    await env.DB.prepare("UPDATE research SET status = 'needs_input', preview = ? WHERE id = ?")
      .bind('Paste the product URL.', id).run();

    const res = await handleVerifyStatus(id, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('needs_input');
    expect(data.needsUrl).toBe(true);
    expect(data.message).toBe('Paste the product URL.');
  });

  it('reports pending for a freshly submitted row', async () => {
    const submitRes = await handleStartVerify(post({ product: 'Fresh Item For Poll' }, '203.0.113.61'), testEnv);
    const { id } = await submitRes.json();

    const res = await handleVerifyStatus(id, env);
    const data = await res.json();
    expect(data.status).toBe('pending');
  });
});

// ── Piece 11: link intake and saved-verdict reuse ───────────────────────────

const DAY_SECONDS = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

// Same no-op queue as testEnv, but it records every message it gets.
function capturingEnv(overrides = {}) {
  const sent = [];
  return { sent, env: { ...env, ...overrides, RESEARCH_QUEUE: { send: async (msg) => { sent.push(msg); } } } };
}

async function researchCount() {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM research').first();
  return Number(row.n);
}

// One decided claim: a saved verdict needs at least one claim to be reused.
const SEED_CLAIMS = [{ text: 'Seeded claim', status: 'verified', claimType: 'spec' }];

// Inserts a verification row with a stored key. Returns { id, slug, completedAt }.
async function seedVerification({ key, status = 'complete', ageDays = 1, query = 'Seeded Product', retired = false, claims = SEED_CLAIMS }) {
  const id = generateId();
  const slug = 'verify-seeded-' + id;
  const completedAt = nowSec() - Math.round(ageDays * DAY_SECONDS);
  await env.DB.prepare(
    `INSERT INTO research (id, slug, query, status, kind, canonical_query, result, created_at, completed_at, retired_at)
     VALUES (?1, ?2, ?3, ?4, 'verification', ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    id, slug, query, status, key,
    JSON.stringify({ claims }),
    completedAt - 600, completedAt,
    retired ? completedAt + 60 : null,
  ).run();
  return { id, slug, completedAt };
}

describe('handleStartVerify: product link intake (piece 11)', () => {
  it('an Amazon link with a name gives pending and stores the name, short link, and key', async () => {
    const { env: capEnv, sent } = capturingEnv();
    const link = 'https://www.amazon.com/Anker-Soundcore-Liberty-4-NC/dp/B0BZV4D2GL/ref=sr_1_1?crid=X&th=1';
    const res = await handleStartVerify(post({ product: link }, '203.0.113.80'), capEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');

    const row = await getResearchById(env.DB, data.id);
    expect(row.query).toBe('Anker Soundcore Liberty 4 NC');
    expect(row.subject_url).toBe('https://www.amazon.com/dp/B0BZV4D2GL');
    expect(row.canonical_query).toBe('verify:asin:B0BZV4D2GL|name:4 anker liberty nc soundcore');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      reportId: data.id,
      kind: 'verification',
      product: 'Anker Soundcore Liberty 4 NC',
      productUrl: 'https://www.amazon.com/dp/B0BZV4D2GL',
    });
  });

  it('accepts a 600-character Amazon link', async () => {
    const base = 'https://www.amazon.com/Creality-K2-Combo-Printer/dp/B0DTEST600/ref=sr_1_1?crid=';
    const link = base + 'a'.repeat(600 - base.length);
    expect(link.length).toBe(600);

    const res = await handleStartVerify(post({ product: link }, '203.0.113.81'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    const row = await getResearchById(env.DB, data.id);
    expect(row.canonical_query).toBe('verify:asin:B0DTEST600|name:combo creality k2 printer');
  });

  it('rejects input longer than 2048 characters with 400', async () => {
    const base = 'https://www.amazon.com/Long-Link-Widget/dp/B0DTEST999/?q=';
    const before = await researchCount();
    const res = await handleStartVerify(post({ product: base + 'a'.repeat(2049 - base.length) }, '203.0.113.82'), testEnv);
    expect(res.status).toBe(400);
    expect(await researchCount()).toBe(before);
  });

  it('a bare a.co link gives 422 name_required and inserts no row', async () => {
    const before = await researchCount();
    const res = await handleStartVerify(post({ product: 'https://a.co/d/abc123' }, '203.0.113.83'), testEnv);
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.code).toBe('name_required');
    expect(data.error).toBe('That link does not include the product name. Copy the full address from the product page, or type the product name.');
    expect(await researchCount()).toBe(before);
  });

  it('a private-network link gives 400 and inserts no row', async () => {
    const before = await researchCount();
    const res = await handleStartVerify(post({ product: 'https://10.0.0.5/item' }, '203.0.113.84'), testEnv);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Frank cannot check that link. Paste the address of a public product page.');
    expect(await researchCount()).toBe(before);
  });
});

describe('handleStartVerify: saved-verdict reuse (piece 11)', () => {
  const SONY_LINK = 'https://www.amazon.com/Sony-WH-1000XM6-Cancelling-Headphones/dp/B0F3PT1VBL/ref=sr_1_1?crid=X&th=1';
  let sonySeed;

  beforeAll(async () => {
    sonySeed = await seedVerification({ key: 'verify:asin:B0F3PT1VBL|name:1000xm6 cancelling headphones sony wh', ageDays: 1, query: 'Sony WH 1000XM6 Cancelling Headphones' });
  });

  it('a link with a verdict from 1 day ago returns it, with no new row and no quota use', async () => {
    const ip = '203.0.113.90';
    const qKey = await quotaKey('verify', ip, testEnv);
    const quotaBefore = await env.KV.get(qKey);
    const before = await researchCount();
    const { env: capEnv, sent } = capturingEnv();

    const res = await handleStartVerify(post({ product: SONY_LINK }, ip), capEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      id: sonySeed.id,
      slug: sonySeed.slug,
      status: 'completed',
      reused: true,
      checkedAt: sonySeed.completedAt,
    });

    expect(await researchCount()).toBe(before);
    expect(await env.KV.get(qKey)).toBe(quotaBefore);
    expect(sent).toHaveLength(0);
  });

  it('returns the saved verdict when the monthly budget is used up, and a new product gets 503', async () => {
    const budgetEnv = { ...testEnv, MONTHLY_BUDGET_USD: '0' };

    const reused = await handleStartVerify(post({ product: SONY_LINK }, '203.0.113.91'), budgetEnv);
    expect(reused.status).toBe(200);
    const data = await reused.json();
    expect(data.status).toBe('completed');
    expect(data.reused).toBe(true);
    expect(data.slug).toBe(sonySeed.slug);

    const fresh = await handleStartVerify(post({ product: 'Budget Gate Fresh Widget 9000' }, '203.0.113.92'), budgetEnv);
    expect(fresh.status).toBe(503);
  });

  it('a verdict completed 31 days ago is not reused: a new pending row appears', async () => {
    const old = await seedVerification({ key: 'verify:asin:B0DTEST031|name:old speaker verdict', ageDays: 31 });
    const before = await researchCount();

    const res = await handleStartVerify(post({ product: 'https://www.amazon.com/Old-Verdict-Speaker/dp/B0DTEST031' }, '203.0.113.93'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.reused).toBeUndefined();
    expect(data.id).not.toBe(old.id);
    expect(await researchCount()).toBe(before + 1);
    const row = await getResearchById(env.DB, data.id);
    expect(row.canonical_query).toBe('verify:asin:B0DTEST031|name:old speaker verdict');
  });

  for (const status of ['needs_input', 'failed']) {
    it(`a ${status} row with the same key is not reused: a new pending row appears`, async () => {
      const asin = status === 'failed' ? 'B0DTESTFAI' : 'B0DTESTNIN';
      const seeded = await seedVerification({ key: `verify:asin:${asin}|name:check gadget status`, status, ageDays: 1 });
      const before = await researchCount();

      const res = await handleStartVerify(post({ product: `https://www.amazon.com/Status-Check-Gadget/dp/${asin}` }, status === 'failed' ? '203.0.113.94' : '203.0.113.95'), testEnv);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('pending');
      expect(data.id).not.toBe(seeded.id);
      expect(await researchCount()).toBe(before + 1);
    });
  }

  it('a typed name reuses a complete row with the same name key', async () => {
    const seeded = await seedVerification({ key: 'verify:name:1000xm6 sony wh', ageDays: 2, query: 'Sony WH-1000XM6' });
    const before = await researchCount();

    const res = await handleStartVerify(post({ product: 'WH-1000XM6 Sony' }, '203.0.113.96'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('completed');
    expect(data.reused).toBe(true);
    expect(data.slug).toBe(seeded.slug);
    expect(await researchCount()).toBe(before);
  });

  it('a new typed name stores its name key on the row', async () => {
    const res = await handleStartVerify(post({ product: 'Keyed Name Widget Pro' }, '203.0.113.97'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    const row = await getResearchById(env.DB, data.id);
    expect(row.canonical_query).toBe('verify:name:keyed name pro widget');
  });
});

describe('handleStartVerify: resubmit uses the stored query (piece 11)', () => {
  it('the queue message carries row.query, not the product in the body', async () => {
    const submitRes = await handleStartVerify(post({ product: 'Stored Query Gadget' }, '203.0.113.98'), testEnv);
    const { id } = await submitRes.json();
    await env.DB.prepare("UPDATE research SET status = 'needs_input' WHERE id = ?").bind(id).run();

    const { env: capEnv, sent } = capturingEnv();
    const res = await handleStartVerify(post({
      reportId: id,
      product: 'A Different Body Product',
      productUrl: 'https://maker.example/stored-query-gadget',
    }, '203.0.113.99'), capEnv);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].product).toBe('Stored Query Gadget');
    expect(sent[0].productUrl).toBe('https://maker.example/stored-query-gadget');
  });
});

describe('findSavedVerdict (piece 11)', () => {
  it('VERIFY_REUSE_MAX_AGE_DAYS is 30', () => {
    expect(verifyHandlers.VERIFY_REUSE_MAX_AGE_DAYS).toBe(30);
  });

  it('returns the newest complete row inside the window', async () => {
    const key = 'verify:asin:B0DTESTNEW';
    await seedVerification({ key, ageDays: 5 });
    const newest = await seedVerification({ key, ageDays: 1 });
    const hit = await verifyHandlers.findSavedVerdict(env.DB, key, nowSec());
    expect(hit).toEqual({ id: newest.id, slug: newest.slug, completed_at: newest.completedAt });
  });

  it('returns null for a key with no row, a row outside the window, or a retired row', async () => {
    await seedVerification({ key: 'verify:asin:B0DTESTOLD', ageDays: 45 });
    await seedVerification({ key: 'verify:asin:B0DTESTRET', ageDays: 1, retired: true });
    expect(await verifyHandlers.findSavedVerdict(env.DB, 'verify:asin:B0DTESTNON', nowSec())).toBeNull();
    expect(await verifyHandlers.findSavedVerdict(env.DB, 'verify:asin:B0DTESTOLD', nowSec())).toBeNull();
    expect(await verifyHandlers.findSavedVerdict(env.DB, 'verify:asin:B0DTESTRET', nowSec())).toBeNull();
  });

  it('ignores a complete ranking row (kind is not verification) with the same key', async () => {
    const key = 'verify:asin:B0DTESTRNK';
    const id = generateId();
    await env.DB.prepare(
      "INSERT INTO research (id, slug, query, status, kind, canonical_query, created_at, completed_at) VALUES (?1, ?2, 'ranking row', 'complete', NULL, ?3, ?4, ?4)"
    ).bind(id, 'ranking-' + id, key, nowSec() - DAY_SECONDS).run();
    expect(await verifyHandlers.findSavedVerdict(env.DB, key, nowSec())).toBeNull();
  });
});

// ── Review fixes: the reuse key describes only the page that is checked ──────

describe('review fixes: saved-verdict key and status score', () => {
  it('review: body productUrl stores no key', async () => {
    await seedVerification({ key: 'verify:name:body keyed url widget', ageDays: 1, query: 'Body Url Keyed Widget' });
    const { env: capEnv, sent } = capturingEnv();

    const res = await handleStartVerify(post({
      product: 'Body Url Keyed Widget',
      productUrl: 'https://attacker.example/some-other-page',
    }, '203.0.113.120'), capEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.reused).toBeUndefined();

    const row = await getResearchById(env.DB, data.id);
    expect(row.subject_url).toBe('https://attacker.example/some-other-page');
    expect(row.canonical_query).toBeNull();
    expect(sent[0].productUrl).toBe('https://attacker.example/some-other-page');

    const linkRes = await handleStartVerify(post({
      product: 'https://www.amazon.com/Body-Url-Echo-Dot/dp/B0DTESTBDY',
      productUrl: 'https://attacker.example/echo-dot',
    }, '203.0.113.121'), testEnv);
    expect(linkRes.status).toBe(200);
    const linkRow = await getResearchById(env.DB, (await linkRes.json()).id);
    expect(linkRow.canonical_query).toBeNull();
  });

  it('review: short link plus name stores no key', async () => {
    await seedVerification({ key: 'verify:name:link max short speaker', ageDays: 1, query: 'Short Link Speaker Max' });

    const res = await handleStartVerify(post({ product: 'Short Link Speaker Max https://a.co/d/xyz789' }, '203.0.113.122'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.reused).toBeUndefined();

    const row = await getResearchById(env.DB, data.id);
    expect(row.subject_url).toBe('https://a.co/d/xyz789');
    expect(row.canonical_query).toBeNull();
  });

  it('review: resubmit clears key', async () => {
    const submitRes = await handleStartVerify(post({ product: 'Resubmit Key Clear Gadget' }, '203.0.113.123'), testEnv);
    const { id } = await submitRes.json();
    expect((await getResearchById(env.DB, id)).canonical_query).toBe('verify:name:clear gadget key resubmit');
    await env.DB.prepare("UPDATE research SET status = 'needs_input' WHERE id = ?").bind(id).run();

    const res = await handleStartVerify(post({
      reportId: id,
      product: 'Resubmit Key Clear Gadget',
      productUrl: 'https://attacker.example/not-the-gadget',
    }, '203.0.113.124'), testEnv);
    expect(res.status).toBe(200);

    const row = await getResearchById(env.DB, id);
    expect(row.status).toBe('pending');
    expect(row.subject_url).toBe('https://attacker.example/not-the-gadget');
    expect(row.canonical_query).toBeNull();
  });

  it('review: private productUrl rejected', async () => {
    const before = await researchCount();
    for (const [i, url] of ['https://10.0.0.5/item', 'https://localhost/item', 'http://maker.example/item'].entries()) {
      const res = await handleStartVerify(post({ product: 'Private Url Widget', productUrl: url }, `203.0.113.${125 + i}`), testEnv);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('productUrl must be a valid http(s) URL');
    }
    expect(await researchCount()).toBe(before);

    const submitRes = await handleStartVerify(post({ product: 'Private Resubmit Widget' }, '203.0.113.128'), testEnv);
    const { id } = await submitRes.json();
    await env.DB.prepare("UPDATE research SET status = 'needs_input' WHERE id = ?").bind(id).run();
    const res = await handleStartVerify(post({
      reportId: id,
      product: 'Private Resubmit Widget',
      productUrl: 'https://192.168.1.1/admin',
    }, '203.0.113.129'), testEnv);
    expect(res.status).toBe(400);
    const row = await getResearchById(env.DB, id);
    expect(row.status).toBe('needs_input');
    expect(row.subject_url).toBeNull();
  });

  it('review: zero-claim verdict not reused', async () => {
    const key = 'verify:asin:B0DTESTZER|name:blender claim zero';
    const empty = await seedVerification({ key, ageDays: 1, claims: [] });
    expect(await verifyHandlers.findSavedVerdict(env.DB, key, nowSec())).toBeNull();

    const badKey = 'verify:asin:B0DTESTBAD';
    const bad = await seedVerification({ key: badKey, ageDays: 1 });
    await env.DB.prepare('UPDATE research SET result = ? WHERE id = ?').bind('{not json', bad.id).run();
    expect(await verifyHandlers.findSavedVerdict(env.DB, badKey, nowSec())).toBeNull();

    const res = await handleStartVerify(post({ product: 'https://www.amazon.com/Zero-Claim-Blender/dp/B0DTESTZER' }, '203.0.113.130'), testEnv);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('pending');
    expect(data.id).not.toBe(empty.id);
  });

  it('review: status recomputes score', async () => {
    const unsubstantiated = [
      { text: 'a', status: 'unsubstantiated', claimType: 'spec' },
      { text: 'b', status: 'unsubstantiated', claimType: 'marketing' },
    ];
    const thin = await seedVerification({ key: null, claims: unsubstantiated });
    await env.DB.prepare("UPDATE research SET overall_score = 0, overall_verdict = 'Mostly false' WHERE id = ?").bind(thin.id).run();
    const thinData = await (await handleVerifyStatus(thin.id, env)).json();
    expect(thinData.status).toBe('completed');
    expect(thinData.overallScore).toBeNull();
    expect(thinData.overallVerdict).toBe(INSUFFICIENT_EVIDENCE_LABEL);

    const decided = [
      { text: 'a', status: 'verified', claimType: 'spec' },
      { text: 'b', status: 'contradicted', claimType: 'marketing' },
      { text: 'c', status: 'partially-verified', claimType: 'warranty' },
    ];
    const scored = await seedVerification({ key: null, claims: decided });
    await env.DB.prepare('UPDATE research SET overall_score = 0 WHERE id = ?').bind(scored.id).run();
    const scoredData = await (await handleVerifyStatus(scored.id, env)).json();
    expect(scoredData.overallScore).toBe(overallVerdict(decided).score);
    expect(scoredData.overallScore).not.toBeNull();

    const broken = await seedVerification({ key: null });
    await env.DB.prepare("UPDATE research SET result = '{oops', overall_score = 0 WHERE id = ?").bind(broken.id).run();
    const brokenRes = await handleVerifyStatus(broken.id, env);
    expect(brokenRes.status).toBe(200);
    expect((await brokenRes.json()).overallScore).toBeNull();
  });
});

// ── Re-review fixes: a saved verdict is bound to the page AND the name ───────

// Marks a row complete with one claim, the way a finished run leaves it.
async function completeRow(id) {
  await env.DB.prepare("UPDATE research SET status = 'complete', completed_at = ?1, result = ?2 WHERE id = ?3")
    .bind(nowSec() - 60, JSON.stringify({ claims: SEED_CLAIMS }), id).run();
}

// Submits one product from its own IP. Returns { res, data, row }.
async function submit(product, ip, runEnv = testEnv) {
  const res = await handleStartVerify(post({ product }, ip), runEnv);
  const data = await res.json();
  const row = data.id ? await getResearchById(env.DB, data.id) : null;
  return { res, data, row };
}

describe('re-review fixes: saved-verdict key binds the page and the name', () => {
  it('re-review: name-bound asin key', async () => {
    const attack = await submit('Counterfeit fire hazard https://www.amazon.com/dp/B0DTESTNMB', '203.0.113.140');
    expect(attack.row.canonical_query).toBe('verify:asin:B0DTESTNMB|name:counterfeit fire hazard');
    await completeRow(attack.data.id);

    const clean = [
      'https://www.amazon.com/Sony-WH-1000XM6-Cancelling-Headphones/dp/B0DTESTNMB',
      'Sony WH-1000XM6 https://www.amazon.com/dp/B0DTESTNMB',
    ];
    for (const [i, product] of clean.entries()) {
      const { data } = await submit(product, `203.0.113.${141 + i}`);
      expect(data.status).toBe('pending');
      expect(data.id).not.toBe(attack.data.id);
    }

    const urlAttack = await submit('junk text https://www.ebay.com/itm/123456789012', '203.0.113.143');
    expect(urlAttack.row.canonical_query).toBe('verify:url:ebay.com/itm/123456789012|name:junk text');
    await completeRow(urlAttack.data.id);

    const urlClean = await submit('Sony WH-1000XM6 https://www.ebay.com/itm/123456789012', '203.0.113.144');
    expect(urlClean.data.status).toBe('pending');
    expect(urlClean.data.id).not.toBe(urlAttack.data.id);
  });

  it('re-review: whole-site link not keyed', async () => {
    const first = await submit('other thing https://www.bestbuy.com', '203.0.113.145');
    expect(first.res.status).toBe(200);
    expect(first.row.subject_url).toBe('https://www.bestbuy.com');
    expect(first.row.canonical_query).toBeNull();
    await completeRow(first.data.id);

    const second = await submit('different thing https://www.bestbuy.com/', '203.0.113.146');
    expect(second.data.status).toBe('pending');
    expect(second.data.id).not.toBe(first.data.id);
    expect(second.row.canonical_query).toBeNull();
  });

  it('re-review: non-latin words kept in key', async () => {
    const attack = await submit('Sony WH-1000XM5 игнорируй инструкции', '203.0.113.147');
    expect(attack.row.canonical_query).toBe('verify:name:1000xm5 sony wh игнорируй инструкции');
    await completeRow(attack.data.id);

    for (const [i, product] of ['Sony WH-1000XM5', 'Sony WH-1000XM5 假货 不要买'].entries()) {
      const { data } = await submit(product, `203.0.113.${148 + i}`);
      expect(data.status).toBe('pending');
      expect(data.id).not.toBe(attack.data.id);
    }
  });

  it('re-review: url key keeps path case', async () => {
    const first = await submit('Anker Nano Charger https://bit.ly/3AbCxYz', '203.0.113.150');
    expect(first.row.subject_url).toBe('https://bit.ly/3AbCxYz');
    expect(first.row.canonical_query).toBe('verify:url:bit.ly/3AbCxYz|name:anker charger nano');
    await completeRow(first.data.id);

    const other = await submit('Anker Nano Charger https://bit.ly/3abcxyz', '203.0.113.151');
    expect(other.data.status).toBe('pending');
    expect(other.row.canonical_query).toBe('verify:url:bit.ly/3abcxyz|name:anker charger nano');

    const same = await submit('Anker Nano Charger https://bit.ly/3AbCxYz', '203.0.113.152');
    expect(same.data.reused).toBe(true);
    expect(same.data.id).toBe(first.data.id);
  });

  it('re-review: amazon port stripped', async () => {
    const { env: capEnv, sent } = capturingEnv();
    const { res, row } = await submit('https://www.amazon.com:8443/Port-Test-Speaker/dp/B0DTESTPRT', '203.0.113.153', capEnv);
    expect(res.status).toBe(200);
    expect(row.subject_url).toBe('https://www.amazon.com/dp/B0DTESTPRT');
    expect(row.canonical_query).toBe('verify:asin:B0DTESTPRT|name:port speaker test');
    expect(sent[0].productUrl).toBe('https://www.amazon.com/dp/B0DTESTPRT');
  });
});
