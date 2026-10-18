// Unit tests for scripts/lib/eval-score.mjs, the page scorer behind
// scripts/run-eval.mjs (golden-query eval). CP-415 added non-product kinds
// (service, local, experience); the HTML below copies the live page markup
// as of 2026-10-18.
import { readFileSync } from 'node:fs';
import { scorePage, hardFailures, QUERY_KINDS } from '../../scripts/lib/eval-score.mjs';

const CHECKS = { min_products: 3, min_sources: 5, max_age_days: 120 };
const NOW = Date.parse('2026-10-18T00:00:00Z');

const ourPick = (name) => `<h2 class="ourpick-name wrap-anywhere mt-2 font-serif text-h3 font-semibold text-ink">${name}</h2>`;
const card = (i, name, extra = '') => `<article class="product border border-line bg-surface-1 p-5" id="product-${i}"><h3>#${i} ${name}</h3>${extra}</article>`;
const amazonCta = '<a href="/api/go/abc?ref=x&amp;network=amazon" class="product-cta-amazon mt-4 flex">Search Amazon <span aria-hidden="true">&#8599;</span></a>';
// Live markup: the Google hand-off reuses the product-cta-amazon CSS class.
const googleCta = '<a href="/find?q=H%26R%20Block&amp;ref=x" class="product-cta-amazon mt-4 flex">Find on Google <span>&#8599;</span></a>';
const cleanAmazonCta = '<a href="https://www.amazon.com/dp/B0ABCDEFGH" class="product-cta-amazon">Buy on Amazon</a>';
const disclosure = '<p class="trust-panel-disclosure">We may earn a commission on purchases made through links on this page.</p>';
const recsHeading = '<h2 id="products" class="font-mono">Recommendations</h2>';

function page({ pick, cards, ctas = '', heading = '', sources = 12, date = '2026-10-01', disclose = true }) {
  return `<html><time datetime="${date}">x</time>${ourPick(pick)}${heading}${cards.join('')}${ctas}<h2>Sources (${sources})</h2>${disclose ? disclosure : ''}</html>`;
}

export function runEvalScoreTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, actual, expected) => {
    const A = JSON.stringify(actual), E = JSON.stringify(expected);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  eq('kinds', QUERY_KINDS, ['product', 'service', 'local', 'experience']);

  // ── product (the original checks, against today's markup) ────────────────
  {
    const html = page({ pick: 'Kindle Paperwhite', cards: [card(1, 'Kindle Paperwhite'), card(2, 'Kobo Clara'), card(3, 'Boox')], ctas: amazonCta });
    const s = scorePage(html, { query: 'best ereader', accepted_winners: ['kindle', 'kobo'] }, CHECKS, NOW);
    eq('product: pick read from current ourpick markup', s.top_pick, 'Kindle Paperwhite');
    eq('product: pick correct', s.pick_correct, true);
    eq('product: product cards counted from current markup', s.product_count, 3);
    eq('product: sources counted', [s.source_count, s.sources_ok], [12, true]);
    eq('product: fresh', [s.age_days, s.fresh_ok], [17, true]);
    eq('product: disclosure', s.disclosure_present, true);
    eq('product: kind defaults to product', s.kind, 'product');
    eq('product: Amazon buttons are fine on a product page', s.amazon_free, null);
    eq('product: no hard failures', hardFailures(s), []);
  }
  {
    const html = page({ pick: 'GamerWidget Pro', cards: [card(1, 'GamerWidget Pro')], disclose: false, sources: 2, date: '2026-01-01' });
    const s = scorePage(html, { query: 'q', accepted_winners: ['keychron'] }, CHECKS, NOW);
    eq('product: wrong pick, no disclosure are hard failures', hardFailures(s), ['pick_correct', 'disclosure_present']);
    eq('product: thin and stale are soft', [s.products_ok, s.sources_ok, s.fresh_ok], [false, false, false]);
  }
  eq('pick name entities are decoded', scorePage(page({ pick: 'H&amp;R Block', cards: [] }), { query: 'q', kind: 'service', accepted_winners: ['h&r block'] }, CHECKS, NOW).pick_correct, true);
  eq('no pick on the page reads as empty', scorePage('<html></html>', { query: 'q', accepted_winners: ['x'] }, CHECKS, NOW).top_pick, '');

  // ── service ──────────────────────────────────────────────────────────────
  {
    const g = { query: 'best tax preparation service for freelancers', kind: 'service', accepted_winners: ['turbotax', 'h&r block'] };
    const good = scorePage(page({ pick: 'TurboTax', cards: [card(1, 'TurboTax')], ctas: googleCta, heading: recsHeading }), g, CHECKS, NOW);
    eq('service: Google hand-off, Recommendations layout pass', [good.amazon_free, good.service_layout, good.pick_correct], [true, true, true]);
    eq('service: no hard failures', hardFailures(good), []);
    const bad = scorePage(page({ pick: 'TurboTax', cards: [card(1, 'TurboTax')], ctas: amazonCta }), g, CHECKS, NOW);
    eq('service: Amazon button and product layout are hard failures', hardFailures(bad), ['amazon_free', 'service_layout']);
  }
  {
    const s = scorePage(page({ pick: 'Some CPA', cards: [card(1, 'Some CPA')], heading: recsHeading }), { query: 'q', kind: 'service' }, CHECKS, NOW);
    eq('service: no accepted list means the pick is not judged', s.pick_correct, null);
    eq('service: unjudged pick is not a failure', hardFailures(s), []);
  }

  // ── local ────────────────────────────────────────────────────────────────
  {
    const g = { query: 'best coffee shops in brooklyn', kind: 'local', location_any: ['brooklyn'] };
    const good = scorePage(page({ pick: 'SEY Coffee – 18 Grattan St, Brooklyn, NY 11206', cards: [card(1, 'SEY Coffee – 18 Grattan St, Brooklyn, NY 11206')], ctas: googleCta }), g, CHECKS, NOW);
    eq('local: pick in the asked place, no Amazon', [good.location_ok, good.amazon_free], [true, true]);
    eq('local: service layout is not required', good.service_layout, null);
    eq('local: no hard failures', hardFailures(good), []);
    const wrongCity = scorePage(page({ pick: 'Pho Bac', cards: [card(1, 'Pho Bac', '<p>Seattle, WA</p>')] }), { query: 'best pho in wichita', kind: 'local', location_any: ['wichita'] }, CHECKS, NOW);
    eq('local: a Seattle pick for a Wichita query fails', [wrongCity.location_ok, hardFailures(wrongCity)], [false, ['location_ok']]);
    const fromCard = scorePage(page({ pick: 'Pho Hoa', cards: [card(1, 'Pho Hoa', '<dd>2800 E Douglas Ave, Wichita, KS</dd>'), card(2, 'Other', 'Seattle')] }), { query: 'q', kind: 'local', location_any: ['wichita'] }, CHECKS, NOW);
    eq('local: the place can come from the #1 card details', fromCard.location_ok, true);
    const onlySecond = scorePage(page({ pick: 'Pho Hoa', cards: [card(1, 'Pho Hoa'), card(2, 'Pho Wichita')] }), { query: 'q', kind: 'local', location_any: ['wichita'] }, CHECKS, NOW);
    eq('local: the place on card #2 does not count for the #1 pick', onlySecond.location_ok, false);
    const amazon = scorePage(page({ pick: 'SEY Coffee, Brooklyn', cards: [card(1, 'SEY Coffee, Brooklyn')], ctas: amazonCta }), g, CHECKS, NOW);
    eq('local: Search Amazon on a coffee shop fails', hardFailures(amazon), ['amazon_free']);
    const clean = scorePage(page({ pick: 'SEY Coffee, Brooklyn', cards: [card(1, 'SEY Coffee, Brooklyn')], ctas: cleanAmazonCta }), g, CHECKS, NOW);
    eq('local: a plain amazon.com link (clean-links render) fails too', clean.amazon_free, false);
  }

  // ── experience ───────────────────────────────────────────────────────────
  {
    const s = scorePage(page({ pick: 'Gregory Canyon Trail via Chautauqua, Boulder', cards: [card(1, 'Gregory Canyon Trail', '<p>Best for Denver-area hikers</p>')], ctas: googleCta }), { query: 'q', kind: 'experience', location_any: ['denver', 'boulder'] }, CHECKS, NOW);
    eq('experience: place-bound pick passes', [s.location_ok, s.amazon_free, hardFailures(s)], [true, true, []]);
    const unbound = scorePage(page({ pick: 'Yellowstone', cards: [card(1, 'Yellowstone')], ctas: amazonCta }), { query: 'q', kind: 'experience' }, CHECKS, NOW);
    eq('experience: no place asked means location is not judged', unbound.location_ok, null);
    eq('experience: Amazon button on a park trip fails', hardFailures(unbound), ['amazon_free']);
  }

  // ── the golden file itself ───────────────────────────────────────────────
  {
    const cfg = JSON.parse(readFileSync(new URL('../../eval/golden-queries.json', import.meta.url), 'utf8'));
    const kinds = cfg.queries.map((q) => q.kind || 'product');
    eq('golden: every kind is known', kinds.every((k) => QUERY_KINDS.includes(k)), true);
    for (const k of ['service', 'local', 'experience']) eq(`golden: has a ${k} query`, kinds.includes(k), true);
    eq('golden: every local query names its place', cfg.queries.filter((q) => q.kind === 'local').every((q) => Array.isArray(q.location_any) && q.location_any.length > 0), true);
    eq('golden: product queries keep an accepted list', cfg.queries.filter((q) => !q.kind || q.kind === 'product').every((q) => q.accepted_winners?.length > 0), true);
  }

  return report;
}
