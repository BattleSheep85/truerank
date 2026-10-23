// Saved evidence pages for /verify (CP-789): key, read, write, shorten, and
// the checks that make a bad, partial, or expired saved entry a miss.
import {
  pageCacheKey,
  readSavedPages,
  writeSavedPages,
  shortenSavedPages,
  PAGE_CACHE_TTL_SECONDS,
  PAGE_CACHE_WEAK_TTL_SECONDS,
  PAGE_CACHE_MAX_BYTES,
} from '../../worker/lib/page-cache.js';
import { claimCacheKey } from '../../worker/lib/claim-cache.js';

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
const SOURCES = [
  { url: 'https://www.rtings.com/vacuum/reviews/dyson/v15-detect', title: 'Dyson V15 Detect review', content: 'We measured 58 minutes of runtime.', credibility: 90, independence: 70, tags: ['hands-on'] },
  { url: 'https://www.reddit.com/r/VacuumCleaners/comments/abc', title: 'V15 after a year', content: 'The laser is great on tile.', credibility: 70, independence: 70, tags: [] },
];
const CLAIM_PAGES = [{ url: 'https://www.dyson.com/v15', title: 'Dyson V15 Detect', content: 'maker page text' }];
const NOW = 1_800_000_000_000;

export async function runPageCacheTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  // Runs fn with console.warn/error captured; returns { value, lines }.
  const capture = async (fn) => {
    const { warn, error } = console;
    const lines = [];
    console.warn = (...a) => { lines.push(a.join(' ')); };
    console.error = (...a) => { lines.push(a.join(' ')); };
    try { return { value: await fn(), lines }; } finally { console.warn = warn; console.error = error; }
  };
  const saved = () => ({ claims: CLAIMS, claimSources: CLAIM_PAGES, sources: SOURCES });

  // Key: same product rules as the claim key, its own prefix.
  eq('key: word order and case do not matter', pageCacheKey('Dyson V15 Detect'), pageCacheKey('detect dyson v15'));
  eq('key: not the claim key', pageCacheKey('Dyson V15 Detect') === claimCacheKey('Dyson V15 Detect'), false);
  eq('key: a pasted page gets its own key', pageCacheKey('Dyson V15 Detect', 'https://www.amazon.com/dp/B0X') === pageCacheKey('Dyson V15 Detect'), false);
  eq('key: empty name has no key', pageCacheKey('  '), null);
  eq('key: an unparsable page has no key', pageCacheKey('Antec C8', 'not a url'), null);

  // Round trip: the same product twice gives the same page set.
  {
    const kv = memoryKv();
    eq('write: saved', await writeSavedPages(kv, 'Dyson V15 Detect', null, saved(), { now: NOW }), true);
    eq('write: TTL is 30 days', kv.puts[0].opts.expirationTtl, PAGE_CACHE_TTL_SECONDS);
    eq('write: TTL value', PAGE_CACHE_TTL_SECONDS, 30 * 86400);
    const back = await readSavedPages(kv, 'dyson v15 detect', null, { now: NOW + 1000 });
    eq('read: same page urls', back.sources.map((s) => s.url), SOURCES.map((s) => s.url));
    eq('read: same page text', back.sources.map((s) => s.content), SOURCES.map((s) => s.content));
    eq('read: scores kept', back.sources.map((s) => [s.credibility, s.independence, s.tags]), SOURCES.map((s) => [s.credibility, s.independence, s.tags]));
    eq('read: same claims, renumbered', back.claims, CLAIMS.map((c, i) => ({ id: `c${i + 1}`, text: c.text, type: c.type })));
    eq('read: claim page urls kept', back.claimSourceUrls, ['https://www.dyson.com/v15']);
    eq('read: saved time', back.savedAt, NOW);
    const again = await readSavedPages(kv, 'Dyson V15 Detect', null, { now: NOW + 2000 });
    eq('read: a second read gives the same pages', again.sources, back.sources);
    eq('read: a pasted page does not read the name entry', await readSavedPages(kv, 'Dyson V15 Detect', 'https://www.amazon.com/dp/B0X', { now: NOW }), null);
  }

  // Expired: older than 30 days is a miss, even when KV still returns it.
  {
    const kv = memoryKv();
    await writeSavedPages(kv, 'Dyson V15 Detect', null, saved(), { now: NOW });
    const late = NOW + PAGE_CACHE_TTL_SECONDS * 1000 + 1;
    const { value, lines } = await capture(() => readSavedPages(kv, 'Dyson V15 Detect', null, { now: late }));
    eq('expired: miss', value, null);
    eq('expired: logged', lines.some((l) => l.includes('expired')), true);
    eq('expired: just inside 30 days is a hit', (await readSavedPages(kv, 'Dyson V15 Detect', null, { now: late - 2 }))?.sources.length, 2);
  }

  // Bad or partial entries: ignored and logged, never thrown.
  {
    const key = pageCacheKey('Bad Product');
    const goodKv = memoryKv();
    await writeSavedPages(goodKv, 'Bad Product', null, saved(), { now: NOW });
    const goodRaw = goodKv.store.get(key);
    const good = () => JSON.parse(goodRaw);
    const cases = [
      ['invalid JSON', '{not json'],
      ['not an object', '"text"'],
      ['wrong version', JSON.stringify({ ...good(), version: 'v0' })],
      ['old claim rules', JSON.stringify({ ...good(), claimVersion: 'v0' })],
      ['no saved time', JSON.stringify({ ...good(), savedAt: undefined })],
      ['count does not match (partial)', JSON.stringify({ ...good(), sources: SOURCES.slice(0, 1) })],
      ['no sources', JSON.stringify({ ...good(), sources: [], count: 0 })],
      ['a source without text', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], content: null }, SOURCES[1]] })],
      ['a source with a bad url', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], url: 'javascript:alert(1)' }, SOURCES[1]] })],
      ['a source with an unparsable url', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], url: 'not a url' }, SOURCES[1]] })],
      ['a source without a score', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], credibility: 'high' }, SOURCES[1]] })],
      ['a source without an independence score', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], independence: 'independent' }, SOURCES[1]] })],
      ['bad tags', JSON.stringify({ ...good(), sources: [{ ...SOURCES[0], tags: 'hands-on' }, SOURCES[1]] })],
      ['a bad claim', JSON.stringify({ ...good(), claims: [{ text: 5, type: 'spec' }, ...CLAIMS.slice(1)] })],
      ['no claims', JSON.stringify({ ...good(), claims: [] })],
      ['bad claim page urls', JSON.stringify({ ...good(), claimSourceUrls: [42] })],
    ];
    for (const [name, raw] of cases) {
      const kv = memoryKv();
      kv.store.set(key, raw);
      const { value, lines } = await capture(() => readSavedPages(kv, 'Bad Product', null, { now: NOW }));
      eq(`bad entry (${name}): ignored`, value, null);
      eq(`bad entry (${name}): logged`, lines.some((l) => l.includes('[page-cache]') && l.includes(key)), true);
    }
    eq('read: no KV gives null', await readSavedPages(null, 'Dyson V15 Detect'), null);
    eq('read: nothing saved gives null', await readSavedPages(memoryKv(), 'Dyson V15 Detect'), null);
    const down = await capture(() => readSavedPages(memoryKv({ failGet: true }), 'Dyson V15 Detect'));
    eq('read: KV error gives null', down.value, null);
    eq('read: KV error logged', down.lines.some((l) => l.includes('read failed')), true);
  }

  // Write: nothing to save, no KV, too big, or a KV error gives false.
  {
    eq('write: no sources', await writeSavedPages(memoryKv(), 'Dyson V15 Detect', null, { ...saved(), sources: [] }), false);
    eq('write: no claims', await writeSavedPages(memoryKv(), 'Dyson V15 Detect', null, { ...saved(), claims: [] }), false);
    eq('write: no KV', await writeSavedPages(undefined, 'Dyson V15 Detect', null, saved()), false);
    eq('write: no key', await writeSavedPages(memoryKv(), '  ', null, saved()), false);
    const failed = await capture(() => writeSavedPages(memoryKv({ failPut: true }), 'Dyson V15 Detect', null, saved()));
    eq('write: KV error gives false', failed.value, false);
    eq('write: KV error logged', failed.lines.some((l) => l.includes('write failed')), true);
    const huge = [{ ...SOURCES[0], content: 'x'.repeat(PAGE_CACHE_MAX_BYTES) }];
    const big = await capture(() => writeSavedPages(memoryKv(), 'Dyson V15 Detect', null, { ...saved(), sources: huge }));
    eq('write: over the size cap is not saved', big.value, false);
    eq('write: over the size cap is logged', big.lines.some((l) => l.includes('too big')), true);
    // Only the fields the judge uses are saved.
    const kv = memoryKv();
    await writeSavedPages(kv, 'Dyson V15 Detect', null, { ...saved(), sources: [{ ...SOURCES[0], passage: 'p', extra: { a: 1 } }] });
    const emptyKv = memoryKv();
    await writeSavedPages(emptyKv, 'Dyson V15 Detect', null, { ...saved(), sources: [...SOURCES, { ...SOURCES[0], url: 'https://example.com/empty', content: '' }] });
    eq('write: a source with empty text is kept, as the judge saw it', (await readSavedPages(emptyKv, 'Dyson V15 Detect'))?.sources.length, 3);
    eq('write: only judge fields', Object.keys(JSON.parse(kv.puts[0].value).sources[0]).sort(), ['content', 'credibility', 'independence', 'tags', 'title', 'url']);
  }

  // Shorten (a check that ended with no score): one day, once.
  {
    const kv = memoryKv();
    await writeSavedPages(kv, 'Dyson V15 Detect', null, saved(), { now: NOW });
    eq('shorten: shortened', await shortenSavedPages(kv, 'Dyson V15 Detect'), true);
    eq('shorten: TTL is one day', kv.puts[1].opts.expirationTtl, PAGE_CACHE_WEAK_TTL_SECONDS);
    eq('shorten: still readable', (await readSavedPages(kv, 'Dyson V15 Detect', null, { now: NOW }))?.sources.length, 2);
    eq('shorten: a second time does not push it out', await shortenSavedPages(kv, 'Dyson V15 Detect'), false);
    eq('shorten: one put only', kv.puts.length, 2);
    eq('shorten: nothing saved', await shortenSavedPages(memoryKv(), 'Dyson V15 Detect'), false);
    eq('shorten: no KV', await shortenSavedPages(null, 'Dyson V15 Detect'), false);
    const broken = memoryKv();
    broken.store.set(pageCacheKey('Dyson V15 Detect'), '{not json');
    eq('shorten: a bad entry is left alone', (await capture(() => shortenSavedPages(broken, 'Dyson V15 Detect'))).value, false);
  }

  return report;
}
