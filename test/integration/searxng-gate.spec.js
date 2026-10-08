// The self-hosted SearXNG is published at litellm.wafflemedia.net/search behind
// the same BunkerWeb X-Edge-Gate header gate as LiteLLM. searxngSearch must send
// the header when env.LITELLM_GATE_TOKEN is set, omit it when it is not, and
// never write the token to the log. fetch is stubbed; nothing leaves the test.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSearch } from '../../worker/engine/tools.js';

const BASE_URL = 'https://searx.example.test';
const TOKEN = 'ab'.repeat(32);
const GATE_HEADER = 'x-edge-gate';
const BODY = { results: [{ url: 'https://rtings.com/nas', title: 'NAS review', content: 'c' }] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch() {
  const spy = vi.fn(async () => new Response(JSON.stringify(BODY), { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function searxngCall(spy) {
  const call = spy.mock.calls.find(([url]) => String(url).startsWith(`${BASE_URL}/search?`));
  expect(call).toBeDefined();
  return new Headers(call[1]?.headers);
}

describe('searxngSearch edge gate header', () => {
  it('sends X-Edge-Gate when LITELLM_GATE_TOKEN is set', async () => {
    const spy = stubFetch();
    const sources = await runSearch('best nas', 'searxng', { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: TOKEN });
    expect(searxngCall(spy).get(GATE_HEADER)).toBe(TOKEN);
    expect(sources.map((s) => s.url)).toContain('https://rtings.com/nas');
  });

  it('trims the token before it sends it', async () => {
    const spy = stubFetch();
    await runSearch('best nas', 'searxng', { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: `  ${TOKEN}\n` });
    expect(searxngCall(spy).get(GATE_HEADER)).toBe(TOKEN);
  });

  it('omits X-Edge-Gate when LITELLM_GATE_TOKEN is absent or blank', async () => {
    for (const env of [{ SEARXNG_URL: BASE_URL }, { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: '   ' }]) {
      const spy = stubFetch();
      await runSearch('best nas', 'searxng', env);
      expect(searxngCall(spy).has(GATE_HEADER)).toBe(false);
    }
  });

  it('sends the header on the web fallback path too', async () => {
    const spy = stubFetch();
    await runSearch('best nas', 'web', { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: TOKEN });
    expect(searxngCall(spy).get(GATE_HEADER)).toBe(TOKEN);
  });

  it('never logs the token, on success or on a 403', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    stubFetch();
    await runSearch('best nas', 'searxng', { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: TOKEN });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await runSearch('best nas', 'searxng', { SEARXNG_URL: BASE_URL, LITELLM_GATE_TOKEN: TOKEN });
    const printed = logs.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');
    expect(printed).not.toContain(TOKEN);
  });
});
