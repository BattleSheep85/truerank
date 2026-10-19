// Candidate product-name harvesting + entity resolution for the extraction engine.
// Pulls Title-Case / brand-led name candidates out of source + note prose, strips
// boilerplate/chrome, splits merged multi-product mentions, and folds aliases of the
// same product together. Split out of engine.js (2026-07) to stay under the 800-line
// file cap; behavior unchanged.

import { BRANDS, PUBLISHERS, STOPWORDS } from './gazetteer.js';
import { sentences, norm } from './text.js';

// ── candidate harvest ─────────────────────────────────────────────────────────
// Pull Title-Case product-name candidates from notes + source titles/content.
const TITLECASE_RUN = /\b([A-Z][A-Za-z]*(?:[''-][A-Za-z]+)?(?:\s+(?:[A-Z][A-Za-z0-9]*|[A-Z]{1,6}[-]?[A-Za-z0-9]*\d[A-Za-z0-9-]*|\d[A-Za-z0-9-]*|\([A-Za-z]+\)))*)\b/g;
const hasModelCode = (s) => /\b[A-Za-z]*\d[A-Za-z0-9-]*\b/.test(s) || /\b[A-Z]{2,}[-]?\d/.test(s);
// A STRONG model code has a letter ADJACENT to a digit (WF-1000XM6, j9, RK84, K70,
// P20i) — a real product code, NOT a bare integer ("Bluetooth 6", "Over 100",
// "Supportive Shoe 3"). A no-brand candidate needs one; a bare number is chrome.
const hasStrongCode = (s) => /[A-Za-z]\d|\d[A-Za-z]/.test(String(s)) || /\b[A-Z]{2,}-?\d/.test(String(s));
// A pure MEASUREMENT spec ("1350W", "58mm", "0.6L") is a number+unit, NOT a model code.
const MEASUREMENT_SPEC = /^\d+(?:\.\d+)?(?:mm|cm|m|w|kw|kg|g|oz|lb|lbs|in|ft|ml|l|hz|khz|mhz|ghz|bar|psi|rpm|wh|mah|gb|tb|mp|fps|nit|nits|cd|lm|db)$/i;
// A brandless candidate is only a real product if it has a MODEL-ish code (strong code that
// is NOT just a measurement spec). Otherwise it's a review-page spec callout/fragment, not a
// product ("Compact 1350W", "Enthusiasts 58mm Upgradability", "While 51mm").
const hasModelishCode = (name) => String(name).split(/\s+/).some((t) => {
  const ct = cleanTok(t);
  return hasStrongCode(ct) && !MEASUREMENT_SPEC.test(ct);
});
// Boilerplate / chrome / non-product fragments that the Title-Case harvester picks up
// from real pages: license footers, CTAs, timestamps, dates, bare tech-term+number,
// quantifier phrases, repeated words, nav. None of these are products.
const isBoilerplate = (name) => {
  const n = String(name || ''); const t = n.trim();
  return /\b(attribution|sharealike|noncommercial|creative commons|rights reserved)\b/i.test(n)
    || /\b(check (?:latest |the )?price|buy now|shop now|view deal|add to cart|see price|best price|guaranteed|read more|learn more)\b/i.test(n)
    || /^(?:bluetooth|displayport|hdmi|usb|wi-?fi|android|ios|version|chapter|step|figure|table|page|vol|gen|win|macos|category|section)\s+\d+$/i.test(t)
    || /\d{1,2}:\d{2}/.test(n)
    || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(n) // "December 9th"
    || /^(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:19|20)\d\d$/i.test(t) // "July 2026" date fragment
    || /^(?:over|under|up to|from|about|around|approx|nearly|almost|less than|more than|at|with|for|the|a|an)\s+\$?\d/i.test(t) // "At 52g", "Over 100"
    || /^\d+(?:\.\d+)?\s*(?:k|m|g|kg|mm|cm|hz|mah|wh|w|gb|tb|ms|nits|lbs?|oz|fps|hrs?|hours?)$/i.test(t)                       // bare spec/measure "52g", "144K"
    || /\b(\w+)\s+\1\b/i.test(n)
    || ((n.match(/\b(facebook|google|microsoft|meta|twitter|youtube|reddit|instagram|tiktok|linkedin|wikipedia|netflix)\b/gi) || []).length >= 2) // company-list sentence fragment
    || /\b(wwdc|black friday|cyber monday|prime day|ces \d|computex|ifa \d|gdc|e3 \d|keynote|live blog)\b/i.test(n) // event / chrome fragment
    || /\bpty\s*\.?\s*ltd\b|\bgmbh\b|\bllc\b|\bplc\b|incorporated\b|\bholdings\b|\bs\.?a\.?r\.?l\b/i.test(n) // a CORPORATE ENTITY, not a product ("Blue Connect Technology Pty Ltd")
    || /\b(inc|ltd|corp|llp|co)\.?$/i.test(t)
    || /\b(privacy|cookies?|terms of|subscribe|newsletter|sign in|log in|skip to|table of contents|all rights)\b/i.test(n)
    // NON-PRODUCT FRAGMENTS: coupons, warranty/returns pages, and unrelated-category
    // service merges that deeper reads surface as Title-Case "names". None is a product.
    || /^coupon\b/i.test(t)                                                  // "Coupon LEVELUP2026"
    || /\b(?:promo|coupon|discount)\s+code\b/i.test(n)                       // "Promo Code SAVE20"
    || /\b[A-Z]{4,}\d{2,}\b/.test(n)                                         // promo-code token (4+ caps + 2+ digits); real model codes (WF-1000XM5, TK75HE) don't match
    || /\b(?:warranty|returns?|refunds?|replacements?)\b/i.test(n)           // "IKEA Warranty Replacements" — returns/warranty page chrome
    || /\bmeal\s+(?:delivery|kit|kits|plan|plans)\b/i.test(n)                // "Fitbit Garmin Meal Delivery" — foreign-category service merge
    || /\bdeploy(?:ed|ing|ment)?\b/i.test(n);                               // "Google Photos Today Deploy Immich" — how-to imperative bleed
};
// Distinct known brands in a token list — 3+ is a company LIST ("Apple Facebook Google
// Microsoft"), not a product; a 2nd NON-ADJACENT brand is two products merged
// ("Apple AirPods | Sony XM6") and the name should be truncated at it.
// Bounded Levenshtein (cap 2) for near-duplicate brand detection ("Roborock"<->"Roborcok"
// is a transposition → distance 2). Returns 3 for anything farther so callers can early-out.
function lev2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i]; let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const c = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = c; if (c < rowMin) rowMin = c;
    }
    if (rowMin > 2) return 3; // whole row already past the cap — bail
    prev = cur;
  }
  return prev[n];
}
function brandTruncate(toks) {
  // (0) Collapse a near-duplicate brand token — an OCR/typo echo of an earlier gazetteer
  //     brand ("Roborock QRevo Curv Roborcok" → drop trailing "Roborcok"). Fires only for a
  //     non-brand token (len ≥ 5) within edit-distance 1-2 of an EARLIER real brand (len ≥ 5).
  let work = toks;
  for (let k = work.length - 1; k >= 1; k--) {
    const tl = cleanTok(work[k]).toLowerCase();
    if (tl.length < 5 || BRANDS.has(tl)) continue;
    let dup = false;
    for (let j = 0; j < k && !dup; j++) {
      const bl = cleanTok(work[j]).toLowerCase();
      if (BRANDS.has(bl) && bl.length >= 5 && tl !== bl && lev2(tl, bl) <= 2) dup = true;
    }
    if (dup) work = work.slice(0, k).concat(work.slice(k + 1));
  }
  let first = -1, cut = work.length; const seen = new Set(); let codeSeen = false;
  for (let k = 0; k < work.length; k++) {
    const tk = cleanTok(work[k]); const lc = tk.toLowerCase();
    const isBrand = BRANDS.has(lc);
    if (isBrand) {
      seen.add(lc);
      if (first < 0) first = k;
      else if (k > first + 1) { cut = k; break; } // non-adjacent 2nd brand → cut (merge)
    }
    // SECOND-PRODUCT BOUNDARY: once product 1 has carried a strong model code, a later
    // gazetteer brand OR a Title-Case word heading a brand+model product (next token is a
    // strong code) begins a second product — cut there. The "code already seen" gate
    // protects adjacent same-product brands (Anker Soundcore / iRobot Roomba / Breville
    // Bambino), whose 2nd brand precedes any code; the all-caps exclusion keeps "HE" in
    // "NuPhy Field75 HE V2" from triggering.
    if (k > 0 && codeSeen) {
      const titleCase = /^[A-Z][a-z]{3,}$/.test(tk);
      const nextCode = hasStrongCode(cleanTok(work[k + 1] || ''));
      if (isBrand || (titleCase && nextCode)) { cut = k; break; }
    }
    if (hasStrongCode(tk)) codeSeen = true;
  }
  const out = work.slice(0, cut);
  // Drop if 3+ distinct brands (a company LIST), or the result is ENTIRELY brands/
  // stopwords with no model token ("Apple Facebook", "Anker Soundcore" alone).
  const allBrandOrStop = out.length >= 2 && out.every((t) => { const l = cleanTok(t).toLowerCase(); return BRANDS.has(l) || STOPWORDS.has(l); });
  return { toks: out, drop: seen.size >= 3 || allBrandOrStop };
}
// Strip LEADING non-product words that bleed before the brand ("Home Keyboard Reviews
// Keychron Q6" → "Keychron Q6", "Public Keychron Q5" → "Keychron Q5"). Only fires when a
// brand appears after position 0 AND nothing before it carries a model code (so a real
// model prefix is never cut).
function trimNameLead(toks) {
  let firstBrand = -1;
  for (let k = 0; k < toks.length; k++) { if (BRANDS.has(cleanTok(toks[k]).toLowerCase())) { firstBrand = k; break; } }
  if (firstBrand <= 0) return toks;
  if (toks.slice(0, firstBrand).some((t) => hasStrongCode(t))) return toks; // don't cut a model prefix
  return toks.slice(firstBrand);
}
const firstBrand = (toks) => {
  const l = toks.map((t) => t.toLowerCase());
  if (l.length >= 2 && BRANDS.has(`${l[0]} ${l[1]}`)) return `${toks[0]} ${toks[1]}`;
  if (BRANDS.has(l[0])) return toks[0];
  return null;
};

const YEAR_RE = /^(?:19|20)\d\d$/;
const anyBrand = (toks) => firstBrand(toks) || toks.some((t) => BRANDS.has(t.toLowerCase()));
const cleanTok = (t) => t.replace(/^[("'“]+|[)"'”.,;:]+$/g, '');

// Trailing tokens that are never part of a product name: sentence-continuation
// verbs + review words. Deliberately NARROW — NOT all sentiment/stopwords, which
// would truncate legit edition names ("Charge 5 Value"); the bare-rating/ordinal
// boundary below catches "4.0"/"2nd" structurally instead.
const NAME_TAIL_DENY = new Set(['appears', 'delivers', 'offers', 'features', 'comes', 'makes', 'looks', 'sounds', 'tested', 'review', 'reviews', 'rated', 'ranked', 'seems', 'remains', 'stays', 'provides', 'brings', 'adds', 'impresses', 'the', 'a', 'an', 'and', 'or', 'but', 'with', 'for',
  // chrome/listicle words that bleed off real pages ("Qrevo Curv Review Pros", "Jet Bot … Yes")
  'pros', 'cons', 'yes', 'no', 'which', 'source', 'sources', 'dimensions', 'while', 'specifications', 'specs', 'price', 'prices', 'deal', 'deals', 'guide', 'vs', 'versus', 'exposed', 'pick', 'picks', 'kit', 'assembly', 'failures', 'here', 'now', 'today', 'update', 'updated', 'list', 'ranking', 'comparison', 'best', 'top', 'buy', 'shop', 'verdict', 'rating', 'score', 'overview', 'summary',
  // descriptive bleed common in apparel/no-model-code names ("Quince Linen Clothes Worth
  // Buying", "Banana Republic Standard-Fit Texture") — NOT category nouns (shirt/pants kept).
  'clothes', 'clothing', 'worth', 'buying', 'texture', 'tested', 'reviewed', 'recommended', 'roundup', 'edition', 'item', 'items', 'options', 'choices', 'finds', 'outfit', 'outfits', 'collection', 'wardrobe', 'essentials', 'staples', 'looks', 'styles',
  // software / spec / descriptive bleed ("Keychron Q5 Max Operating Environment", "Keychron
  // Launcher" (software), "Ducky Zero 6108 Image") — these are not part of the product name.
  'launcher', 'image', 'images', 'environment', 'operating', 'software', 'app', 'apps', 'driver', 'drivers', 'firmware', 'technology', 'technologies', 'connect', 'hub', 'manual', 'setup', 'support', 'download', 'downloads', 'gallery', 'photo', 'photos', 'video', 'unboxing',
  'bottom', 'line', 'url', 'see', 'complete', 'direct', 'amazon', 'walmart', 'target', 'newegg', 'options', 'tiktok', 'web', 'twitter', 'instagram', 'youtube', 'facebook', 'reddit',
  // trailing review-adjective bleed ("Keychron Q6 Max Exceptional", "Q5 Max Swappable") —
  // evaluative words that are never part of a real product name.
  'exceptional', 'swappable', 'amazing', 'incredible', 'fantastic', 'impressive', 'excellent', 'superb', 'outstanding', 'awesome', 'stunning', 'gorgeous', 'flawless',
  // trailing chrome/review/spec bleed: "IKEA Bekant Electronic", "IKEA Standing Desk Stability",
  // "Soundcore Space A40 Nothing", "Google Photos Alternative Is", "Baratza Encore ESP Budget-Friendly".
  'stability', 'electronic', 'nothing', 'strong', 'alternative', 'is', 'budget-friendly']);
// Product-type nouns that pin a DIFFERENT category — if one appears in a name and it is
// NOT one of the query's category terms, the product belongs to another category (an
// "Apple TV" / "Sony Playstation" leaking into a keyboard query).
export const FOREIGN_CATEGORY = new Set(['tv', 'television', 'playstation', 'xbox', 'nintendo', 'console', 'macbook', 'laptop', 'notebook', 'chromebook', 'iphone', 'ipad', 'tablet', 'smartphone', 'sneaker', 'sneakers', 'treadmill', 'mattress', 'sofa', 'couch', 'blender', 'microwave', 'refrigerator', 'fridge', 'dishwasher', 'games', 'mobile']);
// Strip review-score/version/ordinal noise and trailing verbs that bled into a name.
// Returns a NEW token array; tail-only, order-preserving, and never trims away the
// brand+model code (which would cause a false merge in resolveCandidates).
function trimNameTail(toks) {
  // 1) hard boundary: a bare DECIMAL (rating/version "4.0","2.0") or dangling ordinal
  //    ("2nd") is never part of a name — the name ends before it. Bare INTEGERS are
  //    left alone (usually model numbers, e.g. "Motion 300").
  let cut = toks.length;
  for (let k = 1; k < toks.length; k++) {
    const raw = toks[k];
    const t = cleanTok(raw);
    // bare rating/version "4.0", ordinal "2nd", a price "$749.99", or a timestamp
    // "02:32" are never part of a name — the name ends before them.
    if (/^\d+\.\d+$/.test(t) || /^\d+(?:st|nd|rd|th)$/i.test(t) || /^\$\d/.test(t) || /^\d{1,2}:\d{2}$/.test(t)) { cut = k; break; }
    // SPEC/PRICE JUNK chrome embedded in a name — cut at the junk: "Price:$399-$499
    // Type:Semi-Auto" (key:value spec label), "$399-$499" (any $), "Specifications 03" /
    // "Review 400" / "Review 2" (spec/review word + bare integer). Never matches real model
    // codes (no embedded "$" or "Word:value"); the struct() guard below restores if a code was cut.
    if (/^[A-Za-z][A-Za-z]*:\S/.test(raw) || raw.includes('$')) { cut = k; break; }
    if (/^(?:specifications?|reviews?)$/i.test(t) && /^\d+$/.test(cleanTok(toks[k + 1] || ''))) { cut = k; break; }
  }
  let out = toks.slice(0, cut);
  // 2) drop trailing sentence-continuation/review words, but never below 2 tokens
  //    (avoids shrinking to a bare brand → false merges).
  while (out.length > 2 && NAME_TAIL_DENY.has(cleanTok(out[out.length - 1]).toLowerCase())) out.pop();
  // hard guard: if trimming removed the only structural token (brand/model code), keep
  // the original — do not over-shorten.
  const struct = (arr) => arr.some((t) => BRANDS.has(cleanTok(t).toLowerCase()) || hasModelCode(t));
  if (!out.length || (struct(toks) && !struct(out))) return toks;
  return out;
}

// CP-397: apparel names have no model code, so review words bleed onto the end ("Uniqlo
// Premium Linen Shirt Great", "Madewell Perfect Vintage Jean Fits True"). For an APPAREL
// query (opts.apparel) a code-free name ends at its LAST garment noun; a coded name
// ("Baggies Shorts 5 Inch") is left alone. Other categories never see this rule, so
// "Samsung Top Load Washer" and "Allen Edmonds Dress Shoe" keep their names.
const GARMENT_NOUNS = new Set(['shirt', 'shirts', 'tee', 'tees', 't-shirt', 't-shirts', 'sweater', 'sweaters', 'crewneck',
  'cardigan', 'hoodie', 'sweatshirt', 'polo', 'henley', 'overshirt', 'blouse', 'top', 'tank', 'jean', 'jeans', 'pants',
  'pant', 'trousers', 'chinos', 'chino', 'joggers', 'jogger', 'shorts', 'leggings', 'skirt', 'dress', 'jumpsuit',
  'jacket', 'coat', 'parka', 'blazer', 'vest', 'socks', 'boxers', 'briefs', 'underwear', 'robe', 'pajamas', 'swimsuit',
  // footwear shares the apparel cluster; its noun ends the name ("Allen Edmonds Dress Shoe")
  'shoe', 'shoes', 'boot', 'boots', 'sneaker', 'sneakers', 'sandal', 'sandals', 'loafer', 'loafers', 'slipper', 'slippers',
  'heels', 'flats', 'clogs', 'mules']);
const MAX_NAME_TOKENS = 5;
const MAX_GARMENT_NAME_TOKENS = 6; // "Quince European Linen Long Sleeve Shirt"
const isGarment = (t) => GARMENT_NOUNS.has(cleanTok(t).toLowerCase());
function cutAtGarment(toks) {
  if (toks.some((t) => hasModelCode(t))) return toks;
  let last = -1;
  for (let k = 1; k < toks.length; k++) if (isGarment(toks[k])) last = k;
  return last > 0 ? toks.slice(0, last + 1) : toks;
}
const isBrandList = (toks) => toks.length >= 2 && toks.every((t) => { const l = cleanTok(t).toLowerCase(); return BRANDS.has(l) || STOPWORDS.has(l); });

// A brand-led run keeps 3 words after the brand; for apparel it may reach further to a
// garment noun ("Everlane Organic Cotton Box-Cut Tee").
function brandLedName(parts, span, apparel) {
  let end = Math.min(parts.length, span + 3);
  if (apparel) for (let k = parts.length - 1; k >= end; k--) if (isGarment(parts[k])) { end = k + 1; break; }
  return parts.slice(0, end).join(' ');
}

// All candidate name strings in one sentence: Title-Case runs + brand-led runs
// (the latter catches lowercase brands like "eufy", "iRobot").
function extractNames(sent, apparel = false) {
  const out = [];
  let m; TITLECASE_RUN.lastIndex = 0;
  while ((m = TITLECASE_RUN.exec(sent)) !== null) out.push(m[1].trim());
  const toks = sent.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const l1 = cleanTok(toks[i]).toLowerCase();
    const l2 = cleanTok(toks[i + 1] || '').toLowerCase();
    let span = 0;
    if (l1 && l2 && BRANDS.has(`${l1} ${l2}`)) span = 2;
    else if (BRANDS.has(l1)) span = 1;
    if (!span) continue;
    const parts = toks.slice(i, i + span).map(cleanTok);
    for (let j = i + span; j < toks.length && j < i + span + MAX_GARMENT_NAME_TOKENS - 1; j++) {
      const t = cleanTok(toks[j]);
      if (/^[A-Z]/.test(t) || /\d/.test(t)) parts.push(t); else break;
    }
    out.push(brandLedName(parts, span, apparel));
  }
  return out;
}

export function harvestCandidates(sources, notes, opts = {}) {
  const units = [];
  notes.forEach((n) => units.push({ text: n.content || '', src: null }));
  sources.forEach((s, i) => { units.push({ text: `${s.title || ''}. ${s.content || ''}`, src: i }); });

  const cands = new Map();
  for (const u of units) {
    for (const sent of sentences(u.text)) {
      for (const raw of extractNames(sent, opts.apparel)) {
        let toks = raw.split(/\s+/).map(cleanTok).filter(Boolean);
        // strip leading stopword/publisher/number/year tokens; trailing stopword/year
        while (toks.length && (STOPWORDS.has(toks[0].toLowerCase()) || PUBLISHERS.has(toks[0].toLowerCase()) || /^\d+$/.test(toks[0]) || YEAR_RE.test(toks[0]))) toks.shift();
        while (toks.length && (STOPWORDS.has(toks[toks.length - 1].toLowerCase()) || YEAR_RE.test(toks[toks.length - 1]))) toks.pop();
        const bt = brandTruncate(toks); // split a 2-product merge; flag a 3+ brand list
        if (bt.drop) continue;
        toks = trimNameTail(trimNameLead(bt.toks)); // strip leading non-product words + trailing bleed
        if (opts.apparel) toks = cutAtGarment(toks);
        if (!toks.length || isBrandList(toks)) continue; // "Our Favorite ... From Uniqlo Everlane" → a brand list
        const name = toks.join(' ');
        const low = name.toLowerCase();
        if (low.length < 3 || PUBLISHERS.has(low) || toks.every((t) => STOPWORDS.has(t.toLowerCase()))) continue;
        const brand = anyBrand(toks);
        const code = hasModelCode(name);
        // KEEP RULE: a real product has a known brand OR a STRONG model code (letter
        // adjacent to a digit). A no-brand name whose only "code" is a bare integer
        // ("Bluetooth 6", "Over 100", "Supportive Shoe 3") is chrome/spec noise, not a
        // product — drop it. (Brand present → keep regardless, "Motion 300" is fine.)
        if (!brand && !hasModelishCode(name)) continue;
        if (opts.physical && toks.length === 1 && !hasStrongCode(name)) continue; // bare brand for a physical product = noise ("flair")
        if (isBoilerplate(name)) continue; // license footers, CTAs, timestamps, nav
        // Real-markdown noise rejects (clean fixtures never had these):
        const maxToks = opts.apparel && brand && isGarment(toks[toks.length - 1]) ? MAX_GARMENT_NAME_TOKENS : MAX_NAME_TOKENS;
        if (toks.length > maxToks) continue;                    // concatenated headings/lists
        if (toks.length >= 4 && !brand) continue;               // long non-brand string = a heading
        if (/[[\]()]|\.(?:jpg|jpeg|png|webp|gif|avif|svg)\b|https?:/i.test(name)) continue; // md/url/img debris
        if (!brand && /\b(?:more|from|vetted|customer|photo|image|zoom|click|shop|deal|review|guide|under|dollars?|cheapest|budget|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i.test(low)) continue; // nav/date/category
        const key = norm(name);
        if (!cands.has(key)) cands.set(key, { name, toks, brand: firstBrand(toks), hasCode: code, srcIdx: new Set(), sents: [] });
        const c = cands.get(key);
        if (u.src != null) c.srcIdx.add(u.src);
        c.sents.push({ idx: u.src, sentence: sent });
      }
    }
  }
  // RECALL SUPPLEMENT: seed candidates for LLM-proposed leader names the Title-Case harvest
  // missed (lowercase/prose mentions, or filtered by the brand/code KEEP rule). Grounding is
  // automatic — we scan the real sentences for the name; if it appears nowhere, NO candidate
  // is seeded, and even when seeded it only becomes a product if analyzeProduct() later finds
  // credible pros/cons for it. So a hallucinated leader contributes nothing.
  for (const extra of (opts.extraNames || [])) {
    const nm = String(extra || '').trim();
    if (nm.length < 3) continue;
    const key = norm(nm);
    if (cands.has(key)) continue; // already harvested normally
    const low = nm.toLowerCase();
    const toks = nm.split(/\s+/).map(cleanTok).filter(Boolean);
    const c = { name: nm, toks, brand: firstBrand(toks), hasCode: hasModelCode(nm), srcIdx: new Set(), sents: [] };
    for (const u of units) {
      for (const sent of sentences(u.text)) {
        if (sent.toLowerCase().includes(low)) {
          if (u.src != null) c.srcIdx.add(u.src);
          c.sents.push({ idx: u.src, sentence: sent });
        }
      }
    }
    if (c.sents.length) cands.set(key, c); // only when actually present in sources
  }
  return splitMergedCandidates([...cands.values()]);
}

// CP-395: two neighbor products harvested as ONE candidate ("Synology Photos Immich").
// A code-free name is split when a prefix and the rest are BOTH candidates in their own
// right, each with a mention outside the merged name. The merged row's sentences go to
// both parts, so neither starves of pros/cons. Names with a model code are left to
// brandTruncate, and a bare one-token brand prefix never splits ("Sony" + "WH-1000XM5").
function splitMergedCandidates(cands) {
  const byKey = new Map(cands.map((c) => [norm(c.name), c]));
  const splits = new Map();
  for (const c of cands) {
    const parts = findSplit(c, byKey);
    if (parts) splits.set(c, parts);
  }
  if (!splits.size) return cands;
  const extra = new Map();
  for (const [merged, parts] of splits) {
    for (const part of parts) {
      const prev = extra.get(part) || { srcIdx: [], sents: [] };
      extra.set(part, { srcIdx: [...prev.srcIdx, ...merged.srcIdx], sents: [...prev.sents, ...merged.sents] });
    }
  }
  return cands
    .filter((c) => !splits.has(c))
    .map((c) => {
      const add = extra.get(c);
      if (!add) return c;
      const have = new Set(c.sents.map(sentKey));
      const fresh = add.sents.filter((x) => { const k = sentKey(x); if (have.has(k)) return false; have.add(k); return true; });
      return { ...c, srcIdx: new Set([...c.srcIdx, ...add.srcIdx]), sents: [...c.sents, ...fresh] };
    });
}

const sentKey = (x) => `${x.idx}\u0000${x.sentence}`;

function findSplit(c, byKey) {
  if (c.toks.length < 3 || hasModelCode(c.name)) return null;
  const mergedLow = c.name.toLowerCase();
  const standsAlone = (part) => part && part !== c && part.sents.some((s) => !s.sentence.toLowerCase().includes(mergedLow));
  for (let k = 2; k < c.toks.length; k++) {
    const head = byKey.get(norm(c.toks.slice(0, k).join(' ')));
    const tail = byKey.get(norm(c.toks.slice(k).join(' ')));
    if (standsAlone(head) && standsAlone(tail)) return [head, tail];
  }
  return null;
}

// ── entity resolution (conservative — under-merge beats over-merge) ────────────
export const modelToken = (toks) => toks.find((t) => /\d/.test(t))?.toLowerCase() || null;
export function resolveCandidates(cands) {
  // sort longest-name first so codes fold into full names
  const sorted = [...cands].sort((a, b) => b.name.length - a.name.length);
  const kept = [];
  for (const c of sorted) {
    const cCode = modelToken(c.toks);
    let merged = false;
    for (const k of kept) {
      const kCode = modelToken(k.toks);
      // merge ONLY on safe signals: one name contains the other, OR identical model code
      const contains = norm(k.name).includes(norm(c.name)) || norm(c.name).includes(norm(k.name));
      const sameCode = cCode && kCode && cCode === kCode;
      // HARD no-merge if both have model codes that differ (RK84 ≠ RK87)
      const codeConflict = cCode && kCode && cCode !== kCode;
      if (!codeConflict && (sameCode || (contains && (!cCode || !kCode || cCode === kCode)))) {
        k.aliases = k.aliases || [];
        if (!k.aliases.includes(c.name)) k.aliases.push(c.name);
        c.srcIdx.forEach((i) => k.srcIdx.add(i));
        k.sents.push(...c.sents);
        merged = true;
        break;
      }
    }
    if (!merged) { c.aliases = []; kept.push(c); }
  }
  return kept;
}
