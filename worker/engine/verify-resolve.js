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
import { isManufacturerDomain, isCommunityDomain, hasAiInjection, hasIncentivizedReview, hasSponsoredContent } from '../lib/credibility.js';
import { isFetchableUrl } from '../lib/url-guard.js';
import { MODEL_VARIANT_WORDS, distillProductName } from '../lib/product-link.js';
import { buyerStoreKeyOf } from '../lib/verdict.js';
import { afterAbort, anySignal, delay, runPoolUntil, POOL_GRACE_MS } from '../lib/deadline.js';
import { gatedFetchText } from '../lib/jina.js';

export { MODEL_VARIANT_WORDS, distillProductName };

const TOKEN_RE = /[a-z0-9]+/g;
const DIGIT_RE = /\d/;
const ALPHA_RE = /[a-z]/;

// A token with letters and digits and at least this many chars is a model
// code ("1000xm6", "aw3423dwf"). A page that names the code is about the product.
const MODEL_CODE_MIN_CHARS = 5;
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
// "2024", "mouse", "tire", "blender", "case"). The name match ignores them;
// brand, series words, model numbers, and MODEL_VARIANT_WORDS must still match.
const QUALIFIER_WORDS = new Set([
  'generation', 'gen', 'edition', 'model', 'version', 'series',
  'mouse', 'headphones', 'headphone', 'earbuds', 'earbud', 'speaker', 'speakers',
  'soundbar', 'phone', 'smartphone', 'watch', 'smartwatch', 'vacuum',
  'printer', 'monitor', 'laptop', 'tablet', 'ereader', 'camera', 'keyboard',
  'router', 'projector', 'microphone',
  'case', 'tower', 'chassis', 'cooler', 'psu', 'motherboard',
  'tire', 'tires', 'radial', 'season', 'touring', 'all',
  'blender', 'mixer', 'cooker', 'pressure', 'toaster', 'oven', 'microwave', 'dishwasher',
  'refrigerator', 'fridge', 'kettle', 'maker', 'fryer', 'espresso', 'grill', 'skillet', 'stand',
  'drill', 'driver', 'saw', 'sander', 'grinder', 'impact', 'wrench', 'tool', 'kit', 'cordless', 'brushless',
  'shoe', 'shoes', 'boot', 'boots', 'sneaker', 'sneakers', 'running', 'neutral', 'mens', 'womens', 'unisex',
  'wireless', 'wired', 'bluetooth', 'portable', 'electric', 'digital', 'automatic',
  'rechargeable', 'unlocked', 'compatible', 'dual', 'chamber', 'full', 'mid',
  'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red', 'green', 'pink', 'gold', 'tungsten',
]);
const ORDINAL_RE = /^(?:1st|2nd|3rd|[4-9]th|1\dth|20th)$/;
const YEAR_RE = /^(?:2019|202\d|2030)$/;
const SPEC_TOKEN_RE = /^\d+(?:x\d+)?(?:gb|tb|mb|kb|mm|cm|in|inch|inches|ft|yd|m|g|kg|mg|lb|lbs|oz|w|kw|v|kv|mv|ah|mah|wh|kwh|hz|khz|mhz|ghz|db|dba|rpm|psi|bar|cfm|fps|mp|dpi|cpi|nits|lm|lumens|k|c|f|l|ml|gal|qt|quart|quarts|pt|cup|cups|pc|pcs|pk|pack|ct|count|hr|hrs|hour|hours|min|mins|sec|s|yr|yrs|year|years|awg|ply|tpi)$/;
const TIRE_SIZE_TOKEN_RE = /^\d{2,3}[rz]\d{2}$/;
const UNIT_WORDS = new Set([
  'gb', 'tb', 'mb', 'kb', 'mm', 'cm', 'in', 'inch', 'inches', 'ft',
  'g', 'kg', 'lb', 'lbs', 'oz', 'w', 'kw', 'v', 'ah', 'mah', 'wh',
  'hz', 'khz', 'mhz', 'ghz', 'db', 'rpm', 'psi', 'cfm', 'mp', 'dpi',
  'nits', 'lm', 'lumens', 'l', 'ml', 'gal', 'qt', 'quart', 'quarts',
  'pt', 'cup', 'cups', 'pc', 'pcs', 'pk', 'pack', 'ct', 'count',
  'hr', 'hrs', 'hour', 'hours', 'min', 'mins', 'sec', 'yr', 'yrs', 'year', 'years',
]);
const E_READER_RE = /\be-reader\b/gi;
const MULTI_IN_ONE_TEXT_RE = /\b\d+\s*[- ]?\s*in\s*[- ]?\s*1\b/gi;

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

function isSpecNumberAt(words, index) {
  const token = words[index] ?? '';
  if (!DIGIT_RE.test(token)) return false;
  if (ORDINAL_RE.test(token) || YEAR_RE.test(token) || SPEC_TOKEN_RE.test(token) || TIRE_SIZE_TOKEN_RE.test(token)) {
    return true;
  }
  if (/^\d+$/.test(token)) {
    const next = words[index + 1] ?? '';
    if (UNIT_WORDS.has(next) || TIRE_SIZE_TOKEN_RE.test(next)) return true;
    if (next === 'in' && words[index + 2] === '1') return true;
    if (token === '1' && words[index - 1] === 'in' && /^\d+$/.test(words[index - 2] ?? '')) return true;
  }
  return false;
}

function isQualifierAt(words, index) {
  const token = words[index] ?? '';
  if (QUALIFIER_WORDS.has(token) || isSpecNumberAt(words, index)) return true;
  if (UNIT_WORDS.has(token) && /^\d+$/.test(words[index - 1] ?? '')) return true;
  return false;
}

// Product name tokens without the generic qualifier words, or all tokens
// when only qualifier words are left.
function nameTokens(product) {
  const normalized = String(product ?? '').replace(E_READER_RE, 'ereader').replace(MULTI_IN_ONE_TEXT_RE, ' ');
  const all = tokens(normalized);
  const kept = all.filter((_, i) => !isQualifierAt(all, i));
  return kept.length > 0 ? kept : all;
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
  return token.length >= MODEL_CODE_MIN_CHARS
    && DIGIT_RE.test(token)
    && ALPHA_RE.test(token)
    && !SPEC_TOKEN_RE.test(token)
    && !TIRE_SIZE_TOKEN_RE.test(token)
    && !ORDINAL_RE.test(token);
}

function longest(list) {
  return list.reduce((a, b) => (b.length > a.length ? b : a));
}

// The longest model code with its short letter prefix, when the code starts
// with a digit ("wh" + "1000xm6" -> "wh1000xm6").
function modelCodeKey(words, code) {
  const prev = words[words.indexOf(code) - 1] ?? '';
  const isPrefix = DIGIT_RE.test(code[0] ?? '')
    && prev.length > 0
    && prev.length <= MODEL_PREFIX_MAX_CHARS
    && !DIGIT_RE.test(prev)
    && !MODEL_VARIANT_WORDS.has(prev);
  return isPrefix ? `${prev}${code}` : code;
}

// Name without a model number: the series words after the brand, plus any
// trailing model-variant words ("Instant Pot Duo Plus" -> ["pot", "duo", "plus"]).
function seriesWordsOf(words) {
  if (words.length <= 1) return words;
  let end = Math.min(words.length, 3);
  while (end < words.length && MODEL_VARIANT_WORDS.has(words[end])) end += 1;
  return words.slice(1, end);
}

function seriesKey(words) {
  return seriesWordsOf(words).join('');
}

// CP-718: lighting words name the same product with other fans or LEDs
// ("Antec C8 ARGB" is the Antec C8), so they never make another model.
const LIGHTING_VARIANT_WORDS = Object.freeze(new Set(['rgb', 'argb']));

function postVariantAt(words, index) {
  const post = [];
  for (let i = index; i < words.length && MODEL_VARIANT_WORDS.has(words[i]); i += 1) {
    if (!LIGHTING_VARIANT_WORDS.has(words[i])) post.push(words[i]);
  }
  return post.join('');
}

// Structured model line for a name with a model number:
// { series, preVariant, number, postVariant } ("AirPods Pro 2" -> airpods + pro + 2,
// "Antec C8 Wood" -> antec + c8 + wood, "Galaxy S25 Ultra" -> galaxy + s25 + ultra).
function modelLine(words) {
  const first = words.findIndex((w, i) => DIGIT_RE.test(w) && !isSpecNumberAt(words, i));
  if (first < 0) return null;
  const hasPreVariant = first >= 2 && MODEL_VARIANT_WORDS.has(words[first - 1]);
  const series = hasPreVariant ? words[first - 2] : (first > 0 ? words[first - 1] : '');
  const preVariant = hasPreVariant ? words[first - 1] : '';
  const number = words[first];
  const postVariant = postVariantAt(words, first + 1);
  return { series, preVariant, number, postVariant };
}

/**
 * Squashed name runs a page must contain to be about this product. A model
 * code (with its short letter prefix) is enough: "wh1000xm6", "aw3423dwf".
 * Otherwise the series word (plus any pre-number variant) plus the model
 * number plus allowlisted variant words ("liberty4nc", "flip7", "k2combo",
 * "antecc8wood", "airpodspro2"). Generic qualifier words and slug descriptors
 * ("12th generation", "2024", "mouse", "dual", "chamber") are not part of a key.
 */
export function productKeys(product) {
  const words = nameTokens(product);
  if (words.length === 0) return [];
  const codes = words.filter(isModelCode);
  if (codes.length > 0) return [modelCodeKey(words, longest(codes))];

  const line = modelLine(words);
  if (!line) return [seriesKey(words)];
  const run = `${line.number}${line.postVariant}`;
  const withSeries = `${line.series}${line.preVariant}${run}`;
  return run.length >= MIN_BARE_RUN_CHARS && run !== withSeries ? [withSeries, run] : [withSeries];
}

// Words of the url path and the title.
function pathAndTitleWords(source) {
  const parsed = parseUrl(source?.url);
  const path = parsed ? decodeURIComponentSafe(parsed.pathname) : '';
  return { path, words: tokens(`${path} ${source?.title ?? ''}`) };
}

const REGEXP_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;
const VARIANT_TAIL_RE_SOURCE = [...MODEL_VARIANT_WORDS].filter((w) => !LIGHTING_VARIANT_WORDS.has(w)).join('|');
const LIGHTING_RE_SOURCE = [...LIGHTING_VARIANT_WORDS].join('|');
// Lighting words may sit between the model number and a variant word.
const VARIANT_GUARD = `(?![^a-z0-9]*(?:(?:${LIGHTING_RE_SOURCE})[^a-z0-9]+)*(?:${VARIANT_TAIL_RE_SOURCE})(?![a-z0-9]))`;

function keyPattern(key, blockVariantTail) {
  const chars = key.split('').map((c) => c.replace(REGEXP_SPECIAL_RE, '\\$&')).join('[^a-z0-9]*');
  const endBoundary = DIGIT_RE.test(key.at(-1) ?? '') ? '(?![0-9])' : '(?![a-z0-9])';
  const variantGuard = blockVariantTail ? VARIANT_GUARD : '';
  return `(?<![a-z0-9])${chars}${endBoundary}${variantGuard}`;
}

// Words that start another product line between a brand and a number
// ("Galaxy Tab S9" is not the "Galaxy S9"), so they are never a series word.
const LINE_WORDS = Object.freeze(new Set([
  'tab', 'tablet', 'watch', 'buds', 'pad', 'book', 'laptop', 'studio', 'note', 'fold', 'flip', 'fit', 'band', 'tv',
  'phone', 'case', 'vs', 'versus', 'and', 'or', 'like', 'the', 'with', 'than', 'lasted', 'gets', 'has',
]));
const LINE_WORDS_RE_SOURCE = [...LINE_WORDS, ...MODEL_VARIANT_WORDS].join('|');

// CP-718: a two-word "Brand Model" name also matches "Brand Series Model"
// ("Antec Constellation C8 Case Review" names the Antec C8). One letters-only
// series word may sit between; a line word or variant word may not.
function interposedPattern(ours) {
  if (ours.length !== 2 || ours.some(isModelCode)) return null;
  const line = modelLine(ours);
  if (!line || line.preVariant || line.postVariant || line.series !== ours[0]) return null;
  const esc = (w) => w.replace(REGEXP_SPECIAL_RE, '\\$&');
  const endBoundary = DIGIT_RE.test(line.number.at(-1) ?? '') ? '(?![0-9])' : '(?![a-z0-9])';
  return `(?<![a-z0-9])${esc(line.series)}[^a-z0-9]+(?!(?:${LINE_WORDS_RE_SOURCE})(?![a-z0-9]))[a-z]{3,}[^a-z0-9]+${esc(line.number)}${endBoundary}${VARIANT_GUARD}`;
}

// `allowSeriesWord`: also accept interposedPattern (titles and paths only;
// in body text "the Pixel lasted 8 hours" would match "Pixel 8").
function hasKeyMatch(text, product, allowSeriesWord = false) {
  const keys = productKeys(product);
  if (keys.length === 0) return false;
  const ours = nameTokens(product);
  const blockVariantTail = ours.filter(isModelCode).length === 0;
  const body = String(text ?? '');
  if (keys.some((key) => new RegExp(keyPattern(key, blockVariantTail), 'i').test(body))) return true;
  const interposed = allowSeriesWord ? interposedPattern(ours) : null;
  return interposed ? new RegExp(interposed, 'i').test(body) : false;
}

/** True when the url path or the title names this product (see productKeys and interposedPattern). */
export function namesProduct(source, product) {
  const { path } = pathAndTitleWords(source);
  return hasKeyMatch(`${path} ${source?.title ?? ''}`, product, true);
}

/**
 * True when the url path or the title names another model of the same line
 * and not this one: WF-1000XM6 or WH-1000XM5 for WH-1000XM6, Flip 6 for
 * Flip 7, Antec C8 Wood for Antec C8, Galaxy S25 Ultra for Galaxy S25,
 * AirPods Pro 2 for AirPods 2. Such a page tests another product.
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
  const line = modelLine(ours);
  if (!line) {
    const series = seriesWordsOf(ours);
    const last = series.at(-1) ?? '';
    if (!last) return false;
    const prev = series.length >= 2 && MODEL_VARIANT_WORDS.has(last) ? series.at(-2) : '';
    return words.some((w, i) => {
      if (w === last && postVariantAt(words, i + 1) !== '') return true;
      if (prev && w === prev && words[i + 1] !== last) return true;
      return false;
    });
  }
  return words.some((w, i) => {
    if (w === line.series) {
      const hasPre = MODEL_VARIANT_WORDS.has(words[i + 1] ?? '') && DIGIT_RE.test(words[i + 2] ?? '') && !isSpecNumberAt(words, i + 2);
      const numIdx = hasPre ? i + 2 : i + 1;
      const candNum = words[numIdx] ?? '';
      if (DIGIT_RE.test(candNum) && !isSpecNumberAt(words, numIdx)) {
        const candPre = hasPre ? words[i + 1] : '';
        const candPost = postVariantAt(words, numIdx + 1);
        return candPre !== line.preVariant || candNum !== line.number || candPost !== line.postVariant;
      }
      if (MODEL_VARIANT_WORDS.has(candNum) && (candNum !== line.preVariant || line.number !== '')) {
        return true;
      }
    }
    if (ALPHA_RE.test(line.number) && w === line.number) {
      const candPost = postVariantAt(words, i + 1);
      if (candPost !== line.postVariant) return true;
    }
    return false;
  });
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
  return namesProduct(source, product) && !namesOtherModel(source, product) ? kind : 'other-product';
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

/**
 * Start offsets of product name mentions in text: each productKeys key with
 * any separators between its chars ("wh1000xm6" finds "WH-1000XM6"). Sorted.
 */
export function productMentions(text, product) {
  const body = String(text ?? '');
  const ours = nameTokens(product);
  const blockVariantTail = ours.filter(isModelCode).length === 0;
  const starts = productKeys(product).flatMap((key) =>
    [...body.matchAll(new RegExp(keyPattern(key, blockVariantTail), 'gi'))].map((m) => m.index),
  );
  return [...new Set(starts)].sort((a, b) => a - b);
}

/**
 * True when a source is about this product: its url, title, or text names it
 * (see productKeys). A gathered page about another product (an unrelated
 * article that matched a search word) is not evidence for this one.
 */
export function aboutProduct(source, product) {
  if (namesProduct(source, product)) return true;
  return hasKeyMatch(source?.content, product);
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
  const queryName = distillProductName(product) || String(product ?? '').trim();
  const queries = RESOLVE_QUERY_SUFFIXES.map((suffix) => `${queryName}${suffix}`);
  const results = await Promise.all(queries.map((q) => search(q, 'web', env, false)));
  const found = results.flatMap((list) => (Array.isArray(list) ? list : []));
  return { candidates: rankClaimCandidates(found, product), queries, found };
}

// The fallback read: Jina (with the key when one is set) with a longer wait, and without navigation,
// headers, footers, images, recommendation carousels, and Buy Box chrome. The shared reader
// (worker/lib/jina.js) stops after 8 s (keyless Jina often needs longer on a product page).
const FOCUSED_READ_TIMEOUT_MS = 25_000;
export const FOCUSED_READ_MAX_CHARS = 200_000;
export const RETAILER_SPEC_MAX_CHARS = 25_000;
export const MAX_BUYER_REVIEWS = 200;
export const MAX_REVIEW_SNIPPET_CHARS = 400;
const FOCUSED_READ_HEADERS = Object.freeze({
  Accept: 'text/markdown',
  'X-Return-Format': 'markdown',
  'X-Retain-Images': 'none',
  'X-Remove-Selector': [
    'header',
    'nav',
    'footer',
    'aside',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '.a-carousel-container',
    '[id*="sims-consolidated"]',
    '[id*="sp_detail"]',
    '#desktop-dp-sims_session-similarities-sims-feature',
    '#HLCXComparisonWidget_feature_div',
    '#buybox',
    '#rightCol',
    '#apex_desktop',
    '#TellAmazon_feature_div',
  ].join(', '),
  'X-Timeout': '20',
});

/**
 * Page text from the fallback read, or '' on any failure. Never throws.
 * With a Jina key the read uses it (paid tier: faster, no free rate cap).
 * When the page is a structured retailer listing with carousels or customer
 * reviews, strips middle recommendation carousels and Buy Box chrome so spec
 * sections (`<= 25,000` chars) and bottom-of-page buyer reviews both survive.
 * `opts.signal` (optional) stops the read at a caller deadline. `opts.gate`
 * (optional): the check's connection gate; the read and its timer start
 * when it holds a slot (worker/lib/connection-gate.js).
 */
export async function readFocusedPage(url, fetchImpl = fetch, apiKey = '', opts = {}) {
  if (!isFetchableUrl(url) || opts.signal?.aborted) return '';
  const headers = apiKey ? { ...FOCUSED_READ_HEADERS, Authorization: `Bearer ${apiKey}` } : FOCUSED_READ_HEADERS;
  try {
    const response = await gatedFetchText(fetchImpl, `https://r.jina.ai/${url}`, {
      headers,
      timeoutMs: FOCUSED_READ_TIMEOUT_MS,
      signal: opts.signal,
      gate: opts.gate,
    });
    if (!response.ok) {
      console.log(`[verify-resolve] focused read HTTP ${response.status} for ${url}`);
      return '';
    }
    const raw = response.text.slice(0, FOCUSED_READ_MAX_CHARS);
    if (isBlockPage(raw)) {
      console.log(`[verify-resolve] focused read returned block/captcha page for ${url} (${raw.length} chars)`);
      return raw;
    }
    return compactRetailerMarkdown(raw, { url });
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
    .then(() => focusedRead(candidate.url, undefined, env?.JINA_API_KEY || '', { signal: stop, gate: env?.connectionGate }))
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
// CP-718: hosts that answer every page read with a block page (Reddit's
// network policy). Their search snippets stay as evidence; a read would only
// use up a slot.
export const BLOCKED_READ_LABELS = new Set(['reddit', 'redd']);
// CP-718: page reads per site. TechPowerUp splits one review into ten pages,
// and all ten took the test page reads, so GamersNexus and KitGuru were never read.
export const MAX_READS_PER_SITE = 2;

function skipsRead(url) {
  const label = hostLabel(url);
  return NO_READ_LABELS.has(label) || BLOCKED_READ_LABELS.has(label);
}

// Keeps the first MAX_READS_PER_SITE picks of each site, in order. A blog
// on a shared host (alice.substack.com) is its own site (buyerStoreKeyOf).
function capPerSite(picks) {
  const perSite = new Map();
  return picks.filter((p) => {
    const site = buyerStoreKeyOf(p.source.url) || hostLabel(p.source.url);
    const used = perSite.get(site) || 0;
    perSite.set(site, used + 1);
    return used < MAX_READS_PER_SITE;
  });
}
// A url or title with one of these words is a test or review page.
const TEST_PAGE_RE = /\breviews?\b|\btested\b|\btests?\b|\bhands[- ]on\b|\bmeasure/i;

/**
 * The search for independent tests of one claim: the product name, the
 * claim's topic words, and CLAIM_SEARCH_WORDS. Bare numbers stay out: a
 * test result seldom repeats the claimed value.
 */
export function claimSearchQuery(product, terms) {
  const queryName = distillProductName(product) || String(product ?? '').trim();
  const topic = (Array.isArray(terms) ? terms : [])
    .filter((t) => !NUMBER_ONLY_RE.test(t))
    .slice(0, CLAIM_QUERY_TOPIC_WORDS);
  return [queryName, ...topic, CLAIM_SEARCH_WORDS].join(' ');
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
 * maker's or a retailer's, not video, social, or read-blocked pages
 * (BLOCKED_READ_LABELS), one per page, at most MAX_READS_PER_SITE per site.
 * Test and review pages come first, then the input order. Does not change the input.
 */
export function testPagesToRead(sources, product, max = MAX_TEST_PAGE_READS) {
  const seen = new Set();
  const picks = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const key = evidenceKey(source?.url);
    if (!source?.url || seen.has(key) || String(source.content ?? '').length >= THIN_EVIDENCE_CHARS) continue;
    if (ownPageKind(source.url, product) || skipsRead(source.url)) continue;
    if (!namesProduct(source, product) || namesOtherModel(source, product)) continue;
    seen.add(key);
    const { path } = pathAndTitleWords(source);
    picks.push({ source, rank: TEST_PAGE_RE.test(`${path} ${source.title ?? ''}`) ? 0 : 1, index });
  }
  return capPerSite(picks.sort((a, b) => a.rank - b.rank || a.index - b.index)).slice(0, max).map((p) => p.source);
}

// Gather page reads per product check, and the credibility score a page
// needs for a read (the gather's own limits, worker/engine/parallel-engine.js).
export const MAX_GATHER_READS = 50;
const GATHER_READ_MIN_SCORE = 45;

/**
 * The gather's page reads for a product check, best first, at most `max`:
 * snippet-only pages that can be independent evidence (not the maker's or a
 * retailer's site, not video, social, or read-blocked pages, not titled for
 * another model of the line), one per page and at most MAX_READS_PER_SITE
 * per site, with a credibility score of at least
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
    if (score < minScore || ownPageKind(source.url, product) || skipsRead(source.url)) continue;
    if (namesOtherModel(source, product)) continue;
    seen.add(key);
    picks.push({ source, rank: aboutProduct(source, product) ? 0 : 1, score, index });
  }
  return capPerSite(picks.sort((a, b) => a.rank - b.rank || b.score - a.score || a.index - b.index))
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
  if (isBlockPage(text)) {
    console.log(`[verify-resolve] evidence read returned block/captcha page for ${source.url} (${text.length} chars)`);
    return source;
  }
  return text.length > String(source.content ?? '').length ? copy : source;
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
 * The extraction input: each source's clean spec & feature text (no images,
 * link targets, recommendation carousels, Buy Box chrome, or customer review
 * sections) in a fair share of CLAIM_TEXT_CHAR_CAP. Before this, the first
 * source took the whole cap with raw markdown, so a second page never reached
 * the model.
 */
export function buildClaimTextBlock(claimSources) {
  const texts = claimSources.map((s) => cleanPageText(extractRetailerSpecText(s.content)));
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

// ── Full-page retailer section parser & 200-buyer-review harvester ──────────

// Recommendation carousel & non-product bloat section headings on retailer pages.
const CAROUSEL_SECTION_RE = /^(?:#{1,6}\s*)?(?:similar items(?:\s+that may ship faster)?|frequently bought together|products?\s+related to this item|related products?|customers?\s+who\s+(?:viewed|bought)\s+this\s+item\s+also\s+(?:viewed|bought)|compare with similar items|what other items do customers buy|brands in this category|looking for specific info\??|videos(?:\s+for this product)?|sponsored\s+products?|people ultimately bought|you may also like|customers also viewed|more to consider|explore related products|important information)\b/i;

// Customer review section headings (excluded from specText; parsed by extractBuyerReviews).
const REVIEW_SECTION_RE = /^(?:#{1,6}\s*)?(?:customer reviews?|ratings?\s*(?:&|and)\s*reviews?|customers?\s+say|top reviews(?:\s+from\s+the\s+united\s+states|\s+from\s+other\s+countries)?|most\s+recent\s+customer\s+reviews?|verified\s+buyer\s+reviews?|owner\s+reviews?)\b/i;

// Spec & feature section headings we want to KEEP for claim extraction.
const SPEC_SECTION_RE = /^(?:#{1,6}\s*)?(?:about this item|product description|from the (?:manufacturer|brand)|product information|technical details|additional information|features?\s*(?:&|and)\s*specs?|specifications?|tech(?:nical)?\s+specs?|key\s+specs?|product\s+(?:details|specifications?|overview|highlights?)|overview|highlights?|what'?s in the box|in the box)\b/i;

// Buy Box, shipping, seller, return-window, protection-plan, and rating/BSR chrome lines.
const BUYBOX_LINE_RE = /^(?:\s*[-*|]*\s*)(?:deliver(?:y|ed)?\s+to\b|free\s+(?:delivery|shipping|returns?)\b|or\s+fastest\s+delivery\b|ships?\s+from\b|sold\s+by\b|fulfilled\s+by\b|returns?\b.*\b(?:refund|replacement|window|policy|eligible|free)\b|eligible\s+for\s+return,\s*refund\s+or\s+replacement\b|\d+[- ]day\s+(?:refund\/replacement|returns?|return\s+window)\b|add\s+a\s+protection\s+plan\b|(?:\d+[- ]year\s+)?[\w\s]*protection\s+plan\b|asurion\b|applecare\+?\b|squaretrade\b|geek\s+squad\s+protection\b|add\s+to\s+(?:cart|list|registry|wish\s*list)\b|buy\s+now\b|in\s+stock\b|only\s+\d+\s+left\s+in\s+stock\b|secure\s+transaction\b|gift\s+options\b|add\s+a\s+gift\s+receipt\b|best\s+sellers?\s+rank\b|customer\s+reviews?\s*[|:]?\s*\d(?:\.\d)?\s+out\s+of\s+5\s+stars\b|\d(?:\.\d)?\s+out\s+of\s+5\s+stars\s+\d[\d,]*\s+ratings?\b|page\s+\d+\s+of\s+\d+\b|start\s+over\s+page\b)/i;

// Marker detector: true only when raw text has retailer carousels, Buy Box
// chrome, or customer review sections (so plain test strings pass unchanged).
function hasRetailerStructure(raw) {
  const text = String(raw ?? '');
  if (!text) return false;
  return /(?:^|\n)\s*(?:#{1,6}\s*)?(?:about this item|product information|technical details|similar items(?:\s+that may ship faster)?|frequently bought together|products?\s+related to this item|customers?\s+who\s+(?:viewed|bought)\s+this\s+item|compare with similar items|customer reviews?|customers?\s+say|top reviews\s+from|verified purchase|\[buyer review\])/im.test(text)
    || /(?:^|\n)\s*(?:ships?\s+from|sold\s+by|add\s+a\s+protection\s+plan|eligible\s+for\s+return,\s*refund\s+or\s+replacement)\b/im.test(text);
}

// Strips syndicated attribution footers before hashing so Bazaarvoice reviews
// syndicated across Best Buy, Walmart, and Target produce the exact same hash.
const SYNDICATED_ATTRIBUTION_RE = /(?:\[?\s*(?:originally\s+posted\s+on|syndicated\s+(?:review\s+)?from|review\s+from|posted\s+on)\s+[a-z0-9.\s_-]+\]?)\s*$/i;
const BUYER_REVIEW_PREFIX_RE = /^\s*\[buyer review\]\s*/i;

/**
 * Deterministic normalized text hash for a buyer/owner review snippet.
 * Strips syndicated attribution footers ("Originally posted on sony.com") and
 * non-alphanumeric characters so identical reviews syndicated across Best Buy,
 * Walmart, and Target hash to the same key and count only once.
 */
export function reviewTextHash(text) {
  const cleaned = String(text ?? '')
    .replace(BUYER_REVIEW_PREFIX_RE, '')
    .replace(SYNDICATED_ATTRIBUTION_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (!cleaned) return '';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < cleaned.length; i += 1) {
    const code = cleaned.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

// Amazon Rufus / "Customers say" AI-generated review summary patterns.
// Red-Team #4: never extract Amazon's AI summary paragraph as buyer evidence.
const AI_REVIEW_SUMMARY_PATTERNS = [
  /^\s*(?:#{1,6}\s*)?customers\s+(?:say|find|praise|appreciate|like|love|report|mention|note|complain|have\s+mixed\s+opinions|are\s+satisfied|are\s+dissatisfied|highlight|value|enjoy|point\s+out|think|feel)\b/i,
  /\bai[- ]generated\s+from\s+the\s+text\s+of\s+customer\s+reviews\b/i,
  /\bselect\s+to\s+learn\s+more\b/i,
];

/**
 * Returns true if `text` is an AI-generated "Customers say" review summary
 * paragraph or aspect chip list rather than a verbatim customer review.
 */
export function isAiReviewSummary(text) {
  const s = String(text ?? '').trim();
  if (!s) return false;
  return AI_REVIEW_SUMMARY_PATTERNS.some((re) => re.test(s));
}

// Additional incentivized-review markers found in retailer review metadata.
const EXTRA_INCENTIVIZED_RE = /(?:vine\s+customer\s+review(?:\s+of\s+(?:a\s+)?free\s+product)?|\b(?:collected\s+as\s+part\s+of\s+a\s+promotion|incentivized\s+review|free\s+product\s+in\s+exchange\s+for\s+(?:an?\s+)?(?:honest\s+)?review))\b/i;

/**
 * Returns true if a review block or snippet carries an incentivized/Vine
 * disclosure ("Vine Customer Review of Free Product", "received free/discounted
 * product in exchange for a review", "[This review was collected as part of a promotion]").
 */
export function isIncentivizedSnippet(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return hasIncentivizedReview(s) || EXTRA_INCENTIVIZED_RE.test(s);
}

// Trailing review UI chrome ("Read more", "4 people found this helpful", "Helpful", "Report").
const REVIEW_CHROME_TAIL_RE = /(?:\b(?:one|\d[\d,]*)\s+(?:person|people)\s+found\s+this\s+helpful\b|\b(?:read\s+more|helpful|report|share|comment|translate\s+review\s+to\s+english)\b|\[\s*this\s+review\s+was\s+collected\s+as\s+part\s+of\s+a\s+promotion\.?\s*\])[\s.|,-]*$/gi;

/**
 * Sanitizes a single buyer/owner review snippet (Red-Team #5):
 * - Strips markdown images, markdown link URLs (keeping anchor text), bare URLs,
 *   `javascript:...` targets, HTML tags, and markdown formatting tokens.
 * - Strips trailing review UI chrome ("Read more", "Helpful", "Report", etc.).
 * - Collapses whitespace and caps at `maxChars` (default 400 chars).
 */
export function sanitizeReviewSnippet(text, maxChars = MAX_REVIEW_SNIPPET_CHARS) {
  let s = String(text ?? '')
    .replace(BUYER_REVIEW_PREFIX_RE, '')
    .replace(MD_IMAGE_RE, ' ')
    .replace(/\[\s*read\s+more\s*\]\([^)]*\)/gi, ' ')
    .replace(/\[\s*(?:helpful|report|verified\s+purchase)\s*\]\([^)]*\)/gi, ' ')
    .replace(MD_LINK_RE, '$1')
    .replace(BARE_URL_RE, ' ')
    .replace(/javascript:[^\s)]+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_~`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip leading/trailing quotes and review UI chrome repeatedly until stable.
  let prev;
  do {
    prev = s;
    s = s
      .replace(REVIEW_CHROME_TAIL_RE, '')
      .replace(/^(?:["'“”‘’.\s-]+)|(?:["'“”‘’\s]+)$/g, '')
      .trim();
  } while (s !== prev);

  return s.slice(0, maxChars).trim();
}

/**
 * Extracts the spec & feature text (`<= 25,000` chars) from a retailer product
 * page: keeps title, overview/`About this item`, `Product Description`,
 * `Product information`, `Technical Details`, and `Features & Specs`, while
 * stripping middle recommendation carousels ("Similar items", "Related products",
 * "Frequently bought together"), Buy Box seller/return/protection-plan chrome,
 * and bottom customer review sections.
 *
 * Plain non-retailer text (e.g. manufacturer spec pages or unit-test fixtures
 * without retailer carousel/buybox/review sections) is returned unchanged up
 * to `maxChars`.
 */
export function extractRetailerSpecText(content, maxChars = RETAILER_SPEC_MAX_CHARS) {
  const raw = String(content ?? '');
  if (!raw) return '';
  if (!hasRetailerStructure(raw)) return raw.slice(0, maxChars);

  const lines = raw.split('\n');
  const introLines = [];
  const specLines = [];
  let mode = 'intro'; // 'intro' | 'spec' | 'skip'
  let introChars = 0;
  const MAX_INTRO_CHARS = 4000;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Pre-compacted buyer review line -> stop/skip.
    if (BUYER_REVIEW_PREFIX_RE.test(trimmed)) {
      mode = 'skip';
      continue;
    }

    // Check section transitions before adding line.
    if (REVIEW_SECTION_RE.test(trimmed)) {
      mode = 'skip';
      continue;
    }
    if (CAROUSEL_SECTION_RE.test(trimmed)) {
      mode = 'skip';
      continue;
    }
    if (SPEC_SECTION_RE.test(trimmed)) {
      mode = 'spec';
      specLines.push(rawLine);
      continue;
    }

    // Any other top-level `# ` or `## ` heading while in 'spec' mode:
    // keep `###` subheadings (like `### Technical Details` under `# Product information`),
    // but if a new `# ` or `## ` heading isn't in SPEC_SECTION_RE, check if it's noise.
    if (/^#{1,2}\s+\S/.test(trimmed) && mode === 'spec' && !SPEC_SECTION_RE.test(trimmed)) {
      if (CAROUSEL_SECTION_RE.test(trimmed) || REVIEW_SECTION_RE.test(trimmed)) {
        mode = 'skip';
        continue;
      }
    }

    // Drop Buy Box, seller, return window, Asurion/protection plan, and star-rating chrome.
    if (BUYBOX_LINE_RE.test(trimmed)) continue;

    if (mode === 'intro') {
      if (introChars + rawLine.length <= MAX_INTRO_CHARS) {
        introLines.push(rawLine);
        introChars += rawLine.length + 1;
      }
    } else if (mode === 'spec') {
      specLines.push(rawLine);
    }
  }

  const combined = [...introLines, ...specLines].join('\n').trim();
  if (!combined) {
    // Fallback if page only had intro lines or unstructured content
    return lines
      .filter((l) => {
        const t = l.trim();
        return t && !BUYBOX_LINE_RE.test(t) && !CAROUSEL_SECTION_RE.test(t) && !REVIEW_SECTION_RE.test(t) && !BUYER_REVIEW_PREFIX_RE.test(t);
      })
      .join('\n')
      .slice(0, maxChars);
  }
  return combined.slice(0, maxChars);
}

// Matches verbatim buyer quotes in Amazon's aspect widgets:
// "...quote text..." [Read more](https://www.amazon.com/gp/customer-reviews/...)
const LINKED_VERBATIM_QUOTE_RE = /[""\u201c]([^""\u201d\n]{20,600})[""\u201d]\s*\[Read more\]\(https?:\/\/[^)\s]*(?:customer-reviews|reviews)[^)\s]*\)/gi;

// Matches inline Jina `Top reviews` list items:
// ##### _5.0 out of 5 stars_ ... Reviewed in ... on <Date> ... (Verified Purchase | Vine Customer Review...) <Body>
const INLINE_STAR_REVIEW_SPLIT_RE = /(?=(?:\*\s*(?:\[\]\([^)]*\))?\s*)?#{3,6}\s+_?\d(?:\.\d)?\s+out\s+of\s+5\s+stars_?)/gi;

// Metadata header inside a star-review block up to Verified Purchase / Vine disclosure / Reviewed date.
const REVIEWED_IN_DATE_RE = /Reviewed\s+in\s+[^\n]+?\s+on\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}/i;
const VERIFIED_BADGE_RE = /(?:\[\s*Verified\s+(?:Purchase|Buyer|Owner)\s*\]\([^)]*\)|(?<!un)Verified\s+(?:Purchase|Buyer|Owner)\b)/i;
const VINE_BADGE_RE = /Vine\s+Customer\s+Review(?:\s+of\s+(?:a\s+)?Free\s+Product)?\b/i;

function evaluateCandidateSnippet(rawText, {
  verified = false,
  kind = 'buyer-review',
  headerContext = '',
  includeIncentivized = false,
  maxSnippetChars = MAX_REVIEW_SNIPPET_CHARS,
  seenHashes,
  reviews,
  droppedIncentivized,
  droppedAiSummary,
  droppedInjection,
  maxReviews,
}) {
  if (reviews.length >= maxReviews) return;
  const fullCheck = `${headerContext}\n${rawText}`;

  if (isAiReviewSummary(rawText) || isAiReviewSummary(headerContext)) {
    droppedAiSummary.push(rawText.trim());
    return;
  }

  if (hasAiInjection(fullCheck)) {
    droppedInjection.push({ text: sanitizeReviewSnippet(rawText, maxSnippetChars), tags: ['ai-injection'] });
    return;
  }

  // A paid-promotion review (#ad, "sponsored by") is dropped on its own, so it
  // cannot tag the whole host's aggregated buyer-review source (CP-782).
  if (hasSponsoredContent(fullCheck)) {
    const text = sanitizeReviewSnippet(rawText, maxSnippetChars);
    droppedIncentivized.push({ text, hash: reviewTextHash(text), verified: false, kind, tags: ['incentivized-review', 'sponsored-content'] });
    return;
  }

  const incentivized = isIncentivizedSnippet(fullCheck);
  const cleaned = sanitizeReviewSnippet(rawText, maxSnippetChars);
  if (cleaned.length < 20) return;

  if (isAiReviewSummary(cleaned)) {
    droppedAiSummary.push(cleaned);
    return;
  }

  if (hasAiInjection(cleaned)) {
    droppedInjection.push({ text: cleaned, tags: ['ai-injection'] });
    return;
  }

  if (incentivized || isIncentivizedSnippet(cleaned)) {
    const item = { text: cleaned, hash: reviewTextHash(cleaned), verified: false, kind, tags: ['incentivized-review'] };
    droppedIncentivized.push(item);
    if (includeIncentivized) {
      if (item.hash && !seenHashes.has(item.hash)) {
        seenHashes.add(item.hash);
        reviews.push(item);
      }
    }
    return;
  }

  const hash = reviewTextHash(cleaned);
  if (!hash || seenHashes.has(hash)) return;
  seenHashes.add(hash);
  reviews.push({ text: cleaned, hash, verified, kind });
}

/**
 * Extracts verbatim buyer/owner review snippets from a retailer product page
 * or Reddit/forum thread (up to `opts.maxReviews`, default 200):
 * - Extracts verbatim `Verified Purchase` / star-rated customer review bodies.
 * - Extracts verbatim quoted buyer snippets linked to `/customer-reviews/`.
 * - Extracts owner comments from Reddit/forum threads or `# Customer reviews` blocks.
 * - NEVER extracts Amazon's `"Customers say"` AI-generated summary paragraphs.
 * - Filters out `Vine Customer Review of Free Product` and `"received free/discounted ... in exchange for a review"` (`incentivized-review`).
 * - Drops any snippet matching `hasAiInjection` (Red-Team #5), strips links & markdown, and caps each snippet at 400 chars.
 * - Deduplicates by `reviewTextHash` (supports passing `opts.seenHashes` across pages).
 */
export function extractBuyerReviews(content, opts = {}) {
  return parseBuyerReviewsInternal(content, opts).reviews;
}

function parseBuyerReviewsInternal(content, opts = {}) {
  const raw = String(content ?? '');
  const maxReviews = Number.isInteger(opts.maxReviews) && opts.maxReviews > 0 ? opts.maxReviews : MAX_BUYER_REVIEWS;
  const maxSnippetChars = Number.isInteger(opts.maxSnippetChars) && opts.maxSnippetChars > 0
    ? opts.maxSnippetChars
    : MAX_REVIEW_SNIPPET_CHARS;
  const includeIncentivized = opts.includeIncentivized === true;
  const seenHashes = opts.seenHashes instanceof Set ? opts.seenHashes : new Set();
  const reviews = [];
  const droppedIncentivized = [];
  const droppedAiSummary = [];
  const droppedInjection = [];

  if (!raw) {
    return { reviews, droppedIncentivized, droppedAiSummary, droppedInjection };
  }

  const ctx = {
    includeIncentivized,
    maxSnippetChars,
    seenHashes,
    reviews,
    droppedIncentivized,
    droppedAiSummary,
    droppedInjection,
    maxReviews,
  };

  // 0. Pre-compacted `[Buyer review] ...` lines (from readFocusedPage or test fixtures).
  for (const line of raw.split('\n')) {
    if (BUYER_REVIEW_PREFIX_RE.test(line)) {
      evaluateCandidateSnippet(line.replace(BUYER_REVIEW_PREFIX_RE, ''), {
        ...ctx,
        verified: true,
        kind: 'buyer-review',
      });
    }
  }

  // 1. Record any "Customers say" AI summary paragraphs so droppedAiSummary is populated,
  //    and extract linked verbatim buyer quotes ("..." [Read more](.../customer-reviews/...)).
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (isAiReviewSummary(trimmed)) {
      droppedAiSummary.push(trimmed);
    }
  }
  for (const match of raw.matchAll(LINKED_VERBATIM_QUOTE_RE)) {
    evaluateCandidateSnippet(match[1], {
      ...ctx,
      verified: true,
      kind: 'buyer-review',
    });
  }

  // 2. Star-rated / "Reviewed in ... on <Date>" / "Verified Purchase" customer review blocks.
  const starBlocks = raw.split(INLINE_STAR_REVIEW_SPLIT_RE);
  if (starBlocks.length > 1) {
    for (const block of starBlocks.slice(1)) {
      let body = block;
      let headerContext = '';
      const verifiedMatch = VERIFIED_BADGE_RE.exec(block);
      const vineMatch = VINE_BADGE_RE.exec(block);
      const dateMatch = REVIEWED_IN_DATE_RE.exec(block);

      if (verifiedMatch) {
        const cut = verifiedMatch.index + verifiedMatch[0].length;
        headerContext = block.slice(0, cut);
        body = block.slice(cut);
      } else if (vineMatch) {
        const cut = vineMatch.index + vineMatch[0].length;
        headerContext = block.slice(0, cut);
        body = block.slice(cut);
      } else if (dateMatch) {
        const cut = dateMatch.index + dateMatch[0].length;
        headerContext = block.slice(0, cut);
        body = block.slice(cut);
      }

      // Stop before the next major section heading if any trailed into the last block.
      const nextHeading = body.search(/\n#{1,3}\s+\S/);
      if (nextHeading >= 0) body = body.slice(0, nextHeading);
      // Cut at "[Read more](javascript:void(0))" or "Helpful Report" footer.
      const footerIdx = body.search(/\[Read more\]\(javascript:void\(0\)\)|\b(?:\d+\s+people|One\s+person)\s+found\s+this\s+helpful\b|\bHelpful\s+Report\b/i);
      if (footerIdx >= 0) body = body.slice(0, footerIdx);

      evaluateCandidateSnippet(body, {
        ...ctx,
        verified: Boolean(verifiedMatch),
        kind: 'buyer-review',
        headerContext,
      });
    }
  }

  // 3. Multi-line or bulleted review entries inside `# Customer reviews` / `## Ratings & Reviews`
  //    sections (e.g. Best Buy, Walmart, Target, B&H, or clean markdown review sections)
  //    when inline star-rating headers did not already structure the section.
  const lines = raw.split('\n');
  if (starBlocks.length <= 1) {
    let inReviewSection = false;
    let pendingHeader = '';
    for (let i = 0; i < lines.length && reviews.length < maxReviews; i += 1) {
      const trimmed = lines[i].trim();
      if (!trimmed || BUYER_REVIEW_PREFIX_RE.test(trimmed)) continue;

      if (REVIEW_SECTION_RE.test(trimmed)) {
        inReviewSection = true;
        pendingHeader = '';
        continue;
      }
      if (inReviewSection && /^#{1,2}\s+\S/.test(trimmed) && !REVIEW_SECTION_RE.test(trimmed)) {
        if (CAROUSEL_SECTION_RE.test(trimmed) || SPEC_SECTION_RE.test(trimmed)) {
          inReviewSection = false;
          continue;
        }
      }

      // Standalone "Verified Purchase" / "Vine Customer Review..." badge line preceding a review paragraph.
      if (/^(?:[^\n]{0,80}?\b)?(?:Verified\s+(?:Purchase|Buyer|Owner)|Vine\s+Customer\s+Review(?:\s+of\s+(?:a\s+)?Free\s+Product)?)\s*$/i.test(trimmed)) {
        pendingHeader = `${pendingHeader} ${trimmed}`.trim();
        continue;
      }
      if (REVIEWED_IN_DATE_RE.test(trimmed) && trimmed.length < 120) {
        pendingHeader = `${pendingHeader} ${trimmed}`.trim();
        continue;
      }

      if (inReviewSection) {
        // Skip rating histogram lines ("5 star 78%", "4.6 out of 5", "3,907 global ratings"),
        // aspect chip lists, and short UI prompts.
        if (/^(?:\d\s*stars?\b|\d(?:\.\d)?\s+out\s+of\s+5\b|\d[\d,]*\s+(?:global\s+)?(?:ratings?|reviews?)\b|review\s+this\s+product\b|share\s+your\s+thoughts\b|write\s+a\s+customer\s+review\b|sort\s+by\b|filter\s+by\b|customer\s+images\b)/i.test(trimmed)) {
          continue;
        }
        // Skip lines that already matched LINKED_VERBATIM_QUOTE_RE or INLINE_STAR_REVIEW_SPLIT_RE.
        if (/\[Read more\]\(https?:\/\/[^)\s]*(?:customer-reviews|reviews)/i.test(trimmed)) continue;
        if (/^#{3,6}\s+_?\d(?:\.\d)?\s+out\s+of\s+5\s+stars_?/i.test(trimmed)) continue;

        if (trimmed.length >= 25) {
          evaluateCandidateSnippet(trimmed, {
            ...ctx,
            verified: VERIFIED_BADGE_RE.test(pendingHeader) || VERIFIED_BADGE_RE.test(trimmed),
            kind: 'buyer-review',
            headerContext: pendingHeader,
          });
          pendingHeader = '';
        }
      }
    }
  }

  // 4. Community / Reddit / forum owner comments when URL is a community domain
  //    or the text contains Reddit/forum comment blocks (`u/...`, `Posted by`, `> ...`).
  const isCommunity = Boolean(opts.url && isCommunityDomain(opts.url))
    || /(?:^|\n)\s*(?:u\/[a-z0-9_-]+|r\/[a-z0-9_-]+|#{1,4}\s*comments\b)/im.test(raw);
  if (isCommunity && reviews.length < maxReviews) {
    const ownerRe = /\b(?:i\s+(?:bought|own|have|had|used|tested|got|picked\s+up|switched|upgraded|wore|tried)|my\s+(?:unit|pair|headphones|earbuds|battery|experience|wife|husband)|after\s+\d+\s+(?:days?|weeks?|months?|years?)|been\s+using|mine\s+(?:lasts?|lasted|works?|broke|died|holds?))\b/i;
    for (const line of lines) {
      if (reviews.length >= maxReviews) break;
      const trimmed = line.replace(/^\s*(?:>+|\*|-|\d+\.)\s*/, '').trim();
      if (trimmed.length < 25 || trimmed.startsWith('#')) continue;
      if (!ownerRe.test(trimmed)) continue;
      evaluateCandidateSnippet(trimmed, {
        ...ctx,
        verified: false,
        kind: 'owner-comment',
      });
    }
  }

  return { reviews, droppedIncentivized, droppedAiSummary, droppedInjection };
}

/**
 * Full-page retailer parser: returns `{ specText, reviews, isBlock,
 * droppedIncentivized, droppedAiSummary, droppedInjection }` from a raw
 * retailer markdown page (up to 200,000 chars).
 */
export function parseRetailerPage(content, opts = {}) {
  const raw = String(content ?? '').slice(0, FOCUSED_READ_MAX_CHARS);
  const isBlock = isBlockPage(raw);
  if (isBlock) {
    return {
      specText: '',
      reviews: [],
      isBlock: true,
      droppedIncentivized: [],
      droppedAiSummary: [],
      droppedInjection: [],
    };
  }
  const specText = extractRetailerSpecText(raw, opts.maxSpecChars ?? RETAILER_SPEC_MAX_CHARS);
  const parsedReviews = parseBuyerReviewsInternal(raw, opts);
  return {
    specText,
    reviews: parsedReviews.reviews,
    isBlock: false,
    droppedIncentivized: parsedReviews.droppedIncentivized,
    droppedAiSummary: parsedReviews.droppedAiSummary,
    droppedInjection: parsedReviews.droppedInjection,
  };
}

// Compacts a raw retailer markdown page for readFocusedPage: keeps specText
// (<= 25,000 chars) + a compact `# Customer reviews` section of sanitized
// `[Buyer review]` lines so downstream claim extraction gets specText while
// evidencePool / harvestBuyerReviews still has the page's buyer reviews.
function compactRetailerMarkdown(raw, opts = {}) {
  const text = String(raw ?? '');
  if (!hasRetailerStructure(text)) return text;
  const { specText, reviews } = parseRetailerPage(text, opts);
  if (reviews.length === 0) return specText;
  const reviewBlock = reviews.map((r) => `[Buyer review] ${r.text}`).join('\n');
  return `${specText}\n\n# Customer reviews\n${reviewBlock}`;
}

// True when page text holds `[Buyer review]` lines (readFocusedPage output).
function hasBuyerReviewLines(text) {
  return String(text ?? '').split('\n').some((line) => BUYER_REVIEW_PREFIX_RE.test(line));
}

/**
 * Buyer reviews of the retailer claim pages. readClaimPage keeps the shared
 * read when it is usable and stops the focused read, but only the focused
 * read keeps a retailer page's customer reviews, so a check of an Amazon
 * listing had no buyer-review evidence (CP-778). This reads each retailer
 * claim page without `[Buyer review]` lines again with `focusedRead`, all at
 * once, and returns copies with the focused text for the pages whose read has
 * buyer reviews (harvestBuyerReviews takes them from there). Never throws;
 * a failed or stopped read adds nothing. Does not change the input.
 */
export async function readBuyerReviewPages(claimSources, product, opts = {}) {
  const { focusedRead = readFocusedPage, apiKey = '', signal, gate } = opts;
  const list = Array.isArray(claimSources) ? claimSources : [];
  const picks = list.filter((source) => source?.url
    && ownPageKind(source.url, product) === 'retailer'
    && !hasBuyerReviewLines(source.content));
  if (picks.length === 0 || signal?.aborted) return [];
  const pages = await Promise.all(picks.map((source) => Promise.resolve()
    .then(() => focusedRead(source.url, undefined, apiKey, { signal, gate }))
    .then((text) => ({ ...source, content: String(text ?? '') }))
    .catch(() => null)));
  const usable = pages.filter((page) => page && hasBuyerReviewLines(page.content));
  console.log(`[verify-resolve] buyer review reads: ${picks.length} retailer pages, ${usable.length} with reviews`);
  return usable;
}

function normalizedHostOf(url) {
  const parsed = parseUrl(url);
  return parsed ? parsed.hostname.replace(/^www\./, '').toLowerCase() : '';
}

/**
 * Harvests up to `maxReviews` (default 200) short buyer/owner reviews across
 * all candidate pages about `product`, deduplicating across pages/retailers by
 * `reviewTextHash` so syndicated Bazaarvoice reviews copied across Best Buy,
 * Walmart, and Target count only once (Red-Team #4), and grouping all buyer
 * reviews from each retailer host into ONE aggregated evidence source per
 * host (`source: 'buyer-review'`, Red-Team #1).
 */
export function harvestBuyerReviews(sources, product, opts = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const maxReviews = Number.isInteger(opts.maxReviews) && opts.maxReviews > 0 ? opts.maxReviews : MAX_BUYER_REVIEWS;
  const seenHashes = new Set();
  const byHost = new Map();
  let totalHarvested = 0;

  for (const source of list) {
    if (totalHarvested >= maxReviews) break;
    if (!source?.url) continue;
    // If source is already a pre-built buyer-review source, keep its reviews under its host.
    const kind = ownPageKind(source.url, product);
    const isPrebuiltBuyerReview = source.source === 'buyer-review';
    if (!isPrebuiltBuyerReview && kind !== 'retailer') continue;
    if (product && (!aboutProduct(source, product) || namesOtherModel(source, product))) continue;

    const host = normalizedHostOf(source.url);
    if (!host) continue;

    const remaining = maxReviews - totalHarvested;
    const extracted = extractBuyerReviews(source.content, {
      url: source.url,
      maxReviews: remaining,
      seenHashes,
    });
    if (extracted.length === 0) continue;

    totalHarvested += extracted.length;
    if (!byHost.has(host)) {
      const baseUrl = String(source.url).replace(/#.*$/, '');
      byHost.set(host, {
        url: `${baseUrl}#buyer-reviews`,
        title: `${source.title || product || host} — Customer Reviews (${host})`,
        reviews: [],
      });
    }
    byHost.get(host).reviews.push(...extracted);
  }

  return [...byHost.values()].map((entry) => ({
    url: entry.url,
    title: entry.title,
    content: entry.reviews.map((r) => `[Buyer review] ${r.text}`).join('\n'),
    source: 'buyer-review',
    reviewCount: entry.reviews.length,
    reviewHashes: entry.reviews.map((r) => r.hash),
  }));
}

