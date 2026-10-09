import { isFetchableUrl } from './url-guard.js';
import { anySignal } from './deadline.js';

const JINA_TIMEOUT_MS = 8000;
const DIRECT_TIMEOUT_MS = 8000;
const MAX_CONTENT_LENGTH = 15_000;

// Retry-on-429/5xx tuning. Jina's free tier throttles hard (~20 req/min) and
// under concurrent read bursts a large fraction of requests come back 429 —
// those pages then silently fall through to the (usually thinner) direct-fetch
// fallback. A couple of short, jittered backoff retries recover most of them
// without materially slowing down a page that's genuinely blocked/down.
const JINA_MAX_RETRIES = 2;
const JINA_RETRY_BASE_MS = 400; // ~400ms, then ~1200ms (see backoffMs)
const JINA_RETRY_JITTER_MS = 150;
// Hard ceiling on the whole retry loop's added wall-clock so a hammered URL
// still returns promptly instead of hanging the caller's read budget.
const JINA_RETRY_BUDGET_MS = 3000;

function backoffMs(attempt) {
  // attempt 1 → ~400ms, attempt 2 → ~1200ms, plus small jitter.
  const base = JINA_RETRY_BASE_MS * (2 ** (attempt - 1)) * (attempt === 1 ? 1 : 1.5);
  return Math.round(base + Math.random() * JINA_RETRY_JITTER_MS);
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isKeyRejectedStatus(status) {
  return status === 401 || status === 402 || status === 403;
}

// When Jina rejects the key (401/402/403, e.g. the account is out of credit),
// reads go keyless for this long. Keyless Jina still answers, only slower.
export const JINA_KEY_COOLDOWN_MS = 600000;
const KEY_COOLDOWN_MINUTES = JINA_KEY_COOLDOWN_MS / 60000;

// Isolate-scoped: Date.now() when the key was last rejected, or null.
let keyRejectedAt = null;

export function resetJinaKeyState() {
  keyRejectedAt = null;
}

function isKeyCoolingDown() {
  return keyRejectedAt !== null && Date.now() - keyRejectedAt < JINA_KEY_COOLDOWN_MS;
}

function startKeyCooldown(status) {
  if (!isKeyCoolingDown()) {
    console.log(`[jina] key rejected (HTTP ${status}), using keyless reads for ${KEY_COOLDOWN_MINUTES} minutes`);
  }
  keyRejectedAt = Date.now();
}

function buildJinaHeaders(apiKey) {
  // A Jina API key (free signup, generous limits) lifts the keyless rate cap that
  // otherwise 429s most concurrent reads → far more pages actually return body text.
  const base = { Accept: 'text/markdown', 'X-Return-Format': 'markdown' };
  return apiKey ? { ...base, Authorization: `Bearer ${apiKey}` } : base;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch full page content as markdown via Jina Reader.
 * Free tier: ~20 req/min. Returns clean markdown with headings, lists, tables preserved.
 *
 * Resilience: Jina's free tier throttles aggressively (~20 req/min), and under the
 * flywheel + organic load we routinely hit 429/5xx or empty bodies. Before falling
 * through to the direct-fetch fallback, a 429/5xx (or transient network error) is
 * retried up to JINA_MAX_RETRIES times with short exponential backoff + jitter,
 * bounded by JINA_RETRY_BUDGET_MS total so a persistently-throttled URL still
 * returns promptly. When the Jina path still fails after retries (network error,
 * timeout, 429/5xx, or an empty/blocked body) we fall back to fetching the URL
 * directly with browser-like headers and a dependency-free HTML-to-text extraction
 * so the pipeline keeps making progress instead of silently losing the page. Both
 * paths return the same shape (a string, capped at MAX_CONTENT_LENGTH). The
 * graceful empty-string failure remains the final fallback; this function never
 * throws.
 *
 * Key rejection: a 401/402/403 on a keyed request (e.g. the key is out of
 * credit) retries the same Jina URL once without the key, and later calls skip
 * the key for JINA_KEY_COOLDOWN_MS.
 *
 * `opts.fetchImpl`/`opts.sleepImpl` are injectable for tests (default to the
 * global fetch and a real timer-based delay); they do not change the public
 * two-arg call sites used throughout the codebase.
 *
 * `opts.signal` (optional) is the caller's stop signal, for example a verify
 * stage deadline (worker/lib/deadline.js). When it aborts, the read in
 * progress stops and no retry or direct fallback starts: the call returns ''.
 */
export async function fetchPageContent(url, apiKey, opts = {}) {
  if (!isFetchableUrl(url)) return '';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? defaultSleep;
  const stop = opts.signal;
  const started = Date.now();

  let sendKey = Boolean(apiKey) && !isKeyCoolingDown();

  for (let attempt = 0; attempt <= JINA_MAX_RETRIES; attempt++) {
    if (stop?.aborted) return '';
    const headers = buildJinaHeaders(sendKey ? apiKey : null);
    try {
      const response = await fetchImpl(`https://r.jina.ai/${url}`, {
        signal: anySignal([AbortSignal.timeout(JINA_TIMEOUT_MS), stop]),
        headers,
      });

      if (!response.ok) {
        console.log(`[jina] HTTP ${response.status} for ${url} (attempt ${attempt + 1})`);
        if (sendKey && isKeyRejectedStatus(response.status)) {
          // The key is rejected, not the page: retry the same URL once without it
          // (no backoff, does not use up a retry attempt).
          startKeyCooldown(response.status);
          sendKey = false;
          attempt--;
          continue;
        }
        const canRetry = isRetryableStatus(response.status)
          && attempt < JINA_MAX_RETRIES
          && Date.now() - started < JINA_RETRY_BUDGET_MS;
        if (canRetry) {
          await sleepImpl(backoffMs(attempt + 1));
          continue;
        }
        return await fetchDirect(url, fetchImpl, stop);
      }

      const text = await response.text();
      // Jina sometimes returns boilerplate for blocked/empty pages
      if (text.length < 100) return await fetchDirect(url, fetchImpl, stop);
      return text.slice(0, MAX_CONTENT_LENGTH);
    } catch (err) {
      if (stop?.aborted) {
        console.log(`[jina] stopped ${url} (attempt ${attempt + 1}): the caller's deadline was reached`);
        return '';
      }
      console.log(`[jina] ERROR ${url} (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
      const canRetry = attempt < JINA_MAX_RETRIES && Date.now() - started < JINA_RETRY_BUDGET_MS;
      if (canRetry) {
        await sleepImpl(backoffMs(attempt + 1));
        continue;
      }
      return await fetchDirect(url, fetchImpl, stop);
    }
  }
  // Unreachable in practice (the loop always returns), but keep the contract
  // explicit: never throw, always resolve to a string.
  return await fetchDirect(url, fetchImpl, stop);
}

/**
 * Direct fallback: fetch the raw page with browser-like headers and extract
 * readable text without any DOM library. Returns '' on any failure, or when
 * the caller's `stop` signal has aborted; never throws.
 */
async function fetchDirect(url, fetchImpl = fetch, stop = undefined) {
  if (!isFetchableUrl(url) || stop?.aborted) return '';
  try {
    const response = await fetchImpl(url, {
      signal: anySignal([AbortSignal.timeout(DIRECT_TIMEOUT_MS), stop]),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      console.log(`[jina:direct] HTTP ${response.status} for ${url}`);
      return '';
    }

    const html = await response.text();
    if (!html) return '';
    return extractReadableText(html);
  } catch (err) {
    console.log(`[jina:direct] ERROR ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/**
 * Convert raw HTML to readable plain text with no DOM library:
 * strip non-content blocks, prefer <article>/<main> (else <body>), strip remaining
 * tags, decode common entities, collapse whitespace, and cap at MAX_CONTENT_LENGTH.
 */
function extractReadableText(html) {
  let s = html;

  // Drop blocks whose contents are never readable body text.
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside']) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }

  // Prefer the main content region when present.
  const region =
    matchRegion(s, 'article') || matchRegion(s, 'main') || matchRegion(s, 'body') || s;

  let text = region
    .replace(/<[^>]+>/g, ' ') // strip remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, MAX_CONTENT_LENGTH);
}

/** Return the inner HTML of the first matching <tag>...</tag> region, or null. */
function matchRegion(html, tag) {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : null;
}

// ── Rerank ────────────────────────────────────────────────────────────────────

const RERANK_URL = 'https://api.jina.ai/v1/rerank';
export const DEFAULT_RERANK_MODEL = 'jina-reranker-v3.5';
const RERANK_TIMEOUT_MS = 15_000;
// Chars of the error body kept in a thrown message.
const RERANK_ERROR_BODY_CHARS = 200;

/**
 * Orders passages by relevance to a query with the Jina rerank API.
 * Response shape (checked 2026-10-07 with jina-reranker-v3.5):
 *   { model, object: 'list', usage: { total_tokens },
 *     results: [{ index, relevance_score }] }  (results best first; scores can be negative)
 * Returns [{ index, score }] sorted by score, best first, at most topN.
 * `onUsage({ totalTokens, latencyMs })` is optional (benchmarks use it).
 * Throws an Error on a missing key, an HTTP failure, a timeout, or a bad body.
 * The key is never in the error text.
 */
export async function rerankPassages({
  apiKey,
  query,
  passages,
  topN,
  model = DEFAULT_RERANK_MODEL,
  fetchImpl = fetch,
  timeoutMs = RERANK_TIMEOUT_MS,
  onUsage,
}) {
  if (!apiKey) throw new Error('rerank: no Jina API key');
  const documents = Array.isArray(passages) ? passages.map((p) => String(p ?? '')) : [];
  if (documents.length === 0) return [];
  const top = Math.min(documents.length, Number.isInteger(topN) && topN > 0 ? topN : documents.length);
  const started = Date.now();
  const response = await fetchImpl(RERANK_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, query: String(query ?? ''), documents, top_n: top, return_documents: false }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = body.split(apiKey).join('[key]').slice(0, RERANK_ERROR_BODY_CHARS);
    throw new Error(`rerank: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.results)) throw new Error('rerank: response has no results array');
  onUsage?.({ totalTokens: Number(body?.usage?.total_tokens) || 0, latencyMs: Date.now() - started });
  return body.results
    .filter((r) => Number.isInteger(r?.index) && r.index >= 0 && r.index < documents.length && Number.isFinite(r?.relevance_score))
    .map((r) => ({ index: r.index, score: r.relevance_score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
