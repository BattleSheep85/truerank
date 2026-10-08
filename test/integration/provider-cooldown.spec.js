// A search provider that answers out of credit (402, or 400/403/429 with
// credit/quota/balance text) is skipped for PROVIDER_COOLDOWN_MS, so later
// searches stop wasting a request on it. fetch and Date.now are stubbed;
// nothing leaves the test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSearch, resetProviderCooldowns, PROVIDER_COOLDOWN_MS } from '../../worker/engine/tools.js';

const KEY = 'test-provider-key-0123456789';
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const OK_BODY = { organic: [], results: [], web: { results: [] } };

let now = T0;

beforeEach(() => {
  resetProviderCooldowns();
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Answers `host` with `status`/`text`, every other host with an empty 200.
function stubFetch(host, status, text) {
  const spy = vi.fn(async (url) => (String(url).includes(host)
    ? new Response(text, { status })
    : new Response(JSON.stringify(OK_BODY), { status: 200 })));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const callsTo = (spy, host) => spy.mock.calls.filter(([url]) => String(url).includes(host)).length;

describe('provider out-of-credit cooldown', () => {
  it('PROVIDER_COOLDOWN_MS is 10 minutes', () => {
    expect(PROVIDER_COOLDOWN_MS).toBe(600000);
  });

  it('serper: 400 "Not enough credits" starts a cooldown; it retries after 10 minutes', async () => {
    const log = vi.spyOn(console, 'log');
    const spy = stubFetch('google.serper.dev', 400, '{"message":"Not enough credits"}');
    const env = { SERPER_API_KEY: KEY };

    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'google.serper.dev')).toBe(1);

    now = T0 + PROVIDER_COOLDOWN_MS - 1;
    await runSearch('best nas', 'web', env);
    await runSearch('nas review', 'news', env);
    expect(callsTo(spy, 'google.serper.dev')).toBe(1);

    now = T0 + PROVIDER_COOLDOWN_MS;
    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'google.serper.dev')).toBe(2);

    const lines = log.mock.calls.map((args) => args.join(' '));
    expect(lines.filter((l) => l.includes('[serper] out of credit'))).toHaveLength(2);
    expect(lines.some((l) => l.includes(KEY))).toBe(false);
  });

  it('a plain 400 does not start a cooldown', async () => {
    const spy = stubFetch('google.serper.dev', 400, '{"message":"Bad request: q missing"}');
    const env = { SERPER_API_KEY: KEY };
    await runSearch('best nas', 'web', env);
    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'google.serper.dev')).toBe(2);
  });

  it('a 401 falls back but does not start a cooldown', async () => {
    const spy = stubFetch('google.serper.dev', 401, 'Unauthorized');
    const env = { SERPER_API_KEY: KEY };
    await runSearch('best nas', 'web', env);
    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'google.serper.dev')).toBe(2);
  });

  it('serper-videos: 402 starts its own cooldown and leaves web serper alone', async () => {
    const spy = vi.fn(async (url) => (String(url).includes('/videos')
      ? new Response('Payment Required', { status: 402 })
      : new Response(JSON.stringify(OK_BODY), { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const env = { SERPER_API_KEY: KEY };

    await runSearch('nas review', 'video', env);
    await runSearch('nas review', 'video', env);
    expect(callsTo(spy, 'google.serper.dev/videos')).toBe(1);
    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'google.serper.dev/search')).toBe(1);
  });

  it('brave: 429 with quota text starts a cooldown', async () => {
    const spy = stubFetch('api.search.brave.com', 429, '{"error":"Quota exceeded for plan"}');
    const env = { BRAVE_API_KEY: KEY };
    await runSearch('best nas', 'web', env);
    await runSearch('best nas', 'web', env);
    expect(callsTo(spy, 'api.search.brave.com')).toBe(1);
  });

  it('tavily: 403 with balance text starts a cooldown', async () => {
    const spy = stubFetch('api.tavily.com', 403, '{"detail":"Insufficient balance"}');
    const env = { TAVILY_API_KEY: KEY };
    await runSearch('best nas', 'tavily', env);
    await runSearch('best nas', 'tavily', env);
    expect(callsTo(spy, 'api.tavily.com')).toBe(1);
  });
});
