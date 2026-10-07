// Product link parsing for the Verify box (refocus 2026-10, spec D8).
// A person types a product name, pastes a product page link, or pastes share
// text that holds a link. parseProductInput turns that into one frozen
// { kind, name, url, key } object. The key identifies a saved verdict. The
// engine checks the page and searches by the name, so a link key holds both.
// Keys prefer a miss over a wrong match: they keep every word and number in
// any script, never stem, and are null rather than cut short. Pure. Never throws.
import { isFetchableUrl } from './url-guard.js';

export const PRODUCT_INPUT_MAX_LEN = 2048;
export const PRODUCT_NAME_MAX_LEN = 200;
export const VERIFY_KEY_PREFIX = 'verify:';

const NAME_KEY_PREFIX = `${VERIFY_KEY_PREFIX}name:`;
const ASIN_KEY_PREFIX = `${VERIFY_KEY_PREFIX}asin:`;
const URL_KEY_PREFIX = `${VERIFY_KEY_PREFIX}url:`;
// Joins a page key to the name words. A word never holds '|', so the last
// LINK_KEY_NAME_PART in a key always starts the name.
const LINK_KEY_NAME_PART = '|name:';
// A longer name gets no key: a cut key would join names that differ in a later word.
const NAME_KEY_MAX_TOKENS = 20;
const SLUG_NAME_MAX_WORDS = 10;
const SLUG_NAME_MIN_WORDS = 2;
const REMAINDER_MIN_ALNUM = 3;

const LINK_RE = /https?:\/\/\S+/i;
const ALL_LINKS_RE = /https?:\/\/\S+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>"']+$/;
// Real Amazon marketplace domains. A host counts as Amazon only when it is
// one of these, or one of these behind an AMAZON_SUBDOMAINS label. A pattern
// match would accept www.amazon.com.attacker.io.
const AMAZON_DOMAINS = Object.freeze(new Set([
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk',
  'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.se',
  'amazon.pl', 'amazon.com.be', 'amazon.com.tr', 'amazon.ae', 'amazon.sa',
  'amazon.eg', 'amazon.in', 'amazon.co.jp', 'amazon.sg', 'amazon.com.au', 'amazon.cn',
]));
const AMAZON_SUBDOMAINS = Object.freeze(new Set(['www', 'smile', 'm']));
// Query parameters that track the visit and never identify the product.
const TRACKING_PARAM_RE = /^(?:utm_.*|ref|fbclid|gclid)$/i;
const SHORT_LINK_HOSTS = new Set(['a.co', 'amzn.to', 'amzn.eu', 'amzn.asia']);
const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?=[/?#]|$)/i;
// One word: a run of letters, numbers, and their marks (Devanagari vowel
// signs, for example) in any script. A CJK run with no spaces is one word.
const NAME_TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu;
const ALNUM_RE = /[\p{L}\p{N}]/gu;
const LETTER_RE = /\p{L}/u;
const TWO_LETTERS_RE = /\p{L}{2}/u;
const HEX_WORD_RE = /^[0-9a-f]+$/i;
const DIGIT_RE = /\d/;
const FILE_EXT_RE = /\.[a-z0-9]{1,5}$/i;

const EMPTY_URL_RESULT = Object.freeze({ kind: 'url', name: null, url: null, key: null });

function result(kind, name, url, key) {
  return Object.freeze({ kind, name, url, key });
}

function capName(text) {
  const trimmed = String(text || '').trim().slice(0, PRODUCT_NAME_MAX_LEN).trim();
  return trimmed || null;
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** True when key is a name key ('verify:name:...'). A link key that holds a name part is not a name key. */
export function isNameKey(key) {
  return typeof key === 'string' && key.startsWith(NAME_KEY_PREFIX);
}

// The sorted unique lowercase words of name (NFKC first, so full-width
// letters fold) joined by ' '. null when there is no word or more than
// NAME_KEY_MAX_TOKENS.
function nameTokens(name) {
  if (typeof name !== 'string') return null;
  const words = name.normalize('NFKC').toLowerCase().match(NAME_TOKEN_RE) || [];
  const tokens = [...new Set(words)].sort();
  if (tokens.length === 0 || tokens.length > NAME_KEY_MAX_TOKENS) return null;
  return tokens.join(' ');
}

/** 'verify:name:' + the sorted unique lowercase words of name joined by ' '. null when no word or more than 20. */
export function productNameKey(name) {
  const tokens = nameTokens(name);
  return tokens ? NAME_KEY_PREFIX + tokens : null;
}

// The page key bound to the name words, or null when the name has no key.
function boundKey(pageKey, name) {
  const tokens = nameTokens(name);
  return tokens ? pageKey + LINK_KEY_NAME_PART + tokens : null;
}

// A slug that is only an ID: no word holds two letters in a row (A-12345),
// or every word is hex and one holds a digit (a UUID).
function isIdLike(words) {
  if (!words.some((w) => TWO_LETTERS_RE.test(w))) return true;
  return words.every((w) => HEX_WORD_RE.test(w)) && words.some((w) => DIGIT_RE.test(w));
}

// Turn one path segment into a name, or null. sep splits the words.
function slugToName(segment, sep) {
  const text = safeDecode(segment).replace(FILE_EXT_RE, '');
  const words = text.split(sep).filter(Boolean);
  if (words.length < SLUG_NAME_MIN_WORDS || !LETTER_RE.test(text)) return null;
  return words.slice(0, SLUG_NAME_MAX_WORDS).join(' ');
}

function pathSegments(pathname) {
  return pathname.split('/').filter(Boolean);
}

// Amazon: the segment right before /dp/ names the product.
function amazonName(pathname) {
  const segments = pathSegments(pathname);
  const dpIndex = segments.findIndex((s) => s.toLowerCase() === 'dp');
  if (dpIndex < 1) return null;
  return slugToName(segments[dpIndex - 1], '-');
}

// Other hosts: the longest segment that reads as words and is not an ID.
function longestSlugName(pathname) {
  const named = pathSegments(pathname)
    .map((segment) => ({ segment, name: slugToName(segment, /[-_]/) }))
    .filter(({ name }) => name && !isIdLike(name.split(' ')));
  if (named.length === 0) return null;
  const best = named.reduce((a, b) => (b.segment.length > a.segment.length ? b : a));
  return best.name;
}

function isAmazonHost(host) {
  if (AMAZON_DOMAINS.has(host)) return true;
  const dot = host.indexOf('.');
  return dot > 0 && AMAZON_SUBDOMAINS.has(host.slice(0, dot)) && AMAZON_DOMAINS.has(host.slice(dot + 1));
}

// '?' + the non-tracking params sorted by name, or '' when none are left.
function productQuery(searchParams) {
  const kept = [...searchParams]
    .filter(([name]) => !TRACKING_PARAM_RE.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return kept.length > 0 ? `?${new URLSearchParams(kept)}` : '';
}

// Every link comes out, not only the first, so a second pasted link (for
// example a metadata address) never becomes part of the name.
function remainderName(raw) {
  const rest = raw.replace(ALL_LINKS_RE, ' ').replace(/\s+/g, ' ').trim();
  const alnum = rest.match(ALNUM_RE) || [];
  return alnum.length >= REMAINDER_MIN_ALNUM ? capName(rest) : null;
}

// Strip trailing punctuation, parse, and force https. null when not public.
function parsePublicLink(token) {
  const cleaned = token.replace(TRAILING_PUNCT_RE, '');
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }
  const httpsHref = `https://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return isFetchableUrl(httpsHref) ? new URL(httpsHref) : null;
}

function trimSlash(pathname) {
  return pathname.replace(/\/+$/, '');
}

// Rules 3 to 5. Returns { name, url, pageKey, nameKeyOnly }. pageKey names
// the page and is null when the path does not identify the product.
// nameKeyOnly is true when only a name can make the key.
function linkParts(link) {
  const host = link.hostname;
  const amazon = isAmazonHost(host);
  if (amazon) {
    const match = link.pathname.match(ASIN_RE);
    if (match) {
      const asin = match[1].toUpperCase();
      // hostname drops a port, so every link for one ASIN fetches the same page.
      const url = `https://${host}/dp/${asin}`;
      return { name: amazonName(link.pathname), url, pageKey: ASIN_KEY_PREFIX + asin, nameKeyOnly: false };
    }
  }
  // Short links, and Amazon pages with no ASIN: the path does not identify
  // the product, so only a name can make a key.
  if (SHORT_LINK_HOSTS.has(host) || amazon) {
    return { name: null, url: link.href, pageKey: null, nameKeyOnly: true };
  }
  // A path with a name slug identifies the product, so the query goes. A path
  // with no name (item.htm?id=111) needs its query to tell products apart.
  const name = longestSlugName(link.pathname);
  const path = trimSlash(link.pathname);
  const query = name ? '' : productQuery(link.searchParams);
  const url = `https://${link.host}${path}${query}`;
  // A whole-site link (path '/') identifies no product: no key of any kind.
  if (!path) return { name, url, pageKey: null, nameKeyOnly: false };
  // The URL parser lowercases the host. The path keeps its case, because the
  // fetched URL keeps it too (bit.ly/3AbC and bit.ly/3abc are two pages).
  const keyHost = link.host.replace(/^www\./, '');
  return { name, url, pageKey: URL_KEY_PREFIX + keyHost + path + query, nameKeyOnly: false };
}

// The key for a link. With a name: the page key bound to the name, a name key
// when only the name identifies the product, else null. With no name: the
// page key alone (the Verify handler asks for a name and never stores it).
function linkKey(parts, name) {
  if (!name) return parts.pageKey;
  if (parts.pageKey) return boundKey(parts.pageKey, name);
  return parts.nameKeyOnly ? productNameKey(name) : null;
}

/**
 * Parse what a person typed or pasted into the Verify box. Pure. Never throws.
 * @param {string} raw product name, product page link, or share text that contains a link
 * @returns {Readonly<{ kind: 'url'|'name', name: string|null, url: string|null, key: string|null }>}
 *   key is the full stored key, prefix included (for example 'verify:asin:B0F3PT1VBL|name:1000xm6 sony wh').
 */
export function parseProductInput(raw) {
  const text = typeof raw === 'string' ? raw.slice(0, PRODUCT_INPUT_MAX_LEN) : '';
  const linkMatch = text.match(LINK_RE);
  if (!linkMatch) {
    const name = capName(text);
    return result('name', name, null, productNameKey(name));
  }
  const link = parsePublicLink(linkMatch[0]);
  if (!link) return EMPTY_URL_RESULT;
  const parts = linkParts(link);
  const name = parts.name ? capName(parts.name) : remainderName(text);
  return result('url', name, parts.url, linkKey(parts, name));
}
