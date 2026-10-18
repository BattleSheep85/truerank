// Assertions for the result quality gate (worker/engine/validate.js). Pure
// functions, zero deps — run with `node scripts/run-tests.mjs`. These lock in
// the "no junk pick ranks high" behavior: the synth's own sub-3/5 editorial
// rating is the marketplace-churn-brand signal, and such picks are dropped while
// ≥3 better picks remain, without ever punishing honest null ratings or cheap-
// but-reputable budget brands.

import { applyQualityGate, MIN_RATING, validateResearchResult } from '../../worker/engine/validate.js';
import { isChurnBrand } from '../../worker/lib/brand-quality.js';
import { fossLeadersFor } from '../../worker/lib/foss-leaders.js';

// Minimal product factory — only the fields the gate reads. `brand` defaults to
// the first word of the name (so churn detection has something to match) but can
// be overridden.
function prod(name, rating, rank, brand) {
  return { name, rating, rank, brand: brand === undefined ? name.split(' ')[0] : brand };
}

// A fully-formed product for the end-to-end validateResearchResult path.
function fullProd(name, rating, rank, extra = {}) {
  return {
    name, brand: name.split(' ')[0], rating, rank,
    pros: ['a', 'b', 'c'], cons: ['x', 'y'],
    verdict: 'A reasonable pick for the stated use case overall.',
    ...extra,
  };
}

function names(list) {
  return list.map((p) => p.name);
}
function ranks(list) {
  return list.map((p) => p.rank);
}

export function runValidateTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) report.passed++;
    else { report.failed++; report.failures.push(`${name}: expected ${e}, got ${a}`); }
  };

  // The reported bug: Coofandy ★2.5 ranked #3 above better picks. The gate must
  // drop it (3 stronger picks remain) and renumber ranks contiguously.
  {
    const gated = applyQualityGate([
      prod('Buck Mason', 4.0, 1),
      prod('Flint and Tinder', 3.5, 2),
      prod('Coofandy', 2.5, 3),
      prod('Abercrombie', 4.0, 4),
    ]);
    eq('drops sub-floor junk pick', names(gated), ['Buck Mason', 'Flint and Tinder', 'Abercrombie']);
    eq('renumbers ranks contiguously', ranks(gated), [1, 2, 3]);
  }

  // Thin category: when dropping would leave < 3, keep everything (a usable
  // comparison beats an empty page).
  {
    const gated = applyQualityGate([
      prod('Cheap A', 2.5, 1),
      prod('Cheap B', 2.0, 2),
      prod('Cheap C', 2.8, 3),
    ]);
    eq('keeps all when <3 would survive', names(gated), ['Cheap A', 'Cheap B', 'Cheap C']);
  }

  // Honest null ratings ("too thin to score") are NEVER dropped — we don't
  // punish the synth for abstaining.
  {
    const gated = applyQualityGate([
      prod('Rated High', 4.5, 1),
      prod('Unrated One', null, 2),
      prod('Unrated Two', null, 3),
      prod('Bad Pick', 2.0, 4),
    ]);
    eq('null ratings survive, sub-floor dropped', names(gated), ['Rated High', 'Unrated One', 'Unrated Two']);
  }

  // Exactly the floor (3.0) survives — a legit basic brand like Old Navy must
  // not be filtered. Strict less-than is the contract.
  {
    const gated = applyQualityGate([
      prod('Good A', 4.0, 1),
      prod('Old Navy', MIN_RATING, 2),
      prod('Junk', MIN_RATING - 0.1, 3),
      prod('Good B', 4.1, 4),
    ]);
    eq('floor-rated pick survives, just-below dropped', names(gated), ['Good A', 'Old Navy', 'Good B']);
  }

  // We do NOT re-sort by rating: the synth's holistic order (intent fit, price)
  // is preserved among survivors. A lower-rated pick the synth ranked first
  // stays first.
  {
    const gated = applyQualityGate([
      prod('Best Fit', 4.0, 1),
      prod('Higher Rated', 4.8, 2),
    ]);
    eq('preserves synth order (no rating re-sort)', names(gated), ['Best Fit', 'Higher Rated']);
  }

  // Out-of-order rank fields are normalized to the synth's rank intent, then
  // renumbered 1..n.
  {
    const gated = applyQualityGate([
      prod('Second', 4.0, 2),
      prod('First', 4.5, 1),
    ]);
    eq('orders by rank field then renumbers', names(gated), ['First', 'Second']);
    eq('renumbered after reorder', ranks(gated), [1, 2]);
  }

  // Denylist: a known churn brand is dropped even with a GAMED-high rating
  // (the whole point of the denylist — the rating floor can't catch these).
  {
    const gated = applyQualityGate([
      prod('Patagonia Hoody', 4.5, 1, 'Patagonia'),
      prod('Coofandy Shirt', 4.6, 2, 'Coofandy'),
      prod('Smartwool Tee', 4.4, 3, 'Smartwool'),
      prod('REI Hoodie', 4.3, 4, 'REI Co-op'),
    ]);
    eq('drops churn brand despite gamed-high rating', names(gated), ['Patagonia Hoody', 'Smartwool Tee', 'REI Hoodie']);
  }

  // Denylist is unconditional — drops a churn brand even if it takes the list
  // below 3 (an all-junk query then yields an honest non-result downstream).
  {
    const gated = applyQualityGate([
      prod('Good A', 4.0, 1, 'Patagonia'),
      prod('Junk', 4.9, 2, 'Coofandy'),
      prod('Good B', 4.1, 3, 'Smartwool'),
    ]);
    eq('churn drop is unconditional (may go below 3)', names(gated), ['Good A', 'Good B']);
  }

  // isChurnBrand normalization: case + spacing + punctuation insensitive.
  eq('churn match: exact', isChurnBrand('Coofandy'), true);
  eq('churn match: uppercase', isChurnBrand('COOFANDY'), true);
  eq('churn match: spaced + punctuated', isChurnBrand('Coo-Fandy'), true);
  eq('legit brand not churn', isChurnBrand('Patagonia'), false);
  eq('legit short electronics brand not churn', isChurnBrand('LG'), false);
  eq('empty brand not churn', isChurnBrand(''), false);

  // FOSS-leaders allowlist: photo-backup queries must inject Immich (the exact
  // reported recall gap); non-matching queries inject nothing.
  eq('foss: photo backup includes Immich', fossLeadersFor('best photo backup software for android').includes('Immich'), true);
  eq('foss: photo+video backup includes PhotoPrism', fossLeadersFor('best photo and video backup or appliance').includes('PhotoPrism'), true);
  eq('foss: media server includes Jellyfin', fossLeadersFor('best home media server').includes('Jellyfin'), true);
  eq('foss: unrelated query injects nothing', fossLeadersFor('best linen shirts for men'), []);
  eq('foss: empty query safe', fossLeadersFor(''), []);

  // Empty / non-array input is returned untouched (no throw).
  eq('empty array untouched', applyQualityGate([]), []);

  // End-to-end through validateResearchResult: the junk pick is gone from the
  // shipped products and ranks are contiguous.
  {
    const result = validateResearchResult({
      summary: 'Shirts for hot weather.',
      category: 'Apparel',
      products: [
        fullProd('Buck Mason Linen', 4.0, 1),
        fullProd('Flint Tinder Tee', 3.5, 2),
        fullProd('Coofandy Crew', 2.5, 3),
        fullProd('Abercrombie Boxy', 4.0, 4),
      ],
    });
    eq('e2e drops junk pick', result.products.some((p) => p.name === 'Coofandy Crew'), false);
    eq('e2e keeps 3 good picks', result.products.length, 3);
    eq('e2e ranks contiguous', ranks(result.products), [1, 2, 3]);
  }

  // ── Field sanitizers (image / metadata / specs / buyersGuide / coercion) ────
  // A complete product with an overridable imageUrl, exercised through the public
  // validateResearchResult so the internal sanitizers are covered.
  const withImg = (img) => ({
    name: 'Img Test', brand: 'B', rating: 4.5, price: 10, productUrl: 'https://x', manufacturerUrl: 'https://m',
    imageUrl: img, pros: ['a', 'b', 'c'], cons: ['x', 'y'], verdict: 'a'.repeat(15), rank: 1,
  });
  const imgOf = (img) => validateResearchResult({
    summary: 'S', category: 'C',
    products: [withImg(img), withImg('https://cdn.x/ok.jpg'), withImg('https://cdn.x/ok2.png')],
  }).products[0].imageUrl;

  eq('image: valid jpg kept', imgOf('https://cdn.x/photo.jpg'), 'https://cdn.x/photo.jpg');
  eq('image: malformed url (https+ext but unparseable) → ""', imgOf('https://exa mple .com/a.jpg'), '');
  eq('image: non-string → ""', imgOf(12345), '');
  eq('image: blank → ""', imgOf('   '), '');
  eq('image: non-https → ""', imgOf('http://x/a.jpg'), '');
  eq('image: over 2000 chars → ""', imgOf('https://x/' + 'a'.repeat(2000) + '.jpg'), '');
  eq('image: no image extension → ""', imgOf('https://x/page'), '');
  eq('image: youtube host → ""', imgOf('https://m.youtube.com/a.jpg'), '');
  eq('image: *.youtube.com → ""', imgOf('https://foo.youtube.com/a.jpg'), '');

  {
    // Metadata + specs coercion in one product.
    const r = validateResearchResult({
      summary: 'S', category: 'C',
      buyersGuide: { howToChoose: 'choose wisely here', pitfalls: ['p1'], marketingToIgnore: ['m1'] },
      products: [
        { name: 'A', rating: 4.5, pros: ['a', 'b', 'c'], cons: ['x', 'y'], verdict: 'a'.repeat(15),
          metadata: { good: 'val', bad: 5, '': 'skipKey' },
          specs: { w: 2.5, c: 'black', on: true, n: null, obj: { nested: 1 } } },
        { name: 'B', rating: 4.5, pros: ['a', 'b', 'c'], cons: ['x', 'y'], verdict: 'b'.repeat(15) },
        { name: 'C', rating: 4.5, pros: ['a', 'b', 'c'], cons: ['x', 'y'], verdict: 'c'.repeat(15) },
      ],
    });
    eq('metadata: keeps string, drops non-string + empty key', r.products[0].metadata, { good: 'val' });
    eq('specs: coerces num/bool/string, drops null+nested', r.products[0].specs, { w: '2.5', c: 'black', on: 'true' });
    eq('buyersGuide preserved', r.buyersGuide.howToChoose, 'choose wisely here');
  }

  // A null / non-object element in the products array → coerced to a placeholder
  // (which the completeness filter then drops), without throwing.
  {
    const r = validateResearchResult({
      summary: 'S', products: [
        null, 'a string',
        { name: 'A', rating: 4, pros: ['a'], cons: ['b'], verdict: 'a'.repeat(15) },
        { name: 'B', rating: 4, pros: ['a'], cons: ['b'], verdict: 'b'.repeat(15) },
        { name: 'C', rating: 4, pros: ['a'], cons: ['b'], verdict: 'c'.repeat(15) },
      ],
    });
    eq('null/non-object products dropped, valid kept', r.products.map((p) => p.name), ['A', 'B', 'C']);
  }

  // products not an array → [] (no throw); missing summary throws.
  eq('non-array products → empty', validateResearchResult({ summary: 'S', products: 'nope' }).products, []);
  {
    let threw = false;
    try { validateResearchResult({ products: [] }); } catch { threw = true; }
    eq('missing summary throws', threw, true);
  }
  // non-object input throws.
  {
    let threw = false;
    try { validateResearchResult(null); } catch { threw = true; }
    eq('null input throws', threw, true);
  }
  // buyersGuide absent → no buyersGuide key on the result.
  eq('no buyersGuide → omitted', 'buyersGuide' in validateResearchResult({
    summary: 'S', products: [
      { name: 'A', rating: 4, pros: ['a'], cons: ['b'], verdict: 'a'.repeat(15) },
      { name: 'B', rating: 4, pros: ['a'], cons: ['b'], verdict: 'b'.repeat(15) },
      { name: 'C', rating: 4, pros: ['a'], cons: ['b'], verdict: 'c'.repeat(15) },
    ],
  }), false);

  // Category gate: cross-category synth leaks (real-world bench failures).
  {
    const bulbCtx = { query: 'best smart light bulbs', topicalCategory: 'smart light bulbs' };
    const r = validateResearchResult({
      summary: 'Smart bulbs for Home Assistant.',
      category: 'smart light bulbs',
      products: [
        fullProd('Logitech M720 Triathlon Multi-Device', 4.5, 1, {
          verdict: 'A versatile wireless mouse for multi-device switching.',
          pros: ['Comfortable mouse shape', 'Bluetooth and USB receiver'],
        }),
        fullProd('Philips Hue White and Color Ambiance', 4.6, 2, {
          verdict: 'Top smart light bulb with broad Home Assistant support.',
        }),
        fullProd('LIFX Color Bulb', 4.4, 3, {
          verdict: 'Bright Wi-Fi smart bulb, no hub required.',
        }),
        fullProd('Nanoleaf Essentials Matter', 4.3, 4, {
          verdict: 'Affordable Matter smart bulb for whole-home lighting.',
        }),
      ],
    }, bulbCtx);
    eq('category gate drops mouse on bulb query', r.products.some((p) => /m720/i.test(p.name)), false);
    eq('category gate keeps legit bulbs', r.products.length >= 3, true);
  }
  {
    const fryerCtx = { query: 'best air fryer', topicalCategory: 'air fryers' };
    const r = validateResearchResult({
      summary: 'Air fryers for small kitchens.',
      category: 'air fryers',
      products: [
        fullProd('Shark BreatheClear Compact Pro HP062', 4.5, 1, {
          verdict: 'Compact air purifier with HEPA filtration.',
          pros: ['Quiet purifier mode', 'Good for small rooms'],
        }),
        fullProd('Ninja Foodi Dual Zone Air Fryer', 4.6, 2, {
          verdict: 'Excellent dual-basket air fryer for families.',
        }),
        fullProd('Cosori Pro LE Air Fryer', 4.4, 3, {
          verdict: 'Reliable budget air fryer with even cooking.',
        }),
        fullProd('Instant Vortex Plus', 4.3, 4, {
          verdict: 'Fast air fryer with simple controls.',
        }),
      ],
    }, fryerCtx);
    eq('category gate drops purifier mis-pick on fryer query', r.products.some((p) => /breathe/i.test(p.name)), false);
    eq('category gate keeps fryers', r.products.some((p) => /fryer/i.test(p.name)), true);
  }
  // CP-380: leaks the first gate let through. A query word outside the
  // category ("family", "four") or a bare modifier ("smart") matched a product
  // that never names its own type, and "tv" was too short to be checked.
  {
    const fryerCtx = { query: 'best air fryer for a family of four', topicalCategory: 'air fryers' };
    const r = validateResearchResult({
      summary: 'Air fryers for a family.',
      category: 'air fryers',
      products: [
        fullProd('Shark BreatheClear Compact Pro HP062', 4.7, 1, {
          verdict: 'Quiet, compact pick that keeps the whole family comfortable.',
          pros: ['Fits a large family room', 'Low noise at night'],
        }),
        fullProd('Ninja Foodi Dual Zone', 4.6, 2, { verdict: 'Excellent dual-basket air fryer for families.' }),
        fullProd('Cosori Pro LE', 4.4, 3, { verdict: 'Reliable budget air fryer with even cooking.' }),
        fullProd('Instant Vortex Plus', 4.3, 4, { verdict: 'Fast fryer with simple controls for four people.' }),
      ],
    }, fryerCtx);
    eq('cp380: query-only word "family" does not admit a purifier', r.products.some((p) => /breathe/i.test(p.name)), false);
    eq('cp380: fryers stay', r.products.length, 3);
  }
  {
    const bulbCtx = { query: 'best smart light bulbs for home assistant', topicalCategory: 'smart light bulbs' };
    const r = validateResearchResult({
      summary: 'Smart bulbs.',
      category: 'smart light bulbs',
      products: [
        fullProd('Logitech M720 Triathlon', 4.8, 1, {
          verdict: 'Smart multi-device switching for a busy desk.',
          pros: ['Works with Home Assistant via Bluetooth', 'Long battery life'],
        }),
        fullProd('Philips Hue White and Color Ambiance', 4.6, 2, { verdict: 'Top smart light bulb with broad support.' }),
        fullProd('LIFX Color', 4.4, 3, { verdict: 'Bright Wi-Fi smart bulb, no hub required.' }),
        fullProd('Nanoleaf Essentials Matter', 4.3, 4, { verdict: 'Affordable Matter bulb for whole-home lighting.' }),
      ],
    }, bulbCtx);
    eq('cp380: the modifier "smart" alone does not admit a mouse', r.products.some((p) => /m720/i.test(p.name)), false);
    eq('cp380: bulbs stay', r.products.length, 3);
  }
  {
    // The use clause still exempts its device noun from the foreign check.
    const r = validateResearchResult({
      summary: 'S', category: 'C',
      products: [
        fullProd('Spigen Ultra Hybrid', 4.6, 1, { verdict: 'Clear case for the iPhone 16 Pro that resists yellowing.' }),
        fullProd('OtterBox Defender', 4.5, 2, { verdict: 'Rugged iPhone case with a holster clip.' }),
        fullProd('Apple Silicone Case', 4.4, 3, { verdict: 'Soft-touch case made for the iPhone 16.' }),
      ],
    }, { query: 'best case for iphone 16', topicalCategory: 'phone cases' });
    eq('cp380: iPhone cases stay on a case-for-iPhone page', r.products.length, 3);
  }
  {
    // A modifier's singular form ("wireles") is still a modifier.
    const r = validateResearchResult({
      summary: 'S', category: 'C',
      products: [
        fullProd('Anker Soundcore Motion', 4.8, 1, { verdict: 'Loud wireless speaker for parties.' }),
        fullProd('Anker MagGo 3-in-1', 4.6, 2, { verdict: 'Fast Qi2 wireless charger stand.' }),
        fullProd('Belkin BoostCharge Pro', 4.5, 3, { verdict: 'Slim charger pad for phone and earbuds case.' }),
        fullProd('Mophie Snap+', 4.3, 4, { verdict: 'Magnetic wireless charger with a kickstand.' }),
      ],
    }, { query: 'best wireless charger', topicalCategory: 'wireless chargers' });
    eq('cp380: "wireless" alone does not admit a speaker', r.products.some((p) => /motion/i.test(p.name)), false);
  }
  {
    // A comparison keeps both sides after a use clause.
    const r = validateResearchResult({
      summary: 'S', category: 'C',
      products: [
        fullProd('LG C4 OLED', 4.9, 1, { verdict: 'Best OLED TV for movies.' }),
        fullProd('Samsung S90D OLED', 4.7, 2, { verdict: 'Bright OLED panel for gaming.' }),
        fullProd('Dell U2724D Monitor', 4.5, 3, { verdict: 'Sharp 4K monitor for office work.' }),
      ],
    }, { query: 'best monitor for gaming vs oled tv', topicalCategory: 'monitors' });
    eq('cp380: the other side of a "vs" query stays', r.products.length, 3);
  }
  {
    // Without a topical category, the query's own words still decide.
    const r = validateResearchResult({
      summary: 'S', category: 'C',
      products: [
        fullProd('Ninja Foodi Dual Zone', 4.6, 1, { verdict: 'Excellent dual-basket air fryer for families.' }),
        fullProd('Cosori Pro LE', 4.4, 2, { verdict: 'Reliable budget air fryer with even cooking.' }),
        fullProd('Instant Vortex Plus', 4.3, 3, { verdict: 'Fast air fryer with simple controls.' }),
      ],
    }, { query: 'best pair of air fryers', topicalCategory: '' });
    eq('cp380: without a category the whole query decides', r.products.length, 3);
  }
  eq('category gate skipped without ctx (bench compat)', validateResearchResult({
    summary: 'S', category: 'C',
    products: [
      fullProd('Logitech M720 Triathlon', 4.5, 1),
      fullProd('Pick B', 4.4, 2),
      fullProd('Pick C', 4.3, 3),
    ],
  }).products.length, 3);

  // Length and array size capping (data integrity defense)
  {
    const longName = 'N'.repeat(200);
    const longVerdict = 'V'.repeat(1000);
    const longSummary = 'S'.repeat(2000);
    const longPro = 'P'.repeat(500);
    const longCon = 'C'.repeat(500);
    const manyPros = Array.from({ length: 25 }, (_, i) => `Pro ${i}: ${longPro}`);
    const manyCons = Array.from({ length: 25 }, (_, i) => `Con ${i}: ${longCon}`);
    const manyProducts = Array.from({ length: 30 }, (_, i) => ({
      name: i === 0 ? longName : `Product ${i + 1}`,
      rating: 4.5,
      verdict: i === 0 ? longVerdict : 'Solid performer across all tests.',
      pros: i === 0 ? manyPros : ['pro1'],
      cons: i === 0 ? manyCons : ['con1'],
    }));

    const r = validateResearchResult({
      summary: longSummary,
      category: 'Electronics',
      products: manyProducts,
    });

    eq('summary capped at 1200', r.summary.length, 1200);
    eq('products array capped at 20', r.products.length, 20);
    eq('first product name capped at 120', r.products[0].name.length, 120);
    eq('first product verdict capped at 600', r.products[0].verdict.length, 600);
    eq('first product pros capped at 10 items', r.products[0].pros.length, 10);
    eq('first product cons capped at 10 items', r.products[0].cons.length, 10);
    eq('each pro capped at 240 chars', r.products[0].pros[0].length, 240);
    eq('each con capped at 240 chars', r.products[0].cons[0].length, 240);
  }

  return report;
}
