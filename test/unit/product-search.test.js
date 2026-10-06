// Assertions for the faceted product-search builders (product-search.js). Pure,
// zero-dep — run via `node scripts/run-tests.mjs`. Locks in filter validation,
// the parameterized WHERE builder (incl. facet "exclude self" behavior), the
// narrowed/indexable decision, and href serialization.

import {
  parseProductFilters, isNarrowed, buildProductWhere, orderByClause, reviewsHref,
  priceBand, PRICE_BANDS, RATING_OPTIONS,
} from '../../worker/lib/product-search.js';

// get-accessor over a plain object (mirrors URLSearchParams.get → string|null).
const getOf = (o) => (n) => (n in o ? String(o[n]) : null);

export function runProductSearchTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) report.passed++;
    else { report.failed++; report.failures.push(`${name}: expected ${e}, got ${a}`); }
  };
  const ok = (name, cond) => eq(name, !!cond, true);

  // ── parseProductFilters: validation + clamping ─────────────────────────────
  {
    const f = parseProductFilters(getOf({ q: '  nas  ', category: 'NAS', brand: 'Synology', price: '50-100', rating: '4', sort: 'price-asc', page: '3' }));
    eq('parse: trims q', f.q, 'nas');
    eq('parse: keeps valid price band', f.price, '50-100');
    eq('parse: keeps valid rating', f.rating, '4');
    eq('parse: keeps valid sort', f.sort, 'price-asc');
    eq('parse: page', f.page, 3);
  }
  {
    const f = parseProductFilters(getOf({ price: 'bogus', rating: '9', sort: 'hacker', page: '99999' }));
    eq('parse: drops invalid price', f.price, '');
    eq('parse: drops invalid rating', f.rating, '');
    eq('parse: defaults bad sort to featured', f.sort, 'featured');
    eq('parse: clamps page to 200', f.page, 200);
  }
  {
    const f = parseProductFilters(getOf({}));
    eq('parse: empty → defaults', [f.q, f.category, f.brand, f.price, f.rating, f.sort, f.page], ['', '', '', '', '', 'featured', 1]);
  }

  // ── buildProductWhere: base filter always on; binds are positional ─────────
  {
    const { clause, binds } = buildProductWhere(parseProductFilters(getOf({})));
    ok('where: base has status filter', clause.includes("r.status = 'complete'"));
    ok('where: base has verdict filter', clause.includes('p.verdict'));
    eq('where: base has no binds', binds, []);
  }
  {
    const f = parseProductFilters(getOf({ q: 'head', category: 'Headphones', brand: 'Sony', price: '100-250', rating: '4.5' }));
    const { clause, binds } = buildProductWhere(f);
    ok('where: q → 2 LIKE conds', (clause.match(/LIKE/g) || []).length === 2);
    ok('where: category cond', clause.includes('r.category = ?'));
    ok('where: brand cond', clause.includes('p.brand = ?'));
    ok('where: price lower+upper', clause.includes('p.price >= ?') && clause.includes('p.price < ?'));
    ok('where: rating cond', clause.includes('p.rating >= ?'));
    // binds order: q,q, category, brand, price.min, price.max, rating.min
    eq('where: binds', binds, ['%head%', '%head%', 'Headphones', 'Sony', 100, 250, 4.5]);
  }
  {
    // "1000+" band is open-ended — only a lower bound.
    const f = parseProductFilters(getOf({ price: '1000+' }));
    const { binds } = buildProductWhere(f);
    eq('where: open-ended price band → single bind', binds, [1000]);
  }
  {
    // Custom price range (pmin/pmax): both bounds + NOT NULL guard.
    const f = parseProductFilters(getOf({ pmin: '50', pmax: '300' }));
    eq('parse: pmin/pmax numbers', [f.pmin, f.pmax], [50, 300]);
    const { clause, binds } = buildProductWhere(f);
    ok('where: custom range has NOT NULL', clause.includes('p.price IS NOT NULL'));
    eq('where: custom range binds', binds, [50, 300]);
  }
  {
    // A $0 floor is the default → dropped; pmax<pmin → pmax dropped.
    eq('parse: pmin 0 dropped', parseProductFilters(getOf({ pmin: '0' })).pmin, null);
    eq('parse: pmax<pmin dropped', parseProductFilters(getOf({ pmin: '100', pmax: '20' })).pmax, null);
    eq('parse: negative dropped', parseProductFilters(getOf({ pmax: '-5' })).pmax, null);
  }
  {
    // A preset band takes precedence over a custom range when both are present.
    const f = parseProductFilters(getOf({ price: '50-100', pmin: '5', pmax: '5000' }));
    const { binds } = buildProductWhere(f);
    eq('where: band wins over custom range', binds, [50, 100]);
  }
  {
    // Custom range narrows (noindex) and round-trips through reviewsHref.
    const f = parseProductFilters(getOf({ pmin: '50', pmax: '300' }));
    ok('narrowed: custom range narrows', isNarrowed(f));
    eq('href: serializes pmin/pmax', reviewsHref(f), '/reviews?pmin=50&pmax=300');
    eq('href: clearing price keys', reviewsHref(f, { price: '', pmin: '', pmax: '' }), '/reviews');
  }
  {
    // Facet "exclude self": the brand facet's own counts must NOT constrain brand.
    const f = parseProductFilters(getOf({ category: 'NAS', brand: 'Synology' }));
    const { clause, binds } = buildProductWhere(f, 'brand');
    ok('where(exclude brand): no brand cond', !clause.includes('p.brand = ?'));
    ok('where(exclude brand): keeps category', clause.includes('r.category = ?'));
    eq('where(exclude brand): binds drop brand', binds, ['NAS']);
  }
  {
    // LIKE-wildcard injection in q is escaped (a literal % can't match-all).
    const { binds } = buildProductWhere(parseProductFilters(getOf({ q: '50%' })));
    // user's % is escaped to \% so it can't match-all; then wrapped in wildcards.
    eq('where: escapes % in q', binds[0], '%50\\%%');
  }

  // ── Retired reports (refocus 2026-10, plan piece 5, spec D2) ──────────────
  // Products of a retired report must never reach /reviews or its facets.
  const RETIRED_COND = 'r.retired_at IS NULL';
  {
    const { clause, binds } = buildProductWhere(parseProductFilters(getOf({})));
    ok('retired: base clause hides retired reports', clause.includes(RETIRED_COND));
    eq('retired: base binds unchanged', binds, []);
  }
  {
    const f = parseProductFilters(getOf({ q: 'head', category: 'Headphones', brand: 'Sony', price: '100-250', rating: '4.5' }));
    for (const exclude of ['category', 'brand', 'price', 'rating']) {
      const { clause } = buildProductWhere(f, exclude);
      ok(`retired: exclude ${exclude} clause hides retired reports`, clause.includes(RETIRED_COND));
    }
    eq('retired: full filter binds unchanged', buildProductWhere(f).binds, ['%head%', '%head%', 'Headphones', 'Sony', 100, 250, 4.5]);
    eq('retired: exclude brand binds unchanged', buildProductWhere(f, 'brand').binds, ['%head%', '%head%', 'Headphones', 100, 250, 4.5]);
  }
  {
    eq('retired: open-ended band binds unchanged', buildProductWhere(parseProductFilters(getOf({ price: '1000+' }))).binds, [1000]);
    eq('retired: custom range binds unchanged', buildProductWhere(parseProductFilters(getOf({ pmin: '50', pmax: '300' }))).binds, [50, 300]);
  }

  // ── isNarrowed: category-only stays indexable; more is noindex ─────────────
  ok('narrowed: empty is not narrowed', !isNarrowed(parseProductFilters(getOf({}))));
  ok('narrowed: category-only is not narrowed', !isNarrowed(parseProductFilters(getOf({ category: 'NAS' }))));
  ok('narrowed: brand narrows', isNarrowed(parseProductFilters(getOf({ brand: 'Sony' }))));
  ok('narrowed: keyword narrows', isNarrowed(parseProductFilters(getOf({ q: 'x' }))));
  ok('narrowed: non-default sort narrows', isNarrowed(parseProductFilters(getOf({ sort: 'rating' }))));
  ok('narrowed: page>1 alone does not narrow', !isNarrowed(parseProductFilters(getOf({ page: '2' }))));

  // ── reviewsHref: serialize, clear-with-'', reset page, omit default sort ───
  {
    const f = parseProductFilters(getOf({ category: 'NAS', brand: 'Synology', page: '4' }));
    eq('href: clearing brand drops it + resets page', reviewsHref(f, { brand: '' }), '/reviews?category=NAS');
    eq('href: setting sort featured omits sort', reviewsHref(f, { sort: 'featured' }), '/reviews?category=NAS&brand=Synology');
    eq('href: empty filters → /reviews', reviewsHref(parseProductFilters(getOf({}))), '/reviews');
  }

  // ── orderByClause ──────────────────────────────────────────────────────────
  ok('order: known sort', orderByClause('price-asc').includes('p.price ASC'));
  ok('order: unknown → featured default', orderByClause('zzz').includes('view_count'));

  // ── priceBand lookup ───────────────────────────────────────────────────────
  eq('priceBand known', priceBand('50-100').label, '$50 – $100');
  eq('priceBand unknown → null', priceBand('zzz'), null);

  // ── constants sanity ───────────────────────────────────────────────────────
  eq('price bands count', PRICE_BANDS.length, 7);
  eq('rating options count', RATING_OPTIONS.length, 3);

  return report;
}
