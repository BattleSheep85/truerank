// LLM layer for the research engine. Plain ES module, ported from
// src/lib/engine-llm.ts. Types erased; runtime behavior preserved verbatim.
//
// OpenRouter API response shape (subset we actually consume) — formerly the
// OpenRouterChoice / OpenRouterUsage / OpenRouterResponse interfaces. These are
// erased structural types; the runtime objects come straight off the JSON body.

import { resolveRoute, buildRequest, isFallbackStatus, costFromUsage } from '../lib/llm-route.js';

// Budget for OpenRouter calls, scaled to reasoning effort. Extended thinking
// adds a silent pre-generation phase (30-90s for 'medium', 60-180s for 'high'),
// so a fixed 120s ceiling is too tight for exhaustive/unbound tiers.
export function llmBudgetMs(effort) {
  switch (effort) {
    case 'high': return { hardMs: 360_000, chunkMs: 180_000 };
    case 'medium': return { hardMs: 240_000, chunkMs: 120_000 };
    case 'low': return { hardMs: 180_000, chunkMs: 90_000 };
    default: return { hardMs: 120_000, chunkMs: 75_000 };
  }
}

// Streaming calls use a per-chunk watchdog (not just overall timeout) so a stuck stream aborts
// promptly — the historical hang that motivated `await response.text()` came
// from no per-chunk deadline.
//
// StreamResult shape: { content: string, usage?: OpenRouterUsage }

// Reasoning accepts a string effort (legacy) OR a full OpenRouter reasoning
// object — e.g. { enabled: false } to turn thinking OFF for models like
// kimi-k2.6 that reason by default and would otherwise burn the entire
// max_tokens budget on reasoning before emitting any content (empty synthesis).
function normalizeReasoning(r) {
  if (!r) return null;
  return typeof r === 'string' ? { effort: r } : r;
}
function reasoningEffortOf(r) {
  return typeof r === 'string' ? r : (r && r.effort) || undefined;
}

// OpenRouter/OpenAI reject any message string containing an unpaired UTF-16
// surrogate (a lone half of an emoji/multibyte pair) with a 400 "Invalid input
// … unpaired UTF-16 surrogate", failing the whole run. These appear in truncated
// scraped page text AND can be created by slicing a string mid-pair in
// pruneMessages. Strip them at the send boundary. Immutable — returns new msgs.
function stripLoneSurrogates(s) {
  return typeof s === 'string'
    ? s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    : s;
}
export function sanitizeLLMMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => (m && typeof m.content === 'string' ? { ...m, content: stripLoneSurrogates(m.content) } : m));
}

// Every call goes through a route (docs/litellm-2026-10.md D2 to D5). The
// apiKey argument is a route object or a plain OpenRouter key string.
const PROVIDER_LABELS = Object.freeze({ litellm: 'LiteLLM', openrouter: 'OpenRouter' });
const ERROR_TEXT_MAX = 200;
const DEFAULT_STREAM_MAX_TOKENS = 8192;
const REDACTED = '[redacted]';

// A LiteLLM failure that may retry once on the OpenRouter fallback.
class LiteLLMFallbackError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'LiteLLMFallbackError';
    this.fallbackReason = reason;
  }
}

// HTTP 400 because the model takes only its default temperature. LiteLLM
// answers claude-sonnet-5 (the LiteLLM model for minimax-m3, so every verify
// stance call) with "UnsupportedParamsError: ... does not support
// temperature=0. Only temperature=1 is supported."
class UnsupportedTemperatureError extends Error {
  constructor(message, model) {
    super(message);
    this.name = 'UnsupportedTemperatureError';
    this.model = model;
  }
}
const BAD_REQUEST = 400;
const TEMPERATURE_RE = /temperature/i;
const UNSUPPORTED_PARAM_RE = /unsupported|does not support|not supported|only temperature/i;

function isUnsupportedTemperature(status, text) {
  return status === BAD_REQUEST && TEMPERATURE_RE.test(text) && UNSUPPORTED_PARAM_RE.test(text);
}

// Sends the call; an UnsupportedTemperatureError sends it once more without
// temperature (the model default). Other errors pass through.
async function withDefaultTemperatureRetry(opts, attempt) {
  try {
    return await attempt(opts);
  } catch (err) {
    if (!(err instanceof UnsupportedTemperatureError) || opts.omitTemperature) throw err;
    console.log(`[llm] model=${err.model} rejects temperature ${opts.temperature ?? 0}, sending again with the model default`);
    return attempt({ ...opts, omitTemperature: true });
  }
}

function providerLabel(route) {
  return PROVIDER_LABELS[route.kind] ?? route.kind;
}

// Removes the route keys from text so no error or log line carries a key.
function redactKeys(text, route) {
  const keys = [route.apiKey, route.fallback?.apiKey].filter((k) => typeof k === 'string' && k.length > 0);
  return keys.reduce((acc, key) => acc.split(key).join(REDACTED), String(text ?? ''));
}

// Runs attempt on the route. A LiteLLM fallback error retries once on the
// OpenRouter fallback with the original model. Other errors pass through.
async function withFallback(route, attempt) {
  try {
    return await attempt(route);
  } catch (err) {
    if (!(err instanceof LiteLLMFallbackError) || !route.fallback) throw err;
    console.log(`[llm] litellm fallback: ${err.fallbackReason}`);
    return attempt(route.fallback);
  }
}

function requestFor(route, model, body) {
  const req = buildRequest(route, model, body);
  if (req) return req;
  throw new LiteLLMFallbackError(`unmapped model ${model}`, `LiteLLM: no model mapping for ${model}`);
}

// POSTs the request. A LiteLLM network error (not our own abort) may fall back.
async function postChat(route, req, signal, extraHeaders = {}) {
  try {
    return await fetch(req.url, {
      method: 'POST',
      signal,
      headers: { ...req.headers, ...extraHeaders },
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    if (route.kind !== 'litellm' || signal.aborted) throw err;
    const detail = redactKeys(err?.message ?? 'fetch failed', route);
    throw new LiteLLMFallbackError(`network error: ${detail}`, `LiteLLM network error: ${detail}`);
  }
}

// Logs and throws for a non-ok response. The message names the provider.
async function throwHttpError(route, response, logTag, model) {
  const raw = await response.text().catch(() => '');
  const errText = redactKeys(raw, route).slice(0, ERROR_TEXT_MAX);
  console.log(`${logTag} model=${model} HTTP ${response.status}: ${errText}`);
  const message = `${providerLabel(route)} ${response.status}: ${errText}`;
  if (isUnsupportedTemperature(response.status, raw)) throw new UnsupportedTemperatureError(message, model);
  if (route.kind === 'litellm' && isFallbackStatus(response.status)) {
    throw new LiteLLMFallbackError(`HTTP ${response.status}`, message);
  }
  throw new Error(message);
}

// LiteLLM sends no USD cost, so compute it from the price table (D4).
// OpenRouter usage passes through unchanged.
function usageWithCost(route, model, usage) {
  if (route.kind !== 'litellm' || !usage) return usage;
  return { ...usage, cost: costFromUsage(model, usage) };
}

function routeLogSuffix(route) {
  return route.kind === 'litellm' ? ' via=litellm' : '';
}

// Deterministic by default (temperature 0). omitTemperature leaves the field
// out for a model that takes only its default.
function temperatureField(opts) {
  return opts.omitTemperature ? {} : { temperature: opts.temperature ?? 0 };
}

function buildStreamBody(model, messages, opts) {
  const { reasoning, maxTokens, provider, responseFormat, models, seed } = opts;
  const rz = normalizeReasoning(reasoning);
  return {
    ...(Array.isArray(models) && models.length ? { models } : { model }),
    messages: sanitizeLLMMessages(messages),
    stream: true,
    max_tokens: maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
    // Deterministic by default. Every call previously ran at the provider's
    // default (~1.0) sampling temperature, which is why identical inputs
    // produced different results. Overridable per-call.
    ...temperatureField(opts),
    ...(seed !== undefined ? { seed } : {}),
    // The final SSE chunk carries the full usage object (prompt/completion
    // tokens, plus cost in USD on OpenRouter) when this is set. Needed for
    // research.cost_usd accounting.
    stream_options: { include_usage: true },
    ...(rz ? { reasoning: rz } : {}),
    // Provider routing (e.g. {sort:'throughput'} for the synth stream) and
    // optional strict structured outputs. Both off unless the caller sets them.
    ...(provider ? { provider } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };
}

// Reads SSE chunks, calls onToken per content delta, returns { content, usage }.
async function readSseStream(body, onToken, armChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    armChunk();
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return { content, usage };
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          content += delta;
          onToken(delta, content);
        }
        // include_usage: the final chunk (or occasionally a mid-stream
        // chunk) carries the full usage object. Last one wins.
        if (obj.usage) usage = obj.usage;
      } catch { /* skip non-JSON heartbeats */ }
    }
  }
  return { content, usage };
}

async function streamOnce(route, model, messages, onToken, opts) {
  const { reasoning } = opts;
  const req = requestFor(route, model, buildStreamBody(model, messages, opts));
  const { hardMs, chunkMs } = llmBudgetMs(reasoningEffortOf(reasoning));
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort('hard'), hardMs);
  let chunkTimer = null;
  const armChunk = () => {
    if (chunkTimer) clearTimeout(chunkTimer);
    chunkTimer = setTimeout(() => controller.abort('chunk'), chunkMs);
  };

  console.log(`[llm-stream] calling model=${req.model} effort=${reasoningEffortOf(reasoning) ?? 'none'}${routeLogSuffix(route)}`);
  try {
    const response = await postChat(route, req, controller.signal, { Accept: 'text/event-stream' });
    if (!response.ok || !response.body) await throwHttpError(route, response, '[llm-stream]', req.model);
    armChunk();
    const { content, usage } = await readSseStream(response.body, onToken, armChunk);
    return { content, usage: usageWithCost(route, req.model, usage) };
  } finally {
    clearTimeout(hardTimer);
    if (chunkTimer) clearTimeout(chunkTimer);
  }
}

// Stream a completion and surface incremental content via onToken.
export async function callLLMStreaming(apiKey, model, messages, onToken, opts = {}) {
  return withFallback(resolveRoute(apiKey), (route) =>
    withDefaultTemperatureRetry(opts, (o) => streamOnce(route, model, messages, onToken, o)));
}

function buildCallBody(model, messages, opts) {
  const { tools, reasoning, maxTokens, provider, responseFormat, models, seed } = opts;
  const rz = normalizeReasoning(reasoning);
  const hasTools = Array.isArray(tools) && tools.length > 0;
  return {
    messages: sanitizeLLMMessages(messages),
    // model vs models[] fallback chain are mutually exclusive (OpenRouter 400s on both).
    ...(Array.isArray(models) && models.length ? { models } : { model }),
    ...(hasTools ? { tools, tool_choice: 'auto' } : {}),
    ...(rz ? { reasoning: rz } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(provider ? { provider } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    // Deterministic by default. See buildStreamBody for rationale.
    ...temperatureField(opts),
    ...(seed !== undefined ? { seed } : {}),
  };
}

async function callOnce(route, model, messages, opts) {
  const { tools, reasoning, models, hardMsOverride } = opts;
  const req = requestFor(route, model, buildCallBody(model, messages, opts));
  // Scale timeout to reasoning effort. Medium/high thinking phases alone can run
  // 60-180s. A caller can pass hardMsOverride to cap a fast routing turn tighter.
  const { hardMs: budgetHardMs } = llmBudgetMs(reasoningEffortOf(reasoning));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hardMsOverride || budgetHardMs);

  const chain = route.kind === 'openrouter' && Array.isArray(models) && models.length ? models.join('>') : req.model;
  console.log(`[llm] calling model=${chain} effort=${reasoningEffortOf(reasoning) ?? 'none'} tools=${tools?.length ?? 0}${routeLogSuffix(route)}`);
  try {
    const response = await postChat(route, req, controller.signal);
    if (!response.ok) await throwHttpError(route, response, '[llm]', req.model);
    // Read body as text first (avoids hanging on slow streaming responses)
    const data = JSON.parse(await response.text());
    return route.kind === 'litellm' && data?.usage
      ? { ...data, usage: usageWithCost(route, req.model, data.usage) }
      : data;
  } finally {
    clearTimeout(timer);
  }
}

export async function callLLM(apiKey, model, messages, opts = {}) {
  return withFallback(resolveRoute(apiKey), (route) =>
    withDefaultTemperatureRetry(opts, (o) => callOnce(route, model, messages, o)));
}

// ─── Context management ──────────────────────────────────────────────────────

const MAX_CONTEXT_CHARS = 120_000; // keep context lean for fast LLM responses
const KEEP_HEAD = 2;  // system + first user
const KEEP_TAIL = 10; // most recent turns carry the most signal
const MIDDLE_TOOL_TRUNCATE = 200;

function charCount(messages) {
  let n = 0;
  for (const msg of messages) n += (msg.content ?? '').length;
  return n;
}

// Returns a NEW message array under MAX_CONTEXT_CHARS. Head/tail references are
// reused unchanged; middle messages are either truncated (tool results only) or
// dropped oldest-first until the budget is met. Never mutates input messages —
// the agent loop keeps the authoritative history in the caller's array.
export function pruneMessages(messages) {
  if (charCount(messages) <= MAX_CONTEXT_CHARS) return messages;
  if (messages.length <= KEEP_HEAD + KEEP_TAIL) return messages;

  const head = messages.slice(0, KEEP_HEAD);
  const tail = messages.slice(messages.length - KEEP_TAIL);
  const middleRaw = messages.slice(KEEP_HEAD, messages.length - KEEP_TAIL);

  // Step 1: truncate tool outputs in the middle via copy (don't mutate).
  const middleTruncated = middleRaw.map((msg) => {
    if (msg.role === 'tool' && msg.content && msg.content.length > 500) {
      return { ...msg, content: msg.content.slice(0, MIDDLE_TOOL_TRUNCATE) + '\n[...truncated for context management]' };
    }
    return msg;
  });

  // Step 2: if still over budget, drop oldest middle messages until under.
  let current = [...head, ...middleTruncated, ...tail];
  while (charCount(current) > MAX_CONTEXT_CHARS && middleTruncated.length > 0) {
    middleTruncated.shift();
    current = [...head, ...middleTruncated, ...tail];
  }
  return current;
}
