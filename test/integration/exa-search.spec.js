// exaSearch (Exa neural search) and the Brave pacing constant. fetch is
// stubbed; nothing leaves the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exaSearch, runSearch, resetProviderCooldowns, BRAVE_MIN_GAP_MS,
} from '../../worker/engine/tools.js';

const KEY = 'test-exa-key-0123456789';

const EXA_BODY = {
  requestId: 'r1',
  results: [
    {
      id: 'https://www.soundguys.com/jbl-charge-5-review-53379/',
      url: 'https://www.soundguys.com/jbl-charge-5-review-53379/',
      title: 'JBL Charge 5 review',
      publishedDate: '2025-06-05T17:09:55.000Z',
      highlights: ['JBL states the Charge 5 can achieve 20 hours of playback.', 'IP67 rated.'],
    },
    {
      id: 'https://example.com/long',
      url: 'https://example.com/long',
      title: 'Long text page',
      text: 'x'.repeat(5000),
    },
    { id: 'https://example.com/bare', url: 'https://example.com/bare', title: 'Bare' },
  ],
  costDollars: { total: 0.004 },
};

function stubJson(status, body) {
  const spy = vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => resetProviderCooldowns());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exaSearch', () => {
  it('maps results to the shared row shape', async () => {
    const spy = stubJson(200, EXA_BODY);
    const rows = await exaSearch('JBL Charge 5 review', KEY);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      url: 'https://www.soundguys.com/jbl-charge-5-review-53379/',
      title: 'JBL Charge 5 review',
      content: 'JBL states the Charge 5 can achieve 20 hours of playback.\nIP67 rated.',
      source: 'web',
      publishedAt: Math.floor(Date.parse('2025-06-05T17:09:55.000Z') / 1000),
    });
    expect(rows[1].content).toHaveLength(1000);
    expect(rows[1].publishedAt).toBeUndefined();
    expect(rows[2].content).toBe('');

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.exa.ai/search');
    expect(init.headers['x-api-key']).toBe(KEY);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ query: 'JBL Charge 5 review', numResults: 10, type: 'instant' });
    expect(body.startPublishedDate).toBeUndefined();
  });

  it('sends a one-year startPublishedDate for recency-sensitive searches', async () => {
    const spy = stubJson(200, EXA_BODY);
    await exaSearch('q', KEY, { timeRange: 'y' });
    const { startPublishedDate } = JSON.parse(spy.mock.calls[0][1].body);
    const ageDays = (Date.now() - Date.parse(startPublishedDate)) / 86400000;
    expect(Math.round(ageDays)).toBe(365);
  });

  it('returns null without a key and makes no request', async () => {
    const spy = stubJson(200, EXA_BODY);
    expect(await exaSearch('q', undefined)).toBeNull();
    expect(await exaSearch('q', '')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns [] for a genuine empty result', async () => {
    stubJson(200, { requestId: 'r2', results: [] });
    expect(await exaSearch('q', KEY)).toEqual([]);
  });

  it('returns [] on a network error or timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('aborted'); }));
    expect(await exaSearch('q', KEY)).toEqual([]);
  });

  it('402 starts a cooldown: null now, no request on the next call', async () => {
    const log = vi.spyOn(console, 'log');
    const spy = stubJson(402, '{"error":"Insufficient credits"}');
    expect(await exaSearch('q', KEY)).toBeNull();
    expect(await exaSearch('q', KEY)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const lines = log.mock.calls.map((args) => args.join(' '));
    expect(lines.some((l) => l.includes('[exa] out of credit'))).toBe(true);
    expect(lines.some((l) => l.includes(KEY))).toBe(false);
  });

  it('401 returns null without a cooldown', async () => {
    const spy = stubJson(401, 'Unauthorized');
    expect(await exaSearch('q', KEY)).toBeNull();
    expect(await exaSearch('q', KEY)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('exa in the engine search chain', () => {
  const hostCalls = (spy, host) => spy.mock.calls.filter(([u]) => String(u).includes(host)).length;

  it('provider "exa" calls Exa and returns its rows', async () => {
    const spy = stubJson(200, EXA_BODY);
    const sources = await runSearch('JBL Charge 5 review', 'exa', { EXA_API_KEY: KEY });
    expect(hostCalls(spy, 'api.exa.ai')).toBe(1);
    expect(sources.map((s) => s.url)).toContain('https://www.soundguys.com/jbl-charge-5-review-53379/');
  });

  it('web falls back to Exa when Brave is unavailable', async () => {
    const spy = vi.fn(async (url) => (String(url).includes('api.search.brave.com')
      ? new Response('Unauthorized', { status: 401 })
      : new Response(JSON.stringify(EXA_BODY), { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const sources = await runSearch('JBL Charge 5 review', 'web', { BRAVE_API_KEY: KEY, EXA_API_KEY: KEY });
    expect(hostCalls(spy, 'api.search.brave.com')).toBe(1);
    expect(hostCalls(spy, 'api.exa.ai')).toBe(1);
    expect(sources.length).toBeGreaterThan(0);
  });

  it('web does not call Exa when Brave answers', async () => {
    const spy = vi.fn(async (url) => (String(url).includes('api.search.brave.com')
      ? new Response(JSON.stringify({ web: { results: [{ url: 'https://rtings.com/a', title: 'A', description: 'd' }] } }), { status: 200 })
      : new Response(JSON.stringify(EXA_BODY), { status: 200 })));
    vi.stubGlobal('fetch', spy);
    await runSearch('JBL Charge 5 review', 'web', { BRAVE_API_KEY: KEY, EXA_API_KEY: KEY });
    expect(hostCalls(spy, 'api.exa.ai')).toBe(0);
  });
});

describe('Brave pacing', () => {
  it('BRAVE_MIN_GAP_MS is 25 ms (40 requests/s, under the paid 50/s cap)', () => {
    expect(BRAVE_MIN_GAP_MS).toBe(25);
  });
});
