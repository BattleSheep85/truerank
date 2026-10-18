// SearXNG metasearch client. The self-hosted instance aggregates ten free
// engines, so raw answers hold duplicates, dictionary and shopping junk, and
// off-topic hits. This module cleans them (URL-key dedupe, blocked
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
// SearXNG category for image engines (bing images, startpage images).
export const SEARXNG_IMAGES_CATEGORY = 'images';
// "1000×1000", "1200x1050", "3000 x 3000", "1500 X 851".
const RESOLUTION_RE = /^\s*(\d+)\s*[x×X]\s*(\d+)\s*$/;
const NO_RESOLUTION = Object.freeze({ width: 0, height: 0 });

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
// Longer inputs are junk and only cost parse time.
const MAX_URL_LENGTH = 2048;
const PURE_NUMBER = /^\d+$/;
// Ordinals and units ("2nd", "4k", "65in", "1tb", "120hz") are not model numbers.
const UNIT_TOKEN = /^\d+(st|nd|rd|th|k|ft|in|inch|gb|tb|mb|mm|cm|hz|ghz|w|v|mah|p|x|qt|lb|lbs|oz|mp|kg|ml)$/;
// Control characters cannot go in an HTTP header value.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
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

// Lowercase host without "www." or one trailing dot, reddit aliases mapped to
// reddit.com. Empty string when nothing is left.
function canonicalHost(hostname) {
  const noWww = hostname.toLowerCase().replace(/^www\./, '');
  if (!noWww) return '';
  const host = noWww.endsWith('.') ? noWww.slice(0, -1) : noWww;
  return REDDIT_ALIAS.test(host) ? 'reddit.com' : host;
}

// Path without trailing slashes, "/" for the root. Linear scan, no regex.
function trimTrailingSlashes(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end) || '/';
}

// Parsed http(s) URL, or null when unusable.
function parseResultUrl(url) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return canonicalHost(parsed.hostname) ? parsed : null;
}

// Copy of a parsed URL without userinfo, tracking params, or fragment.
// Userinfo goes because credentials leak and "rtings.com@evil.example" reads
// as the wrong host.
function stripNoise(parsed) {
  const params = [...parsed.searchParams].filter(
    ([key]) => !TRACKING_PARAMS.has(key) && !key.startsWith(TRACKING_PREFIX),
  );
  const out = new URL(parsed.href);
  out.username = '';
  out.password = '';
  out.search = new URLSearchParams(params).toString();
  out.hash = '';
  return out;
}

// Canonical https URL with tracking noise removed, or null when unusable.
// A merge key only: it removes www. and forces https, which can break a host
// that answers only on www or http, so never fetch or show it.
export function normalizeResultUrl(url) {
  const parsed = parseResultUrl(url);
  if (!parsed) return null;
  // Edit a parsed copy so the host stays in the host slot.
  const out = stripNoise(parsed);
  out.protocol = 'https:';
  out.hostname = canonicalHost(parsed.hostname);
  out.pathname = trimTrailingSlashes(parsed.pathname);
  return out.href;
}

// The URL to fetch and show: host and path as the engine gave them (www. and
// trailing slash kept), minus userinfo, tracking params, and fragment. https
// stays forced because read_page and Jina accept only https. Null when unusable.
function displayResultUrl(url) {
  const parsed = parseResultUrl(url);
  if (!parsed) return null;
  const out = stripNoise(parsed);
  out.protocol = 'https:';
  return out.href;
}

// Dedupe key shared by every search provider, so the same page from two
// providers (or with www, http, or a trailing slash) counts once. A URL that
// does not parse is its own key; a missing URL has none (null).
export function urlKey(url) {
  if (typeof url !== 'string' || !url) return null;
  return normalizeResultUrl(url) ?? url;
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
    words.filter((w) => /[a-z]/.test(w) && /\d/.test(w)).map(alnum)
      .filter((w) => w && !UNIT_TOKEN.test(w)),
  )];
  const terms = [...new Set(
    cleaned.split(/[^a-z0-9]+/).filter((w) => w.length >= MIN_TERM_LENGTH && !STOPWORDS.has(w)
      && !PURE_NUMBER.test(w) && !UNIT_TOKEN.test(w)),
  )];
  return { terms, modelTokens };
}

const termFound = (term, haystack) =>
  haystack.includes(term) || (term.endsWith('s') && haystack.includes(term.slice(0, -1)));

export function isRelevant(result, tokens) {
  const { terms = [], modelTokens = [] } = tokens ?? {};
  if (terms.length === 0 && modelTokens.length === 0) return true;
  const haystack = `${result?.title ?? ''} ${result?.url ?? ''} ${result?.content ?? ''}`.toLowerCase();
  if (terms.length > 0 && !terms.some((t) => termFound(t, haystack))) return false;
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

// Merge duplicates by normalized URL. Keeps the earliest index and its
// original URL, unions engines, keeps the longest content. Returns new objects only.
function mergeDuplicates(raw) {
  const byUrl = new Map();
  raw.forEach((r, index) => {
    const key = normalizeResultUrl(r?.url);
    if (!key) return;
    const engines = Array.isArray(r.engines) ? r.engines.filter((e) => typeof e === 'string') : [];
    const content = typeof r.content === 'string' ? r.content : '';
    const prev = byUrl.get(key);
    if (!prev) {
      const title = typeof r.title === 'string' ? r.title : '';
      const url = displayResultUrl(r.url);
      byUrl.set(key, { key, url, title, content, engines: [...new Set(engines)], index, publishedMs: parsePublishedMs(r.publishedDate) });
      return;
    }
    byUrl.set(key, {
      ...prev,
      engines: [...new Set([...prev.engines, ...engines])],
      content: content.length > prev.content.length ? content : prev.content,
      publishedMs: prev.publishedMs ?? parsePublishedMs(r.publishedDate),
    });
  });
  return [...byUrl.values()];
}

function isFresh(item, nowMs) {
  const age = item.publishedMs === undefined ? NaN : nowMs - item.publishedMs;
  if (age >= 0 && age <= FRESH_WINDOW_MS) return true;
  const year = new Date(nowMs).getUTCFullYear();
  const years = new RegExp(`(^|\\D)(${year}|${year - 1})(\\D|$)`);
  return years.test(`${item.title} ${item.url}`);
}

function scoreItem(item, nowMs) {
  const position = Math.max(0, POS_MAX - item.index);
  const engines = ENGINE_BONUS * Math.max(0, item.engines.length - 1);
  const domain = isExpertDomain(item.key) ? EXPERT_BONUS : isCommunityDomain(item.key) ? COMMUNITY_BONUS : 0;
  const fresh = isFresh(item, nowMs) ? FRESH_BONUS : 0;
  return position + engines + domain + fresh;
}

export function rankResults(raw, query, nowMs) {
  if (!Array.isArray(raw)) return [];
  const tokens = queryTokens(query);
  return mergeDuplicates(raw)
    .filter((item) => !isBlocked(item.key) && isRelevant(item, tokens))
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

// Gate header object for fetch, or {} when the token is missing, blank, or
// holds a control character (which fetch would reject or a proxy could split).
function edgeGateHeader(rawToken) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return {};
  if (CONTROL_CHARS.test(token)) {
    console.log('[searxng] gate token has invalid characters, header omitted');
    return {};
  }
  return { [EDGE_GATE_HEADER]: token };
}

function buildSearchUrl(query, baseUrl, opts) {
  const params = new URLSearchParams({ q: query, format: 'json' });
  // No category for topic news: none of the instance's engines serves "news",
  // so asking for it returned nothing. The general web engines answer instead.
  if (typeof opts.categories === 'string' && opts.categories) params.set('categories', opts.categories);
  // No time_range: SearXNG drops engines that cannot filter by date, which
  // shrinks the answer. Freshness is a ranking bonus instead.
  return `${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`;
}

// Parsed SearXNG JSON, or null on HTTP error, network error, timeout, or bad
// JSON. Shared by searxngSearch and searxngSiteSearch.
async function fetchSearxngJson(query, baseUrl, opts) {
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
    return await response.json();
  } catch (err) {
    console.log(`[searxng] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const resultsOf = (data) => (Array.isArray(data?.results) ? data.results : []);

// SearXNG image `resolution` string as { width, height }; { 0, 0 } when the
// value is missing, malformed, or not two positive integers.
export function parseResolution(value) {
  if (typeof value !== 'string') return { ...NO_RESOLUTION };
  const match = RESOLUTION_RE.exec(value);
  if (!match) return { ...NO_RESOLUTION };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return { ...NO_RESOLUTION };
  return { width, height };
}

// Image results in the Serper image shape ({ imageUrl, imageWidth,
// imageHeight }), SearXNG order, no ranking (the image resolver ranks).
// [] for zero results, null on any failure.
export async function searxngImageSearch(query, baseUrl, opts = {}) {
  if (!baseUrl) return null;
  const data = await fetchSearxngJson(query, baseUrl, { ...opts, categories: SEARXNG_IMAGES_CATEGORY });
  if (data === null) return null;
  const raw = resultsOf(data);
  const images = raw
    .filter((r) => typeof r?.img_src === 'string' && r.img_src !== '')
    .map((r) => {
      const { width, height } = parseResolution(r.resolution);
      return { imageUrl: r.img_src, imageWidth: width, imageHeight: height };
    });
  console.log(`[searxng] images q="${query}" → raw ${raw.length}, kept ${images.length}`);
  return images;
}

// Cleaned, reranked results, or null so the caller falls through to the next
// provider (not configured, HTTP error, network error, timeout, bad JSON, or
// fewer than SEARXNG_MIN_USABLE usable results).
export async function searxngSearch(query, baseUrl, opts = {}) {
  if (!baseUrl) return null;
  const data = await fetchSearxngJson(query, baseUrl, opts);
  if (data === null) return null;
  const raw = resultsOf(data);
  const ranked = rankResults(raw, query, Date.now());
  console.log(`[searxng] q="${query}" → raw ${raw.length}, kept ${ranked.length}`);
  if (ranked.length < SEARXNG_MIN_USABLE) return null;
  const label = opts.sourceLabel ?? 'web';
  return ranked.map((r) => ({ url: r.url, title: r.title, content: r.content, source: label, publishedAt: r.publishedAt }));
}

// Raw site: search answers for the ASIN resolver: SearXNG order, {url, title}
// only, no cleanup (the resolver checks URL patterns and titles itself).
// [] for zero results, null on any failure.
export async function searxngSiteSearch(query, baseUrl, opts = {}) {
  if (!baseUrl) return null;
  const data = await fetchSearxngJson(query, baseUrl, opts);
  if (data === null) return null;
  return resultsOf(data)
    .filter((r) => typeof r?.url === 'string')
    .map((r) => ({ url: r.url, title: typeof r.title === 'string' ? r.title : '' }));
}
