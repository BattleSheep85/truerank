// Product-card renderers for the research report page: the at-a-glance
// comparison table, the full product cards, and the "Our pick" + "Why trust
// this" panels. Split out of research-page.js verbatim so that file stays
// under the file-size cap.

import { html } from '../lib/html.js';
import { escapeHtml, isValidHttpsUrl, parseJsonSafe } from '../lib/utils.js';
import { resolveProductCtas, starMarkup, renderItemImage, renderMetadataPairs, freshnessLabel } from './research-primitives.js';

// At-a-glance comparison TABLE — a scannable, server-rendered side-by-side of
// every ranked pick with a Buy column, shown above the long detail cards. SSR
// (crawlable + no-JS safe + AI-answer-extractable) and a second cluster of
// above-the-fold affiliate CTAs. Reuses resolveProductCtas so each Buy link is
// byte-identical to the matching product card / Our-pick CTA.
export function renderComparisonTable(products, ids, isService, slug, cleanLinks, webOnly) {
  if (!Array.isArray(products) || products.length < 2) return '';
  const anyPrice = products.some((p) => p.price != null);
  const muted = '<span class="text-ink-3">&mdash;</span>';
  const rows = products.map((p, i) => {
    const ctas = resolveProductCtas(p, ids, isService, slug, cleanLinks, webOnly);
    const a = ctas.amazon, r = ctas.retailer, g = ctas.google;
    const buyCls = 'inline-block whitespace-nowrap bg-accent-strong px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-white hover:bg-accent-hover';
    let buy = muted;
    if (a.url && isValidHttpsUrl(a.url)) {
      buy = `<a href="${escapeHtml(a.href)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="${buyCls}">${escapeHtml(a.label)}</a>`;
    } else if (r.url && isValidHttpsUrl(r.url)) {
      buy = `<a href="${escapeHtml(r.url)}" target="_blank" rel="${r.rel}" class="${buyCls}">${escapeHtml(r.label)}</a>`;
    } else if (g.url) {
      buy = `<a href="${escapeHtml(g.url)}" class="${buyCls}">${escapeHtml(g.label)}</a>`;
    }
    const rating = p.rating != null
      ? `<span class="whitespace-nowrap"><span aria-hidden="true">${starMarkup(p.rating)}</span> <span class="readout">${escapeHtml(String(p.rating))}/5</span></span>`
      : muted;
    const price = p.price != null ? `<span class="readout">$${p.price.toLocaleString()}</span>` : muted;
    const bestFor = p.best_for ? escapeHtml(String(p.best_for).slice(0, 90)) : muted;
    const rankCell = p.rank != null ? `#${escapeHtml(String(p.rank))}` : String(i + 1);
    return `<tr class="border-t border-line align-top hover:bg-surface-1">
<td class="px-4 py-3.5 font-mono font-bold text-ink readout">${rankCell}</td>
<th scope="row" class="px-4 py-3.5 text-left font-semibold text-ink"><a href="#product-${i + 1}" class="border-b border-dotted border-ink-3 hover:text-accent hover:border-accent">${escapeHtml(p.name)}</a>${p.brand ? `<span class="block font-mono text-[11px] font-normal text-ink-3">${escapeHtml(p.brand)}</span>` : ''}</th>
<td class="px-4 py-3.5">${rating}</td>
${anyPrice ? `<td class="whitespace-nowrap px-4 py-3.5">${price}</td>` : ''}
<td class="px-4 py-3.5">${bestFor}</td>
<td class="px-4 py-3.5">${buy}</td>
</tr>`;
  }).join('');
  return `<section class="compare-section mt-8">
<h2 id="compare" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">${isService ? 'At a glance' : `Compare all ${products.length}`}</h2>
<div class="mt-4 overflow-x-auto border border-line">
<table class="w-full min-w-[36rem] border-collapse font-mono text-xs">
<caption class="sr-only">Side-by-side comparison of all ${products.length} ranked picks with ratings${anyPrice ? ', price,' : ''} and where to buy.</caption>
<thead><tr class="border-b border-line bg-surface-2 text-left uppercase tracking-wide text-ink-3">
<th scope="col" class="px-4 py-3 font-medium">#</th>
<th scope="col" class="px-4 py-3 font-medium">Product</th>
<th scope="col" class="px-4 py-3 font-medium">Rating</th>
${anyPrice ? '<th scope="col" class="px-4 py-3 font-medium">Price</th>' : ''}
<th scope="col" class="px-4 py-3 font-medium">Best for</th>
<th scope="col" class="px-4 py-3 font-medium">Where to buy</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
</section>`;
}

// `p` arrives with pros/cons/specs/metadata already parsed (see
// renderResearchResult — the JSON columns are parsed exactly once after fetch).
const RANK_BADGE_CLASS = {
  1: 'border-trust-medium text-trust-medium',
  2: 'border-line-strong text-ink-2',
  3: 'border-trust-medium/60 text-trust-medium',
};

export function renderProduct(p, index, ids, isService, slug, cleanLinks, webOnly) {
  const { pros, cons, specs, metadata } = p;
  const rankBadgeClass = RANK_BADGE_CLASS[p.rank] || 'border-line text-ink-3';

  // CTAs per product:
  //   1. amazonCta — BIG full-width button at the card bottom. Exact /dp/ URL
  //      → "Buy on Amazon"; no exact match → explicit "Search Amazon". Hidden
  //      for services/web-only categories and clean-link renders.
  //   2. googleCta — replaces the Amazon button for categories Amazon doesn't
  //      sell; internal /find hand-off (302-redirects to a Google search).
  //   3. retailerCta — small pill in the links row. Non-Amazon retailers only
  //      (Walmart, Best Buy, etc.) so we don't duplicate the Amazon button.
  const ctas = resolveProductCtas(p, ids, isService, slug, cleanLinks, webOnly);
  const mfrUrl = ctas.mfrUrl;
  const retailerCtaUrl = ctas.retailer.url;
  const retailerCtaLabel = ctas.retailer.label;
  const retailerCtaRel = ctas.retailer.rel;
  const retailerCtaIsSponsored = ctas.retailer.isSponsored;
  const amazonCtaUrl = ctas.amazon.url;
  const amazonCtaLabel = ctas.amazon.label;
  const amazonCtaHref = ctas.amazon.href;

  const prosHtml = pros.map((pr) => html`<li class="relative pl-4 before:absolute before:left-0 before:font-bold before:text-trust-high before:content-['✓']">${pr}</li>`).join('');
  const consHtml = cons.map((c) => html`<li class="relative pl-4 before:absolute before:left-0 before:font-bold before:text-trust-low before:content-['✕']">${c}</li>`).join('');
  const specsHtml = Object.entries(specs).map(([k, v]) => html`<dt class="text-ink-3">${k}</dt><dd class="text-ink-2">${v}</dd>`).join('');

  // Secondary links row: manufacturer page + non-Amazon retailers (Walmart, etc.).
  const links = [];
  const linkClsBase = 'inline-flex items-center gap-1 border px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide';
  const linkClsMfr = `${linkClsBase} border-line-strong text-ink-2 hover:border-ink-3 hover:text-ink`;
  const linkClsBuy = `${linkClsBase} border-accent-strong bg-accent-strong text-white hover:bg-accent-hover hover:border-accent-hover`;
  if (mfrUrl && !(isService && retailerCtaUrl === mfrUrl)) {
    links.push(`<a href="${escapeHtml(mfrUrl)}" target="_blank" rel="noopener noreferrer" class="${linkClsMfr}">Product page <span aria-hidden="true">&#8599;</span></a>`);
  }
  if (retailerCtaUrl && isValidHttpsUrl(retailerCtaUrl)) {
    const cls = retailerCtaIsSponsored ? linkClsBuy : linkClsMfr;
    links.push(`<a href="${escapeHtml(retailerCtaUrl)}" target="_blank" rel="${retailerCtaRel}" class="${cls}">${escapeHtml(retailerCtaLabel)} <span aria-hidden="true">&#8599;</span></a>`);
  }

  // Primary CTA: full-width button at the very bottom of the card. Amazon when
  // the category is Amazon-viable (click-tracked href resolved in
  // resolveProductCtas, shared with Our pick); the /find Google hand-off when
  // it isn't. Never both.
  const ctaCls = 'product-cta-amazon mt-4 flex w-full items-center justify-center gap-2 bg-accent-strong px-4 py-3 font-mono text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover';
  let amazonCtaBlock = '';
  if (amazonCtaUrl && isValidHttpsUrl(amazonCtaUrl)) {
    amazonCtaBlock = `<a href="${escapeHtml(amazonCtaHref)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="${ctaCls}">${escapeHtml(amazonCtaLabel)} <span aria-hidden="true">&#8599;</span></a>`;
  } else if (ctas.google.url) {
    amazonCtaBlock = `<a href="${escapeHtml(ctas.google.url)}" class="${ctaCls}">${escapeHtml(ctas.google.label)} <span aria-hidden="true">&#8599;</span></a>`;
  }

  const imageBlock = renderItemImage(p.image_url, p.name, p.id);
  const metadataBlock = renderMetadataPairs(metadata);

  return `<article class="product border border-line bg-surface-1 p-5" id="product-${index + 1}">
${imageBlock}
<div class="flex items-start justify-between gap-4">
<div>
${p.rank != null ? `<span class="inline-block border ${rankBadgeClass} px-2 py-0.5 font-mono text-xs font-bold readout">#${p.rank}</span>` : ''}
<h3 class="wrap-anywhere mt-1.5 font-sans text-lg font-bold text-ink">${escapeHtml(p.name)}</h3>
${p.brand ? `<p class="font-mono text-xs text-ink-2">${escapeHtml(p.brand)}</p>` : ''}
</div>
<div class="shrink-0 text-right">
${p.price != null ? `<p class="readout font-mono text-2xl font-bold text-ink">$${p.price.toLocaleString()}</p>` : ''}
${p.rating != null ? `<p class="mt-1 font-mono text-xs text-trust-medium"><span aria-hidden="true">${starMarkup(p.rating)}</span> <span class="readout">${p.rating}/5</span></p>` : ''}
</div>
</div>
${p.best_for ? `<div class="mt-3 border-l-2 border-accent bg-accent-quiet px-3 py-2 font-mono text-[11px] text-ink-2"><span class="uppercase tracking-wide text-ink-3">Best for</span> ${escapeHtml(p.best_for)}</div>` : ''}
${ratingNote(p, cons)}
${metadataBlock}
${p.verdict ? `<p class="mt-3 text-body-sm leading-relaxed text-ink-2">${escapeHtml(p.verdict)}</p>` : ''}
${criticalReviewsBlock(p, cons)}
${(pros.length > 0 || (cons.length > 0 && !isBelow4(p))) ? `<div class="mt-4 grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2">
${pros.length > 0 ? `<div><h4 class="font-mono text-[11px] font-semibold uppercase tracking-wide text-trust-high">Pros</h4><ul class="mt-2 space-y-1.5 text-body-sm text-ink-2">${prosHtml}</ul></div>` : ''}
${(cons.length > 0 && !isBelow4(p)) ? `<div><h4 class="font-mono text-[11px] font-semibold uppercase tracking-wide text-trust-low">Cons</h4><ul class="mt-2 space-y-1.5 text-body-sm text-ink-2">${consHtml}</ul></div>` : ''}
</div>` : ''}
${specsHtml ? `<details class="mt-4 border-t border-line pt-3"><summary class="cursor-pointer font-mono text-xs font-medium uppercase tracking-wide text-ink-3">Specifications</summary>
<dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 bg-surface-2 p-3 font-mono text-[11px]">${specsHtml}</dl></details>` : ''}
${links.length > 0 ? `<div class="mt-4 flex flex-wrap gap-2">${links.join('')}</div>` : ''}
${amazonCtaBlock}
</article>`;
}

// A one-line, plain-English explanation of WHY a product earned its rating — so a
// score (especially a low one) never appears without its reason. Built at render
// time from the rating band + the top con, so it works for BOTH the extraction
// engine and the live synth output. Honest about thin evidence (null rating).
function ratingNote(p, cons) {
  if (p.rating == null) {
    return `<p class="rating-why mt-2 font-mono text-[11px] text-ink-3">Not enough independent reviews to score this confidently — shown for context, not as a strong pick.</p>`;
  }
  const r = Number(p.rating);
  const con = (cons && cons[0]) ? String(cons[0]).replace(/^[\s"'“”]+|[\s"'“”.]+$/g, '') : '';
  let lead;
  if (r >= 4.5) lead = 'Strong, consistent praise across our credible sources';
  else if (r >= 4) lead = 'Well-reviewed overall, with only minor trade-offs';
  else if (r >= 3.5) lead = 'A solid, usable pick — but not the best in its class';
  else if (r >= 3) lead = 'Recommended only if it fits a specific need';
  else lead = 'Low marks from reviewers — included only because it suits a particular need';
  const why = con
    ? ` Main caveat reviewers raised: ${escapeHtml(con)}.`
    : (r >= 4.5 ? ' No recurring complaint surfaced in our sources.' : '');
  return `<p class="rating-why mt-2 font-mono text-[11px] leading-relaxed text-ink-3"><strong class="font-semibold text-ink">Why ${escapeHtml(String(r))}/5:</strong> ${escapeHtml(lead)}.${why}</p>`;
}

// A buyer often won't purchase a sub-4★ pick WITHOUT reading the actual criticism
// first (real user feedback). For products rated below 4 (or unrated) we surface the
// critical points PROMINENTLY and framed as "here's why some passed — judge for
// yourself"; when no credible criticism was found we say so honestly instead of
// hiding the gap. Render-time, so it works for both the extraction + synth output.
function isBelow4(p) { return p.rating != null && Number(p.rating) < 4; }
function criticalReviewsBlock(p, cons) {
  const r = p.rating == null ? null : Number(p.rating);
  if (r != null && r >= 4) return ''; // 4★+ : criticism stays in the normal Cons grid
  // cons[0] is already surfaced directly above by ratingNote() as the "main
  // caveat" — list the REMAINING criticism here so the top con doesn't print
  // twice within a few lines.
  const rest = (cons || []).slice(1);
  const items = rest.map((c) => `<li class="text-body-sm text-ink">${escapeHtml(String(c))}</li>`).join('');
  const intro = r == null
    ? 'We didn’t find enough independent reviews to score this confidently — read the criticism we did find before buying:'
    : 'This scores below 4★. Here’s the criticism reviewers actually raised — read it and decide whether any of it is a dealbreaker for you:';
  const introCls = 'mb-2 text-body-sm leading-relaxed text-ink-2';
  const quotes = criticalQuotesHtml(p.critical_reviews);
  const consHtml = items
    ? `<p class="${introCls}">${quotes ? 'Other criticism we found:' : intro}</p><ul class="crit-list flex flex-col gap-1.5 pl-4 [&>li]:list-disc">${items}</ul>`
    : '';
  const fallback = (cons || []).length
    ? `<p class="${introCls}">The main caveat reviewers raised is noted above. We didn’t surface additional specific criticism — read recent buyer reviews before purchasing.</p>`
    : `<p class="${introCls}">This scores below 4★ and we couldn’t surface specific, credible criticism — treat the rating cautiously and read recent buyer reviews before purchasing.</p>`;
  const body = quotes
    ? `<p class="${introCls}">${intro}</p>${quotes}${consHtml ? `<div class="mt-3">${consHtml}</div>` : ''}`
    : (consHtml || fallback);
  return `<section class="critical-reviews mt-4 border border-trust-low bg-trust-low-bg p-4" aria-label="Critical reviews">
<h4 class="crit-head flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-trust-low"><span aria-hidden="true">&#9888;</span> Why some reviewers rated it low</h4>
<div class="mt-2">${body}</div></section>`;
}

// CP-399: verbatim 1-2★ review quotes, each with its star count and a link to its source.
function criticalQuotesHtml(list) {
  const safe = (Array.isArray(list) ? list : [])
    .filter((q) => q && typeof q.quote === 'string' && q.quote.trim() && typeof q.sourceUrl === 'string' && isValidHttpsUrl(q.sourceUrl));
  if (!safe.length) return '';
  const items = safe.map((q) => {
    const label = (typeof q.sourceTitle === 'string' && q.sourceTitle.trim()) || new URL(q.sourceUrl).hostname.replace(/^www\./, '');
    const stars = Number.isFinite(Number(q.stars)) ? `${Number(q.stars)}/5` : '';
    return `<li class="crit-quote border-l-2 border-trust-low pl-4">
<blockquote class="text-body-sm italic leading-relaxed text-ink">“${escapeHtml(q.quote.trim())}”</blockquote>
<p class="mt-1 font-mono text-[11px] text-ink-3">${stars ? `<span class="readout text-trust-low">${stars}</span> · ` : ''}<a href="${escapeHtml(q.sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow" class="text-accent hover:text-accent-hover">${escapeHtml(label)}</a></p>
</li>`;
  }).join('');
  return `<ul class="crit-quotes flex flex-col gap-2">${items}</ul>`;
}

// "Our pick" box: a high-visibility card for the rank-1 product, shown above the
// fold (right after the summary, before the top ad) so the answer beats the ad.
// Reuses resolveProductCtas so the CTA is byte-identical to the product card's.
// lastCheckedTs (epoch seconds, may be null) drives the "Prices checked ___"
// freshness readout directly above the CTA.
export function renderOurPick(p, ids, isService, slug, cleanLinks, webOnly, lastCheckedTs) {
  if (!p) return '';
  const ctas = resolveProductCtas(p, ids, isService, slug, cleanLinks, webOnly);
  const ratingHtml = p.rating != null
    ? `<span class="ourpick-rating inline-flex items-center gap-1.5 font-mono text-sm text-trust-medium"><span aria-hidden="true">${starMarkup(p.rating)}</span> <span class="readout text-ink-2">${p.rating}/5</span></span>`
    : '';
  const priceHtml = p.price != null ? `<span class="ourpick-price readout font-mono text-lg font-bold text-ink">$${p.price.toLocaleString()}</span>` : '';
  const a = ctas.amazon;
  const r = ctas.retailer;
  // Prefer the Amazon button (matches the card's primary CTA); fall back to the
  // retailer/service pill so services and non-Amazon picks still get a CTA.
  const ctaCls = 'product-cta-amazon ourpick-cta mt-4 inline-flex max-w-sm items-center justify-center gap-2 bg-accent-strong px-4 py-3 font-mono text-sm font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover';
  let ctaHtml = '';
  if (a.url && isValidHttpsUrl(a.url)) {
    ctaHtml = `<a href="${escapeHtml(a.href)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="${ctaCls}">${escapeHtml(a.label)} <span aria-hidden="true">&#8599;</span></a>`;
  } else if (r.url && isValidHttpsUrl(r.url)) {
    ctaHtml = `<a href="${escapeHtml(r.url)}" target="_blank" rel="${r.rel}" class="${ctaCls}">${escapeHtml(r.label)} <span aria-hidden="true">&#8599;</span></a>`;
  } else if (ctas.google.url) {
    ctaHtml = `<a href="${escapeHtml(ctas.google.url)}" class="${ctaCls}">${escapeHtml(ctas.google.label)} <span aria-hidden="true">&#8599;</span></a>`;
  }
  const freshness = freshnessLabel(lastCheckedTs);
  const freshnessHtml = freshness.text
    ? `<div class="ourpick-freshness mt-4 font-mono text-[11px] uppercase tracking-widest ${freshness.isStale ? 'text-trust-low' : 'text-trust-high'}">Prices checked ${freshness.text}</div>`
    : '';
  return `<div class="ourpick-box mt-6 border-2 border-trust-medium bg-surface-1 p-6" id="our-pick">
<div class="ourpick-eyebrow font-mono text-[11px] font-semibold uppercase tracking-widest text-trust-medium">Frank's pick</div>
<h2 class="ourpick-name wrap-anywhere mt-2 font-serif text-h3 font-semibold text-ink">${escapeHtml(p.name)}</h2>
${(ratingHtml || priceHtml) ? `<div class="ourpick-meta mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">${ratingHtml}${priceHtml}</div>` : ''}
${ratingNote(p, Array.isArray(p.cons) ? p.cons : [])}
${p.verdict ? `<p class="ourpick-verdict mt-3 text-body leading-relaxed text-ink-2">${escapeHtml(p.verdict)}</p>` : ''}
${isBelow4(p) ? criticalReviewsBlock(p, Array.isArray(p.cons) ? p.cons : []) : ''}
${freshnessHtml ? `${freshnessHtml}\n` : ''}${ctaHtml}
</div>`;
}

// Tally credibility signals across the sources JSON for the "Why trust this"
// E-E-A-T panel. Sources persist as either plain URL strings (legacy: no
// credibility object → degrade to a bare count) or {url, credibility:{tags,...}}
// objects (engine port). Parse defensively; never throw on malformed rows.
function summarizeSourceCredibility(rawSources) {
  const arr = parseJsonSafe(rawSources, []);
  const list = Array.isArray(arr) ? arr : [];
  const stats = { total: 0, handsOn: 0, expert: 0, community: 0, downWeighted: 0, hasCredibility: false };
  for (const s of list) {
    if (!s) continue;
    stats.total++;
    // Credibility tags may live on s.credibility.tags, s.tags, or be absent.
    const cred = (s && typeof s === 'object') ? (s.credibility || s) : null;
    const tags = cred && Array.isArray(cred.tags) ? cred.tags : null;
    if (!tags) continue;
    stats.hasCredibility = true;
    const lower = tags.map((t) => String(t).toLowerCase());
    if (lower.some((t) => t.includes('hands-on'))) stats.handsOn++;
    if (lower.some((t) => t.includes('expert-domain') || t.includes('expert'))) stats.expert++;
    if (lower.some((t) => t.includes('community'))) stats.community++;
    if (lower.some((t) => t.includes('affiliate-conflict') || t.includes('listicle') || t.includes('ai-injection'))) stats.downWeighted++;
  }
  return stats;
}

// Quiet bordered E-E-A-T panel computed entirely from row data. Sits between the
// summary/Our-pick area and the buyer's guide: that is where a skeptical reader
// pauses before the recommendations, so the trust signal lands before the picks
// rather than buried near the sources footer.
export function renderTrustPanel(rawSources, completedAtTs) {
  const s = summarizeSourceCredibility(rawSources);
  if (s.total === 0) return '';
  const dateLabel = completedAtTs
    ? new Date(completedAtTs * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  const dateIso = completedAtTs ? new Date(completedAtTs * 1000).toISOString().slice(0, 10) : '';
  const chipCls = 'trust-chip inline-flex items-center gap-1 border border-line-strong px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-ink-2';
  const chipWarnCls = 'trust-chip trust-chip-warn inline-flex items-center gap-1 border border-trust-medium bg-trust-medium-bg px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-trust-medium';
  const chips = [];
  chips.push(`<span class="${chipCls}"><strong class="readout text-ink">${s.total}</strong> source${s.total === 1 ? '' : 's'} analyzed</span>`);
  if (s.hasCredibility) {
    if (s.handsOn > 0) chips.push(`<span class="${chipCls}"><strong class="readout text-ink">${s.handsOn}</strong> hands-on</span>`);
    if (s.expert > 0) chips.push(`<span class="${chipCls}"><strong class="readout text-ink">${s.expert}</strong> expert</span>`);
    if (s.community > 0) chips.push(`<span class="${chipCls}"><strong class="readout text-ink">${s.community}</strong> community</span>`);
    if (s.downWeighted > 0) chips.push(`<span class="${chipWarnCls}"><strong class="readout">${s.downWeighted}</strong> down-weighted</span>`);
  }
  return `<aside class="trust-panel mt-6 border border-line bg-surface-1 p-5" aria-label="Why trust this">
<div class="trust-panel-head font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-3">Why trust this</div>
<div class="trust-chips mt-3 flex flex-wrap gap-2">${chips.join('')}</div>
${dateLabel ? `<p class="trust-panel-date mt-3 font-mono text-[11px] text-ink-3">Synthesized <time datetime="${dateIso}">${escapeHtml(dateLabel)}</time>${s.hasCredibility ? '' : ' &middot; legacy report (no per-source credibility data)'}</p>` : ''}
<p class="trust-panel-disclosure mt-2 font-mono text-[10.5px] leading-relaxed text-ink-3">We may earn a commission on purchases made through links on this page. Rankings are produced from independent source analysis and are never paid placements.</p>
</aside>`;
}
