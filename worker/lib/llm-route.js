// LLM route selection: LiteLLM (OpenAI-compatible) or OpenRouter.
// Design: docs/litellm-2026-10.md D2 to D5. Pure logic, no I/O.
//
// A route is a frozen object: { kind, baseUrl, apiKey, fallback }.
// kind is 'litellm' or 'openrouter'. fallback is an OpenRouter route or null.

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_CHAT_PATH = '/chat/completions';
const LITELLM_CHAT_PATH = '/v1/chat/completions';
const OPENROUTER_REFERER = 'https://chrisputer.tech';
const OPENROUTER_TITLE = 'Frank';
const ROUTE_KINDS = Object.freeze(['litellm', 'openrouter']);
const ALLOWED_URL_PROTOCOLS = Object.freeze(['http:', 'https:']);
const LITELLM_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high']);
const SERVER_ERROR_MIN = 500;
const SERVER_ERROR_MAX = 599;
const FALLBACK_CLIENT_STATUSES = Object.freeze([401, 403, 404, 429]);

// D3. Production model to LiteLLM model. An unmapped model goes to OpenRouter.
export const LITELLM_MODEL_MAP = Object.freeze({
  'google/gemini-3.8-flash': 'google/gemini-3.8-flash',
  'minimax/minimax-m3': 'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4.5': 'anthropic/claude-haiku-4-5',
});

// D4. USD per token for each LiteLLM model (from LiteLLM /model/info).
export const LITELLM_PRICES = Object.freeze({
  'google/gemini-3.8-flash': Object.freeze({ in: 7.5e-7, out: 3.75e-6 }),
  'anthropic/claude-sonnet-5': Object.freeze({ in: 2e-6, out: 1e-5 }),
  'anthropic/claude-haiku-4-5': Object.freeze({ in: 1e-6, out: 5e-6 }),
});

function openRouterRoute(apiKey) {
  return Object.freeze({ kind: 'openrouter', baseUrl: OPENROUTER_BASE_URL, apiKey, fallback: null });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Returns the base URL without trailing slashes, or null when it is not http(s).
function normalizeBaseUrl(raw) {
  if (!isNonEmptyString(raw)) return null;
  try {
    const { protocol } = new URL(raw);
    if (!ALLOWED_URL_PROTOCOLS.includes(protocol)) return null;
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

// D2. LLM_PROVIDER=litellm needs a valid base URL and a key. Otherwise OpenRouter.
export function llmRouteFromEnv(env) {
  const source = env ?? {};
  const openrouterKey = source.OPENROUTER_API_KEY;
  const provider = String(source.LLM_PROVIDER ?? '').trim().toLowerCase();
  const baseUrl = normalizeBaseUrl(source.LITELLM_BASE_URL);
  const litellmKey = source.LITELLM_API_KEY;
  if (provider !== 'litellm' || !baseUrl || !isNonEmptyString(litellmKey)) {
    return openRouterRoute(openrouterKey);
  }
  const fallback = isNonEmptyString(openrouterKey) ? openRouterRoute(openrouterKey) : null;
  return Object.freeze({ kind: 'litellm', baseUrl, apiKey: litellmKey, fallback });
}

// A plain string (or nothing) is an OpenRouter key, as before this module existed.
export function resolveRoute(input) {
  if (input === null || input === undefined || typeof input === 'string') {
    return openRouterRoute(input);
  }
  if (typeof input !== 'object' || !ROUTE_KINDS.includes(input.kind)) {
    throw new TypeError('resolveRoute: unknown LLM route');
  }
  const fallback = input.fallback ? resolveRoute(input.fallback) : null;
  return Object.freeze({ ...input, fallback });
}

function litellmBody(body, model) {
  const { provider: _provider, models: _models, usage: _usage, reasoning, ...rest } = body ?? {};
  const effort = reasoning?.effort;
  const reasoningField = LITELLM_REASONING_EFFORTS.includes(effort) ? { reasoning_effort: effort } : {};
  return Object.freeze({ ...rest, model, ...reasoningField });
}

function buildLitellmRequest(route, model, body) {
  if (!Object.hasOwn(LITELLM_MODEL_MAP, model)) return null;
  const mapped = LITELLM_MODEL_MAP[model];
  const headers = Object.freeze({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${route.apiKey}`,
  });
  const url = `${route.baseUrl}${LITELLM_CHAT_PATH}`;
  return Object.freeze({ url, headers, model: mapped, body: litellmBody(body, mapped) });
}

function buildOpenRouterRequest(route, model, body) {
  const headers = Object.freeze({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${route.apiKey}`,
    'HTTP-Referer': OPENROUTER_REFERER,
    'X-Title': OPENROUTER_TITLE,
  });
  const url = `${route.baseUrl}${OPENROUTER_CHAT_PATH}`;
  return Object.freeze({ url, headers, model, body: Object.freeze({ ...body }) });
}

// D3 and D5. Returns { url, headers, model, body }, or null for a model LiteLLM
// does not map (the caller then uses the fallback). Never changes the input body.
export function buildRequest(route, model, body) {
  return route.kind === 'litellm'
    ? buildLitellmRequest(route, model, body)
    : buildOpenRouterRequest(route, model, body);
}

// D2. Statuses where a LiteLLM call retries once on OpenRouter.
export function isFallbackStatus(status) {
  return FALLBACK_CLIENT_STATUSES.includes(status)
    || (status >= SERVER_ERROR_MIN && status <= SERVER_ERROR_MAX);
}

function tokenCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// D4. Provider cost when given, else price table times token counts, else 0.
export function costFromUsage(model, usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) return usage.cost;
  if (!Object.hasOwn(LITELLM_PRICES, model)) return 0;
  const price = LITELLM_PRICES[model];
  return tokenCount(usage.prompt_tokens) * price.in + tokenCount(usage.completion_tokens) * price.out;
}

// True when the route (or its fallback) has a key. A plain string is an OpenRouter key.
export function routeHasKey(route) {
  if (route === null || route === undefined || typeof route === 'string') return isNonEmptyString(route);
  if (typeof route !== 'object') return false;
  return isNonEmptyString(route.apiKey) || routeHasKey(route.fallback ?? null);
}

function isAbortError(err) {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function sendRequest(req, fetchImpl, init) {
  return fetchImpl(req.url, {
    ...init,
    method: 'POST',
    headers: { ...req.headers, ...(init.headers ?? {}) },
    body: JSON.stringify(req.body),
  });
}

// D2. Sends one request on the route. An unmapped model, a fallback status, or a
// network error (not an abort) retries once on route.fallback when it exists.
// model overrides body.model. init passes through (signal, extra headers).
// Returns { response, routeKind }.
// Logs never include a key.
export async function fetchWithFallback(route, model, rawBody, fetchImpl = fetch, init = {}) {
  const body = { ...rawBody, model };
  const primary = resolveRoute(route);
  const { fallback } = primary;
  const req = buildRequest(primary, model, body);
  if (!req && !fallback) throw new Error(`no LLM route for model ${model}`);
  if (req) {
    try {
      const response = await sendRequest(req, fetchImpl, init);
      if (!fallback || !isFallbackStatus(response.status)) return { response, routeKind: primary.kind };
      response.body?.cancel?.();
      console.warn(`[llm-route] ${primary.kind} answered ${response.status}, falling back to ${fallback.kind}`);
    } catch (err) {
      if (!fallback || isAbortError(err)) throw err;
      console.warn(`[llm-route] ${primary.kind} request failed, falling back to ${fallback.kind}: ${errorMessage(err)}`);
    }
  } else {
    console.warn(`[llm-route] ${model} is not mapped on ${primary.kind}, using ${fallback.kind}`);
  }
  const response = await sendRequest(buildRequest(fallback, model, body), fetchImpl, init);
  return { response, routeKind: fallback.kind };
}
