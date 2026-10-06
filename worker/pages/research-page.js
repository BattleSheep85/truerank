import { layout } from '../lib/html.js';
import { parseJsonSafe, isValidHttpsUrl, escapeHtml, timeAgo, displayQuery, safeUserFacingError } from '../lib/utils.js';
import { resolveAmazonTag } from '../lib/affiliate-links.js';
import { adSlot } from '../lib/ads.js';
import { getResearchBySlug, getProductsByResearchId, getClusterWinnerSlug } from '../lib/db.js';
import { searchBar } from '../lib/search-bar.js';
import { RESEARCH_ETA } from '../lib/engine-config.js';
import { jsonEmbed, productLayoutBoot } from '../lib/list-layout-boot.js';
import { BTN_PRIMARY, isNonProductCategory, sourceRel, sourceLabel } from './research-primitives.js';
import { renderComparisonTable, renderProduct, renderOurPick, renderTrustPanel } from './research-cards.js';
import { pageBehaviorScript, activityFeedScript, subscribeScript, chatScript } from './research-scripts.js';
import { buildResearchSeo } from './research-jsonld.js';

// Find up to 5 sibling research pages that share canonical tokens. Used to build
// the "Related research" block — internal links Google rewards for topical depth,
// and a browse nudge for users who land on a page from search.
async function getRelatedResearch(db, currentSlug, canonical, category) {
  // Remote D1 rejects LIKE patterns over 50 bytes ("pattern too complex"), so
  // cap token length (the pattern adds 2 bytes of %). Also skip key:value
  // tokens that clarification-aware canonical queries embed — they are
  // metadata, not topic words, and only add noise to relatedness matching.
  const tokens = (canonical ?? '')
    .split(' ')
    .filter((t) => t.length > 1 && t.length <= 40 && !t.includes(':'))
    .slice(0, 8);
  if (tokens.length === 0) return [];

  const likeClauses = tokens.map((_, i) => `canonical_query LIKE ?${i + 2}`).join(' OR ');
  const sql = `SELECT slug, query, category, canonical_query, view_count, created_at
               FROM research
               WHERE status = 'complete'
                 AND research.retired_at IS NULL
                 AND slug != ?1
                 AND canonical_query IS NOT NULL
                 AND canonical_query != ?${tokens.length + 2}
                 AND EXISTS (SELECT 1 FROM products p WHERE p.research_id = research.id)
                 AND (${likeClauses})
               ORDER BY view_count DESC
               LIMIT 50`;

  const binds = [currentSlug, ...tokens.map((t) => `%${t}%`), canonical ?? ''];
  const rows = await db.prepare(sql).bind(...binds).all();
  const tokenSet = new Set(tokens);

  const scored = (rows.results ?? []).map((r) => {
    const otherTokens = new Set((r.canonical_query ?? '').split(' '));
    let shared = 0;
    for (const t of tokenSet) if (otherTokens.has(t)) shared++;
    const categoryBoost = category && r.category === category ? 1 : 0;
    return { ...r, score: shared * 2 + categoryBoost };
  });

  scored.sort((a, b) => (b.score - a.score) || (b.view_count - a.view_count));

  const seen = new Set();
  const deduped = [];
  for (const s of scored) {
    const key = s.canonical_query ?? s.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.score >= 2) deduped.push(s);
    if (deduped.length >= 5) break;
  }
  return deduped;
}

// Return shape (was `export interface RenderedResearch` in the TS source):
// { html: string, lastModified: number } — lastModified is Unix seconds, used
// for the HTTP Last-Modified header.

export async function renderResearchResult(slug, env, fromQuery = null, cleanLinks = false) {
  const entry = await getResearchBySlug(env.DB, slug);
  if (!entry) return new Response('Not found', { status: 404 });

  const isComplete = entry.status === 'complete';

  // The four post-entry queries are independent — fetch products, related
  // research, the cluster winner, and bump the view counter concurrently
  // instead of serializing.
  const [productRows, related, winnerSlug] = await Promise.all([
    getProductsByResearchId(env.DB, entry.id),
    isComplete ? getRelatedResearch(env.DB, slug, entry.canonical_query, entry.category) : Promise.resolve([]),
    isComplete ? getClusterWinnerSlug(env.DB, entry.canonical_query) : Promise.resolve(null),
    // Increment views only for completed research.
    isComplete
      ? env.DB.prepare('UPDATE research SET view_count = view_count + 1 WHERE id = ?').bind(entry.id).run()
      : Promise.resolve(),
  ]);

  // Parse each product's JSON columns ONCE here, so renderProduct and the
  // JSON-LD builder both consume already-parsed values (no double JSON.parse).
  const products = (productRows.results ?? []).map((p) => ({
    ...p,
    pros: parseJsonSafe(p.pros, []),
    cons: parseJsonSafe(p.cons, []),
    specs: parseJsonSafe(p.specs, {}),
    metadata: parseJsonSafe(p.metadata, {}),
  }));

  const hasProducts = products.length > 0;
  const isProcessing = entry.status === 'pending' || entry.status === 'processing';
  const isLiveReport = entry.status === 'complete' || (isProcessing && hasProducts);
  const showProcessingHero = isProcessing && !hasProducts;
  const isFailed = entry.status === 'failed';

  const resultData = parseJsonSafe(entry.result, {});
  // Only surface a stored failure reason if it's a clean, short, user-facing
  // message (e.g. "No reliable products found for this query."). Raw provider /
  // HTTP / JSON errors (e.g. an OpenRouter 403) must never leak to users.
  const failReason = safeUserFacingError(resultData.error, '');
  const buyersGuide = resultData.buyersGuide;
  const hasBuyersGuide = !!(buyersGuide && (buyersGuide.howToChoose || (buyersGuide.pitfalls?.length ?? 0) > 0 || (buyersGuide.marketingToIgnore?.length ?? 0) > 0));
  // Classifier verdict: this category isn't sold on Amazon (lumber, vehicles,
  // local venues, ...). Suppresses every Amazon link on the page; CTAs hand
  // off to Google via /find instead. Legacy rows without the facet default to
  // Amazon-viable.
  const rowFacets = parseJsonSafe(entry.facets, {}) || {};
  const webOnly = rowFacets.sold_on_amazon === false;
  // Service detection must mirror the orchestrator's ASIN-resolution gate
  // (is_service facet) — the category-string heuristic alone misses services
  // whose category label isn't in the hints list (e.g. "wedding photographer"),
  // which would render Amazon CTAs for a hire-a-professional page.
  const isService = isNonProductCategory(entry.category) || rowFacets.is_service === true;
  // sources persist as either plain URL strings (legacy) or {url, credibility}
  // objects (engine port). Normalize to the URL string for rendering.
  const sourceList = parseJsonSafe(entry.sources, [])
    .map((s) => (typeof s === 'string' ? s : s && typeof s.url === 'string' ? s.url : ''))
    .filter(isValidHttpsUrl);
  const clarifications = parseJsonSafe(entry.clarifications, {});

  const date = new Date(entry.created_at * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const createdIso = new Date(entry.created_at * 1000).toISOString().slice(0, 10);
  const lastModifiedTs = entry.completed_at ?? entry.created_at;
  const lastUpdatedLabel = new Date(lastModifiedTs * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lastUpdatedIso = new Date(lastModifiedTs * 1000).toISOString().slice(0, 10);
  // cleanLinks: strip ALL affiliate IDs for this render. Used when the page is
  // being linked from a community that prohibits affiliate URLs (e.g. Reddit).
  // Known retailer URLs still render as buy CTAs; they just go to the plain
  // retailer page instead of the tagged/redirect affiliate version.
  const affiliateIds = cleanLinks
    ? { amazonTag: '' }
    : {
        amazonTag: resolveAmazonTag(env),
        walmartImpact: env.WALMART_IMPACT_ID || undefined,
        targetImpact: env.IMPACT_TARGET_ID || undefined,
        bestbuyImpact: env.IMPACT_BESTBUY_ID || undefined,
        neweggImpact: env.IMPACT_NEWEGG_ID || undefined,
        bhphoto: env.BHPHOTO_AFFILIATE_ID || undefined,
      };
  const pageUrl = `https://chrisputer.tech/research/${escapeHtml(slug)}`;
  // isWinner: this page is the winner of its canonical cluster (or a cluster
  // of one, winnerSlug === null). A non-winner keeps its own full readable
  // page (200, no noindex) but points its canonical + structured data at the
  // winner, so Google consolidates ranking signal onto one page instead of
  // treating two near-identical reports as competitors.
  const isWinner = !winnerSlug || winnerSlug === slug;
  const winnerUrl = isWinner ? pageUrl : `https://chrisputer.tech/research/${escapeHtml(winnerSlug)}`;
  const displayTitle = displayQuery(entry.query);
  const shareText = encodeURIComponent(displayTitle);
  const shareUrl = encodeURIComponent(pageUrl);

  const productListItems = products.map((p, i) => ({
    id: p.id,
    rank: p.rank ?? i + 1,
    name: p.name,
    price: p.price,
    rating: p.rating,
    best_for: p.best_for || '',
    href: `#product-${i + 1}`,
  }));

  const chatSection = `<section id="talk-about-it" class="report-chat-feature mt-6 border border-line border-l-2 border-l-accent bg-surface-1 p-5">
<div class="mb-3.5 flex flex-wrap items-start justify-between gap-3">
<div>
<span class="mb-1 inline-block font-mono text-[11px] font-bold uppercase tracking-widest text-accent">Interactive</span>
<h2 class="font-sans text-lg font-bold text-ink">Talk about this research</h2>
<p class="mt-1.5 max-w-xl text-body-sm text-ink-2">Ask follow-up questions about the ranking, or refine the search and rerun it with new constraints.</p>
</div>
</div>
<div class="mb-3.5 flex gap-2" role="tablist" aria-label="Chat mode">
<button type="button" id="chat-tab-ask" role="tab" aria-selected="true" aria-controls="chat-panel-ask" data-chat-tab="ask" class="border border-accent bg-accent-quiet px-3.5 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-accent">Ask about it</button>
<button type="button" id="chat-tab-refine" role="tab" aria-selected="false" aria-controls="chat-panel-refine" data-chat-tab="refine" class="border border-line px-3.5 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-2 hover:border-ink-3">Refine this search</button>
</div>
<div class="chat-panel border border-line bg-bg p-4">
<div id="chat-messages" class="mb-3 flex max-h-64 flex-col gap-2.5 overflow-y-auto" aria-live="polite"></div>
<form id="chat-form" class="m-0 flex gap-2">
<label for="chat-input" class="sr-only">Your message</label>
<input id="chat-input" type="text" maxlength="2000" autocomplete="off" placeholder="e.g. Which one is best for a small apartment?" class="min-w-0 flex-1 border border-line bg-surface-1 px-3 py-2.5 font-mono text-sm text-ink placeholder:text-ink-3">
<button type="submit" class="${BTN_PRIMARY} whitespace-nowrap text-sm">Send</button>
</form>
<p id="chat-status" role="status" aria-live="polite" class="mt-2 min-h-[1em] text-xs text-ink-3"></p>
</div>
</section>`;

  const body = `<div class="grid-bg border-b border-line">
<div class="mx-auto max-w-4xl px-6 py-12">
<nav aria-label="Breadcrumb" class="breadcrumb mb-4 font-mono text-[11px] uppercase tracking-widest text-ink-3">
<a href="/" class="hover:text-ink">Home</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<a href="/research" class="hover:text-ink">Research</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<span class="text-ink-2">${escapeHtml(displayTitle)}</span>
</nav>
<div class="page-header">
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Ledger &middot; Ranked comparison report</p>
<h1 class="mt-3 font-serif text-h1 font-semibold text-ink">${escapeHtml(displayTitle)}</h1>
${entry.category ? `<span class="card-badge mt-3 inline-block">${escapeHtml(entry.category)}</span>` : ''}
${!isWinner ? `<div class="mt-4 border border-line bg-surface-1 px-4 py-3 text-body-sm text-ink-2">A newer report answers this question. <a href="${winnerUrl}" class="underline hover:text-ink">Read the current version</a>.</div>` : ''}
<div class="mt-4 border border-line bg-surface-1 px-4 py-3 text-body-sm text-ink-2">Frank wrote this from real reviews he read himself, not a human editor. <a href="/how-it-works" class="underline hover:text-ink">See how Frank works</a>.</div>
<div class="page-meta mt-4 flex flex-wrap gap-4 font-mono text-[13px] text-ink-3 readout">
<span>Published <time datetime="${createdIso}">${date}</time></span>
${entry.completed_at && entry.completed_at !== entry.created_at ? `<span>Last updated <time datetime="${lastUpdatedIso}">${lastUpdatedLabel}</time></span>` : ''}
<span>${entry.view_count} views</span>
<span>${products.length === 0 ? 'No products found' : `${products.length} product${products.length === 1 ? '' : 's'} compared`}</span>
</div>
${isLiveReport ? `<div class="share-bar mt-4 flex flex-wrap items-center gap-2">
<span class="font-mono text-xs uppercase tracking-wide text-ink-3">Share:</span>
<a href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" target="_blank" rel="noopener noreferrer" class="share-btn"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Post</a>
<a href="https://reddit.com/submit?url=${shareUrl}&title=${shareText}" target="_blank" rel="noopener noreferrer" class="share-btn"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 000-.463.327.327 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.095z"/></svg>Reddit</a>
<button type="button" class="share-btn js-copy-link" data-url="${pageUrl}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>Copy link</button>
<button type="button" class="share-btn js-native-share hidden" data-url="${pageUrl}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>Share</button>
<form action="/research/new" method="POST" class="m-0 inline-block"><input type="hidden" name="q" value="${escapeHtml(entry.query)}"><input type="hidden" name="fresh" value="1"><button type="submit" class="share-btn" title="Ignore the saved report and research this again from scratch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582M20 20v-5h-.581M5.635 9A8 8 0 0118.418 7M18.418 15A8 8 0 015.635 13"/></svg>Re-run fresh</button></form>
</div>` : ''}
</div>
</div>
</div>

<div class="container mx-auto max-w-4xl px-6 py-8">
${isProcessing && hasProducts ? `<div class="refreshing-note mb-5 flex items-center gap-2.5 border border-accent/30 bg-surface-1 px-4 py-3 font-mono text-xs text-ink-2"><div class="spinner" style="width:0.875rem;height:0.875rem;border-width:1.5px;margin:0;flex-shrink:0"></div><span>Refreshing this research in the background with latest data…</span></div>` : ''}

${fromQuery && fromQuery !== entry.query ? `<div class="cluster-banner mt-0 mb-5 flex flex-wrap items-center justify-between gap-3 border border-accent/30 bg-accent-quiet p-4">
<div class="min-w-0 flex-1 text-body-sm text-ink-2">
<strong class="text-ink">Matched to existing research.</strong> You asked &ldquo;${escapeHtml(fromQuery)}&rdquo; — we already researched a very similar question (${date}).
</div>
<form action="/research/new" method="POST" class="m-0"><input type="hidden" name="q" value="${escapeHtml(fromQuery)}"><input type="hidden" name="fresh" value="1"><button type="submit" class="${BTN_PRIMARY} whitespace-nowrap">Re-research with fresh data</button></form>
</div>` : ''}

${Object.keys(clarifications).length > 0 ? `<div class="clarifications-bar mt-5 border border-line bg-surface-1 p-4">
<div class="mb-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-3">Researched for</div>
<div class="flex flex-wrap gap-2">
${Object.entries(clarifications).map(([k, v]) => `<span class="card-badge"><strong class="text-ink">${escapeHtml(k.replace(/_/g, ' '))}:</strong> ${escapeHtml(v)}</span>`).join('')}
</div>
</div>` : ''}

${showProcessingHero ? `<div id="processing" class="my-8 border border-accent/30 bg-surface-1 p-6">
<div class="mb-4 flex items-center gap-3">
<div class="spinner" style="width:1.5rem;height:1.5rem;border-width:2px;margin:0;flex-shrink:0"></div>
<div>
<h2 class="font-sans text-lg font-semibold text-ink">Researching</h2>
<p class="font-mono text-xs text-ink-3" id="source-count">Starting...</p>
</div>
</div>
<ol id="progress-steps" class="progress-steps" aria-hidden="true">
<li class="progress-step is-active" data-step="0"><span class="progress-dot"></span><span>Searching</span></li>
<li class="progress-step" data-step="1"><span class="progress-dot"></span><span>Reading</span></li>
<li class="progress-step" data-step="2"><span class="progress-dot"></span><span>Ranking</span></li>
<li class="progress-step" data-step="3"><span class="progress-dot"></span><span>Writing</span></li>
</ol>
<div id="preview-box" class="mb-4 hidden border border-accent/25 bg-accent-quiet p-4">
<div class="mb-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-3">Quick answer &middot; from prior knowledge</div>
<div id="preview-text" class="whitespace-pre-wrap text-body-sm leading-relaxed text-ink-2"></div>
</div>
<div id="activity-feed" class="activity-feed"></div>
<div class="notify-box mt-5 border border-accent/25 bg-accent-quiet p-4">
<label for="notify-email" class="mb-2 block text-body-sm text-ink-2">This usually takes ${RESEARCH_ETA}. Want an email when it&rsquo;s ready?</label>
<form id="notify-form" class="m-0 flex flex-wrap gap-2">
<input id="notify-email" type="email" name="email" required placeholder="you@example.com" autocomplete="email" maxlength="254" class="min-w-[12rem] flex-1 border border-line bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3">
<button type="submit" class="${BTN_PRIMARY} whitespace-nowrap">Notify me</button>
</form>
<p id="notify-msg" role="status" aria-live="polite" class="mt-2 min-h-[1em] font-mono text-xs text-ink-3"></p>
</div>
</div>` : ''}

${isFailed ? `<div class="my-8 border border-trust-low/40 bg-trust-low-bg p-6">
<h2 class="font-sans text-lg font-semibold text-trust-low">Research failed</h2>
<p class="mt-2 text-body-sm text-ink-2">${failReason ? escapeHtml(failReason) : 'Something went wrong during analysis. This could be due to insufficient source data.'}</p>
<form method="POST" action="/research/new" class="mt-4"><input type="hidden" name="q" value="${escapeHtml(entry.query)}"><input type="hidden" name="fresh" value="1"><button type="submit" class="${BTN_PRIMARY}">Try again</button></form>
</div>` : ''}

${isLiveReport ? (() => {
  const tocItems = [];
  if (entry.summary) tocItems.push({ id: 'summary', label: 'Summary' });
  if (products.length > 1) tocItems.push({ id: 'compare', label: 'Compare' });
  tocItems.push({ id: 'talk-about-it', label: 'Ask or refine' });
  if (hasBuyersGuide) tocItems.push({ id: 'buyers-guide', label: "Buyer's guide" });
  if (products.length > 0) tocItems.push({ id: 'products', label: isService ? 'Recommendations' : 'Products compared' });
  if (resultData.methodology) tocItems.push({ id: 'methodology', label: 'Methodology' });
  if (sourceList.length > 0) tocItems.push({ id: 'sources', label: `Sources (${sourceList.length})` });
  if (related.length > 0) tocItems.push({ id: 'related', label: 'Related research' });
  if (tocItems.length < 3) return '';
  return `<nav class="toc my-6 border border-line bg-surface-1 p-4" aria-label="Table of contents">
<div class="mb-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-3">On this page</div>
<ul class="m-0 flex flex-wrap gap-x-3.5 gap-y-2 p-0 font-mono text-xs">${tocItems.map((t) => `<li class="list-none"><a href="#${t.id}" class="border-b border-dotted border-ink-3 text-ink-2 no-underline hover:border-accent hover:text-accent">${escapeHtml(t.label)}</a></li>`).join('')}</ul>
</nav>`;
})() : ''}

${entry.summary ? `<div class="summary-box border border-line bg-surface-1 p-5"><h2 id="summary" class="font-serif text-h3 font-semibold text-ink">Summary</h2><p class="mt-2 text-body leading-relaxed text-ink-2">${escapeHtml(entry.summary)}</p></div>` : ''}

${isLiveReport && products.length === 0 ? `<div class="my-8 border border-line bg-surface-1 p-6">
<h2 class="font-sans text-xl font-bold text-ink">No clear picks this time</h2>
<p class="mt-2 text-body-sm text-ink-2">We couldn't find enough trustworthy sources to confidently rank products for this query.</p>
<form method="POST" action="/research/new" class="mt-4"><input type="hidden" name="q" value="${escapeHtml(entry.query)}"><input type="hidden" name="fresh" value="1"><button type="submit" class="${BTN_PRIMARY}">Try again</button></form>
</div>` : ''}

${isLiveReport && products.length > 0 ? `<p class="affiliate-disclosure my-4 font-mono text-[11px] text-ink-3">We may earn an affiliate commission on qualifying purchases made through links on this page. Rankings remain independent and objective.</p>` : ''}

${isLiveReport && products.length > 0 ? renderOurPick(products.find((p) => p.rank === 1) || products[0], affiliateIds, isService, slug, cleanLinks, webOnly, lastModifiedTs) : ''}

${isLiveReport ? renderComparisonTable(products, affiliateIds, isService, slug, cleanLinks, webOnly) : ''}

${isLiveReport ? chatSection : ''}

${isLiveReport ? renderTrustPanel(entry.sources, entry.completed_at) : ''}

${isLiveReport ? adSlot(env, 'top', 'Advertisement') : ''}

${hasBuyersGuide && buyersGuide ? `<section class="buyers-guide mb-8 border border-line bg-surface-1 p-6">
<h2 id="buyers-guide" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Buyer's guide</h2>
${buyersGuide.howToChoose ? `<h3 class="mt-4 font-mono text-xs font-semibold uppercase tracking-wide text-ink">How to choose</h3>
<p class="mt-2 text-body-sm leading-relaxed text-ink-2">${escapeHtml(buyersGuide.howToChoose)}</p>` : ''}
${(buyersGuide.pitfalls?.length ?? 0) > 0 ? `<h3 class="mt-5 font-mono text-xs font-semibold uppercase tracking-wide text-trust-medium">Common pitfalls</h3>
<ul class="mt-2 list-disc space-y-1.5 pl-5 text-body-sm leading-relaxed text-ink-2">${buyersGuide.pitfalls.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
${(buyersGuide.marketingToIgnore?.length ?? 0) > 0 ? `<h3 class="mt-5 font-mono text-xs font-semibold uppercase tracking-wide text-trust-low">Marketing to ignore</h3>
<ul class="mt-2 list-disc space-y-1.5 pl-5 text-body-sm leading-relaxed text-ink-2">${buyersGuide.marketingToIgnore.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
</section>` : ''}

${products.length > 0 ? `<h2 id="products" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">${isService ? 'Recommendations' : 'Products compared'}</h2>
${(!isService && products.some((p) => p.price != null)) ? `<p class="mb-5 mt-2 font-mono text-[11px] text-ink-3">Prices were last checked ${new Date(lastModifiedTs * 1000).toISOString().split('T')[0]} and can change — confirm the current price at the retailer before buying.</p>` : ''}
${jsonEmbed('product-list-data', productListItems)}
<div id="product-list" class="mt-4"></div>
<div id="product-grid-detail" class="product-grid mt-4" style="display:none">${products.map((p, i) => {
  const card = renderProduct(p, i, affiliateIds, isService, slug, cleanLinks, webOnly);
  const midAd = (i === 2 && products.length >= 5) ? adSlot(env, 'mid', 'Advertisement') : '';
  return card + midAd;
}).join('')}</div>
${adSlot(env, 'bottom', 'Advertisement')}` : ''}

${(resultData.methodology || sourceList.length > 0) ? `<div class="sources mt-8 border-t border-line pt-6">
${resultData.methodology ? `<h2 id="methodology" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Methodology</h2><p class="mt-2 mb-4 text-body-sm leading-relaxed text-ink-2">${escapeHtml(resultData.methodology)}</p>` : ''}
${sourceList.length > 0 ? `<h2 id="sources" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Sources (${sourceList.length})</h2><div class="mt-3 space-y-1.5">${sourceList.map((u) => `<a href="${escapeHtml(u)}" target="_blank" rel="${sourceRel(u)}" class="block truncate font-mono text-xs text-accent hover:text-accent-hover">${escapeHtml(sourceLabel(u))}</a>`).join('')}</div>` : ''}
</div>` : ''}

${related.length > 0 ? `<section class="related-research mt-10 border-t border-line pt-6">
<h2 id="related" class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Related research</h2>
<div class="grid mt-4">${related.map((r) => `<a class="card" href="/research/${escapeHtml(r.slug)}">
${r.category ? `<div class="card-top"><span class="card-badge">${escapeHtml(r.category)}</span><span class="card-time">${timeAgo(r.created_at * 1000)}</span></div>` : `<div class="card-top"><span class="card-time">${timeAgo(r.created_at * 1000)}</span></div>`}
<h3>${escapeHtml(displayQuery(r.query))}</h3>
</a>`).join('')}</div>
</section>` : ''}

<div class="mt-10 border-t border-line pt-6">
<h2 class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Research something else</h2>
<div class="mt-4">${searchBar('compact')}</div>
</div>
${isLiveReport ? `<div class="notify-footer mt-8 border-t border-line pt-6">
<form id="notify-form" class="m-0 flex flex-wrap items-center gap-2">
<label for="notify-email" class="min-w-[14rem] flex-1 text-body-sm text-ink-2">Get notified when we re-research this category</label>
<input id="notify-email" type="email" name="email" required placeholder="you@example.com" autocomplete="email" maxlength="254" class="min-w-[12rem] flex-1 border border-line bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3">
<button type="submit" class="${BTN_PRIMARY} whitespace-nowrap">Notify me</button>
</form>
<p id="notify-msg" role="status" aria-live="polite" class="mt-2 min-h-[1em] font-mono text-xs text-ink-3"></p>
</div>` : ''}
</div>`;

  // Structured data and canonical/OG metadata all key off winnerUrl, not
  // pageUrl: winnerUrl === pageUrl for a cluster winner (or a cluster of
  // one), and points at the winning report for a non-winner. A canonical
  // link that disagrees with the JSON-LD url/@id is a mixed signal Google
  // may ignore entirely, so every one of these must agree.
  const { structuredData, layoutMeta } = buildResearchSeo({
    entry, products, affiliateIds, pageUrl: winnerUrl, displayTitle, lastModifiedTs, hasBuyersGuide, buyersGuide, isService,
  });

  const turnstileScript = env.TURNSTILE_SITE_KEY
    ? '<script nonce="__CSP_NONCE__" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
    : '';

  // Always-on wiring: copy-link buttons + image fallback swap on error. These
  // replace the old inline onclick/onerror handlers that nonce-based CSP
  // refuses to execute.
  const pageBehaviorHtml = pageBehaviorScript();
  const activityFeedHtml = activityFeedScript(slug);
  const subscribeHtml = subscribeScript(entry.id);
  const chatHtml = chatScript(slug);
  const extra = pageBehaviorHtml + subscribeHtml + (isLiveReport ? chatHtml : '') + (showProcessingHero ? activityFeedHtml : '') + (hasProducts ? productLayoutBoot() : '');
  // Canonical is emitted by layout() from layoutMeta.canonical — don't add a
  // second hand-built <link rel="canonical"> here.
  // Keep thin and failed pages out of the index (mirrors publicResearchFilter:
  // >= 3 products, or >= 2 for comparative "X vs Y" queries). Direct links
  // still work — only crawlers are turned away.
  const isComparative = rowFacets.is_comparative === true || /\bvs\.?\b|versus/i.test(entry.query);
  const minIndexableProducts = isComparative ? 2 : 3;
  const isThin = isLiveReport && products.length < minIndexableProducts;
  const noindex = (isThin || isFailed || showProcessingHero) ? '<meta name="robots" content="noindex, follow">' : '';
  // Amazon-viable pages carry Amazon buy-links on every card. dns-prefetch is
  // cheap (DNS-only, no TLS handshake) and shaves ~50-200ms off the first
  // affiliate click. Web-only/service pages have no Amazon links to warm.
  const amazonHint = products.length > 0 && !webOnly && !isService ? '<link rel="dns-prefetch" href="//www.amazon.com">' : '';
  // Append the freshness year to the <title>/OG title only (not the on-page H1 or
  // schema headline) — a measurable CTR lift on commercial "best X" queries. Use
  // the page's last-completion year (honest: reflects actual freshness) and only
  // when the title doesn't already carry a 4-digit year.
  const titleYear = new Date(lastModifiedTs * 1000).getUTCFullYear();
  const seoTitle = (isLiveReport && !/\b20\d{2}\b/.test(displayTitle))
    ? `${displayTitle} (${titleYear})`
    : displayTitle;
  const htmlOut = layout(seoTitle, entry.summary ?? 'AI-powered product research', body, amazonHint + noindex + structuredData + turnstileScript + extra, layoutMeta);
  return { html: htmlOut, lastModified: lastModifiedTs, status: entry.status };
}
