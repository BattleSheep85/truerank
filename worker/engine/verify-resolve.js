// Page finding and reading for the verify path (Truth Audit).
//
// Finds the product's own pages (the maker's site or a retailer listing) to
// extract claims from, finds and reads independent test pages for the claims,
// and keeps every maker or retailer page out of the independent evidence pool. Before this module, resolution only kept gathered
// sources on a short fixed domain list (credibility.js), so the maker's own
// site (soundcore.com, jbl.com, creality.com) was never a claim source and
// counted as independent evidence instead.
//
// Zero runtime deps. Pure helpers first, then the I/O step (search + read are
// injectable for tests).

import { runSearch, readPageInto } from './tools.js';
import { isManufacturerDomain } from '../lib/credibility.js';
import { isFetchableUrl } from '../lib/url-guard.js';
import { afterAbort, anySignal, delay, runPoolUntil, POOL_GRACE_MS } from '../lib/deadline.js';

const TOKEN_RE = /[a-z0-9]+/g;
const DIGIT_RE = /\d/;
const ALPHA_RE = /[a-z]/;

// A token with letters and digits and at least this many chars is a model
// code ("1000xm6", "aw3423dwf"). A page that names the code is about the product.
const MODEL_CODE_MIN_CHARS = 5;
// A short word right after the model number names a variant ("nc", "pro", "combo").
const VARIANT_MAX_CHARS = 5;
// A model run without its series word must have at least this many chars.
const MIN_BARE_RUN_CHARS = 4;
// A short letter prefix of a model code ("wh" of WH-1000XM6) is part of the
// model name: WF-1000XM6 (earbuds) shares the code "1000xm6".
const MODEL_PREFIX_MAX_CHARS = 3;
// A single brand word must have at least this many chars ("jbl", "sony").
const MIN_BRAND_CHARS = 3;
// The brand is one of the first words of the product name.
const BRAND_WORDS = 2;

// Generic name words a product page often leaves out ("12th generation",
// "2024", "mouse"). The name match ignores them; brand, series words, and
// model numbers must still match.
const QUALIFIER_WORDS = new Set([
  'generation', 'gen', 'edition', 'model', 'version', 'series',
  'mouse', 'headphones', 'earbuds', 'speaker', 'phone', 'watch', 'vacuum',
  'printer', 'monitor', 'laptop', 'tablet', 'ereader', 'camera', 'keyboard',
]);
const ORDINAL_RE = /^(?:1st|2nd|3rd|[4-9]th|1\dth|20th)$/;
const YEAR_RE = /^(?:2019|202\d|2030)$/;
const E_READER_RE = /\be-reader\b/gi;

// Retailer host labels on any country domain. credibility.js lists only a few
// retailer hosts (amazon.com, amazon.co.uk, amazon.de).
const RETAILER_LABELS = new Set([
  'amazon', 'bestbuy', 'walmart', 'target', 'newegg', 'bhphotovideo', 'costco',
  'crutchfield', 'microcenter', 'adorama', 'ebay', 'currys', 'argos', 'johnlewis',
  'mediamarkt', 'jbhifi', 'harveynorman', 'aliexpress', 'temu', 'staples',
]);

// Second-level labels of country domains with a two-part suffix (amazon.co.uk).
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);

// Search and listing pages name many products. They are not a product page.
// "clp" is an Amazon category landing page, not a product page.
const LISTING_PATH_RE = /\/(?:s|b|sch|search|searchpage\.jsp|clp)(?:\/|$)/i;
// Pages on the maker's site that are not the product page. Ranked last.
const SECONDARY_PATH_RE = /\/(?:support|manuals?|faqs?|community|forums?|blog|news|press|compare|reviews?)(?:\/|$)/i;
// Spec pages and spec sheets list the maker's claims densely. Ranked first,
// also under a support path.
const SPEC_PATH_RE = /spec/i;

// Searches that find the product's own pages. Not recency filtered: a
// product page can be older than a year.
export const RESOLVE_QUERY_SUFFIXES = Object.freeze(['', ' specs']);
// Page reads per resolution (the first pass and the retry share it).
export const MAX_RESOLVE_READS = 4;
// Usable claim pages to read before extraction starts.
export const CLAIM_PAGES_WANTED = 2;

function tokens(text) {
  return String(text ?? '').toLowerCase().match(TOKEN_RE) || [];
}

function isQualifier(token) {
  return QUALIFIER_WORDS.has(token) || ORDINAL_RE.test(token) || YEAR_RE.test(token);
}

// Product name tokens without the generic qualifier words, or all tokens
// when only qualifier words are left.
function nameTokens(product) {
  const all = tokens(String(product ?? '').replace(E_READER_RE, 'ereader'));
  const kept = all.filter((w) => !isQualifier(w));
  return kept.length > 0 ? kept : all;
}

function squash(text) {
  return tokens(text).join('');
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Registrable label of a host: "us.soundcore.com" -> "soundcore", "www.amazon.co.uk" -> "amazon". */
export function hostLabel(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  const parts = parsed.hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  const twoPartSuffix = parts.length >= 3 && parts.at(-1).length === 2 && SECOND_LEVEL_LABELS.has(parts.at(-2));
  return twoPartSuffix ? parts.at(-3) : parts.at(-2);
}

/** Host labels the maker's own site can have: the first words of the name, alone or joined. */
export function brandLabels(product) {
  const words = tokens(product).slice(0, BRAND_WORDS);
  const singles = words.filter((w) => w.length >= MIN_BRAND_CHARS && !DIGIT_RE.test(w));
  const joined = words.length === BRAND_WORDS && !words.some((w) => DIGIT_RE.test(w)) ? [words.join('')] : [];
  return [...new Set([...singles, ...joined])];
}

/** 'maker', 'retailer', or null (the page is neither the maker's nor a retailer's). */
export function ownPageKind(url, product) {
  const label = hostLabel(url);
  if (!label) return null;
  if (RETAILER_LABELS.has(label)) return 'retailer';
  if (brandLabels(product).includes(label)) return 'maker';
  return isManufacturerDomain(url) ? 'maker' : null;
}

function isModelCode(token) {
  return token.length >= MODEL_CODE_MIN_CHARS && DIGIT_RE.test(token) && ALPHA_RE.test(token);
}

function longest(list) {
  return list.reduce((a, b) => (b.length > a.length ? b : a));
}

// The longest model code with its short letter prefix, when it has one.
function modelCodeKey(words, code) {
  const prev = words[words.indexOf(code) - 1] ?? '';
  const isPrefix = prev.length > 0 && prev.length <= MODEL_PREFIX_MAX_CHARS && !DIGIT_RE.test(prev);
  return isPrefix ? `${prev}${code}` : code;
}

// Name without a model number: the series words after the brand.
function seriesKey(words) {
  return words.length > 1 ? words.slice(1, 3).join('') : words.join('');
}

/**
 * Squashed name runs a page must contain to be about this product. A model
 * code (with its short letter prefix) is enough: "wh1000xm6", "aw3423dwf".
 * Otherwise the series word plus the model number plus one short variant
 * word ("liberty4nc", "flip7", "k2combo"). Generic qualifier words
 * ("12th generation", "2024", "mouse") are not part of a key.
 */
export function productKeys(product) {
  const words = nameTokens(product);
  if (words.length === 0) return [];
  const codes = words.filter(isModelCode);
  if (codes.length > 0) return [modelCodeKey(words, longest(codes))];

  const first = words.findIndex((w) => DIGIT_RE.test(w));
  if (first < 0) return [seriesKey(words)];
  const next = words[first + 1];
  const variant = next && !DIGIT_RE.test(next) && next.length <= VARIANT_MAX_CHARS ? next : '';
  const run = `${words[first]}${variant}`;
  const withSeries = first > 0 ? `${words[first - 1]}${run}` : run;
  return run.length >= MIN_BARE_RUN_CHARS && run !== withSeries ? [withSeries, run] : [withSeries];
}

// Words of the url path and the title.
function pathAndTitleWords(source) {
  const parsed = parseUrl(source?.url);
  const path = parsed ? decodeURIComponentSafe(parsed.pathname) : '';
  return { path, words: tokens(`${path} ${source?.title ?? ''}`) };
}

/** True when the url path or the title names this product (see productKeys). */
export function namesProduct(source, product) {
  const keys = productKeys(product);
  if (keys.length === 0) return false;
  const { path } = pathAndTitleWords(source);
  const text = `${squash(path)} ${squash(source?.title)}`;
  return keys.some((key) => text.includes(key));
}

// The series word and model number of a name without a model code
// ("flip" and "7" of "JBL Flip 7"), or null.
function seriesAndNumber(words) {
  const first = words.findIndex((w) => DIGIT_RE.test(w));
  return first > 0 ? { series: words[first - 1], number: words[first] } : null;
}

/**
 * True when the url path or the title names another model of the same line
 * and not this one: WF-1000XM6 or WH-1000XM5 for WH-1000XM6, Flip 6 for
 * Flip 7. Such a page tests another product.
 */
export function namesOtherModel(source, product) {
  if (namesProduct(source, product)) return false;
  const ours = nameTokens(product);
  const { words } = pathAndTitleWords(source);
  const codes = ours.filter(isModelCode);
  if (codes.length > 0) {
    const ourKey = modelCodeKey(ours, longest(codes));
    return words.some((w) => isModelCode(w) && modelCodeKey(words, w) !== ourKey);
  }
  const line = seriesAndNumber(ours);
  if (!line) return false;
  return words.some((w, i) => w === line.series && DIGIT_RE.test(words[i + 1] ?? '') && words[i + 1] !== line.number);
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function isListingPage(url) {
  const parsed = parseUrl(url);
  return !parsed || LISTING_PATH_RE.test(parsed.pathname);
}

// Lower rank is better: maker product or spec page, retailer page, other maker pages.
function candidateRank(source, kind) {
  const path = parseUrl(source.url)?.pathname ?? '';
  if (kind === 'maker' && SPEC_PATH_RE.test(path)) return 0;
  if (SECONDARY_PATH_RE.test(path)) return 2;
  return kind === 'maker' ? 0 : 1;
}

/** Host plus path, without query, hash, or a trailing slash: one key per page. */
export function canonicalPageKey(url) {
  const parsed = parseUrl(url);
  if (!parsed) return String(url ?? '');
  return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
}

// Puts the first page of each host before the second page of any host, so two
// claim pages come from two sites (not two colors of one product page).
function hostDiverse(sources) {
  const seenHosts = new Set();
  const firsts = [];
  const rest = [];
  for (const source of sources) {
    const host = parseUrl(source.url)?.hostname ?? '';
    (seenHosts.has(host) ? rest : firsts).push(source);
    seenHosts.add(host);
  }
  return [...firsts, ...rest];
}

/**
 * Why a source is or is not a claim page candidate: 'maker' or 'retailer'
 * (a candidate), or 'not-own-site', 'listing-page', 'other-product'.
 */
export function claimCandidateReason(source, product) {
  const kind = ownPageKind(source?.url, product);
  if (!kind) return 'not-own-site';
  if (isListingPage(source.url)) return 'listing-page';
  return namesProduct(source, product) ? kind : 'other-product';
}

/**
 * Own-page candidates for claim extraction, best first, one per page (see
 * canonicalPageKey): maker or retailer pages that name the product and are
 * not search or listing pages. Equal rank keeps the input order, then the
 * first page of each host comes before a second page of any host.
 * Does not change the input.
 */
export function rankClaimCandidates(sources, product) {
  const seen = new Set();
  const candidates = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const key = canonicalPageKey(source?.url);
    if (!source?.url || seen.has(key)) continue;
    const kind = claimCandidateReason(source, product);
    if (kind !== 'maker' && kind !== 'retailer') continue;
    seen.add(key);
    candidates.push({ source, rank: candidateRank(source, kind), index });
  }
  const ranked = candidates.sort((a, b) => a.rank - b.rank || a.index - b.index).map((c) => c.source);
  return hostDiverse(ranked);
}

/** Sources that can be independent evidence: not on the maker's or a retailer's site. */
export function independentSources(sources, product) {
  return (Array.isArray(sources) ? sources : []).filter((s) => s?.url && !ownPageKind(s.url, product));
}

/** Lowercase word tokens of the product name. */
export function productWords(product) {
  return tokens(product);
}

const REGEXP_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Start offsets of product name mentions in text: each productKeys key with
 * any separators between its chars ("wh1000xm6" finds "WH-1000XM6"). Sorted.
 */
export function productMentions(text, product) {
  const body = String(text ?? '');
  const starts = productKeys(product).flatMap((key) => {
    const pattern = key.split('').map((c) => c.replace(REGEXP_SPECIAL_RE, '\\$&')).join('[^a-z0-9]*');
    return [...body.matchAll(new RegExp(`(?<![a-z0-9])${pattern}`, 'gi'))].map((m) => m.index);
  });
  return [...new Set(starts)].sort((a, b) => a - b);
}

/**
 * True when a source is about this product: its url, title, or text names it
 * (see productKeys). A gathered page about another product (an unrelated
 * article that matched a search word) is not evidence for this one.
 */
export function aboutProduct(source, product) {
  if (namesProduct(source, product)) return true;
  const text = squash(source?.content);
  return productKeys(product).some((key) => text.includes(key));
}

/** One key per evidence page: host plus path, plus the video id of a YouTube watch url. */
export function evidenceKey(url) {
  const parsed = parseUrl(url);
  const video = parsed?.searchParams.get('v');
  return video ? `${canonicalPageKey(url)}?v=${video}` : canonicalPageKey(url);
}

// Evidence text below this many chars is a search snippet, not a page read.
export const THIN_EVIDENCE_CHARS = 1500;

// Two copies of one page: the longer text wins, but two snippets (from two
// searches) join in first-seen order, so the passage each search found stays.
function mergeCopies(kept, source) {
  const a = String(kept.content ?? '');
  const b = String(source.content ?? '');
  const longer = b.length > a.length ? source : kept;
  const bothThin = a.length < THIN_EVIDENCE_CHARS && b.length < THIN_EVIDENCE_CHARS;
  if (!bothThin || !a || !b || a.includes(b) || b.includes(a)) return longer;
  return { ...longer, content: `${a}\n${b}` };
}

/**
 * One source per evidence page, in first-seen order: the longest text, or
 * the joined snippets when every copy is a snippet. Does not change the input.
 */
export function uniqueEvidence(sources) {
  const best = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    const key = evidenceKey(source.url);
    const kept = best.get(key);
    best.set(key, kept ? mergeCopies(kept, source) : source);
  }
  return [...best.values()];
}

// ── Page text checks ─────────────────────────────────────────────────────────

// Bot walls, block pages, and error pages that a reader returns instead of the page.
const BLOCK_PAGE_PATTERNS = Object.freeze([
  /\bnot a robot\b/i,
  /enter the characters you see below/i,
  /\bcaptcha\b/i,
  /access denied/i,
  /you don'?t have permission to access/i,
  /request (?:blocked|unsuccessful)/i,
  /just a moment\.\.\./i,
  /checking (?:your|if the site connection is secure|the browser)/i,
  /verify (?:that )?you are (?:a )?human/i,
  /pardon our interruption/i,
  /robot or human/i,
  /unusual traffic/i,
  /enable (?:javascript|js) and disable any ad ?blocker/i,
  /attention required/i,
  /target url returned error [45]\d\d/i,
  /\b(?:403 forbidden|404 not found|page not found)\b/i,
]);
// A block page is short. A real product page that mentions "captcha" in a
// footer is long, so the patterns apply only below this length.
const BLOCK_PAGE_MAX_CHARS = 3000;
// Below this many chars of clean text a page has no claims worth extracting.
export const MIN_CLAIM_PAGE_CHARS = 600;

// A spec value: a number with a unit, a percentage, an IP rating, or a
// Bluetooth version. A page with claims has several distinct ones.
const SPEC_VALUE_RE = /\b\d+(?:[.,]\d+)?\s?(?:hrs?|hours?|h|mins?|minutes?|mm|cm|m|in|inch(?:es)?|ft|g|kg|lbs?|oz|mah|wh|w|v|hz|khz|mhz|db|ms|gb|tb|mbps|kbps|nits|mp|fps|rpm|°c|°f)\b|\b\d+(?:[.,]\d+)?\s?%|\bip[x\d]\d\b|\bbluetooth\s?\d(?:\.\d)?\b/gi;
const MIN_SPEC_VALUES = 4;
// A prose line has at least this many words. Navigation lines are shorter.
const PROSE_LINE_MIN_WORDS = 8;
const MIN_PROSE_CHARS = 800;

const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL_RE = /https?:\/\/\S+/g;
const EMPTY_LINE_RE = /^[\s|*#>_\-=:.,]*$/;

/** Page text without images, link targets, bare URLs, and empty lines. */
export function cleanPageText(content) {
  const text = String(content ?? '')
    .replace(MD_IMAGE_RE, ' ')
    .replace(MD_LINK_RE, '$1')
    .replace(BARE_URL_RE, ' ');
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => !EMPTY_LINE_RE.test(line))
    .join('\n');
}

// Base64 blobs, tracking ids, and other unbroken runs this long are not prose.
const LONG_RUN_RE = /\S{41,}/g;

/** Evidence page text for passage selection: clean text without long unbroken runs. */
export function evidenceText(content) {
  return cleanPageText(content).replace(LONG_RUN_RE, ' ');
}

/** True when the text is a bot wall, block page, or error page (short text only). */
export function isBlockPage(content) {
  const text = cleanPageText(content);
  if (text.length >= BLOCK_PAGE_MAX_CHARS) return false;
  return BLOCK_PAGE_PATTERNS.some((re) => re.test(text));
}

/**
 * True when clean page text carries claims: at least MIN_SPEC_VALUES distinct
 * spec values, or MIN_PROSE_CHARS of prose lines. A page read that returns
 * only the site's navigation menus (electronics.sony.com: the menus fill the
 * reader's 15,000-char cap) has neither.
 */
export function hasClaimContent(cleanText) {
  const text = String(cleanText ?? '');
  const specValues = new Set((text.match(SPEC_VALUE_RE) || []).map((v) => v.toLowerCase().replace(/\s+/g, '')));
  if (specValues.size >= MIN_SPEC_VALUES) return true;
  const prose = text.split('\n').filter((line) => line.split(/\s+/).length >= PROSE_LINE_MIN_WORDS);
  return prose.join('\n').length >= MIN_PROSE_CHARS;
}

/** Why page text cannot feed claim extraction ('too-short', 'block-page', 'no-claim-content'), or null. */
export function claimPageProblem(content) {
  const text = cleanPageText(content);
  if (text.length < MIN_CLAIM_PAGE_CHARS) return 'too-short';
  if (isBlockPage(content)) return 'block-page';
  return hasClaimContent(text) ? null : 'no-claim-content';
}

/** True when the page text can feed claim extraction. */
export function isUsableClaimPage(content) {
  return claimPageProblem(content) === null;
}

// ── I/O: search and read ─────────────────────────────────────────────────────

/**
 * Own-page candidates from searches for the product's own pages
 * (RESOLVE_QUERY_SUFFIXES), best first. Returns { candidates, queries, found }
 * (found: every search result).
 */
export async function findClaimCandidates({ product, env, search = runSearch }) {
  const queries = RESOLVE_QUERY_SUFFIXES.map((suffix) => `${product}${suffix}`);
  const results = await Promise.all(queries.map((q) => search(q, 'web', env, false)));
  const found = results.flatMap((list) => (Array.isArray(list) ? list : []));
  return { candidates: rankClaimCandidates(found, product), queries, found };
}

// The fallback read: Jina (with the key when one is set) with a longer wait, and without navigation,
// headers, footers, and images. The shared reader (worker/lib/jina.js) stops
// after 8 s (keyless Jina often needs longer on a product page) and keeps the
// first 15,000 chars, which can be only menus.
const FOCUSED_READ_TIMEOUT_MS = 25_000;
const FOCUSED_READ_MAX_CHARS = 40_000;
const FOCUSED_READ_HEADERS = Object.freeze({
  Accept: 'text/markdown',
  'X-Return-Format': 'markdown',
  'X-Retain-Images': 'none',
  'X-Remove-Selector': 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
  'X-Timeout': '20',
});

/**
 * Page text from the fallback read, or '' on any failure. Never throws.
 * With a Jina key the read uses it (paid tier: faster, no free rate cap).
 * `opts.signal` (optional) stops the read at a caller deadline.
 */
export async function readFocusedPage(url, fetchImpl = fetch, apiKey = '', opts = {}) {
  if (!isFetchableUrl(url) || opts.signal?.aborted) return '';
  const headers = apiKey ? { ...FOCUSED_READ_HEADERS, Authorization: `Bearer ${apiKey}` } : FOCUSED_READ_HEADERS;
  try {
    const response = await fetchImpl(`https://r.jina.ai/${url}`, {
      headers,
      signal: anySignal([AbortSignal.timeout(FOCUSED_READ_TIMEOUT_MS), opts.signal]),
    });
    if (!response.ok) {
      console.log(`[verify-resolve] focused read HTTP ${response.status} for ${url}`);
      return '';
    }
    return (await response.text()).slice(0, FOCUSED_READ_MAX_CHARS);
  } catch (err) {
    console.log(`[verify-resolve] focused read failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

// When the focused read is usable first, readClaimPage waits this long for
// the shared read: its text is the one claim extraction was tuned on.
export const SHARED_READ_WAIT_MS = 2000;

// The claim page of two page reads ({ page, via }): the shared read when it
// is usable; else the focused read when it is usable; else the shared read
// (its text gives the reject reason). A usable focused read that comes first
// waits at most waitMs for the shared read.
function preferShared(shared, focused, waitMs) {
  return new Promise((resolve) => {
    let sharedResult = null;
    let focusedResult = null;
    let timer = null;
    const finish = (result) => {
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const decide = () => {
      if (sharedResult && isUsableClaimPage(sharedResult.page.content)) return finish(sharedResult);
      const focusedUsable = focusedResult && isUsableClaimPage(focusedResult.page.content);
      if (sharedResult && focusedUsable) return finish(focusedResult);
      if (sharedResult && focusedResult) return finish(sharedResult);
      if (focusedUsable && timer === null) timer = setTimeout(() => finish(focusedResult), waitMs);
      return undefined;
    };
    shared.then((result) => {
      sharedResult = result;
      decide();
    });
    focused.then((result) => {
      focusedResult = result;
      decide();
    });
  });
}

// One claim page: the shared reader and the focused read at the same time
// (preferShared picks the text); the other read stops. Before, the focused
// read started only after the shared read failed, so a slow product page
// cost both waits in series. Fills a copy, so the candidate never changes.
async function readClaimPage(candidate, env, read, focusedRead, signal, sharedWaitMs = SHARED_READ_WAIT_MS) {
  const started = Date.now();
  const loser = new AbortController();
  const stop = anySignal([signal, loser.signal]);
  const shared = Promise.resolve()
    .then(async () => {
      const copy = { ...candidate };
      await read(copy, env, { signal: stop });
      return copy;
    })
    .catch(() => ({ ...candidate }))
    .then((page) => ({ page, via: 'shared read' }));
  const focused = Promise.resolve()
    .then(() => focusedRead(candidate.url, undefined, env?.JINA_API_KEY || '', { signal: stop }))
    .then((text) => ({ ...candidate, content: String(text ?? '') }))
    .catch(() => ({ ...candidate, content: '' }))
    .then((page) => ({ page, via: 'focused read' }));
  const { page, via } = await preferShared(shared, focused, sharedWaitMs);
  loser.abort();
  const problem = claimPageProblem(page.content);
  const chars = String(page.content ?? '').length;
  console.log(`[verify-resolve] claim page ${problem ?? `usable via ${via}`} in ${Date.now() - started} ms (${chars} chars) ${candidate.url}`);
  return page;
}

// The candidates to look at from `start`: each candidate that is already
// usable, and each one that needs a read, until maxReads reads or until
// `wanted` candidates are usable without a read.
function claimReadWindow(list, start, wanted, maxReads) {
  const window = [];
  let reads = 0;
  let known = 0;
  let index = start;
  for (; index < list.length && known < wanted; index += 1) {
    const usable = isUsableClaimPage(list[index].content);
    if (!usable && reads >= maxReads) break;
    if (usable) known += 1;
    else reads += 1;
    window.push({ candidate: list[index], needsRead: !usable });
  }
  return { window, reads, nextIndex: index };
}

// Waits for a promise, or until graceMs after signal aborts (then null).
function untilStopped(promise, signal, graceMs = POOL_GRACE_MS) {
  if (!signal) return promise;
  const stop = afterAbort(signal, graceMs);
  return Promise.race([promise, stop.promise.then(() => null)]).finally(stop.cancel);
}

// True when a settled read (a page, not null) is usable.
function isUsableRead(page) {
  return page !== null && isUsableClaimPage(page.content);
}

// True when the claim pages are known: the first `wanted` usable pages in
// candidate order, with every read before them done, or every read done.
function claimPagesKnown(done, wanted) {
  let usable = 0;
  for (const page of done) {
    if (usable >= wanted) return true;
    if (page === null) return false;
    if (isUsableClaimPage(page.content)) usable += 1;
  }
  return true;
}

const STOPPED = Symbol('stopped');
const OUT_OF_PATIENCE = Symbol('out-of-patience');

// Waits until claimPagesKnown, or until `signal` aborts (plus graceMs). Once
// `wanted` reads are usable in any order, it waits at most patienceMs more
// for slower reads of better ranked candidates (0 = no limit). `done[i]` is
// the page of read i, or null while it runs; `tracked[i]` settles after
// done[i] is set.
async function settleClaimReads({ done, tracked, wanted, signal, patienceMs, graceMs }) {
  const stop = afterAbort(signal, graceMs);
  let patience = null;
  try {
    while (!claimPagesKnown(done, wanted)) {
      const running = tracked.filter((_, i) => done[i] === null);
      if (!patience && patienceMs > 0 && done.filter(isUsableRead).length >= wanted) patience = delay(patienceMs);
      const waits = [Promise.race(running), stop.promise.then(() => STOPPED)];
      if (patience) waits.push(patience.promise.then(() => OUT_OF_PATIENCE));
      const why = await Promise.race(waits);
      if (why === STOPPED || why === OUT_OF_PATIENCE) return;
    }
  } finally {
    stop.cancel();
    patience?.cancel();
  }
}

// The first `wanted` usable pages among the done reads, in candidate order,
// and the reads done without a usable page. A read still running is neither.
function pickClaimPages(done, wanted) {
  const picked = [];
  const rejected = [];
  done.forEach((page, i) => {
    if (page === null) return;
    if (!isUsableClaimPage(page.content)) rejected.push(i);
    else if (picked.length < wanted) picked.push(i);
  });
  return { picked, rejected };
}

function rejectedRow(page) {
  return { url: page.url, chars: String(page.content ?? '').length, reason: claimPageProblem(page.content) };
}

/**
 * Reads the candidates from `start` at the same time (claimReadWindow: at
 * most `maxReads` reads; a candidate that is already usable needs no read)
 * and keeps the first `wanted` usable pages in candidate order. Each read
 * runs the shared reader and the focused read at once and keeps the shared
 * text when it is usable (a usable focused text waits at most sharedWaitMs
 * for it). It returns as soon as those pages are known, without waiting for
 * the reads after them. When `wanted` pages are usable but a better ranked
 * candidate is still being read, it waits at most `patienceMs` for that
 * read (0 = until it ends), then takes the usable pages it has. A page that stays unusable is
 * skipped with its reason (see claimPageProblem). `signal` (optional) is the
 * stage deadline: a read still running then stops and counts as unusable.
 * Returns { pages, rejected: [{ url, chars, reason }], readsUsed, nextIndex,
 * spares } — spares: a promise of { pages, rejected } for the window's other
 * candidates, usable pages in candidate order (the extraction retry uses them).
 */
export async function readClaimPages(candidates, env, opts = {}) {
  const {
    wanted,
    maxReads,
    start = 0,
    read = readPageInto,
    focusedRead = readFocusedPage,
    signal,
    patienceMs = 0,
    graceMs = POOL_GRACE_MS,
    sharedWaitMs = SHARED_READ_WAIT_MS,
  } = opts;
  const list = Array.isArray(candidates) ? candidates : [];
  const { window, reads, nextIndex } = claimReadWindow(list, start, wanted, maxReads);
  const pending = window.map(({ candidate, needsRead }) =>
    (needsRead ? readClaimPage(candidate, env, read, focusedRead, signal, sharedWaitMs) : Promise.resolve(candidate)));
  const done = new Array(pending.length).fill(null);
  const tracked = pending.map((p, i) => p.then((page) => {
    done[i] = page;
  }));

  await settleClaimReads({ done, tracked, wanted, signal, patienceMs, graceMs });
  const snapshot = [...done];
  const { picked, rejected } = pickClaimPages(snapshot, wanted);
  const settledElsewhere = new Set([...picked, ...rejected]);
  const others = window.map((_, i) => i).filter((i) => !settledElsewhere.has(i));
  const spares = Promise.all(others.map((i) => untilStopped(pending[i], signal, graceMs).then((page) => page ?? window[i].candidate)))
    .then((pages) => ({
      pages: pages.filter((page) => isUsableClaimPage(page.content)),
      rejected: pages.filter((page) => !isUsableClaimPage(page.content)).map(rejectedRow),
    }));
  return {
    pages: picked.map((i) => snapshot[i]),
    rejected: rejected.map((i) => rejectedRow(snapshot[i])),
    readsUsed: reads,
    nextIndex,
    spares,
  };
}

// ── Evidence: claim searches and test page reads ─────────────────────────────

// Words added to a claim search. They steer the results to test results.
const CLAIM_SEARCH_WORDS = 'review test';
// Claim topic words in one claim search.
const CLAIM_QUERY_TOPIC_WORDS = 6;
// Claim searches per run: one for each claim.
export const MAX_CLAIM_SEARCHES = 12;
const NUMBER_ONLY_RE = /^\d+$/;
// Full reads of test pages per run.
export const MAX_TEST_PAGE_READS = 8;
// Reads at the same time. The keyless reader allows about 20 reads a minute.
const TEST_READ_CONCURRENCY = 2;
// With a Jina key (paid tier, no free rate cap) every test page is read at once.
const KEYED_TEST_READ_CONCURRENCY = MAX_TEST_PAGE_READS;
// Host labels whose reads hold no test text: video and social pages.
export const NO_READ_LABELS = new Set(['youtube', 'youtu', 'tiktok', 'instagram', 'facebook', 'x', 'twitter', 'pinterest', 'threads']);
// A url or title with one of these words is a test or review page.
const TEST_PAGE_RE = /\breviews?\b|\btested\b|\btests?\b|\bhands[- ]on\b|\bmeasure/i;

/**
 * The search for independent tests of one claim: the product name, the
 * claim's topic words, and CLAIM_SEARCH_WORDS. Bare numbers stay out: a
 * test result seldom repeats the claimed value.
 */
export function claimSearchQuery(product, terms) {
  const topic = (Array.isArray(terms) ? terms : [])
    .filter((t) => !NUMBER_ONLY_RE.test(t))
    .slice(0, CLAIM_QUERY_TOPIC_WORDS);
  return [String(product ?? '').trim(), ...topic, CLAIM_SEARCH_WORDS].join(' ');
}

/** Round robin over lists: the first item of each list, then the second, and so on. */
export function interleave(lists) {
  const all = (Array.isArray(lists) ? lists : []).map((l) => (Array.isArray(l) ? l : []));
  const longest = Math.max(0, ...all.map((l) => l.length));
  return Array.from({ length: longest }, (_, i) => all.filter((l) => i < l.length).map((l) => l[i])).flat();
}

/**
 * One search per claim (claimSearchQuery), at most MAX_CLAIM_SEARCHES. Not
 * recency filtered: a test from last year still holds. `termsFor(claim)`
 * gives the claim's terms. Returns { queries, results: one list per claim }.
 */
export async function searchClaimTests({ claims, product, termsFor, env, search = runSearch }) {
  const picked = (Array.isArray(claims) ? claims : []).slice(0, MAX_CLAIM_SEARCHES);
  const queries = picked.map((claim) => claimSearchQuery(product, termsFor(claim)));
  const results = await Promise.all(queries.map((q) => Promise.resolve().then(() => search(q, 'web', env, false)).catch(() => [])));
  return { queries, results: results.map((list) => (Array.isArray(list) ? list : [])) };
}

/**
 * Snippet-only independent pages worth a full read, best first, at most max:
 * pages whose url or title names this product and no other model, not the
 * maker's or a retailer's, not video or social pages, one per page. Test and
 * review pages come first, then the input order. Does not change the input.
 */
export function testPagesToRead(sources, product, max = MAX_TEST_PAGE_READS) {
  const seen = new Set();
  const picks = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const key = evidenceKey(source?.url);
    if (!source?.url || seen.has(key) || String(source.content ?? '').length >= THIN_EVIDENCE_CHARS) continue;
    if (ownPageKind(source.url, product) || NO_READ_LABELS.has(hostLabel(source.url))) continue;
    if (!namesProduct(source, product) || namesOtherModel(source, product)) continue;
    seen.add(key);
    const { path } = pathAndTitleWords(source);
    picks.push({ source, rank: TEST_PAGE_RE.test(`${path} ${source.title ?? ''}`) ? 0 : 1, index });
  }
  return picks.sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, max).map((p) => p.source);
}

// Gather page reads per product check, and the credibility score a page
// needs for a read (the gather's own limits, worker/engine/parallel-engine.js).
export const MAX_GATHER_READS = 50;
const GATHER_READ_MIN_SCORE = 45;

/**
 * The gather's page reads for a product check, best first, at most `max`:
 * snippet-only pages that can be independent evidence (not the maker's or a
 * retailer's site, not video or social pages, not titled for another model
 * of the line), one per page, with a credibility score of at least
 * `minScore`. Pages whose url, title, or snippet names this product come
 * first, then the others; each group by credibility score. Before this,
 * the gather read the most credible pages of any topic first (RSS items
 * about other products), and a stage deadline cut the useful reads.
 * Does not change the input.
 */
export function evidencePagesToRead(sources, product, { max = MAX_GATHER_READS, minScore = GATHER_READ_MIN_SCORE } = {}) {
  const seen = new Set();
  const picks = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const key = evidenceKey(source?.url);
    if (!source?.url || seen.has(key) || String(source.content ?? '').length >= THIN_EVIDENCE_CHARS) continue;
    const score = source.credibility?.score ?? 0;
    if (score < minScore || ownPageKind(source.url, product) || NO_READ_LABELS.has(hostLabel(source.url))) continue;
    if (namesOtherModel(source, product)) continue;
    seen.add(key);
    picks.push({ source, rank: aboutProduct(source, product) ? 0 : 1, score, index });
  }
  return picks
    .sort((a, b) => a.rank - b.rank || b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, max))
    .map((p) => p.source);
}

/**
 * One read per evidence page for a whole product check: the test page reads
 * and the gather reads share it, so a page both find is read once. Returns
 * readPage(source): a promise of a filled copy of `source`, or `source` when
 * the read gave no more text (readEvidencePage). `signal` (optional) stops
 * every read still running (the check calls it when the evidence is in).
 */
export function evidenceReader(env, { read = readPageInto, signal } = {}) {
  const reads = new Map();
  return (source) => {
    const key = evidenceKey(source?.url);
    if (!reads.has(key)) reads.set(key, { first: source, page: readEvidencePage(source, env, read, signal) });
    const { first, page } = reads.get(key);
    return page.then((filled) => {
      if (filled === first) return source;
      if (source === first) return filled;
      return { ...source, content: filled.content, credibility: filled.credibility ?? source.credibility };
    });
  };
}

/** Test page reads at the same time: all of them with a Jina key, else TEST_READ_CONCURRENCY. */
export function testReadConcurrency(env) {
  return env?.JINA_API_KEY ? KEYED_TEST_READ_CONCURRENCY : TEST_READ_CONCURRENCY;
}

/**
 * One evidence page read into a copy. A read that fails, gives a block page,
 * or gives no more text than the snippet keeps the snippet source (the same
 * object). `signal` (optional) stops the read at a stage deadline.
 */
export async function readEvidencePage(source, env, read = readPageInto, signal = undefined) {
  const copy = { ...source };
  try {
    await read(copy, env, { signal });
  } catch (err) {
    // One failed read never stops the run: the snippet stays.
    console.log(`[verify-resolve] page read failed for ${source.url}: ${err instanceof Error ? err.message : String(err)}`);
    return source;
  }
  const text = String(copy.content ?? '');
  return text.length > String(source.content ?? '').length && !isBlockPage(text) ? copy : source;
}

/**
 * Full reads of test pages, testReadConcurrency(env) at a time. Each read
 * fills a copy (readEvidencePage, or opts.readPage when given, see
 * evidenceReader). `opts.signal` (optional) is the stage deadline: no read
 * starts after it, and a page not read by then keeps its snippet.
 * `opts.graceMs`: how long to wait after the deadline for running reads
 * (see runPoolUntil). Returns { pages, filled } (filled: reads that gave
 * page text). Does not change the input.
 */
export async function readTestPages(picks, env, read = readPageInto, opts = {}) {
  const { signal, concurrency = testReadConcurrency(env), readPage, graceMs } = opts;
  const list = Array.isArray(picks) ? picks : [];
  const readOne = readPage ?? ((source) => readEvidencePage(source, env, read, signal));
  const pages = await runPoolUntil(
    list.map((source) => () => readOne(source)),
    concurrency,
    { signal, graceMs, onMissing: (i) => list[i], onError: (_err, i) => list[i] },
  );
  return { pages, filled: pages.filter((page, i) => page !== list[i]).length };
}

// ── Claim page text ──────────────────────────────────────────────────────────

const CLAIM_TEXT_CHAR_CAP = 20_000;
// A claim source below this many chars is snippet-only (search-result text,
// not the actual page) and needs a full-page read before extraction can find
// more than a couple of claims.
const THIN_CONTENT_CHARS = 800;
// Default read budget of selectSourcesToHydrate.
const MAX_CLAIM_READS = 3;

/**
 * Chars of each text in a shared budget: a short text keeps its full length,
 * the long texts split the rest evenly. Pure.
 */
export function fairShares(lengths, cap) {
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len || a.i - b.i);
  const shares = new Array(lengths.length).fill(0);
  let left = cap;
  order.forEach(({ len, i }, k) => {
    const share = Math.min(len, Math.floor(left / (order.length - k)));
    shares[i] = share;
    left -= share;
  });
  return shares;
}

/**
 * The extraction input: each source's clean text (no images, link targets, or
 * navigation-only lines) in a fair share of CLAIM_TEXT_CHAR_CAP. Before this,
 * the first source took the whole cap with raw markdown, so a second page
 * never reached the model.
 */
export function buildClaimTextBlock(claimSources) {
  const texts = claimSources.map((s) => cleanPageText(s.content));
  const shares = fairShares(texts.map((t) => t.length), CLAIM_TEXT_CHAR_CAP);
  return claimSources
    .map((s, i) => `### SOURCE ${i + 1} ${s.title || ''}\n${s.url}\n${texts[i].slice(0, shares[i])}`)
    .join('\n\n');
}

// Picks which claim sources need a full-page read: those whose `content` is
// still snippet-thin, capped at `max` (a read budget), preserving order.
// Immutable — returns a new array, never mutates `claimSources`.
export function selectSourcesToHydrate(claimSources, { thinChars = THIN_CONTENT_CHARS, max = MAX_CLAIM_READS } = {}) {
  const sources = Array.isArray(claimSources) ? claimSources : [];
  const thin = sources.filter((s) => (s?.content?.length ?? 0) < thinChars);
  return thin.slice(0, max);
}
