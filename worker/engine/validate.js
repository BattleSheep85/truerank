import { isChurnBrand } from '../lib/brand-quality.js';
import { filterByCategory } from '../lib/category-gate.js';
import { parsePriceConstraint, applyPriceConstraint } from '../lib/constraints.js';

// Hosts that only serve pages (never direct images) — if the LLM hands us one
// of these, it's a review/video/listing URL, not an image.
const NON_IMAGE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'vimeo.com', 'www.vimeo.com',
  'tiktok.com', 'www.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'twitter.com', 'x.com', 'facebook.com', 'www.facebook.com',
  'reddit.com', 'www.reddit.com',
]);

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i;

function sanitizeImageUrl(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (!/^https:\/\//i.test(trimmed)) return '';
  if (trimmed.length > 2000) return '';
  // Path must end in a recognized image extension (query/fragment allowed after).
  // Rejects page URLs the LLM occasionally returns (alltrails trail pages,
  // tripadvisor review pages, manufacturer homepages, article URLs).
  if (!IMAGE_EXT_RE.test(trimmed)) return '';
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (NON_IMAGE_HOSTS.has(host)) return '';
    if (host.endsWith('.youtube.com') || host.endsWith('.vimeo.com')) return '';
  } catch {
    return '';
  }
  return trimmed;
}

function sanitizeMetadata(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (typeof k !== 'string') continue;
    if (typeof v !== 'string') continue;
    const key = k.trim().slice(0, 40);
    const value = v.trim().slice(0, 240);
    if (key && value) out[key] = value;
  }
  return out;
}

// CP-399: verbatim 1-2★ review quotes ({quote, stars, sourceUrl, sourceTitle}) shown in the
// "rated it low" block. Only https sources, low stars, short quotes; anything else is dropped.
const CAP_CRITICAL_REVIEWS = 2;
const CAP_CRITICAL_TITLE = 120;
function sanitizeCriticalReviews(val) {
  if (!Array.isArray(val)) return [];
  return val
    .filter((r) => r && typeof r === 'object' && typeof r.quote === 'string' && r.quote.trim())
    .filter((r) => typeof r.stars === 'number' && r.stars >= 1 && r.stars <= 2)
    .filter((r) => typeof r.sourceUrl === 'string' && /^https:\/\/[^\s]+$/i.test(r.sourceUrl) && r.sourceUrl.length <= 2000)
    .slice(0, CAP_CRITICAL_REVIEWS)
    .map((r) => ({
      quote: r.quote.trim().slice(0, CAP_PRO_CON),
      stars: r.stars,
      sourceUrl: r.sourceUrl,
      sourceTitle: (typeof r.sourceTitle === 'string' ? r.sourceTitle.trim() : '').slice(0, CAP_CRITICAL_TITLE),
    }));
}

// Accept any flat object whose values can be coerced to strings. The synthesis
// LLM sometimes returns mixed-type specs like `{weight: 2.5, color: "black"}` —
// dropping the entire specs map because one value is numeric loses useful data.
function coerceStringRecord(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return {};
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (v == null) continue;
    if (typeof v === 'string') { out[k] = v; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = String(v); continue; }
    // Skip nested objects/arrays.
  }
  return out;
}

function extractBuyersGuide(val) {
  if (!val || typeof val !== 'object') return undefined;
  const g = val;
  const howToChoose = typeof g.howToChoose === 'string' ? g.howToChoose.trim() : '';
  const pitfalls = Array.isArray(g.pitfalls) ? g.pitfalls.filter((x) => typeof x === 'string' && x.trim().length > 0) : [];
  const marketingToIgnore = Array.isArray(g.marketingToIgnore) ? g.marketingToIgnore.filter((x) => typeof x === 'string' && x.trim().length > 0) : [];
  if (!howToChoose && pitfalls.length === 0 && marketingToIgnore.length === 0) return undefined;
  return { howToChoose, pitfalls, marketingToIgnore };
}

// Editorial-rating floor. A pick the synth scored below this is treated as
// low-confidence/promotional (the marketplace-churn-brand signature) and dropped
// when better picks exist. Strict less-than, so an honest 3.5 survives; anything
// the synth rated 3.4 or below — including Coofandy-style no-names — does not.
// Raised from 3.0 → 3.5 per the "go aggressive" directive (2026-06-18).
export const MIN_RATING = 3.5;

/**
 * Quality gate. Two layers, then a renumber:
 *  1. Hard-drop known marketplace-churn brands UNCONDITIONALLY (their star
 *     ratings are gamed, so the floor can't catch them) — these are never shown.
 *  2. Drop sub-floor-rated picks while ≥3 stronger picks remain — the softer
 *     signal, so it keeps a usable list in thin categories. Null ratings (honest
 *     "too thin to score") are never dropped; price is never a factor.
 *
 * We deliberately do NOT re-sort by rating: rating is not the only ranking
 * signal (intent fit, price, availability matter too), so the synth's holistic
 * order is preserved among the survivors. Pure + immutable.
 *
 * @param {Array<object>} products - completeness-filtered product objects
 * @returns {Array<object>} surviving picks, re-ranked 1..n in the synth's order
 */
export function applyQualityGate(products) {
  if (!Array.isArray(products) || products.length === 0) return products;

  // Layer 1 — churn denylist. Unconditional: a known no-name marketplace brand
  // is never shown even if it's the only thing left (an all-junk query then
  // yields an honest non-result downstream, which is correct).
  const notChurn = products.filter((p) => !isChurnBrand(p.brand));

  // Layer 2 — editorial-rating floor, with a ≥3-survivors guard so a thin
  // category keeps its best available options instead of collapsing.
  const strong = notChurn.filter((p) => p.rating === null || p.rating >= MIN_RATING);
  const kept = strong.length >= 3 ? strong : notChurn;

  // Renumber 1..n following the synth's own rank field (robust to an array that
  // isn't already rank-ordered); stable on ties so the original order wins.
  return kept
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.rank - b.p.rank) || (a.i - b.i))
    .map(({ p }, i) => ({ ...p, rank: i + 1 }));
}

// Space-joined clarification answer values. The classifier's answer map
// should always hold strings, but upstream data is never trusted blindly, so
// a non-string value is skipped rather than coerced.
function clarificationValues(clarifications) {
  if (!clarifications || typeof clarifications !== 'object') return [];
  return Object.values(clarifications).filter((v) => typeof v === 'string');
}

// Field length and array size caps for persisted research objects.
export const CAP_NAME = 120;
export const CAP_VERDICT = 600;
export const CAP_SUMMARY = 1200;
export const CAP_PRO_CON = 240;
export const CAP_PROS_CONS_COUNT = 10;
export const CAP_PRODUCTS_COUNT = 20;

/**
 * @param {object} data - raw synth JSON
 * @param {{ query?: string, topicalCategory?: string, clarifications?: object }} [ctx] - when set, drops cross-category products and enforces a stated price cap or floor
 */
export function validateResearchResult(data, ctx = {}) {
  if (!data || typeof data !== 'object') throw new Error('Response is not an object');
  const obj = data;

  const rawSummary = typeof obj.summary === 'string' ? obj.summary : '';
  const summary = rawSummary.slice(0, CAP_SUMMARY);
  const category = (typeof obj.category === 'string' ? obj.category : 'General').slice(0, 80);
  const methodology = (typeof obj.methodology === 'string' ? obj.methodology : '').slice(0, 1200);

  if (!summary) throw new Error('Missing summary in response');

  const rawProducts = Array.isArray(obj.products) ? obj.products : [];
  const products = rawProducts.slice(0, CAP_PRODUCTS_COUNT).map((p, i) => {
    // Drop items the LLM left under-specified — honest cards need pros AND cons.
    if (!p || typeof p !== 'object') {
      return { name: `Item ${i + 1}`, brand: '', price: null, rating: null, productUrl: '', manufacturerUrl: '', imageUrl: '', pros: [], cons: [], specs: {}, metadata: {}, verdict: '', rank: i + 1, bestFor: '', criticalReviews: [] };
    }
    const prod = p;
    const rawName = typeof prod.name === 'string' && prod.name ? prod.name : `Item ${i + 1}`;
    const name = rawName.slice(0, CAP_NAME);
    const brand = (typeof prod.brand === 'string' ? prod.brand : '').slice(0, 80);
    const verdict = (typeof prod.verdict === 'string' ? prod.verdict : '').slice(0, CAP_VERDICT);
    const bestFor = (typeof prod.bestFor === 'string' ? prod.bestFor : '').slice(0, 120);
    const pros = (Array.isArray(prod.pros) ? prod.pros.filter((x) => typeof x === 'string') : [])
      .map((x) => x.slice(0, CAP_PRO_CON))
      .slice(0, CAP_PROS_CONS_COUNT);
    const cons = (Array.isArray(prod.cons) ? prod.cons.filter((x) => typeof x === 'string') : [])
      .map((x) => x.slice(0, CAP_PRO_CON))
      .slice(0, CAP_PROS_CONS_COUNT);

    return {
      name,
      brand,
      price: typeof prod.price === 'number' ? prod.price : null,
      rating: typeof prod.rating === 'number' && prod.rating >= 0 && prod.rating <= 5 ? prod.rating : null,
      productUrl: typeof prod.productUrl === 'string' ? prod.productUrl : '',
      manufacturerUrl: typeof prod.manufacturerUrl === 'string' ? prod.manufacturerUrl : '',
      imageUrl: sanitizeImageUrl(prod.imageUrl),
      pros,
      cons,
      specs: coerceStringRecord(prod.specs),
      metadata: sanitizeMetadata(prod.metadata),
      verdict,
      rank: typeof prod.rank === 'number' ? prod.rank : i + 1,
      bestFor,
      criticalReviews: sanitizeCriticalReviews(prod.criticalReviews),
    };
  });

  // Drop items missing essential fields. Brand is optional (restaurants, trails,
  // services often have no "brand"). Require name + real evidence (≥1 pro OR ≥1 con) +
  // 10+ char verdict. NB: the honest extraction synth ABSTAINS on cons when the sources
  // carry no criticism (it never fabricates), so requiring ≥1 con (the old LLM-synth
  // assumption, which always invented cons) wrongly dropped ~20 legit pros-only products
  // — that collapsed comprehensiveness. A pros-only product ships with its honest
  // "no criticism surfaced" verdict. Never drop below 3 items to preserve the comparison.
  const complete = products.filter(
    (p) => p.name && (p.pros.length >= 1 || p.cons.length >= 1) && p.verdict.length >= 10,
  );
  let filtered = complete.length >= 3 ? complete : products;

  // Category gate (LLM synth path): same intent as extract/engine.js inCategory —
  // a mouse must not rank #1 on a smart-bulb query. Fail-open when ctx is omitted
  // (bench scripts parsing cached JSON without query context).
  if (ctx.query || ctx.topicalCategory) {
    filtered = filterByCategory(filtered, ctx.topicalCategory, ctx.query);
  }

  // Price gate: enforce a budget cap or floor stated in the query or in the
  // clarification answers (for example "under $500"). Before this gate, that
  // text was read ONLY to decide whether to ask a clarifying question
  // (worker/lib/classifier.js), so an over-cap product could still rank #1.
  // Fail-open when ctx.query is absent (bench scripts parsing cached JSON
  // without query context). A product with no known price is never dropped:
  // an honest "price not found" is not proof of an over-budget pick. The cap
  // or floor is only applied while at least two products would still be
  // left, so a strict budget can never collapse a thin category down to a
  // broken report.
  if (ctx.query) {
    const priceSource = [ctx.query, ...clarificationValues(ctx.clarifications)].join(' ');
    filtered = applyPriceConstraint(filtered, parsePriceConstraint(priceSource));
  }

  // Quality gate: drop picks the synth itself rated below the floor. The rating
  // is OUR editorial score (derived from source credibility, per the synth
  // prompt), so a sub-3/5 score means the evidence is thin/promotional — the
  // signature of a no-name marketplace-churn brand (the "cheap knockoff" a savvy
  // buyer avoids). We only drop while ≥3 stronger picks remain, so thin
  // categories keep their best available options. Crucial guards against
  // over-filtering legit budget brands: a null rating is honest "too thin to
  // score" and is NEVER dropped; price/cheapness is never a factor here.
  const ranked = applyQualityGate(filtered);

  const buyersGuide = extractBuyersGuide(obj.buyersGuide);

  return { summary, category, products: ranked, methodology, ...(buyersGuide ? { buyersGuide } : {}) };
}
