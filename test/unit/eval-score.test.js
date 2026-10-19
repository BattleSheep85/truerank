// Unit tests for scripts/lib/eval-score.mjs, the page scorer behind
// scripts/run-eval.mjs (golden-query eval). CP-415 added non-product kinds
// (service, local, experience); the HTML below copies the live page markup
// as of 2026-10-18.
import { readFileSync } from 'node:fs';
import { scorePage, hardFailures, QUERY_KINDS, pickExistingSlug, groundedness, productNames } from '../../scripts/lib/eval-score.mjs';

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
    const amazonSource = scorePage(page({ pick: 'SEY Coffee, Brooklyn', cards: [card(1, 'SEY Coffee, Brooklyn')], ctas: googleCta + '<a href="https://www.amazon.com/some-guide" rel="nofollow">amazon.com</a>' }), g, CHECKS, NOW);
    eq('local: an amazon.com page in the Sources list is not a buy button', amazonSource.amazon_free, true);
    const wordOnly = scorePage(page({ pick: 'Brooklyner Cafe', cards: [card(1, 'Brooklyner Cafe')] }), g, CHECKS, NOW);
    eq('local: the place must be a whole word ("Brooklyner" is not "Brooklyn")', wordOnly.location_ok, false);
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

  // ── CP-803: which existing page the eval reads ───────────────────────────
  {
    // Live /api/search/suggest answer for "best robot vacuum for pet hair" (2026-10-19):
    // most-viewed first, so a test run outranked the real page.
    const vacuum = [
      { slug: 'best-robot-vacuum-for-pet-hair-diagnostic-20260621-24173s2r', query: 'Best Robot Vacuum for Pet Hair Diagnostic 20260621' },
      { slug: 'best-robot-vacuum-for-pet-hair-2026-526w6f20', query: 'Best Robot Vacuum for Pet Hair 2026' },
    ];
    eq('lookup: prefers the page in the same cache cluster', pickExistingSlug('best robot vacuum for pet hair', vacuum), 'best-robot-vacuum-for-pet-hair-2026-526w6f20');
    const keyboard = [
      { slug: 'best-budget-mechanical-keyboard-for-typing-06414x60', query: 'Best Budget Mechanical Keyboard for Typing' },
      { slug: 'best-budget-mechanical-keyboard-under-100-8f7ce915', query: 'Best Budget Mechanical Keyboard Under $100' },
    ];
    eq('lookup: a price filter is the same cluster', pickExistingSlug('best budget mechanical keyboard', keyboard), 'best-budget-mechanical-keyboard-under-100-8f7ce915');
    eq('lookup: falls back to a page holding every word', pickExistingSlug('best budget mechanical keyboard', keyboard.slice(0, 1)), 'best-budget-mechanical-keyboard-for-typing-06414x60');
    eq('lookup: a test run is never read', pickExistingSlug('best robot vacuum for pet hair', vacuum.slice(0, 1)), null);
    const strips = [{ slug: 'fentanyl-test-strips-abc', query: 'Fentanyl Test Strips' }];
    eq('lookup: a test word the golden query holds is not a test run', pickExistingSlug('fentanyl test strips', strips), 'fentanyl-test-strips-abc');
    eq('lookup: nothing that matches', pickExistingSlug('best password manager', vacuum), null);
    eq('lookup: tolerates a bad answer', pickExistingSlug('best password manager', null), null);
  }

  // ── CP-807: groundedness against the saved per-source snippets ───────────
  {
    const G_CHECKS = { ...CHECKS, grounded_top_n: 3, min_grounded_names: 0.5 };
    const src = (snippet) => ({ url: 'https://example.com/a', credibility: { score: 70 }, ...(snippet ? { snippet } : {}) });
    const body = (products, sources) => ({ report: { products }, sources });
    const products = [
      { name: 'Kindle Paperwhite', price: 159.99, specs: { screen: '7 inch' } },
      { name: 'Kobo Clara BW', price: 129, specs: { storage: '16 GB' } },
      { name: 'Boox Go 7', price: 249, specs: {} },
      { name: 'Ignored Fourth', price: 1, specs: {} },
    ];
    const sources = [
      src('The Kindle Paperwhite costs $160 and has a 7 inch screen.'),
      src('We tested the Kobo Clara BW for a month. 16 GB of storage.'),
      src(null),
    ];
    const g = groundedness(body(products, sources), G_CHECKS);
    eq('grounded: snippet sources counted', g.snippet_sources, 2);
    eq('grounded: top N names checked, two found', [g.names_checked, g.names_grounded], [3, 2]);
    eq('grounded: the missing name is listed', g.ungrounded_names, ['Boox Go 7']);
    eq('grounded: prices and spec numbers checked, near price counts', [g.numbers_checked, g.numbers_grounded], [5, 3]);
    eq('grounded: fractions', [g.grounded_names_frac, g.grounded_numbers_frac], [0.667, 0.6]);
    eq('grounded: ok against the threshold', g.grounded_ok, true);
    eq('grounded: a name word must be a whole word', groundedness(body([{ name: 'Kobo Clara' }], [src('Kobold Claravision')]), G_CHECKS).names_grounded, 0);
    const old = groundedness(body(products, [src(null), src(null)]), G_CHECKS);
    eq('grounded: a page with no snippets is not judged', [old.snippet_sources, old.grounded_names_frac, old.grounded_ok], [0, null, null]);
    eq('grounded: tolerates a bad answer', groundedness(null, G_CHECKS).grounded_ok, null);
    eq('grounded: low share fails the soft check', groundedness(body(products, [src('Nothing here about any reader at all.')]), G_CHECKS).grounded_ok, false);
    const noisy = groundedness(body([{ name: 'Antec C8', price: 3, specs: { fans: '0 fans' } }], [src('Antec C8 at https://www.amazon.com/dp/B0CP3MZXVH page 2')]), G_CHECKS);
    eq('grounded: link and ASIN digits are not snippet numbers', [noisy.numbers_checked, noisy.numbers_grounded], [2, 0]);
    eq('grounded: not a hard failure', hardFailures({ grounded_ok: false }), []);
  }

  // ── productNames (CP-812: scripts/run-real-world-eval.mjs reads the cards) ──
  {
    // The live card (2026-10-19): an image, a "#1" badge span, then the name in an h3.
    const liveCard = (i, name) => `<article class="product border border-line bg-surface-1 p-5" id="product-${i}">
<img class="item-image-photo" src="/api/img/x" alt="${name}">
<div class="flex"><div><span class="inline-block border readout">#${i}</span>
<h3 class="wrap-anywhere mt-1.5 font-sans text-lg font-bold text-ink">${name}</h3>
<p class="font-mono text-xs text-ink-2">brand</p></div></div></article>`;
    const html = page({ pick: 'eufy X9', cards: [liveCard(1, 'eufy Clean RoboVac X9'), liveCard(2, 'Roborock Q7 &amp; Dock'), liveCard(3, 'Shark AI')] });
    eq('productNames: names in card order from the live markup', productNames(html), ['eufy Clean RoboVac X9', 'Roborock Q7 & Dock', 'Shark AI']);
    eq('productNames: the old card markup test helper still reads', productNames(page({ pick: 'K', cards: [card(1, 'Kindle'), card(2, 'Kobo')] })), ['#1 Kindle', '#2 Kobo']);
    eq('productNames: falls back to the Our-pick name', productNames(page({ pick: 'Only Pick', cards: [] })), ['Only Pick']);
    eq('productNames: an empty page has none', productNames(''), []);
  }

  return report;
}
