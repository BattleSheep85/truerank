// Product link parsing for the Verify box (refocus 2026-10, spec D8).
// A person types a product name, pastes a product page link, or pastes share
// text that holds a link. parseProductInput turns that into one frozen
// { kind, name, url, key } object. The key identifies the product for saved
// verdicts. Keys prefer a miss over a wrong match: they keep every number and
// never stem or drop words. Pure. Never throws.
import { isFetchableUrl } from './url-guard.js';

export const PRODUCT_INPUT_MAX_LEN = 2048;
export const PRODUCT_NAME_MAX_LEN = 200;
export const VERIFY_KEY_PREFIX = 'verify:';

const NAME_KEY_PREFIX = `${VERIFY_KEY_PREFIX}name:`;
const ASIN_KEY_PREFIX = `${VERIFY_KEY_PREFIX}asin:`;
const URL_KEY_PREFIX = `${VERIFY_KEY_PREFIX}url:`;
const NAME_KEY_MAX_TOKENS = 20;
const SLUG_NAME_MAX_WORDS = 10;
const SLUG_NAME_MIN_WORDS = 2;
const REMAINDER_MIN_ALNUM = 3;

const LINK_RE = /https?:\/\/\S+/i;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>"']+$/;
const AMAZON_HOST_RE = /(^|\.)amazon\.[a-z.]+$/;
const SHORT_LINK_HOSTS = new Set(['a.co', 'amzn.to', 'amzn.eu', 'amzn.asia']);
const ASIN_RE = /\/(?:dp|gp\/product|gp\/aw\/d)\/([a-z0-9]{10})(?=[/?#]|$)/i;
const NAME_TOKEN_RE = /[a-z0-9]+/g;
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

/** 'verify:name:' + sorted unique lowercase [a-z0-9]+ tokens joined by ' ' (at most 20). null when no token. */
export function productNameKey(name) {
  if (typeof name !== 'string') return null;
  const tokens = [...new Set(name.toLowerCase().match(NAME_TOKEN_RE) || [])].sort();
  if (tokens.length === 0) return null;
  return NAME_KEY_PREFIX + tokens.slice(0, NAME_KEY_MAX_TOKENS).join(' ');
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

function remainderName(raw, linkToken) {
  const rest = raw.replace(linkToken, ' ').replace(/\s+/g, ' ').trim();
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

// Rules 3 to 5. Returns { name, url, key } where key is null for a name key.
function linkParts(link) {
  const host = link.hostname;
  if (AMAZON_HOST_RE.test(host)) {
    const match = link.pathname.match(ASIN_RE);
    if (match) {
      const asin = match[1].toUpperCase();
      return { name: amazonName(link.pathname), url: `https://${link.host}/dp/${asin}`, key: ASIN_KEY_PREFIX + asin };
    }
  }
  // Short links, and Amazon pages with no ASIN: the path does not identify
  // the product, so only a name can make a key.
  if (SHORT_LINK_HOSTS.has(host) || AMAZON_HOST_RE.test(host)) {
    return { name: null, url: link.href, key: null };
  }
  const path = trimSlash(link.pathname);
  const keyHost = link.host.replace(/^www\./, '');
  return { name: longestSlugName(link.pathname), url: `https://${link.host}${path}`, key: URL_KEY_PREFIX + keyHost + path.toLowerCase() };
}

/**
 * Parse what a person typed or pasted into the Verify box. Pure. Never throws.
 * @param {string} raw product name, product page link, or share text that contains a link
 * @returns {Readonly<{ kind: 'url'|'name', name: string|null, url: string|null, key: string|null }>}
 *   key is the full stored key, prefix included (for example 'verify:asin:B0F3PT1VBL').
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
  const name = parts.name ? capName(parts.name) : remainderName(text, linkMatch[0]);
  const key = parts.key || (name ? productNameKey(name) : null);
  return result('url', name, parts.url, key);
}
