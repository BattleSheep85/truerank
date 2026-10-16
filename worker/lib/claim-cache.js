// Saved claim sets for /verify (CP-718).
//
// The claims of a product come from whichever maker and store pages a run
// happens to find, so two runs of one product checked different claims and
// their scores swung (Dyson V15 Detect: 13 vs 80). The first run's claims are
// saved in KV under the product's name key, and later runs of the same
// product check the same claims against fresh evidence.

import { productNameKey } from './product-link.js';

/** Bump when the extraction rules change, so older claim sets are not reused. */
export const CLAIM_CACHE_VERSION = 'v1';
/** Same as the saved-verdict reuse window (VERIFY_REUSE_MAX_AGE_DAYS). */
export const CLAIM_CACHE_TTL_SECONDS = 30 * 86400;
const KEY_PREFIX = `verify-claims:${CLAIM_CACHE_VERSION}:`;
const CLAIM_TYPES = Object.freeze(['spec', 'marketing', 'warranty', 'support']);
const MAX_CLAIM_CHARS = 400;
const MAX_CACHED_CLAIMS = 12;

/** The KV key of a product's claim set, or null when the name has no key. */
export function claimCacheKey(product) {
  const nameKey = productNameKey(String(product ?? '').trim());
  return nameKey ? KEY_PREFIX + nameKey : null;
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
 * The saved claims of `product` that `keep` (for example isTestableClaim)
 * still accepts, or [] when there is no KV, no key, no saved set, or the
 * saved value is not valid. A KV error is logged and gives []. Never throws.
 */
export async function readCachedClaims(kv, product, keep = () => true) {
  const key = claimCacheKey(product);
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
 * Saves the claims of `product` for CLAIM_CACHE_TTL_SECONDS. Returns true
 * when saved. A KV error is logged and gives false. Never throws.
 */
export async function writeCachedClaims(kv, product, claims) {
  const key = claimCacheKey(product);
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
