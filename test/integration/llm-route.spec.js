// Contract tests for worker/lib/llm-route.js (docs/litellm-2026-10.md D2 to D5).
// Pure logic: route selection from env, request shaping per route, fallback
// statuses, and cost from usage. No network calls.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as llmRoute from '../../worker/lib/llm-route.js';
import {
  LITELLM_MODEL_MAP,
  LITELLM_PRICES,
  llmRouteFromEnv,
  resolveRoute,
  buildRequest,
  isFallbackStatus,
  costFromUsage,
} from '../../worker/lib/llm-route.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const LITELLM_BASE = 'https://llm.example.test';

const litellmEnv = (overrides = {}) => ({
  LLM_PROVIDER: 'litellm',
  LITELLM_BASE_URL: LITELLM_BASE,
  LITELLM_API_KEY: 'sk-litellm-test',
  OPENROUTER_API_KEY: 'sk-or-test',
  ...overrides,
});

const litellmRoute = () => llmRouteFromEnv(litellmEnv());
const openrouterRoute = () => llmRouteFromEnv({ OPENROUTER_API_KEY: 'sk-or-test' });

const sampleBody = () => ({
  model: 'anthropic/claude-haiku-4.5',
  models: ['anthropic/claude-haiku-4.5', 'google/gemini-3.8-flash'],
  provider: { order: ['anthropic'], allow_fallbacks: false },
  reasoning: { effort: 'high' },
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  max_tokens: 1024,
  temperature: 0,
  usage: { include: true },
});

describe('LITELLM_MODEL_MAP and LITELLM_PRICES', () => {
  it('maps each production model to its LiteLLM model (D3)', () => {
    expect(LITELLM_MODEL_MAP).toEqual({
      'google/gemini-3.8-flash': 'google/gemini-3.8-flash',
    });
  });

  it('has a price for every mapped LiteLLM model (D4)', () => {
    for (const target of Object.values(LITELLM_MODEL_MAP)) {
      expect(LITELLM_PRICES[target], target).toBeDefined();
    }
    expect(LITELLM_PRICES['google/gemini-3.8-flash']).toEqual({ in: 7.5e-7, out: 3.75e-6 });
    expect(LITELLM_PRICES['anthropic/claude-haiku-4-5']).toEqual({ in: 1e-6, out: 5e-6 });
    expect(LITELLM_PRICES['anthropic/claude-sonnet-5']).toEqual({ in: 2e-6, out: 1e-5 });
  });

  it('both tables are frozen', () => {
    expect(Object.isFrozen(LITELLM_MODEL_MAP)).toBe(true);
    expect(Object.isFrozen(LITELLM_PRICES)).toBe(true);
  });
});

describe('llmRouteFromEnv', () => {
  it('selects litellm when provider, http(s) base URL, and key are all set', () => {
    const route = llmRouteFromEnv(litellmEnv());
    expect(route.kind).toBe('litellm');
    expect(route.baseUrl).toBe(LITELLM_BASE);
    expect(route.apiKey).toBe('sk-litellm-test');
  });

  it('accepts a plain http base URL', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_BASE_URL: 'http://10.0.0.5:4000' }));
    expect(route.kind).toBe('litellm');
    expect(route.baseUrl).toBe('http://10.0.0.5:4000');
  });

  it('sets an OpenRouter fallback on the litellm route when an OpenRouter key exists', () => {
    const route = llmRouteFromEnv(litellmEnv());
    expect(route.fallback).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-test' });
  });

  it('has no fallback on the litellm route without an OpenRouter key', () => {
    const route = llmRouteFromEnv(litellmEnv({ OPENROUTER_API_KEY: undefined }));
    expect(route.kind).toBe('litellm');
    expect(route.fallback).toBeNull();
  });

  it('removes a trailing slash from LITELLM_BASE_URL', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_BASE_URL: `${LITELLM_BASE}/` }));
    expect(route.baseUrl).toBe(LITELLM_BASE);
  });

  it('defaults to openrouter with an empty env', () => {
    const route = llmRouteFromEnv({});
    expect(route.kind).toBe('openrouter');
    expect(route.baseUrl).toBe(OPENROUTER_BASE);
    expect(route.fallback).toBeNull();
  });

  it('uses openrouter with the OpenRouter key when LLM_PROVIDER is unset', () => {
    const route = llmRouteFromEnv(litellmEnv({ LLM_PROVIDER: undefined }));
    expect(route).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-test', baseUrl: OPENROUTER_BASE });
    expect(route.fallback).toBeNull();
  });

  it('uses openrouter when LLM_PROVIDER is "openrouter"', () => {
    const route = llmRouteFromEnv(litellmEnv({ LLM_PROVIDER: 'openrouter' }));
    expect(route).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-test', baseUrl: OPENROUTER_BASE });
  });

  it('falls back to openrouter when LITELLM_BASE_URL is missing', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_BASE_URL: undefined }));
    expect(route).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-test', baseUrl: OPENROUTER_BASE });
  });

  it.each([
    ['not a url'],
    ['ftp://llm.example.test'],
    ['javascript:alert(1)'],
    [''],
  ])('falls back to openrouter when LITELLM_BASE_URL is not http(s): %s', (baseUrl) => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_BASE_URL: baseUrl }));
    expect(route.kind).toBe('openrouter');
    expect(route.baseUrl).toBe(OPENROUTER_BASE);
  });

  it('falls back to openrouter when LITELLM_API_KEY is missing', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_API_KEY: undefined }));
    expect(route).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-test', baseUrl: OPENROUTER_BASE });
  });

  it('falls back to openrouter when LITELLM_API_KEY is empty', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_API_KEY: '' }));
    expect(route.kind).toBe('openrouter');
  });

  it('returns a frozen route with a frozen fallback', () => {
    const route = llmRouteFromEnv(litellmEnv());
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.fallback)).toBe(true);
    expect(Object.isFrozen(openrouterRoute())).toBe(true);
  });
});

describe('resolveRoute', () => {
  it('treats a plain string as an OpenRouter key (backward compatibility)', () => {
    const route = resolveRoute('sk-or-legacy');
    expect(route).toMatchObject({ kind: 'openrouter', apiKey: 'sk-or-legacy', baseUrl: OPENROUTER_BASE });
    expect(route.fallback ?? null).toBeNull();
  });

  it('returns a route object as an equal route', () => {
    const input = litellmRoute();
    expect(resolveRoute(input)).toEqual(input);
  });

  it('returns frozen routes', () => {
    expect(Object.isFrozen(resolveRoute('sk-or-legacy'))).toBe(true);
    expect(Object.isFrozen(resolveRoute(litellmRoute()))).toBe(true);
  });

  it('a string key builds the same OpenRouter request as an env route', () => {
    const fromString = buildRequest(resolveRoute('sk-or-test'), 'google/gemini-3.8-flash', sampleBody());
    const fromEnv = buildRequest(openrouterRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(fromString).toEqual(fromEnv);
  });
});

describe('buildRequest: litellm', () => {
  it('posts to baseUrl + /v1/chat/completions with the LiteLLM key', () => {
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.url).toBe(`${LITELLM_BASE}/v1/chat/completions`);
    expect(req.headers.Authorization).toBe('Bearer sk-litellm-test');
  });

  it('builds the URL without a double slash when the base URL had a trailing slash', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_BASE_URL: `${LITELLM_BASE}/` }));
    const req = buildRequest(route, 'google/gemini-3.8-flash', sampleBody());
    expect(req.url).toBe(`${LITELLM_BASE}/v1/chat/completions`);
  });

  it.each(Object.entries({
    'google/gemini-3.8-flash': 'google/gemini-3.8-flash',
  }))('maps %s to %s in the result and the body', (from, to) => {
    const req = buildRequest(litellmRoute(), from, { ...sampleBody(), model: from });
    expect(req.model).toBe(to);
    expect(req.body.model).toBe(to);
  });

  it.each(['minimax/minimax-m3', 'anthropic/claude-haiku-4.5'])(
    'returns null for %s by default so it falls back to OpenRouter',
    (model) => {
      expect(buildRequest(litellmRoute(), model, sampleBody())).toBeNull();
    },
  );

  it('returns null for an unmapped model so the caller uses the fallback', () => {
    expect(buildRequest(litellmRoute(), 'x-ai/grok-4', sampleBody())).toBeNull();
    expect(buildRequest(litellmRoute(), 'some/unknown-model', sampleBody())).toBeNull();
  });

  it('strips OpenRouter-only fields: provider, models, reasoning object', () => {
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.body).not.toHaveProperty('provider');
    expect(req.body).not.toHaveProperty('models');
    expect(req.body).not.toHaveProperty('reasoning');
  });

  it('strips the OpenRouter-only usage field', () => {
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.body).not.toHaveProperty('usage');
  });

  it('keeps the other body fields', () => {
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.body.stream).toBe(true);
    expect(req.body.max_tokens).toBe(1024);
    expect(req.body.temperature).toBe(0);
  });

  it.each(['low', 'medium', 'high'])('sends reasoning effort %s as reasoning_effort', (effort) => {
    const body = { ...sampleBody(), reasoning: { effort } };
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', body);
    expect(req.body.reasoning_effort).toBe(effort);
    expect(req.body).not.toHaveProperty('reasoning');
  });

  it('sends no reasoning_effort when the body has no reasoning', () => {
    const { reasoning, ...body } = sampleBody();
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', body);
    expect(req.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends no reasoning_effort for an effort outside low|medium|high', () => {
    const body = { ...sampleBody(), reasoning: { effort: 'minimal' } };
    const req = buildRequest(litellmRoute(), 'google/gemini-3.8-flash', body);
    expect(req.body).not.toHaveProperty('reasoning_effort');
    expect(req.body).not.toHaveProperty('reasoning');
  });

  it('does not mutate the input body', () => {
    const body = sampleBody();
    buildRequest(litellmRoute(), 'google/gemini-3.8-flash', body);
    expect(body).toEqual(sampleBody());
  });
});

describe('buildRequest: openrouter', () => {
  it('posts to the OpenRouter URL with today\'s headers', () => {
    const req = buildRequest(openrouterRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.url).toBe(`${OPENROUTER_BASE}/chat/completions`);
    expect(req.headers).toMatchObject({
      Authorization: 'Bearer sk-or-test',
      'HTTP-Referer': 'https://chrisputer.tech',
      'X-Title': 'Frank',
    });
  });

  it('keeps the model and the body unchanged', () => {
    const req = buildRequest(openrouterRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.model).toBe('google/gemini-3.8-flash');
    expect(req.body).toEqual(sampleBody());
  });

  it('keeps the usage field', () => {
    const req = buildRequest(openrouterRoute(), 'google/gemini-3.8-flash', sampleBody());
    expect(req.body.usage).toEqual({ include: true });
  });

  it('does not map or reject models outside the LiteLLM map', () => {
    const req = buildRequest(openrouterRoute(), 'some/unknown-model', sampleBody());
    expect(req).not.toBeNull();
    expect(req.model).toBe('some/unknown-model');
  });
});

describe('buildRequest: frozen output', () => {
  it('returns a frozen request with frozen headers on both routes', () => {
    for (const route of [litellmRoute(), openrouterRoute()]) {
      const req = buildRequest(route, 'google/gemini-3.8-flash', sampleBody());
      expect(Object.isFrozen(req), route.kind).toBe(true);
      expect(Object.isFrozen(req.headers), route.kind).toBe(true);
    }
  });
});

describe('isFallbackStatus', () => {
  it.each([401, 403, 404, 429, 500, 502, 503, 504, 599])('is true for %i', (status) => {
    expect(isFallbackStatus(status)).toBe(true);
  });

  it.each([200, 201, 204, 400, 402, 413, 422, 499, 600])('is false for %i', (status) => {
    expect(isFallbackStatus(status)).toBe(false);
  });
});

describe('costFromUsage', () => {
  it('uses usage.cost when it is a finite number', () => {
    const usage = { cost: 0.0123, prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };
    expect(costFromUsage('google/gemini-3.8-flash', usage)).toBe(0.0123);
  });

  it('uses usage.cost of 0 as-is', () => {
    const usage = { cost: 0, prompt_tokens: 1000, completion_tokens: 1000 };
    expect(costFromUsage('anthropic/claude-sonnet-5', usage)).toBe(0);
  });

  it('computes cost from the price table when usage.cost is absent', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 2000 };
    // 1000 * 7.5e-7 + 2000 * 3.75e-6 = 0.00075 + 0.0075
    expect(costFromUsage('google/gemini-3.8-flash', usage)).toBeCloseTo(0.00825, 12);
  });

  it('computes cost for each priced model', () => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000 };
    expect(costFromUsage('anthropic/claude-sonnet-5', usage)).toBeCloseTo(3, 9);
    expect(costFromUsage('anthropic/claude-haiku-4-5', usage)).toBeCloseTo(1.5, 9);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '0.5'],
    ['null', null],
  ])('ignores usage.cost when it is %s and uses the price table', (_label, cost) => {
    const usage = { cost, prompt_tokens: 1000, completion_tokens: 1000 };
    // 1000 * 1e-6 + 1000 * 5e-6
    expect(costFromUsage('anthropic/claude-haiku-4-5', usage)).toBeCloseTo(0.006, 12);
  });

  it('treats a missing token count as 0', () => {
    const cost = costFromUsage('anthropic/claude-haiku-4-5', { prompt_tokens: 1000 });
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeCloseTo(0.001, 12);
  });

  it('returns 0 for an unknown model without usage.cost', () => {
    expect(costFromUsage('some/unknown-model', { prompt_tokens: 1000, completion_tokens: 1000 })).toBe(0);
  });

  it('returns 0 when usage is missing', () => {
    expect(costFromUsage('google/gemini-3.8-flash', undefined)).toBe(0);
    expect(costFromUsage('google/gemini-3.8-flash', null)).toBe(0);
  });
});

describe('routeHasKey', () => {
  const { routeHasKey } = llmRoute;

  it.each([
    ['a string key', 'sk-or-test', true],
    ['an empty string', '', false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('is %s → %s', (_label, input, expected) => {
    expect(routeHasKey(input)).toBe(expected);
  });

  it('is true for a litellm route and an openrouter route with keys', () => {
    expect(routeHasKey(litellmRoute())).toBe(true);
    expect(routeHasKey(openrouterRoute())).toBe(true);
  });

  it('is false for a route built from an env with no keys', () => {
    expect(routeHasKey(llmRouteFromEnv({}))).toBe(false);
  });

  it('is true when only the fallback has a key', () => {
    const route = {
      kind: 'litellm', baseUrl: LITELLM_BASE, apiKey: '',
      fallback: { kind: 'openrouter', apiKey: 'sk-or-test' },
    };
    expect(routeHasKey(route)).toBe(true);
  });

  it('is false for a route with empty keys everywhere', () => {
    const route = {
      kind: 'litellm', baseUrl: LITELLM_BASE, apiKey: '',
      fallback: { kind: 'openrouter', apiKey: '' },
    };
    expect(routeHasKey(route)).toBe(false);
    expect(routeHasKey({ kind: 'openrouter', baseUrl: OPENROUTER_BASE, apiKey: '', fallback: null })).toBe(false);
  });
});

describe('fetchWithFallback', () => {
  const { fetchWithFallback } = llmRoute;
  const LITELLM_URL = `${LITELLM_BASE}/v1/chat/completions`;
  const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`;
  const MODEL = 'google/gemini-3.8-flash';

  // Records each call. `outcomes` scripts the results in order: a number is a
  // response status, an Error is thrown.
  function scriptedFetch(...outcomes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      const next = outcomes[calls.length - 1] ?? 200;
      if (next instanceof Error) throw next;
      return new Response(`{"status":${next}}`, { status: next });
    };
    return { fetchImpl, calls };
  }

  const abortError = () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
  };

  it('litellm 200 → one LiteLLM call, returned as-is', async () => {
    const { fetchImpl, calls } = scriptedFetch(200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('litellm');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(LITELLM_URL);
    expect(calls[0].body.model).toBe('google/gemini-3.8-flash');
    expect(calls[0].body).not.toHaveProperty('provider');
  });

  it('sends the request headers and passes init through (signal)', async () => {
    const { fetchImpl, calls } = scriptedFetch(200);
    const signal = new AbortController().signal;
    await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl, { signal });
    expect(calls[0].init.signal).toBe(signal);
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer sk-litellm-test');
  });

  it.each([401, 403, 404, 429, 500, 503])('litellm %i → one call on the OpenRouter fallback', async (status) => {
    const { fetchImpl, calls } = scriptedFetch(status, 200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(OPENROUTER_URL);
    expect(new Headers(calls[1].init.headers).get('Authorization')).toBe('Bearer sk-or-test');
    expect(calls[1].body.model).toBe(MODEL);
  });

  it('the fallback request also carries init (signal)', async () => {
    const { fetchImpl, calls } = scriptedFetch(403, 200);
    const signal = new AbortController().signal;
    await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl, { signal });
    expect(calls[1].init.signal).toBe(signal);
  });

  it('litellm 400 is not a fallback status → first response returned', async () => {
    const { fetchImpl, calls } = scriptedFetch(400, 200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('litellm');
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('a failed fallback is sent once and its response returned', async () => {
    const { fetchImpl, calls } = scriptedFetch(403, 503, 200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(2);
  });

  it('litellm network error → one call on the OpenRouter fallback', async () => {
    const { fetchImpl, calls } = scriptedFetch(new TypeError('fetch failed'), 200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(OPENROUTER_URL);
  });

  it('an AbortError is not retried on the fallback', async () => {
    const { fetchImpl, calls } = scriptedFetch(abortError(), 200);
    await expect(fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(1);
  });

  it('an unmapped model goes straight to the OpenRouter fallback', async () => {
    const { fetchImpl, calls } = scriptedFetch(200);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), 'some/unknown-model', sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPENROUTER_URL);
    expect(calls[0].body.model).toBe('some/unknown-model');
  });

  it('no fallback → the first response is returned', async () => {
    const route = llmRouteFromEnv(litellmEnv({ OPENROUTER_API_KEY: undefined }));
    const { fetchImpl, calls } = scriptedFetch(403, 200);
    const { response, routeKind } = await fetchWithFallback(route, MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('litellm');
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it('no fallback and a network error → the error propagates', async () => {
    const route = llmRouteFromEnv(litellmEnv({ OPENROUTER_API_KEY: undefined }));
    const { fetchImpl, calls } = scriptedFetch(new TypeError('fetch failed'));
    await expect(fetchWithFallback(route, MODEL, sampleBody(), fetchImpl)).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(1);
  });

  it('a string OpenRouter key sends one OpenRouter request', async () => {
    const { fetchImpl, calls } = scriptedFetch(200);
    const { response, routeKind } = await fetchWithFallback('sk-or-test', MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(OPENROUTER_URL);
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer sk-or-test');
    expect(calls[0].body).toEqual({ ...sampleBody(), model: MODEL });
  });

  it('a string OpenRouter key has no fallback: a 503 is returned', async () => {
    const { fetchImpl, calls } = scriptedFetch(503, 200);
    const { response, routeKind } = await fetchWithFallback('sk-or-test', MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
});

describe('gateway header (D7)', () => {
  const { fetchWithFallback } = llmRoute;
  const GATE = 'gate-test-token';
  const MODEL = 'google/gemini-3.8-flash';
  const gatedRoute = () => llmRouteFromEnv(litellmEnv({ LITELLM_GATE_TOKEN: GATE }));

  function recordingFetch(...statuses) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response('{}', { status: statuses[calls.length - 1] ?? 200 });
    };
    return { fetchImpl, calls };
  }

  it('the litellm route carries gateToken from LITELLM_GATE_TOKEN', () => {
    expect(gatedRoute().gateToken).toBe(GATE);
  });

  it('trims the token', () => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_GATE_TOKEN: `  ${GATE}\n` }));
    expect(route.gateToken).toBe(GATE);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 42],
  ])('gateToken is null when the token is %s', (_label, value) => {
    expect(llmRouteFromEnv(litellmEnv({ LITELLM_GATE_TOKEN: value })).gateToken).toBeNull();
  });

  it('the litellm request has the X-Edge-Gate header', () => {
    const req = buildRequest(gatedRoute(), MODEL, sampleBody());
    expect(req.headers['X-Edge-Gate']).toBe(GATE);
    expect(req.headers.Authorization).toBe('Bearer sk-litellm-test');
  });

  it.each([undefined, '', '   '])('no header when the token is %j', (value) => {
    const route = llmRouteFromEnv(litellmEnv({ LITELLM_GATE_TOKEN: value }));
    const req = buildRequest(route, MODEL, sampleBody());
    expect(req.headers).not.toHaveProperty('X-Edge-Gate');
  });

  it('the openrouter route has no gateToken and its request has no header', () => {
    const route = llmRouteFromEnv({ OPENROUTER_API_KEY: 'sk-or-test', LITELLM_GATE_TOKEN: GATE });
    expect(route.gateToken ?? null).toBeNull();
    const req = buildRequest(route, MODEL, sampleBody());
    expect(req.headers).not.toHaveProperty('X-Edge-Gate');
  });

  it('the fallback route has no gateToken and its request has no header', () => {
    const { fallback } = gatedRoute();
    expect(fallback.gateToken ?? null).toBeNull();
    const req = buildRequest(fallback, MODEL, sampleBody());
    expect(req.headers).not.toHaveProperty('X-Edge-Gate');
    expect(JSON.stringify(req)).not.toContain(GATE);
  });

  it('fetchWithFallback sends the header to LiteLLM and not to the OpenRouter fallback', async () => {
    const { fetchImpl, calls } = recordingFetch(503, 200);
    const { routeKind } = await fetchWithFallback(gatedRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(calls).toHaveLength(2);
    expect(calls[0].headers.get('X-Edge-Gate')).toBe(GATE);
    expect(calls[1].headers.has('X-Edge-Gate')).toBe(false);
  });

  it('an unmapped model goes to OpenRouter without the header', async () => {
    const { fetchImpl, calls } = recordingFetch(200);
    await fetchWithFallback(gatedRoute(), 'some/unknown-model', sampleBody(), fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.has('X-Edge-Gate')).toBe(false);
  });

  it('route, request, and headers stay frozen with a token', () => {
    const route = gatedRoute();
    const req = buildRequest(route, MODEL, sampleBody());
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.fallback)).toBe(true);
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.isFrozen(req.headers)).toBe(true);
  });
});

describe('upstream billing errors', () => {
  const { fetchWithFallback, isUpstreamBillingError } = llmRoute;
  const MODEL = 'google/gemini-3.8-flash';
  const OPENROUTER_URL = `${OPENROUTER_BASE}/chat/completions`;
  const BILLING_TEXT = '{"error":{"message":"litellm.BadRequestError: AnthropicException - '
    + 'Your credit balance is too low to access the Anthropic API."}}';

  // outcomes: [status, bodyText] pairs, in call order.
  function textFetch(...outcomes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, headers: new Headers(init.headers) });
      const [status, text] = outcomes[calls.length - 1] ?? [200, '{}'];
      return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { fetchImpl, calls };
  }

  it.each([
    [400, 'Your credit balance is too low to access the Anthropic API', true],
    [402, 'Payment required: billing issue', true],
    [403, 'insufficient_quota', true],
    [400, 'You exceeded your current quota, please check your plan', true],
    [400, 'Budget has been exceeded! Current cost: 61.2', true],
    [400, 'INSUFFICIENT QUOTA', true],
    [400, 'invalid request: messages must not be empty', false],
    [400, '', false],
    [401, 'credit balance is too low', false],
    [429, 'insufficient_quota', false],
    [500, 'billing service down', false],
    [200, 'credit balance', false],
  ])('isUpstreamBillingError(%i, %j) is %s', (status, text, expected) => {
    expect(isUpstreamBillingError(status, text)).toBe(expected);
  });

  it('isUpstreamBillingError is false for a non-string body', () => {
    expect(isUpstreamBillingError(400, undefined)).toBe(false);
    expect(isUpstreamBillingError(400, null)).toBe(false);
  });

  it('a billing 400 from LiteLLM falls back to OpenRouter once', async () => {
    const { fetchImpl, calls } = textFetch([400, BILLING_TEXT], [200, '{"ok":true}']);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(OPENROUTER_URL);
  });

  it('a billing 402 from LiteLLM falls back to OpenRouter once', async () => {
    const { fetchImpl, calls } = textFetch([402, 'billing: payment required'], [200, '{}']);
    const { routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(calls).toHaveLength(2);
  });

  it('a plain 400 does not fall back and the caller can still read the body', async () => {
    const text = '{"error":{"message":"invalid request: messages must not be empty"}}';
    const { fetchImpl, calls } = textFetch([400, text], [200, '{}']);
    const { response, routeKind } = await fetchWithFallback(litellmRoute(), MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('litellm');
    expect(calls).toHaveLength(1);
    expect(response.status).toBe(400);
    expect(response.ok).toBe(false);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).toBe(text);
  });

  it('a billing 400 without a fallback is returned with a readable body', async () => {
    const route = llmRouteFromEnv(litellmEnv({ OPENROUTER_API_KEY: undefined }));
    const { fetchImpl, calls } = textFetch([400, BILLING_TEXT]);
    const { response, routeKind } = await fetchWithFallback(route, MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('litellm');
    expect(calls).toHaveLength(1);
    expect(await response.text()).toBe(BILLING_TEXT);
  });

  it('a billing 400 from OpenRouter (no fallback) is returned as-is', async () => {
    const { fetchImpl, calls } = textFetch([400, BILLING_TEXT]);
    const { response, routeKind } = await fetchWithFallback('sk-or-test', MODEL, sampleBody(), fetchImpl);
    expect(routeKind).toBe('openrouter');
    expect(calls).toHaveLength(1);
    expect(await response.text()).toBe(BILLING_TEXT);
  });
});

describe('LITELLM_MODEL_MAP_JSON override', () => {
  const ALL_FLASH = JSON.stringify({
    'minimax/minimax-m3': 'google/gemini-3.8-flash',
    'anthropic/claude-haiku-4.5': 'google/gemini-3.8-flash',
  });
  const overrideRoute = (raw) => llmRouteFromEnv(litellmEnv({ LITELLM_MODEL_MAP_JSON: raw }));
  const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the override on top of the defaults', () => {
    const route = overrideRoute(ALL_FLASH);
    expect(route.modelMap).toEqual({
      'google/gemini-3.8-flash': 'google/gemini-3.8-flash',
      'minimax/minimax-m3': 'google/gemini-3.8-flash',
      'anthropic/claude-haiku-4.5': 'google/gemini-3.8-flash',
    });
    const req = buildRequest(route, 'minimax/minimax-m3', sampleBody());
    expect(req.model).toBe('google/gemini-3.8-flash');
    expect(req.body.model).toBe('google/gemini-3.8-flash');
  });

  it('adds a new source model when the target is known', () => {
    const route = overrideRoute(JSON.stringify({ 'x/new-model': 'anthropic/claude-sonnet-5' }));
    expect(buildRequest(route, 'x/new-model', sampleBody()).model).toBe('anthropic/claude-sonnet-5');
    expect(route.modelMap['google/gemini-3.8-flash']).toBe('google/gemini-3.8-flash');
    expect(route.modelMap).not.toHaveProperty('minimax/minimax-m3');
  });

  it('prices the mapped model', () => {
    const req = buildRequest(overrideRoute(ALL_FLASH), 'anthropic/claude-haiku-4.5', sampleBody());
    const price = LITELLM_PRICES['google/gemini-3.8-flash'];
    expect(costFromUsage(req.model, { prompt_tokens: 1000, completion_tokens: 100 }))
      .toBeCloseTo(1000 * price.in + 100 * price.out, 12);
  });

  it('ignores invalid JSON with one warning', () => {
    const warn = warnSpy();
    const route = overrideRoute('{not json');
    expect(route.modelMap).toBe(LITELLM_MODEL_MAP);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('{not json');
  });

  it('ignores the whole override when one target is unknown', () => {
    const warn = warnSpy();
    const route = overrideRoute(JSON.stringify({
      'minimax/minimax-m3': 'google/gemini-3.8-flash',
      'anthropic/claude-haiku-4.5': 'openai/gpt-9',
    }));
    expect(route.modelMap).toBe(LITELLM_MODEL_MAP);
    expect(buildRequest(route, 'minimax/minimax-m3', sampleBody())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an array', '["google/gemini-3.8-flash"]'],
    ['a string', '"google/gemini-3.8-flash"'],
    ['null', 'null'],
    ['a number', '42'],
    ['a non-string value', '{"minimax/minimax-m3": 1}'],
    ['a non-string env value', { 'minimax/minimax-m3': 'google/gemini-3.8-flash' }],
  ])('ignores %s', (_label, raw) => {
    const warn = warnSpy();
    expect(overrideRoute(raw).modelMap).toBe(LITELLM_MODEL_MAP);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns a frozen route and a frozen map', () => {
    const route = overrideRoute(ALL_FLASH);
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.modelMap)).toBe(true);
    expect(Object.isFrozen(buildRequest(route, 'minimax/minimax-m3', sampleBody()))).toBe(true);
  });

  it('keeps the defaults without the env var and does not warn', () => {
    const warn = warnSpy();
    const route = litellmRoute();
    expect(route.modelMap).toBe(LITELLM_MODEL_MAP);
    for (const [source, target] of Object.entries(LITELLM_MODEL_MAP)) {
      expect(buildRequest(route, source, sampleBody()).model).toBe(target);
    }
    expect(overrideRoute('').modelMap).toBe(LITELLM_MODEL_MAP);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to LITELLM_MODEL_MAP for a litellm route without modelMap', () => {
    const route = resolveRoute({ kind: 'litellm', baseUrl: LITELLM_BASE, apiKey: 'k', fallback: null });
    expect(buildRequest(route, 'google/gemini-3.8-flash', sampleBody()).model).toBe('google/gemini-3.8-flash');
    expect(buildRequest(route, 'minimax/minimax-m3', sampleBody())).toBeNull();
    expect(buildRequest(route, 'x/unmapped', sampleBody())).toBeNull();
  });

  it('does not change an openrouter route', () => {
    const route = llmRouteFromEnv({ OPENROUTER_API_KEY: 'sk-or-test', LITELLM_MODEL_MAP_JSON: ALL_FLASH });
    expect(route.kind).toBe('openrouter');
    expect(route.modelMap).toBeUndefined();
    expect(buildRequest(route, 'minimax/minimax-m3', sampleBody()).model).toBe('minimax/minimax-m3');
  });
});
