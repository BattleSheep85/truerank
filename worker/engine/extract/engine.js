// Pure-ML extraction engine — analysis pipeline (Phase 0).
// sources(+credibility) + notes  →  ranked products with grounded facts + pros/cons.
// 100% hand-rolled, zero deps, Worker-compatible. Every emitted value is a span that
// exists in a source — fabrication is impossible by construction.
// Orchestrates the cross-category cluster gate + the top-level analyze()/
// conCandidateSpans() entry points; text utils, candidate harvest/resolution, and
// scoring live in text.js / candidates.js / scoring.js (split 2026-07, behavior
// unchanged, to stay under the 800-line file cap).

import { MARKETING } from './lexicon.js';
import { BRAND_CLUSTERS } from './gazetteer.js';
import { NONCREDIBLE_GENRES } from '../../lib/credibility.js';
import { sentences, stripMarkdown, categoryTerms, inCategory, tidyClause, looksLikeHeadline } from './text.js';
import { harvestCandidates, resolveCandidates, modelToken, FOREIGN_CATEGORY } from './candidates.js';
import { aliasMatchers, analyzeProduct, rate, pick, looksLikeListing, MIN_CREDIBLE_SCORE, sentencePolarity } from './scoring.js';

// Reverse index brand → Set(cluster keys), for the cross-category brand gate. A brand
// in multiple clusters (Nike = APPAREL_FOOTWEAR+OUTDOOR) maps to all of them.
const BRAND_TO_CLUSTERS = (() => {
  const m = new Map();
  for (const [cluster, brands] of Object.entries(BRAND_CLUSTERS)) {
    for (const b of brands) { if (!m.has(b)) m.set(b, new Set()); m.get(b).add(cluster); }
  }
  return m;
})();

// Keyword → cluster signals for mapping a query/topical_category to a cluster. First
// cluster with the most keyword hits wins; no hits → null (gate stays OFF, fail-open).
const CLUSTER_KEYWORDS = {
  TECH: ['keyboard', 'keycap', 'switch', 'mouse', 'monitor', 'laptop', 'desktop', 'pc', 'headphone', 'headphones', 'earbud', 'earbuds', 'speaker', 'soundbar', 'ssd', 'hdd', 'storage', 'gpu', 'graphics', 'cpu', 'camera', 'webcam', 'router', 'modem', 'mesh', 'wifi', 'software', 'app', 'saas', 'phone', 'smartphone', 'tablet', 'tv', 'projector', 'vacuum', 'robot', 'smartwatch', 'charger', 'powerbank', 'microphone', 'mic', 'gaming', 'console', 'drone', 'printer', 'nas', 'electronic', 'electronics'],
  APPAREL_FOOTWEAR: ['shirt', 'shirts', 'tshirt', 'pants', 'trousers', 'jeans', 'denim', 'dress', 'skirt', 'jacket', 'coat', 'hoodie', 'sweater', 'sweatshirt', 'shoe', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots', 'sandal', 'sandals', 'loafer', 'clothing', 'clothes', 'apparel', 'sock', 'socks', 'underwear', 'bra', 'leggings', 'shorts', 'suit', 'blazer', 'linen', 'cotton', 'wardrobe', 'outfit'],
  HOME_KITCHEN: ['mattress', 'bed', 'desk', 'chair', 'sofa', 'couch', 'recliner', 'cookware', 'pan', 'pans', 'skillet', 'pot', 'knife', 'knives', 'blender', 'coffee', 'espresso', 'kettle', 'toaster', 'sheets', 'bedding', 'pillow', 'duvet', 'comforter', 'furniture', 'sofa', 'dresser', 'fridge', 'refrigerator', 'dishwasher', 'microwave', 'airfryer', 'cutlery', 'dinnerware', 'mug'],
  BEAUTY: ['skincare', 'makeup', 'serum', 'moisturizer', 'cleanser', 'sunscreen', 'spf', 'foundation', 'concealer', 'lipstick', 'mascara', 'fragrance', 'perfume', 'cologne', 'shampoo', 'conditioner', 'razor', 'shaving', 'cosmetic', 'cosmetics', 'retinol', 'toner', 'moisturiser'],
  OUTDOOR: ['tent', 'backpack', 'backpacking', 'hiking', 'camping', 'cooler', 'bike', 'bicycle', 'cycling', 'fishing', 'kayak', 'sleeping', 'climbing', 'trail', 'ski', 'snowboard', 'hydration', 'flask', 'outdoor'],
  TOOLS: ['drill', 'saw', 'tool', 'tools', 'wrench', 'driver', 'mower', 'ladder', 'paint', 'plumbing', 'sander', 'grinder', 'impact', 'cordless', 'hammer', 'screwdriver', 'wood', 'workshop', 'generator', 'compressor'],
  PET: ['dog', 'cat', 'pet', 'puppy', 'kitten', 'litter', 'leash', 'kibble', 'aquarium', 'collar'],
  BABY: ['stroller', 'carseat', 'baby', 'infant', 'toddler', 'diaper', 'crib', 'bassinet', 'nursery', 'toy', 'toys', 'monitor'],
  BAGS_TRAVEL: ['luggage', 'suitcase', 'carryon', 'wallet', 'watch', 'watches', 'briefcase', 'duffel', 'tote', 'purse', 'handbag', 'travel'],
};
function queryCluster(topicalCategory, query) {
  const text = `${topicalCategory || ''} ${query || ''}`.toLowerCase();
  const words = new Set(text.split(/[^a-z]+/).filter(Boolean));
  let best = null, bestN = 0;
  for (const [cluster, kws] of Object.entries(CLUSTER_KEYWORDS)) {
    const n = kws.reduce((s, k) => s + (words.has(k) ? 1 : 0), 0);
    if (n > bestN) { bestN = n; best = cluster; }
  }
  return best; // null when nothing matched → gate disabled
}

export function analyze(query, notes, sources, facets = {}, topicalCategory = '', extraNames = []) {
  // Strip jina markdown FIRST so link/image/url/heading syntax can't leak anywhere.
  const cleanSources = (sources || []).map((s) => ({ ...s, title: stripMarkdown(s.title), content: stripMarkdown(s.content) }));
  const cleanNotes = (notes || []).map((n) => ({ ...n, content: stripMarkdown(n.content) }));
  const catTerms = categoryTerms(topicalCategory, query);
  const qCluster = queryCluster(topicalCategory, query); // null = gate off (fail-open)
  // Physical products are always "Brand Model" — a single bare brand token ("flair",
  // "rigid", "Armani") is collision/sentence-fragment noise. Services/software (email
  // tools, apps) ARE legitimately one word (Brevo, Notion), so only require ≥2 tokens
  // when the query is for a buyable physical product.
  const physical = facets?.sold_on_amazon !== false && facets?.is_service !== true && facets?.is_content !== true;
  // Cap the candidate set before the per-candidate analysis. analyzeProduct() runs for EVERY
  // candidate and re-scans every source, so cost is ~O(candidates x sources x sentences). A
  // legit query yields well under this cap; the limit bounds a pathological/adversarial source
  // payload (many distinct Title-Case strings) from exploding CPU. Keep the best-supported
  // candidates (most source mentions) — real products are corroborated, noise is one-off.
  const MAX_CANDIDATES = 250;
  let harvested = resolveCandidates(harvestCandidates(cleanSources, cleanNotes, { physical, extraNames }));
  if (harvested.length > MAX_CANDIDATES) {
    harvested = harvested.slice().sort((a, b) => ((b.srcIdx?.size || 0) - (a.srcIdx?.size || 0)) || ((b.sents?.length || 0) - (a.sents?.length || 0))).slice(0, MAX_CANDIDATES);
  }
  const allMatch = harvested.map((c) => ({ c, m: aliasMatchers(c) }));
  const seen = new Set(); // a given clause is used as a pro/con for at most ONE product
  const products = [];
  for (const c of harvested) {
    const others = allMatch.filter((x) => x.c !== c).flatMap((x) => x.m).filter((m) => m.length > 2);
    const a = analyzeProduct(c, cleanSources, others, seen);
    // INCLUSION RULE: keep only products with credible (non-listicle/affiliate/
    // manufacturer) support — suppresses fabricated traps — AND require CORROBORATION
    // (≥2 credible sources, OR a strong hands-on/expert source plus ≥2 real pros/cons).
    // Real pages flood the harvester with one-off brand mentions; corroboration prunes them.
    const credible = a.support.filter((s) => s.score >= MIN_CREDIBLE_SCORE && !s.tags.every((t) => NONCREDIBLE_GENRES.has(t)));
    if (a.pros.length === 0 && a.cons.length === 0) continue;
    // CATEGORY GATE: the product must be discussed in the query's category. A laptop /
    // running shoe / vacuum that leaked from a mixed listicle into a keyboard query never
    // mentions a keyboard term → dropped. (No-op when no category terms were derivable.)
    if (!inCategory(c, a.support, catTerms)) continue;
    // foreign-category noun in the name (not a query term) → it's another category's product
    if (c.name.toLowerCase().split(/\s+/).some((w) => FOREIGN_CATEGORY.has(w) && !catTerms.has(w))) continue;
    // BRAND-CLUSTER gate: when the query maps to a cluster and the product's brand is known
    // to belong ONLY to other clusters (ASICS=APPAREL_FOOTWEAR in a TECH keyboard query),
    // drop it. Catches omni-listicle leaks the title gate misses. Fail-open when either side
    // is unknown (unmapped query, or a brand not in the gazetteer) to protect recall.
    if (qCluster && c.brand) {
      const bc = BRAND_TO_CLUSTERS.get(String(c.brand).toLowerCase());
      if (bc && bc.size && !bc.has(qCluster)) continue;
    }
    // INCLUSION: require ≥1 CREDIBLE source (non-listicle/affiliate/manufacturer) — this
    // is the fabricated-trap suppressor (a trap has only promotional support → 0 credible
    // → dropped). We deliberately DO NOT require extra corroboration anymore: the goal is
    // COMPREHENSIVE honest coverage (show every real, credibly-mentioned product), not a
    // curated top-few. Thin products are surfaced with their evidence + honest caveats.
    if (credible.length < 1) continue;
    const rating = rate(a.pros, a.cons, credible.length);
    const weight = credible.reduce((s, x) => s + x.score, 0); // credible evidence mass for ranking
    products.push({
      name: c.name, brand: c.brand || '', price: a.price, rating,
      pros: pick(a.pros, 1), cons: pick(a.cons, -1), specs: a.specs,
      productUrl: '', manufacturerUrl: '', imageUrl: '',
      verdict: '', bestFor: '', metadata: {},
      _credibleCount: credible.length, _nEff: Math.round(weight / 100 * 10) / 10, _weight: weight,
      _topGenres: [...new Set(a.support.flatMap((s) => s.tags))],
    });
  }
  // rank by RATING first (quality — the cap already requires real evidence for a high
  // score), then credible-evidence mass as the tiebreaker. Ranking by mention-count
  // alone wrongly floats the "cheap alternative" above the actual top pick.
  const sortedProducts = [...products].sort((a, b) => b.rating - a.rating || b._weight - a._weight);
  // Comprehensive but pipeline-safe: each shown product costs downstream ASIN + image +
  // con-selector work, so an unbounded list times out the queue consumer. 24 is ~2.5x the
  // old 10 (the "see them all" win) while staying within the per-run subrequest/time budget.
  const capped = sortedProducts.slice(0, 24);
  capped.forEach((p, i) => { p.rank = i + 1; });
  return capped;
}

// Candidate con SPANS for the hybrid LLM con-selector: every credible-BODY sentence
// (+ its 1-2 sentence proximity window, stopping at a rival) that mentions a product.
// Returns clean verbatim spans — positive, neutral, AND negative — so the LLM selector
// can identify criticism the lexicon missed; the selector's output is then gated to be
// a substring of THESE spans, so nothing can be invented.
export function conCandidateSpans(productName, aliases, sources, rivalNames = [], cap = 14) {
  const matchers = [String(productName || '').toLowerCase(), ...(aliases || []).map((a) => String(a).toLowerCase())].filter((m) => m && m.length > 2);
  const code = modelToken(String(productName || '').split(/\s+/));
  if (code && code.length >= 3) matchers.push(code);
  const rivals = (rivalNames || []).map((n) => String(n).toLowerCase()).filter((r) => r && !matchers.includes(r) && r.length > 3);
  const selfIn = (t) => matchers.some((m) => t.toLowerCase().includes(m));
  const otherIn = (t) => rivals.some((m) => t.toLowerCase().includes(m));
  const spans = []; const seen = new Set();
  for (const s of sources || []) {
    if ((s.credibility?.score ?? 0) < MIN_CREDIBLE_SCORE) continue;
    if ((s.credibility?.tags || []).length && (s.credibility.tags).every((t) => NONCREDIBLE_GENRES.has(t))) continue;
    const body = stripMarkdown(s.content || '');
    if (body.length < 400) continue;
    const sents = sentences(body);
    for (let i = 0; i < sents.length; i++) {
      if (!selfIn(sents[i])) continue;
      for (let j = i; j <= i + 2 && j < sents.length; j++) {
        if (j > i && otherIn(sents[j]) && !selfIn(sents[j])) break;
        const clean = tidyClause(sents[j]).slice(0, 220);
        if (clean.length < 24 || looksLikeListing(clean) || looksLikeHeadline(clean)) continue;
        if (otherIn(clean) && !selfIn(clean)) continue;
        const key = clean.toLowerCase();
        if (!seen.has(key)) { seen.add(key); spans.push(clean); }
      }
      if (spans.length >= cap) break;
    }
    if (spans.length >= cap) break;
  }
  return spans.slice(0, cap);
}

export { sentences, sentencePolarity, MARKETING };
