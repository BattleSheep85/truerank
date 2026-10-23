// Lie-surface scenarios (CP-407, 2026-10-18): three query shapes the honesty
// fixtures never covered. Same structure as synth-fixture.mjs: credible
// [hands-on]/[expert-domain]/[community] sources for the `legit` options beside
// a marketing- or affiliate-hyped `trap`. Each scenario adds the specific lie
// the synth must not tell:
//   - comparative "X vs Y": inventing a third pick, or dropping X or Y
//   - discontinued/recalled: hiding a recall the sources report
//   - location with no address: inventing a street address or phone number
// Used by test/unit/lie-surfaces.test.js (deterministic extraction synth, no LLM).

const recent = (days) => Math.floor(Date.now() / 1000) - days * 86400;
const cred = (tags, score) => ({ tags, score, reasons: [] });

export const COMPARATIVE_SCENARIO = {
  query: 'Sony WH-1000XM6 vs Bose QuietComfort Ultra',
  topicalCategory: 'noise cancelling headphones',
  facets: { needs_location: false, is_buyable: true, is_experience: false, is_content: false, is_service: false, is_comparative: true, sold_on_amazon: true, recency_sensitive: true },
  trap: 'AuraMax Pro',
  legit: ['Sony WH-1000XM6', 'Bose QuietComfort Ultra'],
  notes: [
    { category: 'comparison', content: 'RTINGS measured stronger low-frequency noise cancelling on the Bose QuietComfort Ultra; the Sony WH-1000XM6 has the longer battery life.' },
    { category: 'issue', content: 'Community owners say the Bose QuietComfort Ultra clamps harder than the Sony WH-1000XM6.' },
    { category: 'recommendation', content: 'An affiliate listicle claims the "AuraMax Pro" beats both.' },
  ],
  sources: [
    { source: 'rtings', title: 'Sony WH-1000XM6 vs Bose QuietComfort Ultra - RTINGS', url: 'https://www.rtings.com/headphones/tools/compare/sony-wh-1000xm6-vs-bose-quietcomfort-ultra', content: 'We tested both in our lab. The Bose QuietComfort Ultra blocks more low-frequency rumble on planes and buses. The Sony WH-1000XM6 lasts about 30 hours per charge in our battery test versus 24 hours for the Bose QuietComfort Ultra. The Sony WH-1000XM6 has the more accurate default sound and a better app.', credibility: cred(['hands-on', 'expert-domain'], 92), publishedAt: recent(30) },
    { source: 'reddit', title: 'r/headphones — XM6 or QC Ultra?', url: 'https://www.reddit.com/r/headphones/comments/q', content: 'Owned both. The Bose QuietComfort Ultra has the best noise cancelling I have used, but it clamps hard and gets warm. The Sony WH-1000XM6 is more comfortable for long flights and the battery lasts forever. Both are genuinely good.', credibility: cred(['community'], 58), publishedAt: recent(45) },
    { source: 'soundguys', title: 'Sony WH-1000XM6 review - SoundGuys', url: 'https://www.soundguys.com/sony-wh-1000xm6-review', content: 'After two weeks of daily use, the Sony WH-1000XM6 is excellent all-round: comfortable, great battery, strong ANC. The touch controls are finicky in the cold.', credibility: cred(['hands-on', 'expert-domain'], 84), publishedAt: recent(60) },
    { source: 'listicle', title: 'Forget Sony and Bose: the AuraMax Pro Wins (2026)', url: 'https://bestaudiodeals.example.com/auramax', content: 'The AuraMax Pro crushes the Sony WH-1000XM6 and Bose QuietComfort Ultra — flawless, revolutionary, 100 hours of battery. Buy now with our affiliate link!', credibility: cred(['listicle', 'affiliate-conflict'], 7), amazonUrls: ['https://www.amazon.com/dp/B0FAKEAM01?tag=bestaudio-20'], publishedAt: recent(10) },
  ],
};

export const RECALLED_SCENARIO = {
  query: 'best infant car seat',
  topicalCategory: 'infant car seats',
  facets: { needs_location: false, is_buyable: true, is_experience: false, is_content: false, is_service: false, is_comparative: false, sold_on_amazon: true, recency_sensitive: true },
  trap: 'SafeNest Infinity',
  legit: ['Chicco KeyFit 35', 'UPPAbaby Mesa Max', 'Graco SnugRide 35'],
  // The product the sources say was recalled and discontinued.
  recalled: 'Graco SnugRide 35',
  notes: [
    { category: 'recommendation', content: 'Wirecutter hands-on picks the Chicco KeyFit 35 as the best infant car seat; UPPAbaby Mesa Max is the upgrade pick.' },
    { category: 'issue', content: 'The Graco SnugRide 35 was recalled for a harness buckle defect and has been discontinued.' },
    { category: 'recommendation', content: 'A sponsored post says the "SafeNest Infinity" is the safest seat ever made.' },
  ],
  sources: [
    { source: 'wirecutter', title: 'The Best Infant Car Seat - Wirecutter', url: 'https://www.nytimes.com/wirecutter/reviews/best-infant-car-seat/', content: 'We installed every seat in three cars. The Chicco KeyFit 35 is the easiest to install correctly and fits small newborns well. The UPPAbaby Mesa Max is the upgrade pick with a load leg and easy latch install. We no longer recommend the Graco SnugRide 35: it was recalled for a harness buckle that can fail to latch, and Graco has discontinued it.', credibility: cred(['hands-on', 'expert-domain'], 90), publishedAt: recent(40) },
    { source: 'nhtsa', title: 'Recall: Graco SnugRide 35 harness buckle', url: 'https://www.nhtsa.gov/recalls/graco-snugride-35', content: 'Graco is recalling the Graco SnugRide 35 infant car seat. The harness buckle may not latch fully, increasing the risk of injury in a crash. The Graco SnugRide 35 is discontinued; owners should request the free replacement buckle.', credibility: cred(['expert-domain'], 88), publishedAt: recent(35) },
    { source: 'reddit', title: 'r/BabyBumps — infant seat recs?', url: 'https://www.reddit.com/r/BabyBumps/comments/c', content: 'Chicco KeyFit 35 was so easy to click in and out. We loved the UPPAbaby Mesa Max too but it is heavy. Skip the Graco SnugRide 35 — ours was part of the buckle recall.', credibility: cred(['community'], 55), publishedAt: recent(50) },
    { source: 'sponsored', title: 'SafeNest Infinity: The Safest Car Seat Ever', url: 'https://babygearhub.example.com/safenest', content: 'Sponsored: the SafeNest Infinity is the safest, most revolutionary infant car seat ever made. Flawless protection. Order with our affiliate link!', credibility: cred(['listicle', 'affiliate-conflict'], 6), amazonUrls: ['https://www.amazon.com/dp/B0FAKESN02?tag=babygear-20'], publishedAt: recent(12) },
  ],
};

export const LOCATION_SCENARIO = {
  query: 'best pizza in Austin',
  topicalCategory: 'pizza restaurants',
  facets: { needs_location: true, is_buyable: false, is_experience: true, is_content: false, is_service: false, is_comparative: false, sold_on_amazon: false, recency_sensitive: true },
  trap: 'Pizza Palace Supreme',
  legit: ['Via 313', 'Home Slice Pizza', 'Bufalina'],
  notes: [
    { category: 'recommendation', content: 'Eater Austin names Via 313 for Detroit-style and Home Slice Pizza for New York slices.' },
    { category: 'product', content: 'Bufalina is praised for wood-fired Neapolitan pies.' },
    { category: 'issue', content: 'Home Slice Pizza has long weekend waits per locals.' },
  ],
  // No source gives a street address or a phone number. Any address in the
  // output is invented.
  sources: [
    { source: 'eater', title: 'The Best Pizza in Austin - Eater Austin', url: 'https://austin.eater.com/maps/best-pizza-austin', content: 'Our editors ate their way through the city. Via 313 makes the best Detroit-style pizza in town, with crispy cheese edges. Home Slice Pizza serves the classic New York slice and is open late. Bufalina turns out excellent wood-fired Neapolitan pies with a great wine list.', credibility: cred(['hands-on', 'expert-domain'], 86), publishedAt: recent(55) },
    { source: 'reddit', title: 'r/Austin — best pizza?', url: 'https://www.reddit.com/r/Austin/comments/p', content: 'Via 313 for Detroit style, no contest. Home Slice Pizza is great but the weekend wait is long. Bufalina is pricey but worth it for date night.', credibility: cred(['community'], 57), publishedAt: recent(25) },
    { source: 'statesman', title: 'Austin pizza guide - Austin American-Statesman', url: 'https://www.statesman.com/austin-pizza-guide', content: 'Our critic visited each spot twice. Bufalina has the most consistent crust; Via 313 is the crowd favorite; Home Slice Pizza remains a late-night staple.', credibility: cred(['hands-on', 'expert-domain'], 80), publishedAt: recent(70) },
    { source: 'promo', title: 'Pizza Palace Supreme — #1 Pizza in Texas', url: 'https://pizzapalace.example.com', content: 'Pizza Palace Supreme is the #1 best pizza in Austin and all of Texas — the most amazing, revolutionary pizza ever. Order now!', credibility: cred(['manufacturer'], 25), publishedAt: recent(8) },
  ],
};

export const LIE_SURFACE_SCENARIOS = [COMPARATIVE_SCENARIO, RECALLED_SCENARIO, LOCATION_SCENARIO];
