// Shared category-relevance gate for synth validation and extract analysis.
// Drops cross-category leaks (a mouse in a bulbs query, a purifier in an air-fryer query).

const CAT_STOP = new Set([
  'best', 'the', 'and', 'for', 'with', 'under', 'top', 'over', 'from', 'your', 'our',
  'full', 'sized', 'size', 'layout', 'review', 'reviews', 'guide', 'cheap', 'budget',
  'good', 'great', 'new', 'this', 'that', 'percent', 'inch', 'inches', 'home',
]);

// Words that describe a product of any type ("smart", "wireless"). They
// still count as category terms, but alone they do not prove a product is in
// the category when the category has a real noun ("bulbs", "fryers").
const MODIFIER_TERMS = new Set([
  'smart', 'wireless', 'portable', 'electric', 'cordless', 'digital', 'automatic',
  'bluetooth', 'quiet', 'compact', 'mini', 'outdoor', 'indoor', 'waterproof',
  'premium', 'large', 'small',
]);

// A query's use clause ("for a family of four", "with a hub", "under 100")
// describes the buyer, not the product type, so its words are not category
// terms (CP-380: "family" admitted an air purifier on an air-fryer page).
// Location clauses ("in wichita") stay, they matter for local queries. Only
// cut when a topical category names the type; alone, the whole query decides
// ("best pair of headphones" must not shrink to "pair").
const USE_CLAUSE = /\b(?:for|with|without|of|under|over|to)\b.*$/i;

function addTerm(terms, word) {
  const l = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (l.length >= 4 && !CAT_STOP.has(l)) {
    terms.add(l);
    terms.add(l.endsWith('s') ? l.slice(0, -1) : `${l}s`);
  }
}

/** @returns {Set<string>} lowercased category + query-subject terms (len ≥ 4, with naive plural flip). */
export function categoryTerms(topicalCategory, query) {
  const terms = new Set();
  const subject = topicalCategory ? String(query || '').replace(USE_CLAUSE, '') : String(query || '');
  for (const w of `${topicalCategory || ''} ${subject}`.split(/\s+/)) addTerm(terms, w);
  return terms;
}

// The terms a product must mention: the category terms without the bare
// modifiers, unless modifiers are all there is.
function requiredTerms(terms) {
  const core = [...terms].filter((t) => !MODIFIER_TERMS.has(t) && !MODIFIER_TERMS.has(t.replace(/s$/, '')));
  return core.length ? core : [...terms];
}

// Product-type nouns pinning a different category. If one appears in the product name
// and is NOT a query category term, the pick belongs elsewhere.
export const FOREIGN_CATEGORY = new Set([
  'television', 'playstation', 'xbox', 'nintendo', 'console', 'macbook', 'laptop',
  'notebook', 'chromebook', 'iphone', 'ipad', 'tablet', 'smartphone', 'sneaker',
  'sneakers', 'treadmill', 'mattress', 'sofa', 'couch', 'blender', 'microwave',
  'refrigerator', 'fridge', 'dishwasher', 'games', 'mobile', 'tv',
  'mouse', 'trackpad', 'keyboard', 'webcam', 'printer', 'scanner', 'purifier',
  'humidifier', 'dehumidifier', 'vacuum', 'monitor', 'headphones', 'earbuds',
]);

function productContext(product) {
  const parts = [
    product?.name, product?.brand, product?.verdict, product?.bestFor,
    ...(Array.isArray(product?.pros) ? product.pros : []),
    ...(Array.isArray(product?.cons) ? product.cons : []),
  ];
  if (product?.specs && typeof product.specs === 'object') {
    parts.push(...Object.values(product.specs).filter((v) => typeof v === 'string'));
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Whether a synthesized product belongs in the query's topical category.
 * Fail-open when no category terms are derivable (short/vague queries).
 */
export function productMatchesCategory(product, topicalCategory, query) {
  const terms = categoryTerms(topicalCategory, query);
  if (!terms.size) return true;

  const ctx = productContext(product);

  for (const raw of ctx.split(/[^a-z0-9]+/)) {
    const w = raw.replace(/[^a-z]/g, '');
    if (w.length >= 4 && FOREIGN_CATEGORY.has(w) && !terms.has(w)) return false;
  }
  // Short nouns ("tv") are checked in the name only: a soundbar's verdict
  // may say "beats TV speakers" (CP-380).
  const asked = new Set(`${topicalCategory || ''} ${query || ''}`.toLowerCase().split(/[^a-z]+/));
  for (const w of String(product?.name || '').toLowerCase().split(/[^a-z]+/)) {
    if (w.length > 0 && w.length < 4 && FOREIGN_CATEGORY.has(w) && !asked.has(w) && !asked.has(`${w}s`)) return false;
  }

  return requiredTerms(terms).some((t) => ctx.includes(t));
}

/** @param {Array<object>} products */
export function filterByCategory(products, topicalCategory, query) {
  if (!Array.isArray(products) || !products.length) return products;
  if (!topicalCategory && !query) return products;
  return products.filter((p) => productMatchesCategory(p, topicalCategory, query));
}
