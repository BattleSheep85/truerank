// Verify speed (2026-10-09): the gather options the verify path sets
// (worker/engine/parallel-engine.js) and the stage overlap of
// collectClaimsAndEvidence (worker/engine/verify.js). The LLM and the
// search/read tools are mocked, and fetch (the focused read) is stubbed, so no
// spec uses the network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  callLLMStreaming: vi.fn(),
  runSearch: vi.fn(),
  readPageInto: vi.fn(),
}));

vi.mock('../../worker/engine/llm.js', () => ({
  callLLM: mocks.callLLM,
  callLLMStreaming: mocks.callLLMStreaming,
}));
vi.mock('../../worker/engine/tools.js', () => ({
  runSearch: mocks.runSearch,
  readPageInto: mocks.readPageInto,
}));

const { gatherParallel } = await import('../../worker/engine/parallel-engine.js');
const { anySignal } = await import('../../worker/lib/deadline.js');
const { fetchPageContent } = await import('../../worker/lib/jina.js');
const { collectClaimsAndEvidence } = await import('../../worker/engine/verify.js');
const { ENGINE_CONFIG } = await import('../../worker/lib/engine-config.js');

const PRODUCT = 'Acme Flip 7';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A product page with claims (isUsableClaimPage).
const SPEC_PAGE = [
  'Acme Flip 7 portable speaker with a rugged body and a long battery life for travel and parties.',
  'Battery life: up to 14 hours of playtime per charge, and a 10 minute charge gives 2 hours more.',
  'Drivers: a 45 mm woofer and a 16 mm tweeter for clear sound at all volumes in small rooms.',
  'Water resistance: IP68 rated, so the speaker survives a drop in the pool for 30 minutes.',
  'Bluetooth 5.4 with a 40 m range and Auracast for linking two or more speakers at a party.',
  'The speaker weighs 560 g, and USB-C charging takes about 3 hours from empty to full charge.',
  'A drop test from 1.5 m onto concrete is part of the build quality checks at the factory.',
].join('\n');
const REVIEW_TEXT = `In our battery test the Acme Flip 7 lasted 15 hours at half volume. ${'We tested it outdoors for two weeks. '.repeat(60)}`;

const aspectsReply = (queries) => ({
  choices: [{ message: { content: JSON.stringify({ aspects: [{ title: 'Reviews', queries }, { title: 'Tests', queries: queries.map((q) => `${q} test`) }] }) } }],
  usage: { cost: 0.002 },
});
const claimsReply = {
  choices: [{ message: { content: JSON.stringify({ claims: ['Up to 14 hours of playtime', 'IP68 water resistance', 'Bluetooth 5.4', '45 mm woofer'].map((text) => ({ text, type: 'spec' })) }) } }],
  usage: { cost: 0.001 },
};
const snippet = (url, title) => ({ url, title, content: 'snippet', source: 'web', credibility: { score: 70, tags: [] } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  mocks.callLLM.mockImplementation(async () => aspectsReply(['acme flip 7 review']));
  mocks.runSearch.mockImplementation(async (query) => [snippet(`https://www.lab.example/${encodeURIComponent(query)}/acme-flip-7-review`, 'Acme Flip 7 review')]);
  mocks.readPageInto.mockImplementation(async (source) => {
    source.content = REVIEW_TEXT;
    return source;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('stop signals in the Workers runtime', () => {
  it('anySignal aborts when one input aborts', () => {
    const a = new AbortController();
    const both = anySignal([a.signal, AbortSignal.timeout(60_000)]);
    expect(both.aborted).toBe(false);
    a.abort();
    expect(both.aborted).toBe(true);
  });

  it('a stop during a page read returns empty text without a retry or direct fetch', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      calls.push(url);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }));
    const stop = new AbortController();
    const read = fetchPageContent('https://example.com/p', 'k', { signal: stop.signal, sleepImpl: async () => {} });
    await tick(5);
    stop.abort();
    expect(await read).toBe('');
    expect(calls).toEqual(['https://r.jina.ai/https://example.com/p']);
  });
});

describe('gatherParallel verify options', () => {
  it('withNotes false makes no note calls and returns the read pages', async () => {
    const res = await gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1); // the planner call only
    expect(res.notes).toEqual([]);
    expect(res.sources.some((s) => s.content === REVIEW_TEXT)).toBe(true);
  });

  it('a closed start gate stops before the search burst', async () => {
    const res = await gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false, startGate: Promise.resolve(false) });
    expect(mocks.runSearch).not.toHaveBeenCalled();
    expect(res.sources).toEqual([]);
    expect(res.totalCostUsd).toBeCloseTo(0.002);
  });

  it('the search burst waits for the start gate', async () => {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const run = gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false, startGate: gate });
    await tick(5);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    expect(mocks.runSearch).not.toHaveBeenCalled();
    open(true);
    await run;
    expect(mocks.runSearch).toHaveBeenCalled();
  });

  it('the read deadline keeps snippets and starts no read after it', async () => {
    const started = [];
    const read = (source, signal) => {
      started.push(source.url);
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(source), { once: true }));
    };
    const t0 = Date.now();
    const res = await gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false, read, readMs: 30, readGraceMs: 0 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources.every((s) => s.content === 'snippet')).toBe(true);
    expect(started.length).toBeLessThanOrEqual(16); // one wave of READ_CONCURRENCY, none after the deadline
  });

  it('plannerHardMs caps the planner call, and providers sets the search providers', async () => {
    await gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false, plannerHardMs: 25_000, providers: ['web'] });
    expect(mocks.callLLM.mock.calls[0][3]).toMatchObject({ hardMsOverride: 25_000 });
    expect(new Set(mocks.runSearch.mock.calls.map((c) => c[1]))).toEqual(new Set(['web']));
  });

  it('a planner call that fails fast is tried once more', async () => {
    mocks.callLLM
      .mockImplementationOnce(async () => { throw new Error('HTTP 429: temporarily rate-limited upstream'); })
      .mockImplementationOnce(async () => aspectsReply(['acme flip 7 long term review']));
    await gatherParallel(PRODUCT, ENGINE_CONFIG, 'k', {}, null, {}, PRODUCT, {}, { withNotes: false });
    expect(mocks.callLLM).toHaveBeenCalledTimes(2);
    expect(mocks.runSearch.mock.calls.some((c) => c[0] === 'acme flip 7 long term review')).toBe(true);
  });
});

// Search results by query: the resolve searches find the maker page, the
// claim test searches find test pages, and the gather finds review pages. One
// review page is found by both a test search and the gather.
const SHARED_URL = 'https://www.lab.example/acme-flip-7-review';
function routedSearch(log) {
  return async (query) => {
    log.push(query);
    if (query === PRODUCT || query === `${PRODUCT} specs`) {
      return [snippet('https://www.acme.com/speakers/flip-7', 'Acme Flip 7'), snippet('https://www.amazon.com/dp/B0FLIP7', 'Acme Flip 7 Speaker')];
    }
    // Claim test searches: the product name, claim words, then "review test".
    if (query.startsWith(PRODUCT) && query.endsWith('review test')) return [snippet(SHARED_URL, 'Acme Flip 7 review'), snippet(`https://www.tests.example/${log.length}/acme-flip-7`, 'Acme Flip 7 tested')];
    return [snippet(SHARED_URL, 'Acme Flip 7 review'), snippet(`https://www.blog.example/${log.length}/acme-flip-7`, 'Acme Flip 7 long term')];
  };
}

const runCheck = (config, extra = {}) => collectClaimsAndEvidence({
  product: PRODUCT,
  productUrl: null,
  config,
  apiKey: 'k',
  env: {},
  callLLM: mocks.callLLM,
  extractCallLLM: async () => claimsReply,
  ...extra,
});

describe('collectClaimsAndEvidence stage overlap', () => {
  it('starts the gather planner at once, and its searches wait for a claim page', async () => {
    const searches = [];
    const events = [];
    mocks.runSearch.mockImplementation(async (query, ...rest) => {
      events.push(`search ${query}`);
      return routedSearch(searches)(query, ...rest);
    });
    mocks.callLLM.mockImplementation(async () => {
      events.push('planner');
      return aspectsReply(['acme flip 7 review']);
    });
    mocks.readPageInto.mockImplementation(async (source) => {
      events.push(`read ${source.url}`);
      source.content = source.url.includes('acme.com') || source.url.includes('amazon.com') ? SPEC_PAGE : REVIEW_TEXT;
      return source;
    });
    const res = await runCheck({ ...ENGINE_CONFIG, maxSearches: 10 });
    expect(res.status).toBe('ok');
    const planner = events.indexOf('planner');
    const firstGatherSearch = events.findIndex((e) => e === 'search acme flip 7 review');
    const firstClaimRead = events.findIndex((e) => e.startsWith('read https://www.acme.com'));
    expect(planner).toBeGreaterThanOrEqual(0);
    expect(planner).toBeLessThan(firstClaimRead); // the planner runs during resolve
    expect(firstGatherSearch).toBeGreaterThan(firstClaimRead);
    // The gather's own page reads wait for the claims' test page reads.
    const lastTestRead = events.map((e, i) => (e.startsWith('read https://www.tests.example') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    const firstGatherRead = events.findIndex((e) => e.startsWith('read https://www.blog.example'));
    expect(lastTestRead).toBeGreaterThanOrEqual(0);
    expect(firstGatherRead).toBeGreaterThan(lastTestRead);
    expect(res.claims).toHaveLength(4);
    expect(res.marks.gatheredAt).toBeGreaterThanOrEqual(res.marks.extractedAt);
  });

  it('a page that the test searches and the gather both find is read once', async () => {
    mocks.runSearch.mockImplementation(routedSearch([]));
    mocks.readPageInto.mockImplementation(async (source) => {
      source.content = source.url.includes('acme.com') || source.url.includes('amazon.com') ? SPEC_PAGE : REVIEW_TEXT;
      return source;
    });
    const res = await runCheck({ ...ENGINE_CONFIG, maxSearches: 10 });
    const sharedReads = mocks.readPageInto.mock.calls.filter((c) => c[0].url === SHARED_URL);
    expect(sharedReads).toHaveLength(1);
    expect(res.scoredEvidence.find((s) => s.url === SHARED_URL)?.content).toBe(REVIEW_TEXT);
  });

  it('needs_url spends no gather search', async () => {
    const searches = [];
    mocks.runSearch.mockImplementation(async (query) => {
      searches.push(query);
      return query.startsWith(PRODUCT) ? [snippet('https://www.reviews.example/acme-flip-7', 'Acme Flip 7 review')] : [];
    });
    const res = await runCheck({ ...ENGINE_CONFIG, maxSearches: 10 });
    expect(res.status).toBe('needs_url');
    await tick(20);
    expect(searches).toEqual([PRODUCT, `${PRODUCT} specs`]);
  });

  it('a check without claims spends no gather search', async () => {
    const searches = [];
    mocks.runSearch.mockImplementation(async (query, ...rest) => {
      searches.push(query);
      return routedSearch([])(query, ...rest);
    });
    mocks.readPageInto.mockImplementation(async (source) => {
      source.content = SPEC_PAGE;
      return source;
    });
    const noClaims = { choices: [{ message: { content: '{"claims":[]}' } }], usage: { cost: 0 } };
    const res = await runCheck({ ...ENGINE_CONFIG, maxSearches: 10 }, { extractCallLLM: async () => noClaims });
    expect(res.status).toBe('ok');
    expect(res.claims).toEqual([]);
    expect(searches).toEqual([PRODUCT, `${PRODUCT} specs`]);
  });

  it('verifyOverlapGather false runs the gather after the test pages', async () => {
    const events = [];
    mocks.runSearch.mockImplementation(routedSearch([]));
    mocks.callLLM.mockImplementation(async () => {
      events.push('planner');
      return aspectsReply(['acme flip 7 review']);
    });
    mocks.readPageInto.mockImplementation(async (source) => {
      events.push(`read ${source.url}`);
      source.content = source.url.includes('acme.com') || source.url.includes('amazon.com') ? SPEC_PAGE : REVIEW_TEXT;
      return source;
    });
    const res = await runCheck({ ...ENGINE_CONFIG, maxSearches: 10, verifyOverlapGather: false });
    expect(res.status).toBe('ok');
    const planner = events.indexOf('planner');
    const testRead = events.findIndex((e) => e.startsWith('read https://www.tests.example'));
    expect(testRead).toBeGreaterThanOrEqual(0);
    expect(planner).toBeGreaterThan(testRead);
  });
});
