// CP-894: a cross-site page must not start paid runs through its visitors'
// browsers. A no-cors fetch with a text/plain JSON body is a simple request:
// no preflight, so removing CORS (CP-431) alone did not stop it.
// POST /api/research and POST /api/verify refuse a cross-site browser request
// before any work. Server callers (no Origin, no Sec-Fetch-Site) and callers
// with X-Worker-Secret still pass.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleStartResearch } from '../../worker/handlers/research.js';
import { handleStartVerify } from '../../worker/handlers/verify.js';

const BASE = 'https://chrisputer.tech';
const SECRET = 'test-worker-secret-894';

let sent = [];
const testEnv = { ...env, WORKER_SECRET: SECRET, RESEARCH_QUEUE: { send: async (m) => { sent.push(m); } } };

beforeAll(async () => {
  await applySchema(env.DB);
});

const jsonPost = (path, body, headers = {}) => new Request(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.94', ...headers },
  body: JSON.stringify(body),
});

// What a no-cors fetch from another site looks like.
const noCorsPost = (path, body, headers = {}) => jsonPost(path, body, {
  'Content-Type': 'text/plain;charset=UTF-8',
  Origin: 'https://evil.example',
  'Sec-Fetch-Site': 'cross-site',
  ...headers,
});

const CROSS_SITE_HEADERS = [
  { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  { Origin: 'https://evil.example' },
  { 'Sec-Fetch-Site': 'cross-site' },
  { Origin: 'null' },
];

const ENDPOINTS = [
  { path: '/api/research', handler: handleStartResearch, body: (n) => ({ query: `cp894 cross site widget ${n}` }) },
  { path: '/api/verify', handler: handleStartVerify, body: (n) => ({ product: `Cp894 Cross Site Widget ${n}` }) },
];

for (const ep of ENDPOINTS) {
  describe(`${ep.path}: cross-site guard (CP-894)`, () => {
    it('refuses a no-cors text/plain post from another site before any work', async () => {
      sent = [];
      const res = await ep.handler(noCorsPost(ep.path, ep.body('nocors')), testEnv);
      expect(res.status).toBe(403);
      expect(sent).toEqual([]);
    });

    it('refuses every cross-site header shape', async () => {
      sent = [];
      for (const [i, headers] of CROSS_SITE_HEADERS.entries()) {
        const res = await ep.handler(jsonPost(ep.path, ep.body(`shape${i}`), headers), testEnv);
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
      expect(sent).toEqual([]);
    });

    it('refuses a cross-site post through the router too', async () => {
      const res = await SELF.fetch(noCorsPost(ep.path, ep.body('router')));
      expect(res.status).toBe(403);
    });

    it('accepts our own page: same Origin, Sec-Fetch-Site same-origin', async () => {
      sent = [];
      const res = await ep.handler(
        jsonPost(ep.path, ep.body('own'), { Origin: BASE, 'Sec-Fetch-Site': 'same-origin' }),
        testEnv,
      );
      expect(res.status).toBe(200);
      expect(sent.length).toBe(1);
    });

    it('accepts a server caller that sends neither Origin nor Sec-Fetch-Site', async () => {
      sent = [];
      const res = await ep.handler(jsonPost(ep.path, ep.body('server')), testEnv);
      expect(res.status).toBe(200);
      expect(sent.length).toBe(1);
    });

    it('accepts a cross-site request that carries the worker secret', async () => {
      sent = [];
      const res = await ep.handler(
        noCorsPost(ep.path, ep.body('secret'), { 'X-Worker-Secret': SECRET }),
        testEnv,
      );
      expect(res.status).toBe(200);
      expect(sent.length).toBe(1);
    });

    it('still refuses a cross-site request with a wrong worker secret', async () => {
      sent = [];
      const res = await ep.handler(
        noCorsPost(ep.path, ep.body('badsecret'), { 'X-Worker-Secret': 'wrong' }),
        testEnv,
      );
      expect(res.status).toBe(403);
      expect(sent).toEqual([]);
    });
  });
}
