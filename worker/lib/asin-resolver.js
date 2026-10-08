/**
 * ASIN resolver: fill in direct Amazon /dp/ product links for products that
 * lack one.
 *
 * Why: expert review sources hide their Amazon links behind affiliate redirect
 * hops (amzn.to, skimresources, Impact, etc.), so the synthesis step rarely
 * attaches a canonical /dp/ASIN URL. Products then fall back to tagged Amazon
 * *search* links (buildAmazonSearchFallback) which convert far worse than a
 * direct product page. This module does one cheap Serper query per missing
 * product to recover the real /dp/ASIN.
 *
 * Subrequest budget: capped at MAX_RESOLVE (5) products → at most 5 outbound
 * fetches, run sequentially. This keeps us well under the Workers subrequest
 * limit and the Serper free-tier quota.
 *
 * Brave fallback: with no SERPER_API_KEY but a BRAVE_API_KEY, the Amazon site:
 * query goes through the engine's paced Brave client instead. The retailer
 * fallback stays Serper-only: Brave's free plan is 1 request/s and 2,000/month,
 * so 3 queries per product would triple the paced wall-clock and quota spend.
 *
 * Contract: NEVER throws. No key / quota / network error / no confident match
 * leaves the product unchanged (immutable — original object is returned as-is).
 */

import { buildAffiliateUrl } from './affiliate-links.js';
import { braveWebSearch } from '../engine/tools.js';

// Cap on how many products we spend a Serper query on per run. Reports carry
// 4-8 products; 8 covers every card so each quoted product links to its exact
// Amazon page whenever one exists (Serper ≈ $0.0003/query — negligible).
const MAX_RESOLVE = 8;
const TIMEOUT_MS = 8000;
const SERPER_ENDPOINT = 'https://google.serper.dev/search';

// /dp/ASIN extractor. credibility.js's extractAmazonProductUrls is content-wide
// and returns full URLs; here we want the ASIN out of a single result link,
// including the /gp/product/ form, so use a focused local regex.
const DP_ASIN = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/;

// Non-Amazon retailer fallback, tried only when the Amazon site: search finds
// no confident match. Verified against LIVE Serper /search results 2026-07-01:
// site:{retailer} "{product}" returns a genuine product-detail page about as
// often as noise (Q&A pages, review-tab deep links, or — Newegg — its own
// internal search-results page), so a real URL-pattern gate is required, not
// just the loose title-token match used for Amazon. Two retailers max, tried
// in this order, first hit wins — keeps the added Serper spend/latency small.
export const RETAILER_FALLBACKS = [
  {
    host: 'bestbuy.com',
    // Best Buy runs (at least) two live URL schemes for genuine product
    // pages: the older /site/{slug}/{sku}.p and a newer /product/{slug}/{code}
    // /sku/{id} — verified 2026-07-01 both resolve to real, distinct products
    // (missing the second form silently drops real matches). Q&A/review-tab
    // pages live under /site/questions/... or /site/reviews/... and must be
    // rejected even though they also contain digits that look product-ish.
    accept: (url) => (
      /\/site\/[^/]+\/\d+\.p(?:[/?]|$)/.test(url) ||
      /\/product\/[^/]+\/[^/]+\/sku\/\d+(?:[/?]|$)/.test(url)
    ) && !/\/(questions|reviews)\//.test(url),
    normalize: (url) => url,
  },
  {
    host: 'newegg.com',
    // Real product pages: /p/{code}. Newegg's own SEARCH results use the
    // literal path /p/pl (product list) — must be rejected, not a product.
    accept: (url) => /\/p\/(?!pl(?:[/?]|$))[0-9A-Za-z-]+(?:[/?]|$)/.test(url),
    normalize: (url) => url,
  },
];

// Tokens too generic to count toward a title/product-name match.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'best', 'new', 'pro', 'plus',
  'amazon', 'com', 'inch', 'gen', 'series', 'edition', 'model', 'review',
]);

/**
 * Resolve direct Amazon /dp/ links for products missing one.
 *
 * @param {object} env - worker env (reads env.SERPER_API_KEY or env.BRAVE_API_KEY + affiliate tags)
 * @param {Array<object>} products - engine product objects (camelCase fields)
 * @param {(msg: string) => Promise<void>} [onProgress] - optional progress sink
 * @returns {Promise<Array<object>>} products with resolved product_url/affiliate_url
 *          on any that matched; unmatched/untouched products returned unchanged.
 */
export async function resolveAsins(env, products, onProgress) {
  if (!Array.isArray(products) || products.length === 0) return products;

  const search = searchProviderFromEnv(env);
  // No key → nothing to do. Don't burn the subrequest; return untouched.
  if (!search) return products;

  const affiliateIds = affiliateIdsFromEnv(env);

  // Identify up to MAX_RESOLVE products lacking a usable direct /dp/ link, then resolve
  // them CONCURRENTLY (each is one Serper call; sequential resolution blew the queue-
  // consumer wall-clock on rich result sets and left runs stuck 'processing').
  let resolvedCount = 0;
  const out = products.slice();
  const targets = [];
  for (let i = 0; i < out.length && targets.length < MAX_RESOLVE; i++) {
    if (needsResolution(out[i])) targets.push(i);
  }
  await Promise.all(targets.map(async (i) => {
    try {
      // Amazon first (direct /dp/ commission on the primary affiliate program);
      // only fall back to another retailer when Amazon genuinely has no match.
      const url = await resolveOne(out[i], search)
        || (search.retailerFallback ? await resolveOtherRetailer(out[i], search) : null);
      if (url) {
        const affiliateUrl = buildAffiliateUrl(url, affiliateIds);
        out[i] = { ...out[i], productUrl: url, affiliateUrl: affiliateUrl || out[i].affiliateUrl };
        resolvedCount++;
      }
    } catch (err) {
      console.log(`[asin-resolver] resolve failed for "${out[i]?.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  if (resolvedCount > 0 && typeof onProgress === 'function') {
    try {
      await onProgress(`Resolved ${resolvedCount} direct product link${resolvedCount === 1 ? '' : 's'}.`);
    } catch { /* progress is best-effort */ }
  }

  return out;
}

// A product needs resolution when it has no direct /dp/ or /gp/product Amazon
// URL already. A search URL, a non-Amazon URL, or no URL all qualify.
function needsResolution(product) {
  if (!product || typeof product !== 'object') return false;
  const url = product.productUrl;
  if (!url || typeof url !== 'string') return true;
  if (!/amazon\./i.test(url)) return true;
  return !DP_ASIN.test(url);
}

// Product subject for a site:-restricted search: "{brand} {name}" (unless name
// already starts with the brand), quotes stripped since they'd break Serper's
// phrase-query syntax. Shared by the Amazon resolver and the retailer fallback.
function productSubject(product) {
  const brand = (product.brand || '').trim();
  const name = (product.name || '').trim();
  if (name.length < 2) return null;
  return (brand && !name.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${name}`
    : name).replace(/"/g, '');
}

// Serper when its key is set (unchanged behavior), else Brave, else null.
// `siteSearch(host, subject)` resolves to [{ link, title }] (Serper organic shape).
function searchProviderFromEnv(env) {
  const serperKey = env?.SERPER_API_KEY;
  if (serperKey) {
    return { retailerFallback: true, siteSearch: (host, subject) => serperSiteSearch(host, subject, serperKey) };
  }
  const braveKey = env?.BRAVE_API_KEY;
  if (braveKey) {
    return { retailerFallback: false, siteSearch: (host, subject) => braveSiteSearch(host, subject, braveKey) };
  }
  return null;
}

function siteQuery(host, subject) {
  return `site:${host} "${subject}"`;
}

// Brave web results mapped to the Serper organic shape. braveWebSearch never
// throws: null (unavailable) and [] (no hits) both mean no candidates.
async function braveSiteSearch(host, subject, apiKey) {
  const results = await braveWebSearch(siteQuery(host, subject), apiKey);
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({ link: r?.url, title: r?.title }));
}

async function serperSiteSearch(host, subject, apiKey) {
  const query = siteQuery(host, subject);
  const response = await fetch(SERPER_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: 3 }),
  });
  if (!response.ok) {
    console.log(`[asin-resolver] serper HTTP ${response.status} q="${query}"`);
    return [];
  }
  const data = await response.json().catch(() => null);
  return Array.isArray(data?.organic) ? data.organic : [];
}

// Tries each RETAILER_FALLBACKS host in order, first URL-pattern-verified match
// wins. Only called after the Amazon resolver (resolveOne) finds nothing.
async function resolveOtherRetailer(product, search) {
  const subject = productSubject(product);
  if (!subject) return null;
  for (const retailer of RETAILER_FALLBACKS) {
    const organic = await search.siteSearch(retailer.host, subject);
    for (const item of organic) {
      const link = typeof item?.link === 'string' ? item.link : '';
      if (!link || !retailer.accept(link)) continue;
      if (!titleMatches(subject, item?.title || '')) continue;
      return retailer.normalize(link);
    }
  }
  return null;
}

// One site:amazon.com query (Serper or Brave) for a single product. Returns a canonical
// https://www.amazon.com/dp/ASIN URL on a confident match, else null.
async function resolveOne(product, search) {
  const subject = productSubject(product);
  if (!subject) return null;
  const organic = await search.siteSearch('amazon.com', subject);

  for (const item of organic) {
    const link = typeof item?.link === 'string' ? item.link : '';
    const m = link.match(DP_ASIN);
    if (!m) continue;
    // Sanity-check the result title loosely matches the product so we don't
    // attach an accessory/wrong-variant page. Require ≥2 shared significant
    // tokens between the product subject and the Serper result title.
    if (!titleMatches(subject, item?.title || '')) continue;
    return `https://www.amazon.com/dp/${m[1].toUpperCase()}`;
  }
  return null;
}

function affiliateIdsFromEnv(env) {
  return {
    amazonTag: env.AMAZON_AFFILIATE_TAG || env.AMAZON_ASSOCIATE_TAG || 'battlesheep0a-20',
    walmartImpact: env.WALMART_IMPACT_ID || undefined,
    targetImpact: env.IMPACT_TARGET_ID || undefined,
    bestbuyImpact: env.IMPACT_BESTBUY_ID || undefined,
    neweggImpact: env.IMPACT_NEWEGG_ID || undefined,
    bhphoto: env.BHPHOTO_AFFILIATE_ID || undefined,
  };
}

// Significant tokens: lowercase alphanumerics ≥2 chars, minus stopwords.
function significantTokens(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// Loose match: ≥2 shared significant tokens between subject and result title.
export function titleMatches(subject, title) {
  const a = new Set(significantTokens(subject));
  if (a.size === 0) return false;
  let shared = 0;
  for (const t of significantTokens(title)) {
    if (a.has(t)) {
      shared++;
      if (shared >= 2) return true;
    }
  }
  // Single distinctive token can suffice when the subject is itself a single
  // token (e.g. a one-word product name); otherwise require the 2-token bar.
  return a.size === 1 && shared >= 1;
}
