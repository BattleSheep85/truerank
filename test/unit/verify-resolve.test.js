// Unit tests for worker/engine/verify-resolve.js: universal product identity,
// sibling-model separation, and category-agnostic matching (CP-720).
import {
  productKeys,
  namesProduct,
  namesOtherModel,
  aboutProduct,
  productMentions,
  claimCandidateReason,
  rankClaimCandidates,
  testPagesToRead,
  evidencePagesToRead,
  findClaimCandidates,
  claimSearchQuery,
  searchClaimTests,
} from '../../worker/engine/verify-resolve.js';

export async function runVerifyResolveTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a);
    const E = JSON.stringify(e);
    if (A === E) report.passed++;
    else {
      report.failed++;
      report.failures.push(`${name}: expected ${E}, got ${A}`);
    }
  };
  const ok = (name, cond) => {
    if (cond) report.passed++;
    else {
      report.failed++;
      report.failures.push(name);
    }
  };

  // ── 1. productKeys: allowlisted variants stay, slug descriptors drop ──────
  eq('productKeys: Antec C8', productKeys('Antec C8'), ['antecc8']);
  eq('productKeys: Antec C8 Wood keeps wood variant', productKeys('Antec C8 Wood'), ['antecc8wood', 'c8wood']);
  eq(
    'productKeys: Antec C8 Dual Chamber Compatible Full Tower drops descriptor words (no c8dual)',
    productKeys('Antec C8 Dual Chamber Compatible Full Tower'),
    ['antecc8'],
  );
  eq('productKeys: Samsung Galaxy S25', productKeys('Samsung Galaxy S25'), ['galaxys25']);
  eq('productKeys: Samsung Galaxy S25 Ultra', productKeys('Samsung Galaxy S25 Ultra'), ['galaxys25ultra', 's25ultra']);
  eq('productKeys: Apple AirPods 2', productKeys('Apple AirPods 2'), ['airpods2']);
  eq('productKeys: Apple AirPods Pro 2 keeps pre-number Pro variant', productKeys('Apple AirPods Pro 2'), ['airpodspro2']);
  eq('productKeys: Sony WH-1000XM6', productKeys('Sony WH-1000XM6'), ['wh1000xm6']);
  eq('productKeys: Sony WF-1000XM6', productKeys('Sony WF-1000XM6'), ['wf1000xm6']);
  eq('productKeys: Creality K2 Combo', productKeys('Creality K2 Combo'), ['crealityk2combo', 'k2combo']);

  // Non-electronics categories
  eq('productKeys: Hankook Kinergy ST H735 tire', productKeys('Hankook Kinergy ST H735'), ['sth735', 'h735']);
  eq(
    'productKeys: Hankook Kinergy ST H735 All Season Radial Tire 205/55R16 ignores tire size & descriptors',
    productKeys('Hankook Kinergy ST H735 All Season Radial Tire 205/55R16'),
    ['sth735', 'h735'],
  );
  eq('productKeys: Michelin Defender 2 tire', productKeys('Michelin Defender 2 All Season Tire'), ['defender2']);
  eq('productKeys: Vitamix 5200 kitchen blender', productKeys('Vitamix 5200 Blender'), ['vitamix5200', '5200']);
  eq('productKeys: Instant Pot Duo 7-in-1 pressure cooker ignores 7-in-1 spec', productKeys('Instant Pot Duo 7-in-1 Electric Pressure Cooker'), ['potduo']);
  eq('productKeys: Instant Pot Duo Plus keeps Plus variant', productKeys('Instant Pot Duo Plus 9-in-1 Electric Pressure Cooker'), ['potduoplus']);
  eq('productKeys: DEWALT 20V MAX Cordless Drill DCD771C2 uses model code, not 20V spec', productKeys('DEWALT 20V MAX Cordless Drill DCD771C2'), ['dcd771c2']);
  eq('productKeys: Brooks Ghost 16 running shoes', productKeys('Brooks Ghost 16 Mens Running Shoes'), ['ghost16']);

  // ── 2. Sibling-model separation: Antec C8 vs Antec C8 Wood ────────────────
  const c8Page = { url: 'https://www.techpowerup.com/review/antec-c8/', title: 'Antec C8 Full Tower Chassis Review' };
  const c8WoodPage = { url: 'https://www.techpowerup.com/review/antec-c8-wood/', title: 'Antec C8 Wood Review' };
  const c8MakerPage = { url: 'https://www.antec.com/product/case/c8', title: 'Antec C8' };
  const c8WoodMakerPage = { url: 'https://www.antec.com/product/case/c8-wood', title: 'Antec C8 Wood' };

  eq('namesProduct: Antec C8 matches Antec C8 review', namesProduct(c8Page, 'Antec C8'), true);
  eq('namesProduct: Antec C8 full slug matches Antec C8 review', namesProduct(c8Page, 'Antec C8 Dual Chamber Compatible Full Tower'), true);
  eq('namesProduct: Antec C8 does NOT match Antec C8 Wood review', namesProduct(c8WoodPage, 'Antec C8'), false);
  eq('namesProduct: Antec C8 Wood matches Antec C8 Wood review', namesProduct(c8WoodPage, 'Antec C8 Wood'), true);
  eq('namesProduct: Antec C8 Wood does NOT match base Antec C8 review', namesProduct(c8Page, 'Antec C8 Wood'), false);

  eq('namesOtherModel: checking Antec C8 rejects Antec C8 Wood review', namesOtherModel(c8WoodPage, 'Antec C8'), true);
  eq('namesOtherModel: checking Antec C8 accepts Antec C8 review', namesOtherModel(c8Page, 'Antec C8'), false);
  eq('namesOtherModel: checking Antec C8 Wood rejects base Antec C8 review', namesOtherModel(c8Page, 'Antec C8 Wood'), true);
  eq('namesOtherModel: checking Antec C8 Wood accepts Antec C8 Wood review', namesOtherModel(c8WoodPage, 'Antec C8 Wood'), false);

  eq('claimCandidateReason: Antec C8 accepts c8 maker page', claimCandidateReason(c8MakerPage, 'Antec C8'), 'maker');
  eq('claimCandidateReason: Antec C8 rejects c8-wood maker page as other-product', claimCandidateReason(c8WoodMakerPage, 'Antec C8'), 'other-product');
  eq('claimCandidateReason: Antec C8 Wood accepts c8-wood maker page', claimCandidateReason(c8WoodMakerPage, 'Antec C8 Wood'), 'maker');
  eq('claimCandidateReason: Antec C8 Wood rejects base c8 maker page', claimCandidateReason(c8MakerPage, 'Antec C8 Wood'), 'other-product');

  eq(
    'aboutProduct: Antec C8 does NOT match content only about Antec C8 Wood',
    aboutProduct({ url: 'https://example.com/cases', title: 'PC Cases', content: 'We tested the Antec C8 Wood and measured temperatures.' }, 'Antec C8'),
    false,
  );
  eq(
    'productMentions: Antec C8 does NOT match "Antec C8 Wood" mention',
    productMentions('The Antec C8 Wood has a walnut panel, whereas the Antec C8 uses mesh.', 'Antec C8'),
    [50],
  );

  // ── 3. Sibling-model separation: Samsung Galaxy S25 vs Galaxy S25 Ultra ───
  const s25Page = { url: 'https://www.gsmarena.com/samsung_galaxy_s25-review.php', title: 'Samsung Galaxy S25 review' };
  const s25UltraPage = { url: 'https://www.gsmarena.com/samsung_galaxy_s25_ultra-review.php', title: 'Samsung Galaxy S25 Ultra review' };
  const s25PlusPage = { url: 'https://www.gsmarena.com/samsung_galaxy_s25_plus-review.php', title: 'Samsung Galaxy S25 Plus review' };

  eq('namesProduct: Galaxy S25 matches S25 review', namesProduct(s25Page, 'Samsung Galaxy S25'), true);
  eq('namesProduct: Galaxy S25 does NOT match S25 Ultra review', namesProduct(s25UltraPage, 'Samsung Galaxy S25'), false);
  eq('namesOtherModel: checking Galaxy S25 rejects S25 Ultra review', namesOtherModel(s25UltraPage, 'Samsung Galaxy S25'), true);
  eq('namesOtherModel: checking Galaxy S25 rejects S25 Plus review', namesOtherModel(s25PlusPage, 'Samsung Galaxy S25'), true);
  eq('namesOtherModel: checking Galaxy S25 Ultra rejects base S25 review', namesOtherModel(s25Page, 'Samsung Galaxy S25 Ultra'), true);
  eq('namesOtherModel: checking Galaxy S25 Ultra rejects S25 Plus review', namesOtherModel(s25PlusPage, 'Samsung Galaxy S25 Ultra'), true);
  eq('namesProduct: Galaxy S25 Ultra matches S25 Ultra review', namesProduct(s25UltraPage, 'Samsung Galaxy S25 Ultra'), true);

  // ── 4. Sibling-model separation: Apple AirPods Pro 2 vs Apple AirPods 2 ───
  const airpods2Page = { url: 'https://www.rtings.com/headphones/reviews/apple/airpods-2', title: 'Apple AirPods 2 Review' };
  const airpodsPro2Page = { url: 'https://www.rtings.com/headphones/reviews/apple/airpods-pro-2', title: 'Apple AirPods Pro 2 Review' };

  eq('namesProduct: AirPods 2 matches AirPods 2 review', namesProduct(airpods2Page, 'Apple AirPods 2'), true);
  eq('namesProduct: AirPods 2 does NOT match AirPods Pro 2 review', namesProduct(airpodsPro2Page, 'Apple AirPods 2'), false);
  eq('namesOtherModel: checking AirPods 2 rejects AirPods Pro 2 review', namesOtherModel(airpodsPro2Page, 'Apple AirPods 2'), true);
  eq('namesProduct: AirPods Pro 2 matches AirPods Pro 2 review', namesProduct(airpodsPro2Page, 'Apple AirPods Pro 2'), true);
  eq('namesProduct: AirPods Pro 2 does NOT match AirPods 2 review', namesProduct(airpods2Page, 'Apple AirPods Pro 2'), false);
  eq('namesOtherModel: checking AirPods Pro 2 rejects AirPods 2 review', namesOtherModel(airpods2Page, 'Apple AirPods Pro 2'), true);

  // ── 5. Sibling-model separation: Sony WH-1000XM6 vs Sony WF-1000XM6 ───────
  const whPage = { url: 'https://www.soundguys.com/sony-wh-1000xm6-review/', title: 'Sony WH-1000XM6 review' };
  const wfPage = { url: 'https://www.soundguys.com/sony-wf-1000xm6-review/', title: 'Sony WF-1000XM6 review' };

  eq('namesProduct: WH-1000XM6 matches WH-1000XM6 review', namesProduct(whPage, 'Sony WH-1000XM6'), true);
  eq('namesProduct: WH-1000XM6 does NOT match WF-1000XM6 review', namesProduct(wfPage, 'Sony WH-1000XM6'), false);
  eq('namesOtherModel: checking WH-1000XM6 rejects WF-1000XM6 review', namesOtherModel(wfPage, 'Sony WH-1000XM6'), true);
  eq('namesProduct: WF-1000XM6 matches WF-1000XM6 review', namesProduct(wfPage, 'Sony WF-1000XM6'), true);
  eq('namesOtherModel: checking WF-1000XM6 rejects WH-1000XM6 review', namesOtherModel(whPage, 'Sony WF-1000XM6'), true);

  // ── 6. Category-agnostic matching: tires, kitchen, tools, footwear ────────
  // Tires
  const hankookPage = { url: 'https://www.tirerack.com/tires/hankook-kinergy-st-h735', title: 'Hankook Kinergy ST (H735) Test Results' };
  const otherTirePage = { url: 'https://www.tirerack.com/tires/hankook-kinergy-gt-h436', title: 'Hankook Kinergy GT (H436) Test Results' };
  eq('Tire: namesProduct matches Hankook Kinergy ST H735 review', namesProduct(hankookPage, 'Hankook Kinergy ST H735'), true);
  eq('Tire: namesProduct rejects different Hankook model H436', namesProduct(otherTirePage, 'Hankook Kinergy ST H735'), false);

  // Kitchen appliances
  const duoPage = { url: 'https://www.seriouseats.com/instant-pot-duo-review', title: 'Instant Pot Duo Pressure Cooker Review' };
  const duoPlusPage = { url: 'https://www.seriouseats.com/instant-pot-duo-plus-review', title: 'Instant Pot Duo Plus Review' };
  eq('Kitchen: Instant Pot Duo 7-in-1 matches Instant Pot Duo review', namesProduct(duoPage, 'Instant Pot Duo 7-in-1 Electric Pressure Cooker'), true);
  eq('Kitchen: Instant Pot Duo rejects Instant Pot Duo Plus review', namesOtherModel(duoPlusPage, 'Instant Pot Duo 7-in-1 Electric Pressure Cooker'), true);
  eq('Kitchen: Instant Pot Duo Plus rejects base Instant Pot Duo review', namesOtherModel(duoPage, 'Instant Pot Duo Plus 9-in-1 Electric Pressure Cooker'), true);

  // Tools
  const dewaltPage = { url: 'https://www.protoolreviews.com/dewalt-dcd771c2-review/', title: 'DEWALT DCD771C2 20V MAX Drill Review' };
  const otherDewaltPage = { url: 'https://www.protoolreviews.com/dewalt-dcd791d2-review/', title: 'DEWALT DCD791D2 20V MAX Brushless Drill Review' };
  eq('Tools: DEWALT DCD771C2 matches its review', namesProduct(dewaltPage, 'DEWALT 20V MAX Cordless Drill DCD771C2'), true);
  eq('Tools: DEWALT DCD771C2 rejects DCD791D2 review', namesOtherModel(otherDewaltPage, 'DEWALT 20V MAX Cordless Drill DCD771C2'), true);

  // Footwear
  const ghost16Page = { url: 'https://www.runrepeat.com/brooks-ghost-16', title: 'Brooks Ghost 16 Review' };
  const ghost15Page = { url: 'https://www.runrepeat.com/brooks-ghost-15', title: 'Brooks Ghost 15 Review' };
  eq('Footwear: Brooks Ghost 16 matches Ghost 16 review', namesProduct(ghost16Page, 'Brooks Ghost 16 Mens Running Shoes'), true);
  eq('Footwear: Brooks Ghost 16 rejects Ghost 15 review', namesOtherModel(ghost15Page, 'Brooks Ghost 16 Mens Running Shoes'), true);

  // ── 7. testPagesToRead & evidencePagesToRead exclude sibling variants ─────
  const mixedSources = [
    { ...c8WoodPage, content: 'short snippet about Antec C8 Wood', credibility: { score: 80 } },
    { ...c8Page, content: 'short snippet about Antec C8', credibility: { score: 75 } },
  ];
  eq(
    'testPagesToRead: checking Antec C8 keeps only Antec C8 review, dropping Antec C8 Wood',
    testPagesToRead(mixedSources, 'Antec C8').map((s) => s.url),
    [c8Page.url],
  );
  eq(
    'evidencePagesToRead: checking Antec C8 keeps only Antec C8 review, dropping Antec C8 Wood',
    evidencePagesToRead(mixedSources, 'Antec C8').map((s) => s.url),
    [c8Page.url],
  );
  eq(
    'rankClaimCandidates: checking Antec C8 keeps only c8 maker page, dropping c8-wood',
    rankClaimCandidates([c8WoodMakerPage, c8MakerPage], 'Antec C8').map((s) => s.url),
    [c8MakerPage.url],
  );

  // ── 8. Search queries distill noisy 6-to-10-word SEO names ────────────────
  const noisyProduct = 'Antec C8 Dual Chamber Compatible Full Tower';
  eq(
    'claimSearchQuery distills 7-word SEO product name to "Antec C8"',
    claimSearchQuery(noisyProduct, ['360', 'mm', 'radiator', 'support']),
    'Antec C8 mm radiator support review test',
  );
  const candidateSearch = await findClaimCandidates({
    product: noisyProduct,
    env: {},
    search: async () => [c8WoodMakerPage, c8MakerPage],
  });
  eq('findClaimCandidates queries distilled product name', candidateSearch.queries, ['Antec C8', 'Antec C8 specs']);
  eq('findClaimCandidates ranks only base Antec C8 page', candidateSearch.candidates.map((c) => c.url), [c8MakerPage.url]);

  const testSearch = await searchClaimTests({
    claims: [{ id: 'c1', text: 'Supports 360mm radiator', type: 'spec' }],
    product: 'Hankook Kinergy ST H735 All Season Radial Tire 205 55R16',
    termsFor: () => ['treadwear', 'warranty'],
    env: {},
    search: async () => [],
  });
  eq(
    'searchClaimTests queries distilled tire product name',
    testSearch.queries,
    ['Hankook Kinergy ST H735 treadwear warranty review test'],
  );
  ok('verify-resolve suite ran assertions', report.passed > 0);

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runVerifyResolveTests();
  console.log(`verify-resolve: ${r.passed}/${r.passed + r.failed} passed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.error('  FAIL', f);
    process.exit(1);
  }
}
