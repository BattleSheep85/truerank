// CP-713: the engine's web search caches usable SearXNG answers in KV for a
// few hours, so a repeat run of the same query does not hit the free engines
// again. Real Miniflare KV; fetch is stubbed, nothing leaves the test.
import { env } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSearch } from '../../worker/engine/tools.js';
import { searxngCacheKey } from '../../worker/engine/searxng.js';

const BASE_URL = 'https://searx-cache.example.test';
const BODY = {
  results: [
    { url: 'https://rtings.com/nas', title: 'NAS review', content: 'c' },
    { url: 'https://reddit.com/r/homelab/comments/x1/best_nas', title: 'Best NAS for a homelab?', content: 'c' },
    { url: 'https://smallnetbuilder.com/nas-review', title: 'NAS review roundup', content: 'c' },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const searxngCalls = (spy) => spy.mock.calls.filter(([url]) => String(url).startsWith(`${BASE_URL}/search?`)).length;

describe('SearXNG KV cache (CP-713)', () => {
  it('answers a repeat query from KV without a second SearXNG request', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const searchEnv = { SEARXNG_URL: BASE_URL, KV: env.KV };

    const first = await runSearch('best nas cache', 'searxng', searchEnv);
    const second = await runSearch('best nas cache', 'searxng', searchEnv);

    expect(searxngCalls(spy)).toBe(1);
    expect(second.map((s) => s.url)).toEqual(first.map((s) => s.url));
    const key = await searxngCacheKey('best nas cache', 'web', {});
    expect(await env.KV.get(key, 'json')).toEqual(BODY);
  });

  it('does not cache a failed request', async () => {
    const spy = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', spy);
    const searchEnv = { SEARXNG_URL: BASE_URL, KV: env.KV };

    await runSearch('best nas failing', 'searxng', searchEnv);
    const key = await searxngCacheKey('best nas failing', 'web', {});
    expect(await env.KV.get(key)).toBeNull();
  });

  it('a forceFresh run (SEARXNG_CACHE_BYPASS) searches again and refreshes the cache (CP-819)', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await runSearch('best nas bypass', 'searxng', { SEARXNG_URL: BASE_URL, KV: env.KV });
    await runSearch('best nas bypass', 'web', { SEARXNG_URL: BASE_URL, KV: env.KV, SEARXNG_CACHE_BYPASS: true });
    await runSearch('best nas bypass', 'searxng', { SEARXNG_URL: BASE_URL, KV: env.KV, SEARXNG_CACHE_BYPASS: 'true' });
    expect(searxngCalls(spy)).toBe(2);
  });
});
