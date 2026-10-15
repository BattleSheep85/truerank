// SearXNG metasearch client. The self-hosted instance aggregates ten free
// engines, so raw answers hold duplicates, dictionary and shopping junk, and
// off-topic hits. This module cleans them (URL normalization, dedupe, blocked
// domains, relevance), reranks, and returns null for weak answers so the caller
// falls through to the paid providers (Brave, Exa, Tavily).
// The public instance sits behind the BunkerWeb X-Edge-Gate header gate.
// Never log the gate token.
import { isExpertDomain, isCommunityDomain } from '../lib/credibility.js';

// Ten engines per call need more headroom than a single-API provider.
export const SEARXNG_TIMEOUT_MS = 11000;
// Cap so one query cannot flood the source pool.
export const SEARXNG_MAX_RESULTS = 15;
// Fewer cleaned results than this means a weak answer: let a paid provider run.
export const SEARXNG_MIN_USABLE = 3;

export const BLOCKED_DOMAINS = new Set([
  'pinterest.com', 'alibaba.com', 'aliexpress.com', 'taobao.com', 'tiktok.com',
  'merriam-webster.com', 'thefreedictionary.com', 'wiktionary.org',
  'dictionary.cambridge.org', 'dictionary.com', 'collinsdictionary.com',
  'csdn.net', 'zhihu.com', 'baidu.com', 'quora.com', 'redditmedia.com',
]);

const EDGE_GATE_HEADER = 'X-Edge-Gate';
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'ref', 'ref_src', 'srsltid', 'mc_cid', 'mc_eid']);
const TRACKING_PREFIX = 'utm_';
const REDDIT_ALIAS = /^(old|new|m|np)\.reddit\.com$/;
const MIN_TERM_LENGTH = 3;
const STOPWORDS = new Set([
  'best', 'review', 'reviews', 'reddit', 'top', 'vs', 'the', 'and', 'for', 'with',
  'test', 'tests', 'specs', 'buy', 'buying', 'guide', 'which', 'what', 'are', 'you',
  'your', 'from', 'that', 'this', 'should', 'good', 'great', 'worth', 'compare',
  'comparison', 'versus', 'cheap', 'new', 'under',
]);

// Scoring weights for rankResults.
const POS_MAX = 20;
const ENGINE_BONUS = 3;
const EXPERT_BONUS = 6;
const COMMUNITY_BONUS = 5;
const FRESH_BONUS = 4;
const FRESH_WINDOW_MS = 18 * 30.44 * 24 * 60 * 60 * 1000;
const MS_PER_SECOND = 1000;

// Canonical https URL with tracking noise removed, or null when unusable.
export function normalizeResultUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const lower = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const host = REDDIT_ALIAS.test(lower) ? 'reddit.com' : lower;
  const params = [...parsed.searchParams].filter(
    ([key]) => !TRACKING_PARAMS.has(key) && !key.startsWith(TRACKING_PREFIX),
  );
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '') || '/';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `https://${host}${port}${path}${query}`;
}

const alnum = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Topic terms and model numbers that a relevant result must mention.
export function queryTokens(query) {
  const cleaned = String(query ?? '')
    .replace(/\bsite:\S+/gi, ' ')
    .replace(/["“”]/g, ' ')
    .toLowerCase();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const modelTokens = [...new Set(
    words.filter((w) => /[a-z]/.test(w) && /\d/.test(w)).map(alnum).filter(Boolean),
  )];
  const terms = [...new Set(
    cleaned.split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_TERM_LENGTH && !STOPWORDS.has(w)),
  )];
  return { terms, modelTokens };
}

const termFound = (term, haystack) =>
  haystack.includes(term) || (term.endsWith('s') && haystack.includes(term.slice(0, -1)));

export function isRelevant(result, tokens) {
  const { terms = [], modelTokens = [] } = tokens ?? {};
  if (terms.length === 0 && modelTokens.length === 0) return true;
  const haystack = `${result?.title ?? ''} ${result?.url ?? ''} ${result?.content ?? ''}`.toLowerCase();
  if (!terms.some((t) => termFound(t, haystack))) return false;
  if (modelTokens.length === 0) return true;
  const flat = alnum(haystack);
  return modelTokens.some((m) => flat.includes(m));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isBlocked(url) {
  const host = hostOf(url);
  if (!host) return true;
  for (const d of BLOCKED_DOMAINS) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

function parsePublishedMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

// Merge duplicates by normalized URL. Keeps the earliest index, unions
// engines, keeps the longest content. Returns new objects only.
function mergeDuplicates(raw) {
  const byUrl = new Map();
  raw.forEach((r, index) => {
    const url = normalizeResultUrl(r?.url);
    if (!url) return;
    const engines = Array.isArray(r.engines) ? r.engines.filter((e) => typeof e === 'string') : [];
    const content = typeof r.content === 'string' ? r.content : '';
    const prev = byUrl.get(url);
    if (!prev) {
      const title = typeof r.title === 'string' ? r.title : '';
      byUrl.set(url, { url, title, content, engines: [...new Set(engines)], index, publishedMs: parsePublishedMs(r.publishedDate) });
      return;
    }
    byUrl.set(url, {
      ...prev,
      engines: [...new Set([...prev.engines, ...engines])],
      content: content.length > prev.content.length ? content : prev.content,
      publishedMs: prev.publishedMs ?? parsePublishedMs(r.publishedDate),
    });
  });
  return [...byUrl.values()];
}

function isFresh(item, nowMs) {
  if (item.publishedMs !== undefined && nowMs - item.publishedMs <= FRESH_WINDOW_MS) return true;
  const year = new Date(nowMs).getUTCFullYear();
  const years = new RegExp(`(^|\\D)(${year}|${year - 1})(\\D|$)`);
  return years.test(`${item.title} ${item.url}`);
}

function scoreItem(item, nowMs) {
  const position = Math.max(0, POS_MAX - item.index);
  const engines = ENGINE_BONUS * Math.max(0, item.engines.length - 1);
  const domain = isExpertDomain(item.url) ? EXPERT_BONUS : isCommunityDomain(item.url) ? COMMUNITY_BONUS : 0;
  const fresh = isFresh(item, nowMs) ? FRESH_BONUS : 0;
  return position + engines + domain + fresh;
}

export function rankResults(raw, query, nowMs) {
  if (!Array.isArray(raw)) return [];
  const tokens = queryTokens(query);
  return mergeDuplicates(raw)
    .filter((item) => !isBlocked(item.url) && isRelevant(item, tokens))
    .map((item) => ({ item, score: scoreItem(item, nowMs) }))
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index)
    .slice(0, SEARXNG_MAX_RESULTS)
    .map(({ item, score }) => ({
      url: item.url,
      title: item.title,
      content: item.content,
      engines: item.engines,
      score,
      publishedAt: item.publishedMs === undefined ? undefined : Math.floor(item.publishedMs / MS_PER_SECOND),
    }));
}

// Gate header object for fetch, or {} when the token is missing or blank.
function edgeGateHeader(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  return token ? { [EDGE_GATE_HEADER]: token } : {};
}

function buildSearchUrl(query, baseUrl, opts) {
  const params = new URLSearchParams({ q: query, format: 'json' });
  if (opts.topic === 'news') params.set('categories', 'news');
  // No time_range: SearXNG drops engines that cannot filter by date, which
  // shrinks the answer. Freshness is a ranking bonus instead.
  return `${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
}

// Cleaned, reranked results, or null so the caller falls through to the next
// provider (not configured, HTTP error, network error, timeout, bad JSON, or
// fewer than SEARXNG_MIN_USABLE usable results).
export async function searxngSearch(query, baseUrl, opts = {}) {
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT_MS);
  try {
    const response = await fetch(buildSearchUrl(query, baseUrl, opts), {
      signal: controller.signal,
      headers: { Accept: 'application/json', ...edgeGateHeader(opts.gateToken) },
    });
    if (!response.ok) {
      console.log(`[searxng] HTTP ${response.status} q="${query}"`);
      return null;
    }
    const data = await response.json();
    const raw = Array.isArray(data?.results) ? data.results : [];
    const ranked = rankResults(raw, query, Date.now());
    console.log(`[searxng] q="${query}" → raw ${raw.length}, kept ${ranked.length}`);
    if (ranked.length < SEARXNG_MIN_USABLE) return null;
    const label = opts.sourceLabel ?? 'web';
    return ranked.map((r) => ({ url: r.url, title: r.title, content: r.content, source: label, publishedAt: r.publishedAt }));
  } catch (err) {
    console.log(`[searxng] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
