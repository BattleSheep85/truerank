// Shared render primitives for the research report page (and its siblings
// reviews.js / verify-page.js): button classes, metadata icons, star/image
// rendering, the "is this even sold on Amazon" category heuristic, source-link
// rel/label helpers, the CTA resolver, and the Our-pick freshness badge. Split
// out of research-page.js verbatim so that file stays under the file-size cap.

import { escapeHtml, isValidHttpsUrl } from '../lib/utils.js';
import { buildAffiliateUrl, buildAmazonSearchFallback, retailerLabel } from '../lib/affiliate-links.js';

// Forensic-instrument button classes (mono, square, uppercase) — shared
// across this page's CTAs so re-run/notify/copy-link controls read as the
// same instrument as verify-page.js instead of the legacy rounded `.btn`.
export const BTN_PRIMARY = 'inline-flex items-center justify-center gap-2 bg-accent-strong px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover';
const BTN_GHOST = 'inline-flex items-center justify-center gap-2 border border-line px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-ink-2 transition-colors hover:border-ink-3 hover:text-ink';

// Icons for well-known metadata keys. Unknown keys render with a generic dot so
// new verticals render sensibly without code changes.
const METADATA_ICONS = {
  address: '&#128205;',        // pin
  hours: '&#128336;',           // clock
  phone: '&#128222;',           // phone
  mapsUrl: '&#128506;&#65039;', // map
  priceRange: '&#128176;',      // money bag
  cuisine: '&#127869;&#65039;', // fork/knife
  brand: '&#127991;&#65039;',   // label/tag
  modelNumber: '&#128295;',     // wrench
  releaseDate: '&#128197;',     // calendar
  availability: '&#128230;',    // package
  platform: '&#128187;',        // laptop
  creator: '&#128100;',         // bust
  length: '&#9202;',            // stopwatch
  contentType: '&#128214;',     // book
  location: '&#127758;',        // globe
  season: '&#127809;',          // leaf
  cost: '&#128181;',            // dollar
  duration: '&#9202;',          // stopwatch
  difficulty: '&#128170;',      // muscle
  serviceArea: '&#128506;&#65039;', // map
  pricingModel: '&#128200;',    // chart
  credentials: '&#127891;',     // grad cap
  responseTime: '&#9889;',      // bolt
};

function labelForMetadataKey(key) {
  const map = {
    mapsUrl: 'Map',
    priceRange: 'Price range',
    modelNumber: 'Model',
    releaseDate: 'Released',
    availability: 'Availability',
    contentType: 'Type',
    serviceArea: 'Service area',
    pricingModel: 'Pricing',
    responseTime: 'Response time',
  };
  if (map[key]) return map[key];
  // camelCase → "Camel case"; snake_case → "Snake case" (legacy rows persisted
  // before the orchestrator normalized metadata keys to camelCase).
  return key
    .replace(/_+/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\s+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

export function renderMetadataPairs(metadata) {
  // The orchestrator now writes a flat string map (see buildProductMetadata),
  // but legacy rows persisted numbers (trust_score) and nested objects
  // (affiliate_links). Render strings and numbers; skip objects/arrays/empties.
  const entries = Object.entries(metadata)
    .map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])
    .filter(([, v]) => typeof v === 'string' && v.trim().length > 0);
  if (entries.length === 0) return '';
  return `<dl class="item-metadata mt-2.5 grid grid-cols-[max-content_1fr] gap-x-2.5 gap-y-1.5 font-mono text-[11px] text-ink-2">
${entries.map(([k, v]) => {
    const icon = METADATA_ICONS[k] ?? '&#9679;';
    const label = escapeHtml(labelForMetadataKey(k));
    // Render mapsUrl / URL-ish values as links when they look like URLs
    const isUrl = /^https?:\/\//i.test(v) && isValidHttpsUrl(v);
    const value = isUrl
      ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener noreferrer nofollow" class="text-accent hover:text-accent-hover">${escapeHtml(new URL(v).hostname.replace(/^www\./, ''))}</a>`
      : escapeHtml(v);
    return `<dt class="whitespace-nowrap uppercase tracking-wide text-ink-3"><span aria-hidden="true" class="mr-1">${icon}</span>${label}</dt><dd class="m-0">${value}</dd>`;
  }).join('')}
</dl>`;
}

// Star row for a rating. Clamps to 0..5 so a bad rating (>5, negative, NaN,
// null) never makes String.repeat throw a RangeError (which 500s the page).
export function starMarkup(rating) {
  const full = Math.max(0, Math.min(5, Math.floor(Number(rating) || 0)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

// Soft gradient fallback when imageUrl is missing or fails to load. Keyed by
// first letter so different items get distinct visual treatments without
// needing a real image pipeline.
export function renderItemImage(imageUrl, name, productId) {
  const safe = String(name ?? '').trim() || 'Product';
  const safeName = escapeHtml(safe.slice(0, 60));
  const letter = escapeHtml((safe.charAt(0) || '?').toUpperCase());
  const colorIndex = safe.charCodeAt(0) % 6;
  const gradients = [
    'linear-gradient(135deg,#1e3a8a,#2563eb)',
    'linear-gradient(135deg,#4c1d95,#7c3aed)',
    'linear-gradient(135deg,#14532d,#16a34a)',
    'linear-gradient(135deg,#7c2d12,#ea580c)',
    'linear-gradient(135deg,#831843,#db2777)',
    'linear-gradient(135deg,#0c4a6e,#0284c7)',
  ];
  const fallback = `<div class="item-image-fallback aspect-video w-full items-center justify-center border border-line mb-3" aria-hidden="true" style="display:flex;background:${gradients[colorIndex]}"><span class="font-mono text-4xl font-extrabold tracking-tight text-white/85">${letter}</span></div>`;
  if (!imageUrl || !isValidHttpsUrl(imageUrl)) return fallback;
  // Serve through the same-origin /api/img proxy when we know the product id:
  // the worker-side fetch carries no Referer (defeating hotlink blocks) and
  // edge-caches the bytes. Direct URL only as a legacy fallback.
  const src = productId ? `/api/img/${encodeURIComponent(productId)}` : imageUrl;
  // Broken images degrade gracefully: emit img + sibling fallback; a page-
  // level script swaps them on 'error'. Replaces the old inline onerror= that
  // was incompatible with nonce-based CSP.
  // NB: hide via inline display:none, NOT the [hidden] attribute — the fallback's own
  // inline `display:flex` OVERRIDES [hidden]'s UA display:none, so the letter-block was
  // rendering on top of a perfectly good picture. The onerror handler restores display:flex.
  const hiddenFallback = fallback.replace('display:flex', 'display:none');
  return `<img class="item-image-photo aspect-video w-full border border-line bg-surface-1 object-cover mb-3" src="${escapeHtml(src)}" alt="${safeName}" loading="lazy" referrerpolicy="no-referrer">
${hiddenFallback}`;
}

// User-generated content hosts get rel="ugc"; everything else gets plain nofollow.
// All outbound source links stay nofollow so we don't hand PageRank to competitors.
const UGC_HOSTS = ['reddit.com', 'stackoverflow.com', 'stackexchange.com', 'quora.com', 'news.ycombinator.com', 'medium.com', 'substack.com'];

export function sourceRel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const isUgc = UGC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    return isUgc ? 'noopener noreferrer nofollow ugc' : 'noopener noreferrer nofollow';
  } catch {
    return 'noopener noreferrer nofollow';
  }
}

export function sourceLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Resolve every CTA target for one product in one place so renderProduct and
// the "Our pick" box stay in lockstep (same labels, same rel, same redirect
// vs. clean-link behavior). Returns:
//   retailer — small non-Amazon pill { url, label, rel, isSponsored }
//   amazon   — the primary Amazon button { url, label, href, exact } where href
//              is the click-tracked /api/go/:id redirect (or the plain url for
//              cleanLinks / missing id). url stays the raw https target used for
//              the isValidHttpsUrl guard. exact=true only for a real /dp/ page;
//              false means it's an explicit "Search Amazon" fallback.
//   google   — internal /find hand-off for categories Amazon doesn't sell
//              (lumber, vehicles, services). Never rendered alongside amazon.
//
// webOnly: the classifier flagged this category as not-sold-on-Amazon. NO
// Amazon link of any kind renders for these — the primary CTA hands off to
// a real Google search via /find (a 302 redirect; logged as a guide_click).
export function resolveProductCtas(p, ids, isService, slug, cleanLinks, webOnly = false) {
  const mfrUrl = p.manufacturer_url && isValidHttpsUrl(p.manufacturer_url) ? p.manufacturer_url : '';
  const buyRaw = p.affiliate_url || p.product_url || '';

  let retailerCtaUrl = '';
  let retailerCtaLabel = '';
  let retailerCtaRel = 'noopener noreferrer nofollow sponsored';
  let retailerCtaIsSponsored = true;
  let amazonCtaUrl = '';
  let amazonCtaLabel = '';
  let amazonExact = false;
  let googleCtaUrl = '';
  let googleCtaLabel = '';

  const googleQuery = () => {
    const name = (p.name || '').trim();
    if (name.length < 3) return '';
    const b = (p.brand || '').trim();
    return b && !name.toLowerCase().startsWith(b.toLowerCase()) ? `${b} ${name}` : name;
  };

  if (isService || webOnly) {
    const serviceUrl = (mfrUrl || (buyRaw && isValidHttpsUrl(buyRaw) ? buyRaw : ''));
    if (serviceUrl) {
      retailerCtaUrl = serviceUrl;
      retailerCtaLabel = 'Visit site';
    }
    retailerCtaRel = 'noopener noreferrer nofollow';
    retailerCtaIsSponsored = false;
    const gq = googleQuery();
    if (gq) {
      googleCtaUrl = `/find?q=${encodeURIComponent(gq)}${slug ? `&ref=${encodeURIComponent(slug)}` : ''}`;
      googleCtaLabel = isService ? 'Find on Google' : 'Find sellers on Google';
    }
  } else {
    const affiliate = buildAffiliateUrl(buyRaw, ids);
    const isAmazonBuy = affiliate && /^https?:\/\/(www\.)?amazon\.com\//i.test(affiliate);
    if (isAmazonBuy) {
      amazonCtaUrl = affiliate;
      amazonCtaLabel = 'Buy on Amazon';
      amazonExact = true;
    } else {
      if (affiliate) {
        retailerCtaUrl = affiliate;
        retailerCtaLabel = `Buy on ${retailerLabel(affiliate)}`;
      }
      const searchFallback = buildAmazonSearchFallback(p.name, p.brand || '', ids.amazonTag);
      if (searchFallback) {
        amazonCtaUrl = searchFallback;
        amazonCtaLabel = 'Search Amazon';
      }
    }
  }

  // Route clicks through /api/go/:productId so every click lands in
  // affiliate_clicks. Exceptions: cleanLinks renders (the redirect always tags
  // the URL, which we must NOT do for affiliate-prohibited communities) and a
  // missing product id both fall back to the direct URL.
  let amazonCtaHref = amazonCtaUrl;
  if (amazonCtaUrl && !cleanLinks && p.id && slug) {
    amazonCtaHref = `/api/go/${encodeURIComponent(p.id)}?ref=${encodeURIComponent(slug)}&network=amazon`;
  }

  return {
    mfrUrl,
    retailer: { url: retailerCtaUrl, label: retailerCtaLabel, rel: retailerCtaRel, isSponsored: retailerCtaIsSponsored },
    amazon: { url: amazonCtaUrl, label: amazonCtaLabel, href: amazonCtaHref, exact: amazonExact },
    google: { url: googleCtaUrl, label: googleCtaLabel },
  };
}

// "Prices checked ___" freshness readout for the Our-pick CTA. Pure function of
// a completion timestamp (epoch seconds) and the current time (injectable so
// tests are deterministic) — never mutates its inputs.
export const STALE_AFTER_DAYS = 30;
export const ABSOLUTE_AFTER_DAYS = 60;

export function freshnessLabel(epochSec, nowMs = Date.now()) {
  if (typeof epochSec !== 'number' || !Number.isFinite(epochSec)) return { text: '', isStale: false };
  const days = Math.floor((nowMs - epochSec * 1000) / 86_400_000);
  const isStale = days > STALE_AFTER_DAYS;
  if (days <= 0) return { text: 'today', isStale };
  if (days === 1) return { text: 'yesterday', isStale };
  if (days < ABSOLUTE_AFTER_DAYS) return { text: `${days} days ago`, isStale };
  const text = new Date(epochSec * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  return { text, isStale };
}
