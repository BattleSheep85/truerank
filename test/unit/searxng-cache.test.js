// CP-713: a short-lived KV cache for SearXNG answers, so repeat runs of the
// same query do not hit the free engines again (they CAPTCHA the home IP
// under load). Only usable answers are cached: never errors, nulls, or empties.

const MODULE_PATH = '../../worker/engine/searxng.js';
const BASE_URL = 'https://searx.example.test';
const QUERY = 'best robot vacuum reddit';

const vacuum = (n) => ({
  url: `https://www.rtings.com/vacuum/reviews/model-${n}`,
  title: 'Best robot vacuum for pet hair',
  content: 'We tested every robot vacuum on carpet and hard floors.',
  engines: ['google'],
});
const FOUR = [1, 2, 3, 4].map(vacuum);
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });

// In-memory stand-in for a KV namespace that records puts.
function fakeKv({ failGet = false, failPut = false } = {}) {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    async get(key, type) {
      if (failGet) throw new Error('kv get down');
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      if (failPut) throw new Error('kv put down');
      puts.push({ key, opts });
      store.set(key, value);
    },
  };
}

async function withFetch(respond, fn) {
  const real = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (url, init) => { count++; return respond(String(url), init); };
  const realLog = console.log;
  console.log = () => {};
  try { await fn(); } finally { globalThis.fetch = real; console.log = realLog; }
  return count;
}

async function testHitAndMiss(m, t) {
  const kv = fakeKv();
  let first, second;
  const fetches = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    first = await m.searxngSearch(QUERY, BASE_URL, { kv });
    second = await m.searxngSearch(QUERY, BASE_URL, { kv });
  });
  t.eq('cache: second identical query makes no request', fetches, 1);
  t.eq('cache: hit returns the same answer', second, first);
  t.eq('cache: one put', kv.puts.length, 1);
  t.eq('cache: TTL is a few hours', kv.puts[0]?.opts?.expirationTtl, m.SEARXNG_CACHE_TTL_S);
  t.ok('cache: TTL between 1 and 12 hours', m.SEARXNG_CACHE_TTL_S >= 3600 && m.SEARXNG_CACHE_TTL_S <= 12 * 3600);
  t.ok('cache: key is namespaced and short', /^searxng:v1:[0-9a-f]{64}$/.test(kv.puts[0]?.key ?? ''));
  t.ok('cache: key does not hold the raw query', !kv.puts[0]?.key.includes('vacuum'));
}

async function testKeyParams(m, t) {
  const kv = fakeKv();
  const fetches = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    await m.searxngSearch(QUERY, BASE_URL, { kv });
    await m.searxngSearch(`${QUERY} 2026`, BASE_URL, { kv });
    await m.searxngSiteSearch(QUERY, BASE_URL, { kv, categories: 'news' });
    await m.searxngSearch(QUERY, BASE_URL, { kv, gateToken: 'another-token' });
  });
  t.eq('key: different query or params miss, gate token does not change the key', fetches, 3);
  const web = await m.searxngCacheKey(QUERY, 'web', {});
  t.ok('key: site and web answers do not share a key', web !== await m.searxngCacheKey(QUERY, 'site', {}));
  t.ok('key: categories change the key', web !== await m.searxngCacheKey(QUERY, 'web', { categories: 'news' }));
  const moved = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    await m.searxngSearch(QUERY, 'https://other-host.test', { kv });
  });
  t.eq('key: a new SEARXNG_URL still hits the cache', moved, 0);
}

async function noPut(m, t, name, respond, call) {
  const kv = fakeKv();
  await withFetch(respond, () => call(kv));
  t.eq(name, kv.puts.length, 0);
}

async function testNoCacheOnBadAnswers(m, t) {
  const web = (kv) => m.searxngSearch(QUERY, BASE_URL, { kv });
  await noPut(m, t, 'no cache: HTTP 500', () => new Response('boom', { status: 500 }), web);
  await noPut(m, t, 'no cache: fetch throws', () => { throw new TypeError('network down'); }, web);
  await noPut(m, t, 'no cache: bad JSON', () => new Response('nope', { status: 200 }), web);
  await noPut(m, t, 'no cache: weak web answer (null)', () => jsonResponse({ results: FOUR.slice(0, 2) }), web);
  await noPut(m, t, 'no cache: empty image answer', () => jsonResponse({ results: [] }),
    (kv) => m.searxngImageSearch(QUERY, BASE_URL, { kv }));
  await noPut(m, t, 'no cache: empty site answer', () => jsonResponse({ results: [] }),
    (kv) => m.searxngSiteSearch(QUERY, BASE_URL, { kv }));
}

async function testImageAndSiteCached(m, t) {
  const kv = fakeKv();
  let a, b;
  const fetches = await withFetch(() => jsonResponse({ results: [{ img_src: 'https://i.example/a.jpg', resolution: '800x600' }] }), async () => {
    a = await m.searxngImageSearch(QUERY, BASE_URL, { kv });
    b = await m.searxngImageSearch(QUERY, BASE_URL, { kv });
  });
  t.eq('images: cached on second call', fetches, 1);
  t.eq('images: same answer from cache', b, a);
  const kv2 = fakeKv();
  const siteFetches = await withFetch(() => jsonResponse({ results: [{ url: 'https://www.amazon.com/dp/B0ABCDEFGH', title: 'x' }] }), async () => {
    await m.searxngSiteSearch(QUERY, BASE_URL, { kv: kv2 });
    await m.searxngSiteSearch(QUERY, BASE_URL, { kv: kv2 });
  });
  t.eq('site: cached on second call', siteFetches, 1);
}

async function testKvFailuresFallThrough(m, t) {
  let r1, r2;
  const f1 = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    r1 = await m.searxngSearch(QUERY, BASE_URL, { kv: fakeKv({ failGet: true }) });
  });
  t.eq('kv get error: still searches', f1, 1);
  t.eq('kv get error: answer returned', r1?.length, 4);
  await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    r2 = await m.searxngSearch(QUERY, BASE_URL, { kv: fakeKv({ failPut: true }) });
  });
  t.eq('kv put error: answer still returned', r2?.length, 4);

  const kv = fakeKv();
  const key = await m.searxngCacheKey(QUERY, 'web', {});
  kv.store.set(key, JSON.stringify({ results: 'not a list' }));
  let r3;
  const f3 = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    r3 = await m.searxngSearch(QUERY, BASE_URL, { kv });
  });
  t.eq('bad cached shape: treated as a miss', f3, 1);
  t.eq('bad cached shape: fresh answer returned', r3?.length, 4);
}

async function testNoKv(m, t) {
  let r;
  const fetches = await withFetch(() => jsonResponse({ results: FOUR }), async () => {
    r = await m.searxngSearch(QUERY, BASE_URL, {});
    await m.searxngSearch(QUERY, BASE_URL, {});
  });
  t.eq('no kv: every call searches', fetches, 2);
  t.eq('no kv: answer returned', r?.length, 4);
}

const GROUPS = [testHitAndMiss, testKeyParams, testNoCacheOnBadAnswers, testImageAndSiteCached, testKvFailuresFallThrough, testNoKv];

export async function runSearxngCacheTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const t = { eq, ok: (name, c) => eq(name, !!c, true) };
  let m;
  try {
    m = await import(MODULE_PATH);
  } catch (err) {
    report.failed++;
    report.failures.push(`cannot import ${MODULE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  for (const group of GROUPS) {
    try {
      await group(m, t);
    } catch (err) {
      report.failed++;
      report.failures.push(`${group.name} threw: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
  return report;
}
