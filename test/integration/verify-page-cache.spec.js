// Saved evidence pages in a verify run (CP-789): a second run of the same
// product inside 30 days judges the same pages without a new gather, an
// internal forceFresh run gathers again, and a bad saved entry is ignored.
// The LLM and the search/read tools are mocked, and fetch is stubbed, so no
// spec uses the network.
import { env as testEnv } from 'cloudflare:test';
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

const { collectClaimsAndEvidence, keepClaimsByOutcome, savePagesByOutcome } = await import('../../worker/engine/verify.js');
const { ENGINE_CONFIG } = await import('../../worker/lib/engine-config.js');
const { pageCacheKey, readSavedPages, writeSavedPages, PAGE_CACHE_WEAK_TTL_SECONDS } = await import('../../worker/lib/page-cache.js');

const SCORED = { score: 70 };

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

const aspectsReply = {
  choices: [{ message: { content: JSON.stringify({ aspects: [{ title: 'Reviews', queries: ['acme flip 7 review'] }] }) } }],
  usage: { cost: 0.002 },
};
const claimsReply = {
  choices: [{ message: { content: JSON.stringify({ claims: ['Up to 14 hours of playtime', 'IP68 water resistance', 'Bluetooth 5.4', '45 mm woofer'].map((text) => ({ text, type: 'spec' })) }) } }],
  usage: { cost: 0.001 },
};
const snippet = (url, title) => ({ url, title, content: 'snippet', source: 'web', credibility: { score: 70, tags: [] } });

// Each run finds different review pages (the search counter is in the URL),
// as the live gather does.
let searchCount = 0;
function search(product) {
  return async (query) => {
    searchCount += 1;
    if (query === product || query === `${product} specs`) {
      return [snippet('https://www.acme.com/speakers/flip-7', product), snippet('https://www.amazon.com/dp/B0FLIP7', `${product} Speaker`)];
    }
    return [snippet(`https://www.lab.example/${searchCount}/acme-flip-7-review`, `${product} review`)];
  };
}

const memoryKv = () => {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { puts.push({ key, opts }); store.set(key, value); },
  };
};

const runCheck = (product, kv, extra = {}) => collectClaimsAndEvidence({
  product,
  productUrl: null,
  config: { ...ENGINE_CONFIG, maxSearches: 10 },
  apiKey: 'k',
  env: { KV: kv },
  callLLM: mocks.callLLM,
  extractCallLLM: async () => claimsReply,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  searchCount = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  mocks.callLLM.mockImplementation(async () => aspectsReply);
  mocks.readPageInto.mockImplementation(async (source) => {
    source.content = source.url.includes('acme.com') || source.url.includes('amazon.com') ? SPEC_PAGE : REVIEW_TEXT;
    return source;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('verify saved pages (CP-789)', () => {
  it('the same product twice judges the same page set, and the second run gathers nothing', async () => {
    const kv = memoryKv();
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const first = await runCheck('Acme Flip 7', kv);
    expect(first.status).toBe('ok');
    expect(first.fromSavedPages).toBe(false);
    expect(first.scoredEvidence.length).toBeGreaterThan(0);
    expect(kv.store.has(pageCacheKey('Acme Flip 7'))).toBe(false); // nothing saved before the judges ran
    await savePagesByOutcome(kv, 'Acme Flip 7', null, first, SCORED);
    expect(kv.store.has(pageCacheKey('Acme Flip 7'))).toBe(true);

    vi.clearAllMocks();
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const second = await runCheck('Acme Flip 7', kv);
    expect(second.status).toBe('ok');
    expect(second.fromSavedPages).toBe(true);
    expect(second.scoredEvidence).toEqual(first.scoredEvidence);
    expect(second.claims).toEqual(first.claims);
    expect(second.claimSources.map((s) => s.url)).toEqual(first.claimSources.map((s) => s.url));
    expect(second.costUsd).toBe(0);
    expect(mocks.runSearch).not.toHaveBeenCalled();
    expect(mocks.readPageInto).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
    // A run that reused the pages saves nothing, so the 30 days do not restart.
    const puts = kv.puts.length;
    await savePagesByOutcome(kv, 'Acme Flip 7', null, second, SCORED);
    expect(kv.puts.length).toBe(puts);
  });

  it('a check with no score or too few claims saves no pages', async () => {
    const kv = memoryKv();
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const res = await runCheck('Acme Flip 7', kv);
    await savePagesByOutcome(kv, 'Acme Flip 7', null, res, { score: null });
    await savePagesByOutcome(kv, 'Acme Flip 7', null, { ...res, claims: res.claims.slice(0, 3) }, SCORED);
    expect(kv.store.has(pageCacheKey('Acme Flip 7'))).toBe(false);
  });

  it('saved pages with fewer than 4 testable claims are ignored', async () => {
    const kv = memoryKv();
    const sources = [{ url: 'https://www.lab.example/x', title: 't', content: REVIEW_TEXT, credibility: 70, independence: 70, tags: [] }];
    await writeSavedPages(kv, 'Acme Flip 7', null, { claims: [{ text: 'Up to 14 hours of playtime', type: 'spec' }], claimSources: [], sources });
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const res = await runCheck('Acme Flip 7', kv);
    expect(res.fromSavedPages).toBe(false);
    expect(mocks.runSearch).toHaveBeenCalled();
  });

  it('forceFresh gathers again and leaves the saved pages alone', async () => {
    const kv = memoryKv();
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const first = await runCheck('Acme Flip 7', kv);
    await savePagesByOutcome(kv, 'Acme Flip 7', null, first, SCORED);
    const fresh = await runCheck('Acme Flip 7', kv, { forceFresh: true });
    await savePagesByOutcome(kv, 'Acme Flip 7', null, fresh, SCORED, { forceFresh: true });
    expect(fresh.fromSavedPages).toBe(false);
    expect(fresh.scoredEvidence.map((s) => s.url)).not.toEqual(first.scoredEvidence.map((s) => s.url));
    const saved = await readSavedPages(kv, 'Acme Flip 7');
    expect(saved.sources.map((s) => s.url)).toEqual(first.scoredEvidence.map((s) => s.url));
  });

  it('a bad saved entry is ignored and logged, and the run gathers again', async () => {
    const kv = memoryKv();
    kv.store.set(pageCacheKey('Acme Flip 7'), '{not json');
    const warn = vi.spyOn(console, 'warn');
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    const res = await runCheck('Acme Flip 7', kv);
    expect(res.fromSavedPages).toBe(false);
    expect(mocks.runSearch).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[page-cache]'))).toBe(true);
    await savePagesByOutcome(kv, 'Acme Flip 7', null, res, SCORED);
    expect((await readSavedPages(kv, 'Acme Flip 7')).sources.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('works with the real KV binding', async () => {
    mocks.runSearch.mockImplementation(search('Acme Flip 8'));
    const first = await runCheck('Acme Flip 8', testEnv.KV);
    await savePagesByOutcome(testEnv.KV, 'Acme Flip 8', null, first, SCORED);
    const second = await runCheck('Acme Flip 8', testEnv.KV);
    expect(second.fromSavedPages).toBe(true);
    expect(second.scoredEvidence).toEqual(first.scoredEvidence);
  });

  it('a check with no score keeps its saved pages one day', async () => {
    const kv = memoryKv();
    mocks.runSearch.mockImplementation(search('Acme Flip 7'));
    await savePagesByOutcome(kv, 'Acme Flip 7', null, await runCheck('Acme Flip 7', kv), SCORED);
    await keepClaimsByOutcome(kv, 'Acme Flip 7', null, { score: null });
    const shortened = kv.puts.filter((p) => p.key === pageCacheKey('Acme Flip 7')).at(-1);
    expect(shortened.opts.expirationTtl).toBe(PAGE_CACHE_WEAK_TTL_SECONDS);
  });
});
