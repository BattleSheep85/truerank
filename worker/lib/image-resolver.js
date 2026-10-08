/**
 * Product image resolver: fill in image_url for products that lack one.
 *
 * One Serper Images query per missing product. Candidates are ranked by
 * host quality (Amazon's CDN allows hotlinking and is product-accurate;
 * retailer CDNs next; everything else last) and minimum dimensions. The
 * render path serves images through the /api/img/:id proxy, so even
 * hotlink-hostile hosts work — ranking is about accuracy, not loadability.
 *
 * Brave fallback: with no SERPER_API_KEY but a BRAVE_API_KEY, the query goes
 * to the Brave Image Search API, paced on the engine's shared Brave slot. Brave
 * results are mapped to the Serper image shape so pickBestImage filters both
 * the same way. If Brave refuses the endpoint (401/403/422, for example a plan
 * without image search), the run logs once and leaves the remaining products as they are.
 *
 * Contract mirrors asin-resolver: NEVER throws; unresolved products pass
 * through unchanged (immutable updates only).
 */

import { waitForBraveSlot } from '../engine/tools.js';

const SERPER_IMAGES_ENDPOINT = 'https://google.serper.dev/images';
const BRAVE_IMAGES_ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';
const BRAVE_IMAGES_COUNT = 5;
// Brave answers these when the key or plan cannot use the image endpoint.
const BRAVE_IMAGES_REFUSED = new Set([401, 403, 422]);
const TIMEOUT_MS = 8000;
// Cap per run: one Serper query each → ≤8 extra subrequests.
const MAX_RESOLVE = 8;
const MIN_DIM = 200;

// Hosts whose product imagery is reliable and accurately keyed to products.
const PREFERRED_HOSTS = [
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'i5.walmartimages.com',
  'pisces.bbystatic.com',
  'target.scene7.com',
  'images.thdstatic.com',
  'mobileimages.lowes.com',
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/** Build the image-search query for a product (brand-deduped, like the ASIN resolver). */
export function buildImageQuery(product) {
  const name = (product.name || '').trim();
  if (name.length < 3) return '';
  const brand = (product.brand || '').trim();
  const subject = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
    ? `${brand} ${name}`
    : name;
  return `${subject} product`;
}

/**
 * Pick the best candidate from a Serper images response. Pure function so
 * the offline backfill script reuses the exact same ranking. Returns an
 * https URL or ''.
 */
export function pickBestImage(images) {
  if (!Array.isArray(images)) return '';
  const candidates = [];
  for (const im of images.slice(0, 10)) {
    let url = typeof im?.imageUrl === 'string' ? im.imageUrl.trim() : '';
    if (!url) continue;
    // Most product CDNs serve https even when Serper reports http.
    if (url.startsWith('http://')) url = `https://${url.slice(7)}`;
    if (!url.startsWith('https://')) continue;
    const w = Number(im.imageWidth) || 0;
    const h = Number(im.imageHeight) || 0;
    if (w < MIN_DIM || h < MIN_DIM) continue;
    // Extreme aspect ratios are banners/sprites, not product shots.
    if (w / h > 3 || h / w > 3) continue;
    const host = hostOf(url);
    const preferred = PREFERRED_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));
    candidates.push({ url, score: (preferred ? 1000 : 0) + Math.min(w * h, 4_000_000) / 10_000 });
  }
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  return sorted[0]?.url || '';
}

/**
 * Map Brave Image Search results to the Serper image shape pickBestImage reads.
 * properties.url is the original image; width/height are not always present,
 * so the proxied thumbnail's dimensions stand in (same aspect ratio).
 */
export function braveImagesToSerperShape(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    imageUrl: r?.properties?.url || r?.thumbnail?.src,
    imageWidth: r?.properties?.width ?? r?.thumbnail?.width,
    imageHeight: r?.properties?.height ?? r?.thumbnail?.height,
  }));
}

// One Brave Image Search call. `state` is shared by one resolveImages run so a
// refused endpoint logs once and stops later calls in that run.
async function searchImageBrave(query, apiKey, state) {
  if (state.refused) return '';
  await waitForBraveSlot();
  if (state.refused) return '';
  const params = new URLSearchParams({ q: query, count: String(BRAVE_IMAGES_COUNT) });
  const response = await fetch(`${BRAVE_IMAGES_ENDPOINT}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });
  if (!response.ok) {
    if (BRAVE_IMAGES_REFUSED.has(response.status)) {
      if (!state.refused) console.log(`[image-resolver] brave images HTTP ${response.status}: endpoint not available, skipping images`);
      state.refused = true;
      return '';
    }
    console.log(`[image-resolver] brave images HTTP ${response.status} q="${query}"`);
    return '';
  }
  const data = await response.json().catch(() => null);
  return pickBestImage(braveImagesToSerperShape(data?.results));
}

// Serper when its key is set (unchanged behavior), else Brave, else null.
function imageSearchFromEnv(env) {
  const serperKey = env?.SERPER_API_KEY;
  if (serperKey) return (query) => searchImage(query, serperKey);
  const braveKey = env?.BRAVE_API_KEY;
  if (braveKey) {
    const state = { refused: false };
    return (query) => searchImageBrave(query, braveKey, state);
  }
  return null;
}

async function searchImage(query, apiKey) {
  const response = await fetch(SERPER_IMAGES_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  if (!response.ok) {
    console.log(`[image-resolver] serper HTTP ${response.status} q="${query}"`);
    return '';
  }
  const data = await response.json().catch(() => null);
  return pickBestImage(data?.images);
}

/**
 * Resolve images for products missing one. Same shape as resolveAsins.
 */
export async function resolveImages(env, products, onProgress) {
  if (!Array.isArray(products) || products.length === 0) return products;
  const search = imageSearchFromEnv(env);
  if (!search) return products;

  // Pick up to MAX_RESOLVE products needing an image, then resolve them CONCURRENTLY
  // (each is one Serper call; sequential resolution blew the queue-consumer wall-clock on
  // rich comprehensive result sets and left runs stuck 'processing').
  const out = products.slice();
  const targets = [];
  for (let i = 0; i < out.length && targets.length < MAX_RESOLVE; i++) {
    const hasImage = typeof out[i]?.imageUrl === 'string' && out[i].imageUrl.startsWith('https://');
    if (!hasImage && buildImageQuery(out[i])) targets.push(i);
  }
  let resolved = 0;
  await Promise.all(targets.map(async (i) => {
    try {
      const url = await search(buildImageQuery(out[i]));
      if (url) { out[i] = { ...out[i], imageUrl: url }; resolved++; }
    } catch (err) {
      console.log(`[image-resolver] failed for "${out[i]?.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  if (resolved > 0 && typeof onProgress === 'function') {
    try { await onProgress(`Found product photos for ${resolved} item${resolved === 1 ? '' : 's'}.`); } catch { /* best-effort */ }
  }
  return out;
}
