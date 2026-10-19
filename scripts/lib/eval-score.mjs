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

export const QUERY_KINDS = ['product', 'service', 'local', 'experience'];

const DISCLOSURE_RE = /may earn a commission/i;
const OUR_PICK_RE = /class="ourpick-name[^"]*"[^>]*>([^<]+)</;
const PRODUCT_CARD_RE = /<article class="product[\s"][^>]*id="product-\d+"/g;
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
