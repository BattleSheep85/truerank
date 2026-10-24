/**
 * /reviews — sitewide product-review directory.
 *
 * Every reviewed product across all completed research, as full review cards:
 * photo, star rating, price, the review verdict, pros/cons, a link to the
 * parent research report (the full review with sources), and a click-tracked
 * buy CTA. Filterable by category, paginated. ItemList JSON-LD for rich
 * results. Products with photos sort first so the page leads with its
 * strongest visual content.
 */

import { layout, jsonLdScript } from '../lib/html.js';
import { escapeHtml, parseJsonSafe, isValidHttpsUrl, displayQuery } from '../lib/utils.js';
import { renderItemImage, resolveProductCtas } from './research-primitives.js';
import { pageKind } from '../lib/page-kind.js';
import { resolveAmazonTag } from '../lib/affiliate-links.js';
import { adSlot } from '../lib/ads.js';
import { jsonEmbed, listLayoutBoot } from '../lib/list-layout-boot.js';
import { renderPagerNav } from '../lib/pager.js';
import {
  PAGE_SIZE, PRICE_BANDS, RATING_OPTIONS, SORT_OPTIONS,
  parseProductFilters, isNarrowed, buildProductWhere, orderByClause, reviewsHref,
} from '../lib/product-search.js';

// SQL CASE that buckets p.price into PRICE_BANDS keys — generated from the
// constant so the JS bands and the SQL facet counts can never drift. Bounds are
// our own numeric constants (never user input), so inlining them is safe.
const PRICE_BAND_CASE = `CASE ${PRICE_BANDS.map((b) =>
  b.max == null ? `WHEN p.price >= ${b.min} THEN '${b.key}'`
    : `WHEN p.price >= ${b.min} AND p.price < ${b.max} THEN '${b.key}'`).join(' ')} END`;

function starsHtml(rating) {
  if (rating == null) return '';
  const full = Math.max(0, Math.min(5, Math.floor(rating)));
  return `<span class="review-stars inline-flex items-center gap-1 font-mono text-xs" aria-label="Rated ${rating} out of 5"><span aria-hidden="true" class="text-accent">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span> <span class="readout text-ink-2">${rating}/5</span></span>`;
}

// review-card is a JS render-smoke test hook (see reviews.test.js) — the
// class attribute must stay exactly `class="review-card"` (no additional
// classes appended). Its Forensic-instrument layout (border, padding, flex
// column) lives in app.css under `.review-card` instead of inline utilities.
function renderReviewCard(row, affiliateIds) {
  const pros = parseJsonSafe(row.pros, []).slice(0, 3);
  const cons = parseJsonSafe(row.cons, []).slice(0, 2);
  const facets = parseJsonSafe(row.facets, {}) || {};
  const { isService, webOnly } = pageKind(row.category, facets);

  // Reuse the research page's CTA resolver so labels/tracking stay identical.
  const p = {
    id: row.id, name: row.name, brand: row.brand,
    affiliate_url: row.affiliate_url, product_url: row.product_url,
    manufacturer_url: row.manufacturer_url,
  };
  const ctas = resolveProductCtas(p, affiliateIds, isService, row.slug, false, webOnly);
  let ctaHtml = '';
  if (ctas.amazon.url && isValidHttpsUrl(ctas.amazon.url)) {
    ctaHtml = `<a href="${escapeHtml(ctas.amazon.href)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="product-cta-amazon mt-auto">${escapeHtml(ctas.amazon.label)} <span aria-hidden="true">&#8599;</span></a>`;
  } else if (ctas.google.url) {
    ctaHtml = `<a href="${escapeHtml(ctas.google.url)}" class="product-cta-amazon mt-auto">${escapeHtml(ctas.google.label)} <span aria-hidden="true">&#8599;</span></a>`;
  }

  const reviewDate = row.completed_at
    ? new Date(row.completed_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';

  return `<article class="review-card">
${renderItemImage(row.image_url, row.name, row.id)}
<div class="flex items-start justify-between gap-2.5">
<div class="min-w-0">
<h3 class="wrap-anywhere font-sans text-[1.02rem] font-bold leading-snug text-ink">${escapeHtml(row.name)}</h3>
${row.brand ? `<p class="font-mono text-xs uppercase tracking-wide text-ink-3">${escapeHtml(row.brand)}</p>` : ''}
</div>
${row.price != null ? `<p class="product-price readout shrink-0">$${row.price.toLocaleString()}</p>` : ''}
</div>
<div class="my-2">${starsHtml(row.rating)}</div>
${row.verdict ? `<p class="my-1.5 text-body-sm leading-relaxed text-ink-2">${escapeHtml(row.verdict)}</p>` : ''}
${(pros.length > 0 || cons.length > 0) ? `<div class="my-1.5 mb-2.5 font-mono text-[11px] leading-relaxed">
${pros.map((pr) => `<div class="flex gap-1.5 text-ink-2"><span class="text-trust-high" aria-hidden="true">+</span><span>${escapeHtml(pr)}</span></div>`).join('')}
${cons.map((c) => `<div class="flex gap-1.5 text-ink-2"><span class="text-trust-low" aria-hidden="true">&minus;</span><span>${escapeHtml(c)}</span></div>`).join('')}
</div>` : ''}
<p class="mb-2.5 font-mono text-[11px] text-ink-3">From <a href="/research/${escapeHtml(row.slug)}" class="text-accent hover:text-accent-hover">${escapeHtml(displayQuery(row.query))}</a>${reviewDate ? ` &middot; ${reviewDate}` : ''}</p>
${ctaHtml}
</article>`;
}

// One facet group in the left rail: a heading + value rows with counts. The
// active value toggles off (links back to the cleared filter); inactive values
// link to the narrowed filter. `keyOf` extracts the comparison key per row.
// NB: the option is `keyOf`, NOT `valueOf` — `valueOf` is an Object.prototype
// method, so a destructuring default `{ valueOf = … } = {}` reads the inherited
// native method instead of applying the default, then throws when called.
// Heading text (">Category<" etc.) is a render-smoke test hook — keep the
// escaped `title` as the h3's only content.
function facetGroup(title, filters, dim, rows, opts = {}) {
  const { activeKey = filters[dim] || '', keyOf = (r) => r.key, labelOf = (r) => r.label, countOf = (r) => r.n } = opts;
  const items = rows.filter((r) => countOf(r) > 0 || keyOf(r) === activeKey);
  if (items.length === 0 && !activeKey) return '';
  const row = (label, count, href, active) =>
    `<li><a href="${escapeHtml(href)}" rel="nofollow" aria-pressed="${active ? 'true' : 'false'}" class="flex items-center justify-between gap-2 py-1 font-mono text-[13px] no-underline ${active ? 'font-semibold text-ink' : 'text-ink-2'}">
<span class="flex min-w-0 items-center gap-1.5"><span aria-hidden="true" class="shrink-0">${active ? '☑' : '☐'}</span><span class="overflow-hidden text-ellipsis whitespace-nowrap">${escapeHtml(label)}</span></span>
${count != null ? `<span class="readout shrink-0 text-ink-3">${count.toLocaleString()}</span>` : ''}</a></li>`;
  return `<div class="mb-5">
<h3 class="mb-2 font-mono text-[11px] font-bold uppercase tracking-widest text-ink-3">${escapeHtml(title)}</h3>
<ul class="m-0 list-none border-t border-line p-0">
${items.map((r) => {
    const key = keyOf(r);
    const active = key === activeKey;
    return row(labelOf(r), countOf(r), reviewsHref(filters, { [dim]: active ? '' : key }), active);
  }).join('')}
</ul></div>`;
}

export async function renderReviewsPage(url, env) {
  const filters = parseProductFilters((n) => url.searchParams.get(n));
  const offset = (filters.page - 1) * PAGE_SIZE;

  const join = 'FROM products p JOIN research r ON r.id = p.research_id';
  const main = buildProductWhere(filters);                 // full filter (list + count)
  const wCat = buildProductWhere(filters, 'category');     // facet contexts exclude their own dim
  const wBrand = buildProductWhere(filters, 'brand');
  const wPrice = buildProductWhere(filters, 'price');
  const wRating = buildProductWhere(filters, 'rating');

  const [listRes, countRes, catRes, brandRes, priceRes, ratingRes] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id, p.name, p.brand, p.price, p.rating, p.image_url, p.product_url,
              p.affiliate_url, p.manufacturer_url, p.pros, p.cons, p.verdict, p.rank,
              r.slug, r.query, r.category, r.facets, r.completed_at, r.view_count
       ${join} WHERE ${main.clause}
       ORDER BY ${orderByClause(filters.sort)}
       LIMIT ? OFFSET ?`
    ).bind(...main.binds, PAGE_SIZE, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n ${join} WHERE ${main.clause}`).bind(...main.binds).first(),
    env.DB.prepare(
      `SELECT r.category AS key, COUNT(*) AS n ${join} WHERE ${wCat.clause} AND r.category IS NOT NULL AND r.category != ''
       GROUP BY r.category ORDER BY n DESC LIMIT 15`
    ).bind(...wCat.binds).all(),
    env.DB.prepare(
      `SELECT p.brand AS key, COUNT(*) AS n ${join} WHERE ${wBrand.clause} AND p.brand IS NOT NULL AND p.brand != ''
       GROUP BY p.brand ORDER BY n DESC LIMIT 15`
    ).bind(...wBrand.binds).all(),
    env.DB.prepare(
      `SELECT ${PRICE_BAND_CASE} AS key, COUNT(*) AS n ${join} WHERE ${wPrice.clause} AND p.price IS NOT NULL
       GROUP BY key`
    ).bind(...wPrice.binds).all(),
    env.DB.prepare(
      `SELECT SUM(CASE WHEN p.rating >= 4.5 THEN 1 ELSE 0 END) AS r45,
              SUM(CASE WHEN p.rating >= 4 THEN 1 ELSE 0 END) AS r4,
              SUM(CASE WHEN p.rating >= 3.5 THEN 1 ELSE 0 END) AS r35
       ${join} WHERE ${wRating.clause}`
    ).bind(...wRating.binds).first(),
  ]);

  const rows = listRes.results ?? [];
  const total = countRes?.n ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (rows.length === 0 && filters.page > 1) return null; // out-of-range page → 404

  const affiliateIds = {
    amazonTag: resolveAmazonTag(env),
    walmartImpact: env.WALMART_IMPACT_ID || undefined,
    targetImpact: env.IMPACT_TARGET_ID || undefined,
    bestbuyImpact: env.IMPACT_BESTBUY_ID || undefined,
    neweggImpact: env.IMPACT_NEWEGG_ID || undefined,
    bhphoto: env.BHPHOTO_AFFILIATE_ID || undefined,
  };

  // ── Left rail: search box + facet groups ──────────────────────────────────
  const priceCounts = new Map((priceRes.results ?? []).map((r) => [r.key, r.n]));
  const ratingCounts = { '4.5': ratingRes?.r45 ?? 0, '4': ratingRes?.r4 ?? 0, '3.5': ratingRes?.r35 ?? 0 };

  const hidden = (name, val) => (val ? `<input type="hidden" name="${name}" value="${escapeHtml(val)}">` : '');
  const searchForm = `<form method="get" action="/reviews" role="search" class="mb-5">
${hidden('category', filters.category)}${hidden('brand', filters.brand)}${hidden('price', filters.price)}${hidden('rating', filters.rating)}${filters.sort !== 'featured' ? hidden('sort', filters.sort) : ''}
<label for="rev-q" class="mb-1.5 block font-mono text-[11px] font-bold uppercase tracking-widest text-ink-3">Search products</label>
<div class="flex gap-1.5">
<input id="rev-q" type="search" name="q" value="${escapeHtml(filters.q)}" placeholder="e.g. nas, headphones" maxlength="80" class="min-w-0 flex-1 border border-line bg-surface-1 px-2.5 py-2 font-mono text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25">
<button type="submit" class="shrink-0 border border-line bg-ink px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-bg transition-colors hover:bg-accent">Go</button>
</div></form>`;

  // Custom price-range form. Preserves every other filter as hidden inputs but
  // NOT the preset band — entering a range replaces the band (parseProductFilters
  // gives the band precedence, so we must drop it here to honor the range).
  const priceRangeForm = `<form method="get" action="/reviews" class="-mt-1.5 mb-5">
${hidden('q', filters.q)}${hidden('category', filters.category)}${hidden('brand', filters.brand)}${hidden('rating', filters.rating)}${filters.sort !== 'featured' ? hidden('sort', filters.sort) : ''}
<div class="flex items-center gap-1.5">
<input type="number" name="pmin" min="0" step="1" value="${filters.pmin ?? ''}" aria-label="Minimum price" placeholder="Min" class="w-full min-w-0 border border-line bg-surface-1 px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25">
<span class="text-ink-3" aria-hidden="true">&ndash;</span>
<input type="number" name="pmax" min="0" step="1" value="${filters.pmax ?? ''}" aria-label="Maximum price" placeholder="Max" class="w-full min-w-0 border border-line bg-surface-1 px-2 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25">
<button type="submit" class="shrink-0 border border-line px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-2 transition-colors hover:border-ink-3 hover:text-ink">Go</button>
</div></form>`;

  const sidebar = `<aside aria-label="Filters" class="sticky top-20">
${searchForm}
${facetGroup('Category', filters, 'category', catRes.results ?? [], { labelOf: (r) => r.key, keyOf: (r) => r.key })}
${facetGroup('Brand', filters, 'brand', brandRes.results ?? [], { labelOf: (r) => r.key, keyOf: (r) => r.key })}
${facetGroup('Price', filters, 'price', PRICE_BANDS.map((b) => ({ ...b, n: priceCounts.get(b.key) ?? 0 })))}
${priceRangeForm}
${facetGroup('Rating', filters, 'rating', RATING_OPTIONS.map((o) => ({ ...o, n: ratingCounts[o.key] ?? 0 })))}
</aside>`;

  // ── Active-filter chips + sort row ─────────────────────────────────────────
  const activeChips = [];
  const chipFor = (dim, label) => `<a href="${escapeHtml(reviewsHref(filters, { [dim]: '' }))}" rel="nofollow" class="inline-flex items-center gap-1.5 border border-line-strong px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-ink-2 no-underline hover:border-ink-3 hover:text-ink">${escapeHtml(label)} <span aria-hidden="true">&times;</span></a>`;
  if (filters.q) activeChips.push(chipFor('q', `“${filters.q}”`));
  if (filters.category) activeChips.push(chipFor('category', filters.category));
  if (filters.brand) activeChips.push(chipFor('brand', filters.brand));
  // Price: a preset band OR a custom pmin/pmax range. Either way, the chip clears
  // all three price keys so the price filter fully resets in one click.
  if (filters.price || filters.pmin != null || filters.pmax != null) {
    const label = filters.price
      ? (PRICE_BANDS.find((b) => b.key === filters.price)?.label || filters.price)
      : `${filters.pmin != null ? '$' + filters.pmin : '$0'} – ${filters.pmax != null ? '$' + filters.pmax : 'any'}`;
    activeChips.push(`<a href="${escapeHtml(reviewsHref(filters, { price: '', pmin: '', pmax: '' }))}" rel="nofollow" class="inline-flex items-center gap-1.5 border border-line-strong px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-ink-2 no-underline hover:border-ink-3 hover:text-ink">${escapeHtml(label)} <span aria-hidden="true">&times;</span></a>`);
  }
  if (filters.rating) activeChips.push(chipFor('rating', RATING_OPTIONS.find((o) => o.key === filters.rating)?.label || filters.rating));
  const chipsRow = activeChips.length
    ? `<div class="mb-4 flex flex-wrap items-center gap-2">
${activeChips.join('')}
<a href="/reviews" rel="nofollow" class="font-mono text-[11px] uppercase tracking-wide text-accent no-underline hover:text-accent-hover">Clear all filters</a></div>`
    : '';

  const sortLinks = SORT_OPTIONS.map((o) =>
    `<a href="${escapeHtml(reviewsHref(filters, { sort: o.key }))}" rel="nofollow" class="border-b-2 px-0.5 py-1 font-mono text-xs no-underline ${filters.sort === o.key ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-3'}">${escapeHtml(o.label)}</a>`).join('');

  // The prev/newer/older strip stays `rel="nofollow"` (it duplicates the
  // numbered pager below and existed before this change); the numbered pager
  // is the crawlable path so every page is reachable in a small hop count.
  const pagerHtml = totalPages > 1
    ? `<nav aria-label="Pagination" class="mt-8 flex items-center justify-center gap-3">
${filters.page > 1 ? `<a href="${escapeHtml(reviewsHref(filters, { page: filters.page - 1 }))}" rel="nofollow" class="border border-line px-3.5 py-2 font-mono text-xs uppercase tracking-wide text-ink-2 hover:border-ink-3 hover:text-ink">&larr; Newer</a>` : ''}
<span class="readout font-mono text-xs text-ink-3">Page ${filters.page} of ${totalPages}</span>
${filters.page < totalPages ? `<a href="${escapeHtml(reviewsHref(filters, { page: filters.page + 1 }))}" rel="nofollow" class="border border-line px-3.5 py-2 font-mono text-xs uppercase tracking-wide text-ink-2 hover:border-ink-3 hover:text-ink">Older &rarr;</a>` : ''}
</nav>` : '';
  const numberedPagerHtml = renderPagerNav(
    totalPages, filters.page,
    (n) => escapeHtml(reviewsHref(filters, { page: n })),
    'Reviews pages',
  );

  // Category-specific heading only when category is the SOLE active filter (so
  // the H1/title match the indexable category listing); any further narrowing
  // falls back to the generic heading (those variants are noindex anyway).
  const categoryOnly = filters.category && !filters.brand && !filters.price && !filters.rating && !filters.q
    && filters.pmin == null && filters.pmax == null;
  const heading = categoryOnly ? `Product reviews: ${filters.category}` : 'Product reviews';
  const reviewListItems = rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    brand: r.brand || '',
    price: r.price,
    rating: r.rating,
    query: displayQuery(r.query),
    category: r.category || '',
    verdict: r.verdict || '',
    ts: (r.completed_at || 0) * 1000,
  }));
  const resultsHtml = rows.length
    ? `${jsonEmbed('reviews-list-data', reviewListItems)}<div id="reviews-list"><div class="grid">${rows.map((r) => renderReviewCard(r, affiliateIds)).join('')}</div></div>`
    : `<p class="border border-line bg-surface-1 px-4 py-8 text-center text-body-sm text-ink-2">No products match these filters. <a href="/reviews" class="text-accent hover:text-accent-hover">Clear all filters</a> and try again.</p>`;

  const body = `<div class="grid-bg border-b border-line">
<div class="container mx-auto max-w-[78rem] px-6 py-10 sm:px-8">
<nav aria-label="Breadcrumb" class="breadcrumb mb-4 font-mono text-[11px] uppercase tracking-widest text-ink-3">
<a href="/" class="hover:text-ink">Home</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<span class="text-ink-2">Reviews</span>
</nav>
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Index &middot; Faceted product ledger</p>
<h1 class="page-header mt-2 font-serif text-h1 font-semibold text-ink">${escapeHtml(heading)}</h1>
<p class="mt-2 max-w-[62ch] text-body-sm text-ink-2">Filter every product we've reviewed by category, brand, price, and rating. Ratings are synthesized from real user reviews and independent testing — never paid placements.</p>
</div>
</div>
<div class="container mx-auto max-w-[78rem] px-6 py-8 sm:px-8">
${adSlot(env, 'top', 'Advertisement')}
<div class="reviews-shell mt-6 items-start gap-8 sm:grid sm:grid-cols-[15rem_minmax(0,1fr)]">
${sidebar}
<div>
<h2 class="sr-only">Product reviews list</h2>
<div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-3 border-b border-line pb-3">
<p class="font-mono text-xs text-ink-2"><strong class="readout text-ink">${total.toLocaleString()}</strong> product${total === 1 ? '' : 's'}</p>
<div class="flex flex-wrap items-center gap-x-4 gap-y-0.5"><span class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Sort</span>${sortLinks}</div>
</div>
${chipsRow}
<p class="affiliate-disclosure mb-4 font-mono text-[11px] text-ink-3">We may earn an affiliate commission on qualifying purchases made through links on this page. Rankings remain independent and objective.</p>
${resultsHtml}
${pagerHtml}
${numberedPagerHtml}
</div>
</div>
${adSlot(env, 'bottom', 'Advertisement')}
</div>
<style>@media (max-width:780px){.reviews-shell aside{position:static !important}}</style>`;

  // ItemList JSON-LD: products with ratings + review bodies — the structure
  // Google parses for review rich results on directory pages.
  const itemListLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: heading,
    numberOfItems: rows.length,
    itemListElement: rows.map((r, i) => {
      const item = { '@type': 'Product', name: r.name };
      if (r.brand) item.brand = { '@type': 'Brand', name: r.brand };
      if (r.image_url && isValidHttpsUrl(r.image_url)) item.image = r.image_url;
      if (r.verdict) {
        item.review = {
          '@type': 'Review',
          reviewBody: r.verdict,
          author: { '@type': 'Organization', name: 'Frank', url: 'https://chrisputer.tech' },
          ...(r.rating != null ? { reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 0 } } : {}),
        };
      }
      item.url = `https://chrisputer.tech/research/${r.slug}`;
      return { '@type': 'ListItem', position: offset + i + 1, item };
    }),
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://chrisputer.tech/' },
      { '@type': 'ListItem', position: 2, name: 'Reviews', item: 'https://chrisputer.tech/reviews' },
    ],
  };

  // SEO: only the base listing and a single-category listing are indexable.
  // Every further facet combination (brand/price/rating/keyword/sort) is
  // noindex,follow and canonicals up to the nearest indexable parent — this is
  // the standard defense against faceted-navigation index bloat (a 192-category
  // × 570-brand × 7-price × 3-rating space is millions of thin URLs otherwise).
  // Pagination alone (page>1, no other facet) stays indexable: Google treats a
  // page left noindex long term as nofollow too, which would eventually cut
  // the crawl path pagination exists to build. Each such page gets its OWN
  // self-referencing canonical (not page 1's), so it is a genuine, distinct,
  // crawlable page rather than deferring to page 1.
  const narrowed = isNarrowed(filters);
  const facetsNarrowed = !!(filters.brand || filters.price || filters.pmin != null || filters.pmax != null
    || filters.rating || filters.q || (filters.sort && filters.sort !== 'featured'));
  const canonical = facetsNarrowed
    ? `https://chrisputer.tech${reviewsHref({ category: filters.category })}`
    : `https://chrisputer.tech${reviewsHref(filters, { page: filters.page })}`;
  const prevLink = (!facetsNarrowed && filters.page > 1)
    ? `<link rel="prev" href="https://chrisputer.tech${reviewsHref(filters, { page: filters.page - 1 })}">` : '';
  const nextLink = (!facetsNarrowed && filters.page < totalPages)
    ? `<link rel="next" href="https://chrisputer.tech${reviewsHref(filters, { page: filters.page + 1 })}">` : '';
  const imgWireScript = `<script nonce="__CSP_NONCE__">
(function(){
  document.querySelectorAll('.item-image-photo').forEach(function(img){
    img.addEventListener('error',function(){
      img.hidden=true;
      var fb=img.nextElementSibling;
      if(fb&&fb.classList.contains('item-image-fallback'))fb.hidden=false;
    });
  });
})();
</script>`;
  const desc = categoryOnly
    ? `Honest reviews of ${filters.category} — ratings, pros and cons, and verdicts synthesized from real user reviews. No paid placements.`
    : 'Every product Frank has reviewed, filterable by category, brand, price, and rating. Honest ratings, pros and cons, and verdicts synthesized from real user reviews. No paid placements.';
  const reviewsListBoot = reviewListItems.length > 0
    ? listLayoutBoot({ dataId: 'reviews-list-data', containerId: 'reviews-list', kind: 'review' })
    : '';
  return layout(heading, desc, body,
    prevLink + nextLink + jsonLdScript(itemListLd) + jsonLdScript(breadcrumbLd) + imgWireScript + reviewsListBoot,
    { canonical, noindex: narrowed });
}
