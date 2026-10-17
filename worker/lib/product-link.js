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
export const SLUG_DISTILL_MIN_WORDS = 6;
const REMAINDER_MIN_ALNUM = 3;

// Explicit allowlist of real model-variant tokens (Red-Team #3).
export const MODEL_VARIANT_WORDS = Object.freeze(new Set([
  'ultra', 'pro', 'plus', 'max', 'mini', 'lite', 'se', 'fe', 'ti', 'xt', 'xtx',
  'super', 'oled', 'anc', 'nc', 'combo', 'duo', 'xl', 'xs', 'air', 'slim',
  'wood', 'flux', 'curve', 'mesh', 'rgb', 'argb',
]));

const SPEC_UNIT_TOKEN_RE = /^\d+(?:x\d+)?(?:gb|tb|mb|kb|mm|cm|in|inch|inches|ft|yd|m|g|kg|mg|lb|lbs|oz|w|kw|v|kv|mv|ah|mah|wh|kwh|hz|khz|mhz|ghz|db|dba|rpm|psi|bar|cfm|fps|mp|dpi|cpi|nits|lm|lumens|k|c|f|l|ml|gal|qt|quart|quarts|pt|cup|cups|pc|pcs|pk|pack|ct|count|hr|hrs|hour|hours|min|mins|sec|s|yr|yrs|year|years|awg|ply|tpi)$/i;
const TIRE_SIZE_RE = /^\d{2,3}[rz]\d{2}$/i;
const ORDINAL_TOKEN_RE = /^(?:1st|2nd|3rd|[4-9]th|1\dth|20th)$/i;
const YEAR_TOKEN_RE = /^(?:2019|202\d|2030)$/;
const MULTI_IN_ONE_RE = /^\d+[-_]?in[-_]?1$/i;
const UNIT_FOLLOW_WORDS = new Set([
  'gb', 'tb', 'mb', 'kb', 'mm', 'cm', 'in', 'inch', 'inches', 'ft',
  'g', 'kg', 'lb', 'lbs', 'oz', 'w', 'kw', 'v', 'ah', 'mah', 'wh',
  'hz', 'khz', 'mhz', 'ghz', 'db', 'rpm', 'psi', 'cfm', 'mp', 'dpi',
  'nits', 'lm', 'lumens', 'l', 'ml', 'gal', 'qt', 'quart', 'quarts',
  'pt', 'cup', 'cups', 'pc', 'pcs', 'pk', 'pack', 'ct', 'count',
  'hr', 'hrs', 'hour', 'hours', 'min', 'mins', 'sec', 'yr', 'yrs', 'year', 'years',
]);

// Common retail SEO slug descriptor words that start the keyword tail after Brand + Series (+ Variant).
const SLUG_DESCRIPTOR_WORDS = new Set([
  'chamber', 'compatible', 'full', 'mid', 'tower', 'atx', 'eatx', 'matx', 'itx',
  'pc', 'computer', 'gaming', 'case', 'chassis', 'tempered', 'glass', 'front', 'panel',
  'all', 'season', 'radial', 'tire', 'tires', 'touring', 'passenger', 'suvs', 'truck',
  'wireless', 'bluetooth', 'noise', 'cancelling', 'canceling', 'active', 'over', 'ear',
  'headphones', 'headphone', 'earbuds', 'earbud', 'headset', 'speaker', 'speakers',
  'unlocked', 'cell', 'phone', 'smartphone', 'android', 'mobile',
  'electric', 'pressure', 'cooker', 'slow', 'multi', 'multicooker', 'steamer', 'warmer',
  'professional', 'grade', 'blender', 'mixer', 'stand', 'tilt', 'head', 'kitchen', 'appliance',
  'cordless', 'brushless', 'drill', 'driver', 'impact', 'hammer', 'tool', 'kit',
  'mens', 'womens', 'unisex', 'neutral', 'running', 'walking', 'trail', 'shoe', 'shoes', 'sneakers', 'footwear',
  'waterproof', 'portable', 'rechargeable', 'stainless', 'steel', 'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red',
  'with', 'for', 'and',
]);

// Product-type words a buyer adds after the name ("Fractal Design North
// case", "Ninja Creami ice cream maker"). They change the searches, so the
// two names read different pages and check different claims (CP-777).
// Longest first. Names where the type word is part of the product line
// (Laptop, TV, Headphones, Earbuds, Watch, Speaker) are left out on purpose.
const PRODUCT_TYPE_TAILS = Object.freeze([
  'ice cream maker', 'espresso machine', 'coffee maker', 'vacuum cleaner',
  'robot vacuum', 'stick vacuum', 'impact driver', 'drill driver', 'hammer drill',
  'cordless drill', 'power supply', 'computer case', 'pc case', 'cell phone', 'air fryer',
  'case', 'chassis', 'phone', 'smartphone', 'tire', 'tires', 'vacuum', 'drill',
].map((phrase) => phrase.split(' ')));
// "case" after one of these is an accessory, not a PC case ("iPhone 16 case").
const CASE_WORDS = Object.freeze(['case', 'chassis']);
const DEVICE_WORDS = Object.freeze([
  'iphone', 'ipad', 'airpods', 'galaxy', 'pixel', 'switch', 'kindle', 'macbook',
  'airtag', 'gopro', 'steam', 'playstation', 'ps5', 'xbox', 'watch', 'phone', 'tablet', 'laptop',
]);
// "phone" leaves only after a model number ("Pixel 9 Pro phone"), so a line
// name such as "Asus ROG Phone" keeps it.
const PHONE_WORDS = Object.freeze(['phone', 'smartphone']);
// trimProductType never leaves fewer words than this.
const TYPE_TRIM_MIN_WORDS = 2;
// A trailing number with a one-letter suffix is usually the model, not a spec
// ("MX Master 3S", "iPhone 5c", "Pixel 4a 5G"). Volts and watts are the
// exceptions ("DCD791 20V", "Nano 65W").
const ONE_LETTER_SUFFIX_RE = /^\d+[a-uxyz]$/;

// "Dual" and "compact" name a variant ("Torrent Compact") unless the next word
// is the thing they describe ("Dual Chamber", "Compact Drill", "Dual Tower"):
// a PAIRED_VARIANT_NOUNS word, or any descriptor word but a color or a filler
// word (CP-781).
const PAIRED_VARIANT_WORDS = new Set(['dual', 'compact']);
const PAIRED_VARIANT_NOUNS = new Set([
  'band', 'zone', 'motor', 'fuel', 'sim', 'port', 'usb', 'fan', 'fans', 'size',
  'monitor', 'screen', 'display', 'charger', 'mini', 'micro', 'basket', 'burner',
]);
const NOT_DESCRIBED_WORDS = new Set([
  'black', 'white', 'silver', 'gray', 'grey', 'blue', 'red', 'tempered', 'with', 'for', 'and',
]);
// A number, a hyphen, and a unit ("65-Inch", "2-Pack") reads as one spec. A
// range ("18-55mm") stays a model token (CP-783).
const HYPHEN_SPEC_RE = /^\d+[-_][a-z]+$/;
const SPEC_JOIN_RE = /[-_]/g;

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

function isSlugSpecToken(lower, i) {
  const raw = lower[i] ?? '';
  const w = HYPHEN_SPEC_RE.test(raw) ? raw.replace(SPEC_JOIN_RE, '') : raw;
  if (!DIGIT_RE.test(w)) return false;
  if (ORDINAL_TOKEN_RE.test(w) || YEAR_TOKEN_RE.test(w) || SPEC_UNIT_TOKEN_RE.test(w) || TIRE_SIZE_RE.test(w) || MULTI_IN_ONE_RE.test(w)) {
    return true;
  }
  if (/^\d+$/.test(w)) {
    const next = lower[i + 1] ?? '';
    if (UNIT_FOLLOW_WORDS.has(next) || TIRE_SIZE_RE.test(next)) return true;
    if (next === 'in' && lower[i + 2] === '1') return true;
    if (w === '1' && lower[i - 1] === 'in' && /^\d+$/.test(lower[i - 2] ?? '')) return true;
  }
  return false;
}

function isPairedVariantAt(lower, i) {
  if (!PAIRED_VARIANT_WORDS.has(lower[i])) return false;
  const next = lower[i + 1] ?? '';
  if (PAIRED_VARIANT_NOUNS.has(next)) return false;
  return !SLUG_DESCRIPTOR_WORDS.has(next) || NOT_DESCRIBED_WORDS.has(next);
}

function isVariantAt(lower, i) {
  return MODEL_VARIANT_WORDS.has(lower[i]) || isPairedVariantAt(lower, i);
}

// A paired word ("dual") that describes the next word is a descriptor too.
function isDescriptorAt(lower, i) {
  if (PAIRED_VARIANT_WORDS.has(lower[i])) return !isPairedVariantAt(lower, i);
  return SLUG_DESCRIPTOR_WORDS.has(lower[i]);
}

// Distills 6+ word retail SEO slugs into Brand + Series + Model + Variant.
function distillSlugWords(words) {
  const capped = words.slice(0, SLUG_NAME_MAX_WORDS);
  if (words.length < SLUG_DISTILL_MIN_WORDS) return capped;
  const lower = words.map(lowerWord);

  // 1. Model number token in positions 1..4 (Brand + Series + Model [+ Variant]).
  for (let i = 1; i <= Math.min(4, words.length - 1); i += 1) {
    if (DIGIT_RE.test(lower[i]) && !isSlugSpecToken(lower, i)) {
      let end = i + 1;
      while (end < words.length && isVariantAt(lower, end)) end += 1;
      return words.slice(0, end);
    }
  }

  // 2. Model code token later in the slug (e.g. DEWALT 20V MAX Cordless Drill Kit DCD771C2).
  for (let i = 5; i < words.length; i += 1) {
    const w = lower[i];
    if (w.length >= 5 && DIGIT_RE.test(w) && /[a-z]/.test(w) && !isSlugSpecToken(lower, i)) {
      let prefixEnd = 1;
      while (prefixEnd < Math.min(4, i) && !isDescriptorAt(lower, prefixEnd)) {
        prefixEnd += 1;
      }
      return [...words.slice(0, prefixEnd), words[i]];
    }
  }

  // 3. No model number: stop before the first spec or SEO descriptor word (at index >= 2).
  for (let i = 2; i < words.length; i += 1) {
    if (isSlugSpecToken(lower, i) || isDescriptorAt(lower, i)) {
      return words.slice(0, Math.min(i, 4));
    }
  }

  return capped;
}

function lowerWord(word) {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

// Length of the longest PRODUCT_TYPE_TAILS phrase that ends `lower`, or 0.
function typeTailLength(lower) {
  const tail = PRODUCT_TYPE_TAILS.find((phrase) => phrase.length <= lower.length
    && phrase.every((w, i) => lower[lower.length - phrase.length + i] === w));
  if (!tail || !isGenericTail(tail, lower.slice(0, -tail.length))) return 0;
  return tail.length;
}

// False when the tail word is part of what the product is: an accessory
// case, or "Phone" in a line name.
function isGenericTail(tail, rest) {
  const word = tail.at(-1);
  if (CASE_WORDS.includes(word) && tail.length === 1) {
    return !rest.some((w) => DEVICE_WORDS.includes(w));
  }
  if (PHONE_WORDS.includes(word)) return rest.some((w) => DIGIT_RE.test(w));
  return true;
}

// True when the last word is a spec (128GB, 20V), not a model suffix (3S).
function isTrailingSpec(lower) {
  const last = lower.length - 1;
  return isSlugSpecToken(lower, last) && !ONE_LETTER_SUFFIX_RE.test(lower[last]);
}

/**
 * The product name without trailing product-type words and trailing spec
 * words ("DeWalt DCD791 20V drill" -> "DeWalt DCD791", "Antec C8 PC case"
 * -> "Antec C8"), so "X" and "X case" search the same way (CP-777). Never
 * leaves fewer than TYPE_TRIM_MIN_WORDS words: "OtterBox case" stays.
 */
export function trimProductType(product) {
  const words = String(product ?? '').trim().split(/\s+/).filter(Boolean);
  let lower = words.map(lowerWord);
  for (;;) {
    const cut = typeTailLength(lower) || (isTrailingSpec(lower) ? 1 : 0);
    if (cut === 0 || lower.length - cut < TYPE_TRIM_MIN_WORDS) break;
    lower = lower.slice(0, -cut);
  }
  return words.slice(0, lower.length).join(' ');
}

/**
 * Distills a 6+ word SEO product name or slug into concise Brand + Series +
 * Model + Variant words for search queries. Shorter names only lose trailing
 * product-type and spec words (trimProductType).
 */
export function distillProductName(product) {
  const raw = String(product ?? '').trim();
  if (!raw) return '';
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < SLUG_DISTILL_MIN_WORDS) return trimProductType(raw);
  return distillSlugWords(words).join(' ');
}

// Turn one path segment into a name, or null. sep splits the words.
function slugToName(segment, sep) {
  const text = safeDecode(segment).replace(FILE_EXT_RE, '');
  const words = text.split(sep).filter(Boolean);
  if (words.length < SLUG_NAME_MIN_WORDS || !LETTER_RE.test(text)) return null;
  return distillSlugWords(words).join(' ');
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
