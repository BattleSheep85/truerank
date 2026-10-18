// Sentiment scoring, per-product fact/pros/cons mining, and rating for the
// extraction engine. Takes harvested + resolved candidates (from candidates.js) and
// their supporting sentences, and produces grounded pros/cons + a deterministic 0-5
// rating. Split out of engine.js (2026-07) to stay under the 800-line file cap;
// behavior unchanged.

import { VALENCE, NEGATORS, INTENSIFIERS } from './lexicon.js';
import { NONCREDIBLE_GENRES } from '../../lib/credibility.js';
import { sentences, clausesWithContrast, tidyClause, looksLikeHeadline, words, CLAUSE_SPLIT } from './text.js';
import { modelToken } from './candidates.js';

// Genres that can NEVER be the sole basis for a recommendation (mirrors the
// deterministic version of the synthesis prompt's credibility rules).
// Imported from the credibility module.
export const MIN_CREDIBLE_SCORE = 45; // a product needs ≥1 supporting source at/above this AND of a credible genre

// ── sentiment ──────────────────────────────────────────────────────────────────
export function sentencePolarity(sentence) {
  const toks = words(sentence);
  let score = 0, hits = 0;
  for (let i = 0; i < toks.length; i++) {
    const v = VALENCE[toks[i]];
    if (v === undefined) continue;
    let s = v;
    const prev = toks[i - 1] || '';
    if (INTENSIFIERS[prev]) s *= INTENSIFIERS[prev];
    // negation in the preceding 3 tokens flips
    for (let j = Math.max(0, i - 3); j < i; j++) if (NEGATORS.has(toks[j])) { s = -s * 0.9; break; }
    score += s; hits++;
  }
  return { score, hits };
}

// ── per-product facts + pros/cons from its supporting sentences ────────────────
const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b/g;
const SPEC_RE = /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s?(ms|hz|nits|mb\/s|gb\/s|tb\/s|gb|tb|mah|wh|watts?|w|mm|cm|"|inch(?:es)?|hours?|hrs?|kg|lbs?|delta-e|%)\b/gi;

export function aliasMatchers(c) {
  const names = [c.name, ...(c.aliases || [])];
  const code = modelToken(c.toks);
  if (code && code.length >= 3) names.push(code);
  return names.map((n) => n.toLowerCase());
}

// High-precision criticism cues — feature-absence + complaint phrasing that signals a
// drawback even when the VADER polarity is mild (real reviews bury cons in "lacks
// LDAC", "the only downside", "wish it had", "battery life is short"). Used by the
// proximity body-miner; deliberately specific to avoid false positives ("no issues").
const CON_CUE = /\b(lacks?|lacking|missing|doesn'?t have|does not have|don'?t have|no (?:ldac|aptx|anc|usb-?c|wireless charging|warranty|app control|water resistance)|wish (?:it|they|i) (?:had|could|would)|only (?:downside|complaint|issue|gripe|drawback)|main (?:downside|drawback|complaint|gripe)|the catch|the downside|biggest (?:downside|drawback)|drawback|gripe|caveat|could be better|falls? short|struggles? (?:with|to|in)|fails? to|too (?:small|big|bulky|heavy|loud|quiet|short|expensive|pricey|dim|tight|stiff|thin|flimsy)|(?:bit|fairly|quite|rather|somewhat|a little|on the) (?:heavy|bulky|loud|noisy|expensive|pricey|dim|slow|stiff|thin|short)(?:\s+side)?|not (?:as good|the best|great|comfortable|worth)|battery (?:life )?(?:is |was )?(?:short|weak|poor|mediocre|disappointing|only|just)|short battery|runs? hot|overheats?|disappoint(?:ing|ed)?|flimsy|cheaply made|poorly (?:made|built))\b/i;
// A neutral META/category statement (not a product-specific con) — guards the
// strong-negative branch against "...whose models range from inexpensive to pricey".
const META_STMT = /\b(brands?|models?|range from|evaluates?|generally|category|options|overall|most of|many of|whose models|the lineup|across the board)\b/i;
// Feature-presence / praise cues — let the proximity miner accept a positive clause
// even when the VADER score is only mildly positive ("hot-swappable PCB", "great
// battery life", "comfortable for long sessions"). High-precision to avoid generic fluff.
const PRO_CUE = /\b(excellent|outstanding|impressive|standout|superb|fantastic|comfortable|durable|reliable|sturdy|responsive|crisp|punchy|premium|well.?built|top.?notch|class.?leading|best.?in.?class|hot.?swap\w*|gasket|wireless|long battery|great battery|excellent battery|easy to|love (?:the|how|that)|highly recommend|worth (?:it|the)|great value|best value|customizable|versatile|seamless|powerful|lightweight|portable|rugged|gorgeous|sleek)\b/i;
// A source TITLE / product-listing line ("Review NuPhy Air75 V3 … 84 Keys 75% Custom"),
// not a sentence of criticism — title-case heavy with spec/listing tokens and no verb.
export function looksLikeListing(clean) {
  if (/^(?:review|the best|top \d|best \d|\d+ best)\b/i.test(clean)) return true;
  const toks = clean.split(/\s+/);
  const capRatio = toks.filter((w) => /^[A-Z0-9]/.test(w)).length / Math.max(1, toks.length);
  return toks.length >= 5 && capRatio > 0.6 && /\b(keys?|wireless|mechanical|bluetooth|custom|rgb|hot.?swap|\d{2,}%|gen|edition)\b/i.test(clean);
}

// Lowercase without changing string length, so regex offsets taken on the original
// sentence still point at the same place (a few characters, like 'İ', grow when
// lowercased; those keep their case).
function lowerSameLength(text) {
  return text.replace(/[^\0-\x7f]|[A-Z]/g, (ch) => {
    const low = ch.toLowerCase();
    return low.length === ch.length ? low : ch;
  });
}

// Product mentions in a lowercased text as [start, end, owner] spans. A mention
// inside a longer mention of the other side is dropped, so "airpods pro" inside
// "airpods pro 2" is not a mention of AirPods Pro, and a mention overlapping the
// number itself (a model code such as "600" in "600 nits") never counts.
function mentionSpans(low, selfMatchers, rivalMatchers, skip) {
  const spans = [];
  const collect = (list, owner) => {
    for (const m of list) {
      for (let i = low.indexOf(m); i >= 0; i = low.indexOf(m, i + 1)) {
        const span = [i, i + m.length, owner];
        if (!skip || span[1] <= skip[0] || span[0] >= skip[1]) spans.push(span);
      }
    }
  };
  collect(selfMatchers, 'self');
  collect(rivalMatchers, 'rival');
  return spans.filter(([a, b, owner]) => !spans.some(([c, d, other]) => other !== owner && c <= a && d >= b && d - c > b - a));
}

// The clause (same split as clausesWithContrast) around offset `at`, with offsets.
const CLAUSE_SPLIT_G = new RegExp(CLAUSE_SPLIT.source, 'gi');
function clauseAround(low, at) {
  let start = 0;
  for (const m of low.matchAll(CLAUSE_SPLIT_G)) {
    if (m.index > at) return { start, end: m.index };
    start = m.index + m[0].length;
  }
  return { start, end: low.length };
}

// Owner of the number at [at, at + len) in a lowercased sentence: decided by its
// clause when the clause names a product (the nearest mention when it names both;
// ties go to self), else by the sentence when that names one side only. 'ambiguous'
// when the clause names no product and the sentence names both; 'none' when the
// sentence names no product.
function ownerOf(low, at, len, selfMatchers, rivalMatchers) {
  const spans = mentionSpans(low, selfMatchers, rivalMatchers, [at, at + len]);
  const clause = clauseAround(low, at);
  const inClause = spans.filter(([a, b]) => a >= clause.start && b <= clause.end);
  const pool = inClause.length ? inClause : spans;
  const owners = new Set(pool.map(([, , owner]) => owner));
  if (owners.size === 0) return 'none';
  if (owners.size === 1) return [...owners][0];
  if (!inClause.length) return 'ambiguous';
  let best = { d: Infinity, owner: 'none' };
  for (const [a, b, owner] of pool) {
    const d = a > at ? a - at : Math.max(0, at - b);
    if (d < best.d || (d === best.d && owner === 'self')) best = { d, owner };
  }
  return best.owner;
}

// Regex matches in a source that belong to this product (CP-407). A comparison
// ("the A lasts 30 hours versus 24 hours for the B") used to hand every number in
// the source to every product it mentions. Now a number counts when ownerOf() gives
// it to this product. A number in a sentence that names no product ("It lasts 30
// hours") counts when the page is about this product: its title names it and no
// rival, or its body names no rival. Match indexes are relative to `sent`.
function ownedMatches(source, re, selfMatchers, rivalMatchers) {
  const text = String(source?.content || '');
  let pageIsSelf;
  const isSelfPage = () => {
    if (pageIsSelf === undefined) {
      const title = lowerSameLength(String(source?.title || ''));
      const hasRival = (t) => rivalMatchers.some((m) => t.includes(m));
      pageIsSelf = (selfMatchers.some((m) => title.includes(m)) && !hasRival(title)) || !hasRival(lowerSameLength(text));
    }
    return pageIsSelf;
  };
  const out = [];
  for (const sent of sentences(text)) {
    let low;
    for (const m of sent.matchAll(re)) {
      low = low || lowerSameLength(sent);
      const owner = ownerOf(low, m.index || 0, m[0].length, selfMatchers, rivalMatchers);
      if (owner === 'self' || (owner === 'none' && isSelfPage())) out.push({ m, sent });
    }
  }
  return out;
}

export function analyzeProduct(c, sources, otherMatchers = [], seen = new Set()) {
  const matchers = aliasMatchers(c);
  // supporting sources: those whose text mentions a matcher
  const support = [];
  sources.forEach((s, i) => {
    const hay = `${s.title || ''} ${s.content || ''}`.toLowerCase();
    if (matchers.some((m) => hay.includes(m))) {
      support.push({ i, score: s.credibility?.score ?? 0, tags: s.credibility?.tags || [], source: s });
    }
  });
  // sentences (from notes+sources) that mention the product
  const proConSents = [];
  for (const sent of c.sents) {
    const low = sent.sentence.toLowerCase();
    if (!matchers.some((m) => low.includes(m))) continue;
    const cred = sent.idx != null ? (sources[sent.idx]?.credibility?.score ?? 40) : 50;
    const genre = sent.idx != null ? (sources[sent.idx]?.credibility?.tags || []) : ['note'];
    proConSents.push({ sentence: sent.sentence, cred, genre, srcIdx: sent.idx });
  }

  // price: only $ amounts that actually appear in supporting text AND belong to this
  // product (ownedMatches: no rival's price in a comparison) → median (grounded)
  const prices = [];
  for (const s of support) for (const { m, sent } of ownedMatches(s.source, PRICE_RE, matchers, otherMatchers)) {
    const ctx = lowerSameLength(sent);
    // skip discount phrasing ("$50 off", "save $50")
    const at = m.index || 0; const before = ctx.slice(Math.max(0, at - 12), at);
    if (/\b(off|save|saving|discount|coupon)\b/.test(before) || /\boff\b/.test(ctx.slice(at, at + 20))) continue;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (n >= 1 && n <= 50000) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  const price = prices.length ? prices[Math.floor(prices.length / 2)] : null;

  // specs: number+unit pairs from supporting text that belong to this product
  const specs = {};
  for (const s of support) for (const { m } of ownedMatches(s.source, SPEC_RE, matchers, otherMatchers)) {
    const unit = m[2].toLowerCase();
    if (!specs[unit]) specs[unit] = `${m[1]}${/^[a-z%"]/.test(unit) ? ' ' : ' '}${m[2]}`.trim();
  }

  // pros/cons: CLAUSE-level + single-product ATTRIBUTION (the #1 honesty fix).
  // A comparison sentence ("A and B are best; C is value") is split, and a clause is
  // credited to this product only when the clause is about it and names no rival.
  const otherIn = (txt) => otherMatchers.some((m) => txt.toLowerCase().includes(m));
  const selfIn = (txt) => matchers.some((m) => txt.toLowerCase().includes(m));
  const negHit = (txt) => (txt.toLowerCase().match(/[a-z0-9'’#-]+/g) || []).some((w) => (VALENCE[w] ?? 0) <= -0.8);
  const pros = [], cons = [];
  for (const ps of proConSents) {
    const sentHasRival = otherIn(ps.sentence);
    for (const cl of clausesWithContrast(ps.sentence)) {
      const clean = tidyClause(cl.text);
      if (clean.length < 12 || clean.length > 220) continue;
      if (looksLikeHeadline(clean) || looksLikeListing(clean)) continue; // drop listicle/heading/title lines
      // multi-product sentence: keep only clauses that name THIS product and no rival.
      // single-product sentence: all its clauses attribute here (carries the "but …" con).
      if (sentHasRival && (!selfIn(clean) || otherIn(clean))) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue; // never reuse the same clause across products
      const { score, hits } = sentencePolarity(clean);
      if (!hits) continue;
      if (score >= 0.8) { pros.push({ text: clean, score, cred: ps.cred }); seen.add(key); }
      // con: a clearly-negative clause, OR a post-contrast ("but …") clause with a real
      // negative term whose net is only mild because a category word cancelled it.
      else if (score <= -0.6 || (cl.afterContrast && score < 0.2 && negHit(clean))) {
        cons.push({ text: clean, score, cred: ps.cred }); seen.add(key);
      }
    }
  }

  // PROXIMITY con-mining over credible review BODIES: real reviews state criticism a
  // sentence or two AFTER the product name (or as feature-absence — "lacks LDAC"),
  // which the same-sentence loop above misses. Scan a 3-sentence window around each
  // mention in a credible body, STOP at a rival mention (attribution boundary), and
  // accept grounded negative / feature-absence clauses. Capped + body-only so
  // grounding + precision hold (every con is still a verbatim source span).
  if (cons.length < 3) {
    const bodies = support.filter((s) => s.score >= MIN_CREDIBLE_SCORE
      && !(s.tags || []).every((t) => NONCREDIBLE_GENRES.has(t))
      && String(s.source.content || '').length >= 400);
    outer:
    for (const s of bodies) {
      const sents = sentences(s.source.content);
      for (let i = 0; i < sents.length; i++) {
        if (!selfIn(sents[i])) continue;
        for (let j = i; j <= i + 2 && j < sents.length; j++) {
          if (j > i && otherIn(sents[j]) && !selfIn(sents[j])) break; // rival → stop window
          for (const cl of clausesWithContrast(sents[j])) {
            const clean = tidyClause(cl.text);
            if (clean.length < 14 || clean.length > 220 || looksLikeHeadline(clean)) continue;
            if (otherIn(clean) && !selfIn(clean)) continue; // names only a rival
            const key = clean.toLowerCase();
            if (seen.has(key)) continue;
            const { score } = sentencePolarity(clean);
            if (score >= 0.6) continue;                    // leans positive → not a con
            if (looksLikeListing(clean)) continue;         // source title / product-listing line, not a con
            // PRECISION: a con needs an explicit complaint CUE, or a strongly-negative,
            // SHORT, focused clause (not a rambling meta/category statement — that was the
            // "out of tight spots" / "...to pricey" false-positive source).
            const isCon = CON_CUE.test(clean)
              || (score <= -0.7 && negHit(clean) && clean.length <= 110 && !META_STMT.test(clean));
            if (!isCon) continue;
            cons.push({ text: clean, score: Math.min(score, -0.3), cred: s.score });
            seen.add(key);
            if (cons.length >= 3) break outer;
          }
        }
      }
    }
  }
  // Recall fallback: a legit, credibly-sourced product mentioned ONLY in comparisons
  // (e.g. "A and B are the best picks") would otherwise lose every clause and be
  // dropped — and dropping a real product is itself a lie. Allow ONE comparative
  // clause that positively names it (deduped), so it still appears honestly.
  if (pros.length === 0) {
    for (const ps of proConSents) {
      let done = false;
      for (const cl of clausesWithContrast(ps.sentence)) {
        const clean = tidyClause(cl.text);
        if (clean.length < 12 || clean.length > 220 || looksLikeHeadline(clean) || !selfIn(clean) || seen.has(clean.toLowerCase())) continue;
        const { score, hits } = sentencePolarity(clean);
        if (hits && score >= 0.8) { pros.push({ text: clean, score, cred: ps.cred }); seen.add(clean.toLowerCase()); done = true; break; }
      }
      if (done) break;
    }
  }

  // PROXIMITY pro-mining over credible BODIES (mirror of the con miner): the same-
  // sentence pass misses praise stated a sentence after the product name, so most
  // thinly-mentioned-but-real products end up with ≤1 pro and get dropped. Scan a
  // 3-sentence window around each mention and accept grounded POSITIVE clauses. This
  // both RESCUES real products (so they survive the ≥1-evidence inclusion gate) and
  // gives the comprehensive tail substance. Every pro stays a verbatim source span.
  if (pros.length < 3) {
    const bodies = support.filter((s) => s.score >= MIN_CREDIBLE_SCORE
      && !(s.tags || []).every((t) => NONCREDIBLE_GENRES.has(t))
      && String(s.source.content || '').length >= 400);
    outerPro:
    for (const s of bodies) {
      const sents = sentences(s.source.content);
      for (let i = 0; i < sents.length; i++) {
        if (!selfIn(sents[i])) continue;
        for (let j = i; j <= i + 2 && j < sents.length; j++) {
          if (j > i && otherIn(sents[j]) && !selfIn(sents[j])) break; // rival → stop window
          for (const cl of clausesWithContrast(sents[j])) {
            const clean = tidyClause(cl.text);
            if (clean.length < 14 || clean.length > 220 || looksLikeHeadline(clean) || looksLikeListing(clean)) continue;
            if (otherIn(clean) && !selfIn(clean)) continue;
            const key = clean.toLowerCase();
            if (seen.has(key)) continue;
            const { score } = sentencePolarity(clean);
            // a clearly-positive clause, or a pre-contrast clause with a feature/praise cue.
            const isPro = score >= 0.8 || (!cl.afterContrast && score >= 0.2 && PRO_CUE.test(clean));
            if (!isPro) continue;
            pros.push({ text: clean, score: Math.max(score, 0.8), cred: s.score });
            seen.add(key);
            if (pros.length >= 3) break outerPro;
          }
        }
      }
    }
  }
  return { support, price, specs, pros, cons }; // pros/cons are RAW scored clauses
}

// rank/dedup the scored clauses into the final text list
export const pick = (arr, sign) => (arr ? [...arr] : []).sort((a, b) => sign * (b.score - a.score) || b.cred - a.cred)
  .filter((x, i, a) => a.findIndex((y) => y.text === x.text) === i).slice(0, 4).map((x) => x.text);

// ── rating (deterministic, auditable) ──────────────────────────────────────────
// Rate from the CLEAN attributed clauses (not raw comparative sentences, which used
// to inflate thin products to 5/5) + an evidence cap so a product with little
// credible backing can't top out. Editorial 0-5; never invented precision.
export function rate(pros, cons, credibleCount) {
  let wSum = 0, wPol = 0;
  for (const x of [...pros, ...cons]) {
    const w = Math.max(0.2, x.cred / 100);
    wSum += w; wPol += w * Math.max(-3, Math.min(3, x.score));
  }
  const C = 2.5, prior = 0.3;
  const meanPol = wSum > 0 ? wPol / wSum : 0;
  const shrunk = (wSum * meanPol + C * prior) / (wSum + C);
  const cap = 3.5 + 0.5 * Math.min(3, credibleCount); // 1 src→4.0, 2→4.5, ≥3→5.0
  const rating = Math.min(2.5 + shrunk * 1.3, cap);
  return Math.round(Math.max(0, Math.min(5, rating)) * 2) / 2; // 0..5 in 0.5 steps
}
