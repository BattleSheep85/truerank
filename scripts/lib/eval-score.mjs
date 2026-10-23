// Page scorer for the golden-query eval (scripts/run-eval.mjs). Pure: takes
// the SSR HTML of one live research page and its golden entry, returns the
// checks. No I/O, so test/unit/eval-score.test.js can pin it.
//
// Query kinds (CP-415). "product" is the original eval. The other three are
// the facets most likely to break, because the engine and page grew up on
// buyable products:
//   service     a hire-a-professional page: no Amazon button, and the page uses
//               the service layout ("Recommendations", not "Products compared")
//   local       a place in a named city: no Amazon button, and the #1 pick is
//               in that city (the "best pho in Wichita" -> Seattle bug)
//   experience  a trip or activity: no Amazon button; when the query names a
//               place, the #1 pick is there
// accepted_winners stays optional outside "product": services and places
// rarely have one stable winner, so the pick is judged only when a list is set.

import { canonicalizeQuery } from '../../worker/lib/utils.js';

export const QUERY_KINDS = ['product', 'service', 'local', 'experience'];

const DISCLOSURE_RE = /may earn a commission/i;
const OUR_PICK_RE = /class="ourpick-name[^"]*"[^>]*>([^<]+)</;
// The opening of one product card. Both card readers below build on it.
const CARD_OPEN = '<article class="product[\\s"][^>]*id="product-\\d+"';
const PRODUCT_CARD_RE = new RegExp(CARD_OPEN, 'g');
const SOURCES_RE = /Sources \((\d+)\)/;
const DATE_RE = /datetime="(\d{4}-\d{2}-\d{2})/g;
// An Amazon CTA is a tracked /api/go/...&network=amazon link or a "Buy on
// Amazon" / "Search Amazon" label (clean-links renders keep the label). Not the
// product-cta-amazon CSS class (the Google hand-off reuses it), and not a bare
// amazon.com href (the Sources list may link an amazon.com page).
const AMAZON_CTA_RE = /network=amazon|>\s*(?:Buy on|Search) Amazon\b/;
const SERVICE_HEADING_RE = />\s*Recommendations\s*</;
const FIRST_CARD_RE = /id="product-1"([\s\S]*?)<\/article>/;
const DAY_MS = 86_400_000;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const decode = (s) => String(s || '').replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (e) => ENTITIES[e]);
const textOf = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').toLowerCase();
const containsAny = (text, list) => list.some((w) => text.includes(String(w).toLowerCase()));
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, list) => list.some((w) => new RegExp(`(?:^|[^a-z0-9])${reEscape(String(w).toLowerCase())}(?:$|[^a-z0-9])`).test(text));

// One product card, up to its end, and the first h3 inside it (the name).
const CARD_RE = new RegExp(`${CARD_OPEN}[^>]*>([\\s\\S]*?)<\\/article>`, 'g');
const CARD_NAME_RE = /<h3[^>]*>([\s\S]*?)<\/h3>/;

/**
 * The product names on a report page, in card order (CP-812: the card name
 * moved into an h3, so the old product-name class read nothing). Falls back to
 * the Our-pick name when the page has no cards.
 */
export function productNames(html) {
  const text = String(html || '');
  const names = [...text.matchAll(CARD_RE)]
    .map((m) => decode(((m[1].match(CARD_NAME_RE) || [])[1] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (names.length) return names;
  const pick = decode((text.match(OUR_PICK_RE) || [])[1] || '').trim();
  return pick ? [pick] : [];
}

function newestAgeDays(html, now) {
  const dates = [...html.matchAll(DATE_RE)].map((m) => Date.parse(m[1])).filter(Number.isFinite);
  if (!dates.length) return null;
  return Math.floor((now - Math.max(...dates)) / DAY_MS);
}

function baseChecks(html, golden, checks, now) {
  const topPick = decode((html.match(OUR_PICK_RE) || [])[1] || '').trim();
  const accepted = Array.isArray(golden.accepted_winners) ? golden.accepted_winners : [];
  const productCount = (html.match(PRODUCT_CARD_RE) || []).length;
  const sourceMatch = html.match(SOURCES_RE);
  const sourceCount = sourceMatch ? parseInt(sourceMatch[1], 10) : null;
  const ageDays = newestAgeDays(html, now);
  return {
    top_pick: topPick,
    pick_correct: accepted.length ? containsAny(topPick.toLowerCase(), accepted) : null,
    disclosure_present: DISCLOSURE_RE.test(html),
    product_count: productCount,
    products_ok: productCount >= checks.min_products,
    source_count: sourceCount,
    sources_ok: sourceCount == null ? null : sourceCount >= checks.min_sources,
    age_days: ageDays,
    fresh_ok: ageDays == null ? null : ageDays <= checks.max_age_days,
  };
}

// The #1 pick's place can be in the Our-pick name ("SEY Coffee – Brooklyn")
// or anywhere in the #1 product card (address, "Best for Denver-area hikers").
function locationOk(html, topPick, places) {
  if (!Array.isArray(places) || !places.length) return null;
  const firstCard = (html.match(FIRST_CARD_RE) || [])[1] || '';
  return hasWord(`${topPick.toLowerCase()} ${textOf(firstCard)}`, places);
}

export function scorePage(html, golden, checks, now = Date.now()) {
  const page = String(html || '');
  const kind = golden.kind || 'product';
  const base = baseChecks(page, golden, checks, now);
  const nonProduct = kind !== 'product';
  return {
    kind,
    ...base,
    amazon_free: nonProduct ? !AMAZON_CTA_RE.test(page) : null,
    service_layout: kind === 'service' ? SERVICE_HEADING_RE.test(page) : null,
    location_ok: nonProduct ? locationOk(page, base.top_pick, golden.location_any) : null,
  };
}

// Checks that fail the eval run (exit 1). Depth and freshness stay soft: they
// drift with the corpus, not with honesty. null means "not judged".
const HARD_CHECKS = ['pick_correct', 'disclosure_present', 'amazon_free', 'service_layout', 'location_ok'];

export function hardFailures(score) {
  return HARD_CHECKS.filter((k) => score[k] === false);
}

// CP-803: test runs ("... diagnostic 20260621", "... unique test 4829") are never the page a
// visitor gets, so the eval never scores one. A marker the golden query holds itself
// ("fentanyl test strips") is not a test run.
const TEST_MARKER_RE = /\b(?:test|diagnostic|debug|verify\s+\d+)\b|\d{5,}/gi;

function isTestRun(candidateQuery, goldenQuery) {
  const golden = goldenQuery.toLowerCase();
  return (candidateQuery.match(TEST_MARKER_RE) || []).some((m) => !golden.includes(m.toLowerCase()));
}

/**
 * Search term sent to /api/search/suggest. The endpoint strips '$' before its
 * LIKE match, so 'under $100' becomes 'under 100' and misses stored queries
 * with '$100'. Cutting at '$' sends the words before the price, and
 * pickExistingSlug checks the returned rows against the full query.
 */
export function suggestQuery(query) {
  const text = String(query || '').trim();
  const beforeDollar = text.split('$')[0].trim();
  return beforeDollar.length >= 2 ? beforeDollar : text;
}

/**
 * Which existing page the eval scores for a golden query, from the /api/search/suggest answer
 * (most-viewed first). The page in the query's own cache cluster (same canonical query, the
 * page a visitor's search would reuse) wins; else the first page holding every word of the query.
 */
export function pickExistingSlug(query, candidates) {
  if (!Array.isArray(candidates)) return null;
  const pages = candidates.filter((c) => c && typeof c.slug === 'string' && !isTestRun(c.query || '', query));
  const canonical = canonicalizeQuery(query);
  const sameCluster = pages.find((c) => canonicalizeQuery(c.query || '') === canonical);
  if (sameCluster) return sameCluster.slug;
  const words = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const holdsAll = pages.find((c) => words.every((t) => (c.query || '').toLowerCase().includes(t)));
  return holdsAll ? holdsAll.slug : null;
}

// ── Groundedness (CP-807) ─────────────────────────────────────────────────
// Since CP-408 each saved source keeps a snippet: the first 200 characters of
// its page text. The check asks whether the top products' names and numbers
// (prices, spec values) appear in those snippets. A miss is a lead, not proof
// of a lie: 200 characters hold little, and a small number (2 fans) can match
// an unrelated snippet, so this check stays soft.
const NUMBER_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
// Snippet numbers: links go first, and a number glued after a letter (an ASIN
// such as B0CP3MZXVH, a model code) is not a value.
const LINK_RE = /https?:\/\/\S+/g;
const SNIPPET_NUMBER_RE = /(?<![a-z0-9.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
const NAME_WORD_RE = /[a-z0-9]+/g;
// A number counts as found when a snippet number is this close (absolute or relative).
const NUMBER_ABS_TOLERANCE = 0.5;
const NUMBER_REL_TOLERANCE = 0.03;

const numbersIn = (text, re = NUMBER_RE) => [...String(text || '').matchAll(re)]
  .map((m) => parseFloat(m[0].replace(/,/g, ''))).filter(Number.isFinite);
const snippetNumbersIn = (text) => numbersIn(text.replace(LINK_RE, ' '), SNIPPET_NUMBER_RE);
const nearAny = (n, list) => list.some((s) => Math.abs(n - s) <= NUMBER_ABS_TOLERANCE
  || (s !== 0 && Math.abs(n - s) / Math.abs(s) <= NUMBER_REL_TOLERANCE));
const round3 = (x) => Math.round(x * 1000) / 1000;

function productNumbers(p) {
  const price = Number.isFinite(p?.price) ? [p.price] : [];
  const specs = p?.specs && typeof p.specs === 'object' ? Object.values(p.specs) : [];
  return [...price, ...specs.flatMap((v) => numbersIn(v))];
}

function nameFound(name, snippetTexts) {
  const words = String(name || '').toLowerCase().match(NAME_WORD_RE) || [];
  if (!words.length) return false;
  return snippetTexts.some((text) => words.every((w) => hasWord(text, [w])));
}

/**
 * Groundedness of one report against its saved source snippets. `body` is the
 * GET /api/report/:id answer ({ report: { products }, sources }). Checks the
 * first checks.grounded_top_n products. grounded_ok compares the share of
 * names found with checks.min_grounded_names; every fraction is null (not
 * judged) when no source has a snippet (reports saved before CP-408).
 */
export function groundedness(body, checks) {
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  const texts = sources.map((s) => s?.snippet).filter((t) => typeof t === 'string' && t.trim())
    .map((t) => decode(t).toLowerCase());
  const products = Array.isArray(body?.report?.products) ? body.report.products : [];
  const top = products.slice(0, checks.grounded_top_n);
  const snippetNumbers = texts.flatMap(snippetNumbersIn);
  const ungrounded = texts.length ? top.filter((p) => !nameFound(p?.name, texts)).map((p) => String(p?.name ?? '')) : [];
  const numbers = top.flatMap(productNumbers);
  const numbersGrounded = numbers.filter((n) => nearAny(n, snippetNumbers)).length;
  const judged = texts.length > 0 && top.length > 0;
  const namesFrac = judged ? round3((top.length - ungrounded.length) / top.length) : null;
  return {
    snippet_sources: texts.length,
    names_checked: judged ? top.length : 0,
    names_grounded: judged ? top.length - ungrounded.length : 0,
    ungrounded_names: ungrounded,
    numbers_checked: judged ? numbers.length : 0,
    numbers_grounded: judged ? numbersGrounded : 0,
    grounded_names_frac: namesFrac,
    grounded_numbers_frac: judged && numbers.length ? round3(numbersGrounded / numbers.length) : null,
    grounded_ok: namesFrac == null ? null : namesFrac >= checks.min_grounded_names,
  };
}
