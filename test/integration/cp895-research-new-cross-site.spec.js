// CP-895: GET|POST /research/new builds its own internal request to
// handleStartResearch, so the CP-894 guard never saw the browser's headers.
// Another site could start a paid run with a cross-site form post, or with an
// embed such as <img src="/research/new?q=...&skip_clarify=1">.
// The handler now refuses a cross-site post, and a cross-site GET that is not
// a top-level page load. A shared link a person clicks still works.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleNewResearch } from '../../worker/routes/pages.js';

const BASE = 'https://chrisputer.tech';

let sent = [];
const testEnv = { ...env, RESEARCH_QUEUE: { send: async (m) => { sent.push(m); } } };

beforeAll(async () => {
  await applySchema(env.DB);
});

const getNew = (q, headers = {}) => {
  const url = new URL('/research/new', BASE);
  url.searchParams.set('q', q);
  url.searchParams.set('skip_clarify', '1');
  return new Request(url, { headers: { 'CF-Connecting-IP': '198.51.100.95', ...headers } });
};

const postNew = (q, headers = {}) => new Request(`${BASE}/research/new`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'CF-Connecting-IP': '198.51.100.95',
    ...headers,
  },
  body: new URLSearchParams({ q, skip_clarify: '1' }).toString(),
});

const run = (req) => handleNewResearch(req, new URL(req.url), testEnv);

const startedRun = (res) => res.status === 302
  && new URL(res.headers.get('Location')).pathname.startsWith('/research/')
  && !new URL(res.headers.get('Location')).searchParams.has('q');

const CLICK = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

describe('POST /research/new: cross-site guard (CP-895)', () => {
  const crossSite = [
    { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'https://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: 'null' },
  ];

  it('refuses every cross-site header shape before any work', async () => {
    sent = [];
    for (const [i, headers] of crossSite.entries()) {
      const res = await run(postNew(`cp895 post widget ${i}`, headers));
      expect(startedRun(res), JSON.stringify(headers)).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('refuses a cross-site form post even when it looks like a page load', async () => {
    sent = [];
    const res = await run(postNew('cp895 post click widget', { ...CLICK, Origin: 'https://evil.example' }));
    expect(startedRun(res)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('accepts our own re-run form', async () => {
    sent = [];
    const res = await run(postNew('cp895 post own widget', { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }));
    expect(startedRun(res)).toBe(true);
    expect(sent.length).toBe(1);
  });
});

describe('GET /research/new: cross-site guard (CP-895)', () => {
  const embeds = [
    { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' },
    { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
    { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
    { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];

  it('refuses a cross-site embed or fetch before any work', async () => {
    sent = [];
    for (const [i, headers] of embeds.entries()) {
      const res = await run(getNew(`cp895 embed widget ${i}`, headers));
      expect(startedRun(res), JSON.stringify(headers)).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('refuses an image embed through the router too', async () => {
    const res = await SELF.fetch(getNew('cp895 router embed widget', embeds[0]), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')).pathname).toBe('/research');
  });

  it('accepts a shared link a person clicks on another site', async () => {
    sent = [];
    const res = await run(getNew('cp895 shared link widget', CLICK));
    expect(startedRun(res)).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('accepts our own search form', async () => {
    sent = [];
    const res = await run(getNew('cp895 own form widget', {
      'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
    }));
    expect(startedRun(res)).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('accepts a typed URL or bookmark (Sec-Fetch-Site none)', async () => {
    sent = [];
    const res = await run(getNew('cp895 typed url widget', {
      'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document',
    }));
    expect(startedRun(res)).toBe(true);
    expect(sent.length).toBe(1);
  });

  it('refuses before the clarify classifier runs', async () => {
    sent = [];
    const url = new URL('/research/new', BASE);
    url.searchParams.set('q', 'cp895 clarify widget');
    const req = new Request(url, { headers: embeds[0] });
    const res = await handleNewResearch(req, url, { ...testEnv, OPENROUTER_API_KEY: undefined });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')).pathname).toBe('/research');
    expect(sent).toEqual([]);
  });
});
