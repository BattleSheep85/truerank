// Saved claim sets for /verify (CP-718).
//
// The claims of a product come from whichever maker and store pages a run
// happens to find, so two runs of one product checked different claims and
// their scores swung (Dyson V15 Detect: 13 vs 80). The first run's claims are
// saved in KV under the product's name key, and later runs of the same
// product check the same claims against fresh evidence.

import { productNameKey, parseProductInput } from './product-link.js';

/** Bump when the extraction rules change, so older claim sets are not reused. */
export const CLAIM_CACHE_VERSION = 'v1';
/** Same as the saved-verdict reuse window (VERIFY_REUSE_MAX_AGE_DAYS). */
export const CLAIM_CACHE_TTL_SECONDS = 30 * 86400;
/**
 * A set whose check ended with no score (not enough independent evidence) is
 * kept only this long, so the next run after that extracts again (CP-819).
 */
export const CLAIM_CACHE_WEAK_TTL_SECONDS = 86400;
const KEY_PREFIX = `verify-claims:${CLAIM_CACHE_VERSION}:`;
const CLAIM_TYPES = Object.freeze(['spec', 'marketing', 'warranty', 'support']);
const MAX_CLAIM_CHARS = 400;
const MAX_CACHED_CLAIMS = 12;

// The query that identifies the product, as product-link keeps it: '' for a
// named slug or an Amazon page, "?id=42" for a generic path
// (product_info.php?products_id=42) (CP-812).
function identifyingQuery(productUrl) {
  const kept = parseProductInput(String(productUrl)).url;
  return kept ? new URL(kept).search : '';
}

// The pasted page as host + path (+ identifying query), lowercase, or '' when
// there is none or it does not parse.
function pageKeyOf(productUrl) {
  if (!productUrl) return '';
  try {
    const url = new URL(String(productUrl));
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${identifyingQuery(productUrl)}`.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The KV key of a product's claim set, or null when the name has no key.
 * With a pasted page (`productUrl`) the key also names the page, so claims
 * from a page someone pasted are never reused for the plain name (the
 * handler's reuseKey rule), and each pasted page keeps its own claims.
 */
export function claimCacheKey(product, productUrl = null) {
  const nameKey = productNameKey(String(product ?? '').trim());
  if (!nameKey) return null;
  const page = pageKeyOf(productUrl);
  if (productUrl && !page) return null;
  return KEY_PREFIX + nameKey + (page ? `|page:${page}` : '');
}

function validClaim(c) {
  return Boolean(c) && typeof c.text === 'string' && c.text.trim().length > 0
    && c.text.length <= MAX_CLAIM_CHARS && CLAIM_TYPES.includes(c.type);
}

// Only { text, type } pairs leave or enter the cache, renumbered c1..cN.
function normalizeClaims(list, keep) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(validClaim)
    .filter((c) => keep(c))
    .slice(0, MAX_CACHED_CLAIMS)
    .map((c, i) => ({ id: `c${i + 1}`, text: c.text.trim(), type: c.type }));
}

/**
 * The saved claims of `product` (and its pasted page `productUrl`, see
 * claimCacheKey) that `keep` (for example isTestableClaim) still accepts, or [] when there is no KV, no key, no saved set, or the
 * saved value is not valid. A KV error is logged and gives []. Never throws.
 */
export async function readCachedClaims(kv, product, keep = () => true, productUrl = null) {
  const key = claimCacheKey(product, productUrl);
  if (!kv || !key) return [];
  try {
    const raw = await kv.get(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizeClaims(parsed?.claims, keep);
  } catch (err) {
    console.error(`[claim-cache] read failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Saves the claims of `product` (and `productUrl`) for CLAIM_CACHE_TTL_SECONDS. Returns true
 * when saved. A KV error is logged and gives false. Never throws.
 */
export async function writeCachedClaims(kv, product, claims, productUrl = null) {
  const key = claimCacheKey(product, productUrl);
  const list = normalizeClaims(claims, () => true).map(({ text, type }) => ({ text, type }));
  if (!kv || !key || list.length === 0) return false;
  try {
    await kv.put(key, JSON.stringify({ claims: list }), { expirationTtl: CLAIM_CACHE_TTL_SECONDS });
    return true;
  } catch (err) {
    console.error(`[claim-cache] write failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Keeps the saved set of `product` (and `productUrl`) for only
 * CLAIM_CACHE_WEAK_TTL_SECONDS from now, and marks it `short`. A set already
 * marked keeps its first expiry, so checks that reuse it within the day do
 * not push it out again. Returns true when a set was shortened now. A KV
 * error is logged and gives false. Never throws.
 */
export async function shortenCachedClaims(kv, product, productUrl = null) {
  const key = claimCacheKey(product, productUrl);
  if (!kv || !key) return false;
  try {
    const raw = await kv.get(key);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (saved?.short === true) return false;
    await kv.put(key, JSON.stringify({ ...saved, short: true }), { expirationTtl: CLAIM_CACHE_WEAK_TTL_SECONDS });
    return true;
  } catch (err) {
    console.error(`[claim-cache] shorten failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
