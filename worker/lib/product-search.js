// Faceted product-search engine for /reviews (the Newegg-style organized search
// over every reviewed product). Pure query-building + facet specs here; the page
// (pages/reviews.js) runs the SQL against D1. Splitting it out keeps the SQL
// builder unit-testable (no bindings needed) — see product-search.test.js.
//
// Every product row is products JOIN research; the base filter is always
// "completed, non-retired research with a real verdict" so junk/in-progress/retired rows never show.

export const PAGE_SIZE = 24;

// Fixed price bands (Newegg-style). [min, max) in USD; max null = open-ended.
export const PRICE_BANDS = [
  { key: 'u25', label: 'Under $25', min: 0, max: 25 },
  { key: '25-50', label: '$25 – $50', min: 25, max: 50 },
  { key: '50-100', label: '$50 – $100', min: 50, max: 100 },
  { key: '100-250', label: '$100 – $250', min: 100, max: 250 },
  { key: '250-500', label: '$250 – $500', min: 250, max: 500 },
  { key: '500-1000', label: '$500 – $1,000', min: 500, max: 1000 },
  { key: '1000+', label: '$1,000 & up', min: 1000, max: null },
];
const PRICE_BAND_BY_KEY = new Map(PRICE_BANDS.map((b) => [b.key, b]));

// Minimum-rating options.
export const RATING_OPTIONS = [
  { key: '4.5', label: '4.5★ & up', min: 4.5 },
  { key: '4', label: '4★ & up', min: 4 },
  { key: '3.5', label: '3.5★ & up', min: 3.5 },
];
const RATING_KEYS = new Set(RATING_OPTIONS.map((o) => o.key));

// Sort options → ORDER BY. Default leads with photographed, popular, recent
// items (the page's strongest content), matching the pre-facet behavior.
export const SORT_OPTIONS = [
  { key: 'featured', label: 'Featured' },
  { key: 'rating', label: 'Highest rated' },
  { key: 'price-asc', label: 'Price: low to high' },
  { key: 'price-desc', label: 'Price: high to low' },
  { key: 'newest', label: 'Newest' },
];
const SORT_KEYS = new Set(SORT_OPTIONS.map((o) => o.key));
const ORDER_BY = {
  featured: "(p.image_url IS NULL OR p.image_url = '') ASC, r.view_count DESC, r.completed_at DESC, p.rank ASC",
  rating: 'p.rating DESC NULLS LAST, r.view_count DESC, p.rank ASC',
  'price-asc': 'p.price ASC NULLS LAST, p.rank ASC',
  'price-desc': 'p.price DESC NULLS LAST, p.rank ASC',
  newest: 'r.completed_at DESC, p.rank ASC',
};

/**
 * Normalize raw query params into a validated filter object. `get(name)` is any
 * (name) => string|null accessor (URLSearchParams.get works directly).
 */
// Upper sanity bound for a custom price input ($10M — well above any real product).
const PRICE_CAP = 1e7;

export function parseProductFilters(get) {
  const str = (name, max) => (get(name) || '').toString().trim().slice(0, max);
  const priceKey = str('price', 12);
  const ratingKey = str('rating', 8);
  const sort = str('sort', 16);
  const pageRaw = parseInt(str('page', 6), 10);
  // Custom price range (pmin/pmax). Non-negative finite numbers, capped. A pmax
  // below pmin is dropped (treated as "no upper bound") rather than rejected.
  const num = (name) => {
    const v = parseFloat(str(name, 12));
    return Number.isFinite(v) && v >= 0 ? Math.min(v, PRICE_CAP) : null;
  };
  let pmin = num('pmin');
  let pmax = num('pmax');
  if (pmin != null && pmax != null && pmax < pmin) pmax = null;
  if (pmin === 0) pmin = null; // a $0 floor is the default — drop it
  return {
    q: str('q', 80),
    category: str('category', 120),
    brand: str('brand', 120),
    price: PRICE_BAND_BY_KEY.has(priceKey) ? priceKey : '',
    pmin, pmax,
    rating: RATING_KEYS.has(ratingKey) ? ratingKey : '',
    sort: SORT_KEYS.has(sort) ? sort : 'featured',
    page: Number.isFinite(pageRaw) ? Math.max(1, Math.min(200, pageRaw)) : 1,
  };
}

// True when any narrowing facet is active (used for noindex + canonical). A bare
// category filter stays indexable (it maps to a real listing); anything more
// specific — brand, price (band or custom range), rating, keyword, non-default
// sort — does not. Pagination alone (page>1) does NOT narrow: Google eventually
// treats a long-term noindex page as nofollow too, which would sever the crawl
// path pagination exists to build. Each paginated page keeps its own
// self-referencing canonical instead, per Google's pagination guidance.
export function isNarrowed(filters) {
  return !!(filters.brand || filters.price || filters.pmin != null || filters.pmax != null
    || filters.rating || filters.q || (filters.sort && filters.sort !== 'featured'));
}

// SQLite LIKE wildcards must be escaped so a user's "%" can't match everything.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Build the SQL WHERE clause + ordered binds for a filter set, optionally
 * EXCLUDING one dimension (so a facet's own counts reflect "what selecting each
 * value would yield" — the standard faceted-count behavior). `exclude` is one of
 * 'category' | 'brand' | 'price' | 'rating' | undefined.
 *
 * Returns { clause, binds } where clause begins with the always-on base filter.
 */
export function buildProductWhere(filters, exclude) {
  // Products of a retired report (research.retired_at set) never reach /reviews or its facets.
  const conds = ["r.status = 'complete'", 'r.retired_at IS NULL', "p.verdict IS NOT NULL", "p.verdict != ''"];
  const binds = [];

  if (filters.q) {
    conds.push('(p.name LIKE ? ESCAPE \'\\\' OR p.brand LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(filters.q)}%`;
    binds.push(like, like);
  }
  if (filters.category && exclude !== 'category') {
    conds.push('r.category = ?');
    binds.push(filters.category);
  }
  if (filters.brand && exclude !== 'brand') {
    conds.push('p.brand = ?');
    binds.push(filters.brand);
  }
  if (exclude !== 'price') {
    // A preset band takes precedence over a custom range when both are present.
    const band = filters.price ? PRICE_BAND_BY_KEY.get(filters.price) : null;
    if (band) {
      conds.push('p.price IS NOT NULL AND p.price >= ?');
      binds.push(band.min);
      if (band.max != null) { conds.push('p.price < ?'); binds.push(band.max); }
    } else if (filters.pmin != null || filters.pmax != null) {
      conds.push('p.price IS NOT NULL');
      if (filters.pmin != null) { conds.push('p.price >= ?'); binds.push(filters.pmin); }
      if (filters.pmax != null) { conds.push('p.price <= ?'); binds.push(filters.pmax); }
    }
  }
  if (filters.rating && exclude !== 'rating') {
    const opt = RATING_OPTIONS.find((o) => o.key === filters.rating);
    if (opt) { conds.push('p.rating >= ?'); binds.push(opt.min); }
  }
  return { clause: conds.join(' AND '), binds };
}

export function orderByClause(sort) {
  return ORDER_BY[sort] || ORDER_BY.featured;
}

export function priceBand(key) {
  return PRICE_BAND_BY_KEY.get(key) || null;
}

// Serialize a filter set to a /reviews query string, with overrides applied.
// Passing a key as '' in `over` clears it; page resets to 1 unless overridden.
export function reviewsHref(filters, over = {}) {
  const f = { ...filters, page: 1, ...over };
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.category) p.set('category', f.category);
  if (f.brand) p.set('brand', f.brand);
  if (f.price) p.set('price', f.price);
  if (f.pmin) p.set('pmin', String(f.pmin));
  if (f.pmax) p.set('pmax', String(f.pmax));
  if (f.rating) p.set('rating', f.rating);
  if (f.sort && f.sort !== 'featured') p.set('sort', f.sort);
  if (f.page > 1) p.set('page', String(f.page));
  const qs = p.toString();
  return `/reviews${qs ? `?${qs}` : ''}`;
}
