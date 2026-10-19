// Saved claim sets for /verify (CP-718): key, read, write, and the
// stableProductClaims step that reuses them so repeat runs check the same claims.
import {
  claimCacheKey,
  readCachedClaims,
  writeCachedClaims,
  shortenCachedClaims,
  CLAIM_CACHE_TTL_SECONDS,
  CLAIM_CACHE_WEAK_TTL_SECONDS,
  CLAIM_CACHE_VERSION,
} from '../../worker/lib/claim-cache.js';
import { stableProductClaims, isTestableClaim, keepClaimsByOutcome } from '../../worker/engine/verify.js';

function memoryKv({ failGet = false, failPut = false } = {}) {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(key) {
      if (failGet) throw new Error('kv get down');
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      if (failPut) throw new Error('kv put down');
      puts.push({ key, value, opts });
      store.set(key, value);
    },
  };
}

const CLAIMS = [
  { id: 'c1', text: 'Runs for up to 60 minutes on a single charge', type: 'spec' },
  { id: 'c2', text: 'Laser reveals microscopic dust on hard floors', type: 'marketing' },
  { id: 'c3', text: 'Piezo sensor counts and sizes dust particles', type: 'spec' },
  { id: 'c4', text: 'Fully sealed filtration captures 99.99% of particles', type: 'spec' },
];

function extractReply(claims) {
  return async () => ({ choices: [{ message: { content: JSON.stringify({ claims }) } }], usage: { cost: 0.01 } });
}

export async function runClaimCacheTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const quiet = async (fn) => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try { return await fn(); } finally { console.log = log; console.error = error; }
  };

  // Key: one key for word order and case, none for an empty name.
  eq('key: word order and case do not matter', claimCacheKey('Dyson V15 Detect'), claimCacheKey('detect dyson v15'));
  eq('key: differs between products', claimCacheKey('Dyson V15 Detect') === claimCacheKey('Dyson V12 Detect'), false);
  eq('key: empty name has no key', claimCacheKey('  '), null);
  eq('key: a pasted page gets its own key', claimCacheKey('Dyson V15 Detect', 'https://evil.example/page') === claimCacheKey('Dyson V15 Detect'), false);
  eq('key: one page, one key (www, case, trailing slash)', claimCacheKey('Antec C8', 'https://www.amazon.com/dp/B0DK85GRFZ/'), claimCacheKey('antec c8', 'https://amazon.com/DP/b0dk85grfz'));
  eq('key: an unparsable page has no key', claimCacheKey('Antec C8', 'not a url'), null);
  // CP-812: a generic path keeps the query that names the product.
  eq('key: two products on one generic path get two keys',
    claimCacheKey('Acme X1', 'https://shop.example/product_info.php?products_id=42') === claimCacheKey('Acme X1', 'https://shop.example/product_info.php?products_id=43'), false);
  eq('key: tracking params on a generic path do not split the key',
    claimCacheKey('Acme X1', 'https://shop.example/product_info.php?products_id=42&utm_source=x'), claimCacheKey('Acme X1', 'https://shop.example/product_info.php?products_id=42'));
  eq('key: a named slug ignores its query',
    claimCacheKey('Sony WH-1000XM6', 'https://shop.example/sony-wh-1000xm6-headphones?ref=home'), claimCacheKey('Sony WH-1000XM6', 'https://shop.example/sony-wh-1000xm6-headphones'));

  // Round trip: write then read gives the same claims, renumbered.
  {
    const kv = memoryKv();
    eq('write: saved', await writeCachedClaims(kv, 'Dyson V15 Detect', CLAIMS), true);
    eq('write: TTL is 30 days', kv.puts[0].opts.expirationTtl, CLAIM_CACHE_TTL_SECONDS);
    eq('write: TTL value', CLAIM_CACHE_TTL_SECONDS, 2592000);
    const back = await readCachedClaims(kv, 'dyson v15 detect');
    eq('read: same texts', back.map((c) => c.text), CLAIMS.map((c) => c.text));
    eq('read: ids renumbered', back.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
  }

  // Read: the keep filter applies, and bad stored values give [].
  {
    const kv = memoryKv();
    await writeCachedClaims(kv, 'Michelin CrossClimate 2', [
      { text: 'Maximum inflation pressure of 51 psi', type: 'spec' },
      { text: 'Short wet braking distances', type: 'spec' },
    ]);
    const kept = await readCachedClaims(kv, 'Michelin CrossClimate 2', isTestableClaim);
    eq('read: untestable saved claims are dropped', kept.map((c) => c.text), ['Short wet braking distances']);
    kv.store.set(claimCacheKey('Bad Json Product'), '{not json');
    eq('read: invalid JSON gives []', await quiet(() => readCachedClaims(kv, 'Bad Json Product')), []);
    kv.store.set(claimCacheKey('Bad Shape'), JSON.stringify({ claims: [{ text: 5, type: 'spec' }, { text: 'ok text', type: 'bogus' }] }));
    eq('read: invalid claims are dropped', await readCachedClaims(kv, 'Bad Shape'), []);
    eq('read: no KV gives []', await readCachedClaims(null, 'Dyson V15 Detect'), []);
    eq('read: KV error gives []', await quiet(() => readCachedClaims(memoryKv({ failGet: true }), 'Dyson V15 Detect')), []);
  }

  // Write: nothing to save, no KV, or a KV error gives false.
  eq('write: no claims', await writeCachedClaims(memoryKv(), 'Dyson V15 Detect', []), false);
  eq('write: no KV', await writeCachedClaims(undefined, 'Dyson V15 Detect', CLAIMS), false);
  eq('write: KV error', await quiet(() => writeCachedClaims(memoryKv({ failPut: true }), 'Dyson V15 Detect', CLAIMS)), false);

  // stableProductClaims: the second run of a product reuses the first run's claims.
  {
    const kv = memoryKv();
    const resolved = { claimSources: [{ url: 'https://www.dyson.com/v15', title: 'Dyson V15 Detect', content: 'x'.repeat(50) }], candidates: [], nextIndex: 0, readsLeft: 0 };
    const base = { product: 'Dyson V15 Detect', resolved, env: { KV: kv }, apiKey: 'k', model: 'm' };
    const first = await quiet(() => stableProductClaims({ ...base, callLLM: extractReply(CLAIMS) }));
    eq('stable: first run extracts', first.fromCache, false);
    eq('stable: first run pays for the extraction', first.costUsd, 0.01);
    const other = [1, 2, 3, 4, 5].map((n) => ({ text: `Different claim number ${n}`, type: 'spec' }));
    const second = await quiet(() => stableProductClaims({ ...base, callLLM: extractReply(other) }));
    eq('stable: second run reuses the saved claims', second.fromCache, true);
    eq('stable: second run checks the same claims', second.claims.map((c) => c.text), first.claims.map((c) => c.text));
    eq('stable: reuse costs nothing', second.costUsd, 0);
    eq('stable: reuse keeps the resolved claim pages', second.claimSources, resolved.claimSources);

    // A pasted page never reads or writes the plain name's claims.
    const pasted = await quiet(() => stableProductClaims({ ...base, productUrl: 'https://evil.example/dyson', callLLM: extractReply(other) }));
    eq('stable: a pasted page does not reuse the name claims', pasted.fromCache, false);
    const plainAgain = await quiet(() => stableProductClaims({ ...base, callLLM: extractReply(other) }));
    eq('stable: a pasted page does not overwrite the name claims', plainAgain.claims.map((c) => c.text), first.claims.map((c) => c.text));

    // Fewer than MIN_CLAIMS (4) extracted: nothing is saved.
    const kv2 = memoryKv();
    const few = await quiet(() => stableProductClaims({ ...base, env: { KV: kv2 }, callLLM: extractReply(CLAIMS.slice(0, 2)) }));
    eq('stable: a short claim set is used', few.claims.length, 2);
    eq('stable: a short claim set is not saved', kv2.puts.length, 0);

    // No KV binding: extraction still works.
    const noKv = await quiet(() => stableProductClaims({ ...base, env: {}, callLLM: extractReply(CLAIMS) }));
    eq('stable: no KV still extracts', noKv.claims.length, 4);
  }

  // CP-819: a claim set whose check ended with no score is kept only a short
  // time, so the next run after that extracts again. The version stays.
  {
    eq('weak: version unchanged', CLAIM_CACHE_VERSION, 'v1');
    eq('weak: short TTL is one day', CLAIM_CACHE_WEAK_TTL_SECONDS, 86400);
    const kv = memoryKv();
    await writeCachedClaims(kv, 'Antec C8', CLAIMS);
    eq('weak: shortened', await shortenCachedClaims(kv, 'antec c8'), true);
    eq('weak: re-saved with the short TTL', kv.puts[1]?.opts?.expirationTtl, CLAIM_CACHE_WEAK_TTL_SECONDS);
    eq('weak: same claims kept', JSON.parse(kv.puts[1]?.value).claims, JSON.parse(kv.puts[0]?.value).claims);
    eq('weak: an already short set keeps its first expiry', await shortenCachedClaims(kv, 'Antec C8'), false);
    eq('weak: no second put', kv.puts.length, 2);
    eq('weak: a short set is still read', (await readCachedClaims(kv, 'Antec C8')).length, 4);
    await writeCachedClaims(kv, 'Antec C8', CLAIMS);
    eq('weak: a fresh extraction saves 30 days again', kv.puts[2]?.opts?.expirationTtl, CLAIM_CACHE_TTL_SECONDS);
    eq('weak: and can be shortened again', await shortenCachedClaims(kv, 'Antec C8'), true);
    eq('weak: nothing saved, nothing to shorten', await shortenCachedClaims(memoryKv(), 'Antec C8'), false);
    eq('weak: no KV', await shortenCachedClaims(null, 'Antec C8'), false);
    eq('weak: no key', await shortenCachedClaims(memoryKv(), '  '), false);
    eq('weak: KV error gives false', await quiet(() => shortenCachedClaims(memoryKv({ failGet: true }), 'Antec C8')), false);
    const pageKv = memoryKv();
    await writeCachedClaims(pageKv, 'Antec C8', CLAIMS, 'https://www.amazon.com/dp/B0DK85GRFZ');
    await shortenCachedClaims(pageKv, 'Antec C8', 'https://www.amazon.com/dp/B0DK85GRFZ');
    eq('weak: a pasted page set is shortened under its own key', pageKv.puts[1]?.key, pageKv.puts[0]?.key);

    // keepClaimsByOutcome: only a run with no score shortens the set.
    const kv2 = memoryKv();
    await writeCachedClaims(kv2, 'Antec C8', CLAIMS);
    await keepClaimsByOutcome(kv2, 'Antec C8', null, { score: 61 });
    eq('outcome: a scored run keeps 30 days', kv2.puts.length, 1);
    await quiet(() => keepClaimsByOutcome(kv2, 'Antec C8', null, { score: null }));
    eq('outcome: a run with no score shortens the set', kv2.puts[1]?.opts?.expirationTtl, CLAIM_CACHE_WEAK_TTL_SECONDS);
    await quiet(() => keepClaimsByOutcome(kv2, 'Antec C8', null, { score: null }));
    eq('outcome: a second no-score run within the day does not extend it', kv2.puts.length, 2);
  }

  return report;
}
