// Text utilities for the extraction engine: sentence segmentation, tokenization,
// clause splitting, HTML-entity decode, markdown stripping, and category-term
// matching. Pure string/regex helpers — no scoring, no candidate logic. Split out
// of engine.js (2026-07) to stay under the 800-line file cap; behavior unchanged.

import { VALENCE } from './lexicon.js';

// ── text utils ───────────────────────────────────────────────────────────────
let _seg;
// Memoize segmentation by content string. analyzeProduct() re-segments the SAME source
// bodies once PER candidate (M times), so without this the cost is O(M x N x segment) and a
// large source set blows the Worker CPU budget. Caching collapses it to one segment per
// distinct body. Bounded so it can't grow unbounded across many runs in a warm isolate.
const _sentCache = new Map();
export function sentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const hit = _sentCache.get(t);
  if (hit) return hit;
  let out;
  try {
    _seg = _seg || new Intl.Segmenter('en', { granularity: 'sentence' });
    out = [..._seg.segment(t)].map((s) => s.segment.trim()).filter(Boolean);
  } catch {
    out = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  }
  if (_sentCache.size > 800) _sentCache.clear(); // bound memory; segmentation is deterministic
  _sentCache.set(t, out);
  return out;
}
export const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9'’#-]+/g) || [];
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Split a sentence into clauses so a mixed "X is great but the bin is small" yields
// a separate pro AND con, and a comparison "A and B are best; C is value" separates.
export const CLAUSE_SPLIT = /\s*(?:;|—|–|\bbut\b|\bthough\b|\bhowever\b|\bwhereas\b|\bwhile\b|\bexcept\b|\byet\b)\s+/i;
// Contrast markers introduce a drawback. A clause AFTER one carries a con even when a
// positive category word cancels the negative to a mild net score ("bulky for a
// portable speaker": bulky −1.3 + portable +1.2 ≈ −0.1).
const CONTRAST_RE = /\b(?:but|though|however|whereas|yet)\b/i;
export function clausesWithContrast(sentence) {
  const s = String(sentence || '');
  const parts = s.split(CLAUSE_SPLIT);
  const markers = s.match(new RegExp(CLAUSE_SPLIT.source, 'gi')) || [];
  const out = [];
  let afterContrast = false;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && CONTRAST_RE.test(markers[i - 1] || '')) afterContrast = true;
    const t = parts[i].trim();
    if (t) out.push({ text: t, afterContrast });
  }
  return out;
}
// Tidy a clause for display: drop leading bullets/conjunctions/"label:" preambles and
// trailing punctuation. Only removes edge noise, so the core stays a verbatim source span.
export function tidyClause(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/^[-–—•*\s]+/, '')
    .replace(/^[A-Z][A-Za-z ]{2,24}:\s+/, '')               // "Measured on our rig: …"
    .replace(/^(?:and|but|or|though|however|yet|so|because)\s+/i, '')
    .replace(/\s*[:|—-]\s*(?:r\/\w+|reddit|youtube|amazon(?:\.com)?|[A-Z][a-z]+\.(?:com|net|org|io)\b).*$/i, '') // source-attribution chrome tail
    .replace(/[,;:\-–—\s]+$/, '')
    .trim();
}
// A listicle HEADLINE / heading line (never a real pro/con). Conjunctive + bounded so a
// short Title-Case verdict that carries a real claim ("Best Battery Life In Its Class")
// is NOT rejected.
export function looksLikeHeadline(clean) {
  const toks = clean.split(/\s+/);
  const noTerminal = !/[.!?]$/.test(clean);
  const titleRun = toks.length >= 4 && toks.filter((w) => /^[A-Z]/.test(w)).length / toks.length > 0.6;
  const listicleShape = /^(?:the\s+)?\d+\s+best\b/i.test(clean) || /\bbest\b[^.!?]*\bfor\b\s*(?:19|20)\d\d/i.test(clean);
  const hasClaim = (clean.toLowerCase().match(/[a-z0-9'’#-]+/g) || []).some((w) => VALENCE[w] !== undefined);
  return (listicleShape && noTerminal) || (noTerminal && titleRun && !hasClaim);
}
// HTML-entity decode — MUST run before any markdown stripping or clause splitting.
// Real jina/HTML content carries raw entities (&#9679;, &amp;, &#39;); left encoded
// they (a) surface as literal garbage in pros/names and (b) their embedded ';' makes
// the clause splitter cut a clause mid-word ("best low-end &amp" ). Decoding here is
// strictly corrective — it replaces an escape with its literal source character, or
// drops a DECORATIVE glyph (bullet/arrow/star/control) to a space; it never invents text.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', bull: ' ', middot: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', deg: '°', trade: '™', reg: '®', copy: '©' };
const safeCp = (cp) => {
  if (!Number.isFinite(cp) || cp < 0x20) return ' ';
  if (cp >= 0x2022 && cp <= 0x2606) return ' '; // decorative bullets/arrows/stars → space (never a claim)
  try { return String.fromCodePoint(cp); } catch { return ' '; }
};
export const decodeEntities = (t) => String(t || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCp(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
  .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] ?? ' '));

// Real source content is jina MARKDOWN (links/images/headings) — strip it before any
// extraction so link/image/url syntax never leaks into product names or facts.
export const stripMarkdown = (t) => decodeEntities(String(t || ''))
  .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')   // images
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → keep text, drop url
  .replace(/https?:\/\/\S+/g, ' ')         // bare urls
  .replace(/[#>*`|_~]+/g, ' ')             // md punctuation
  .replace(/\][([)\]]*/g, ' ')             // stray bracket/paren debris
  .replace(/\s+/g, ' ').trim();

// Category-relevance terms from the topical category + query head nouns. A real product
// for the query is discussed IN its category ("keyboard", "switches"); a cross-category
// entity that leaked from a mixed listicle (a laptop/shoe/vacuum in a keyboard query) is
// not. Used to drop those. Numbers, sizes, and generic qualifiers are excluded.
const CAT_STOP = new Set(['best', 'the', 'and', 'for', 'with', 'under', 'top', 'over', 'from', 'your', 'our', 'full', 'sized', 'size', 'layout', 'review', 'reviews', 'guide', 'cheap', 'budget', 'good', 'great', 'new', 'this', 'that', 'percent', 'inch', 'inches']);
export function categoryTerms(cat, query) {
  const terms = new Set();
  const add = (w) => {
    const l = String(w).toLowerCase().replace(/[^a-z]/g, '');
    if (l.length >= 4 && !CAT_STOP.has(l)) { terms.add(l); terms.add(l.endsWith('s') ? l.slice(0, -1) : l + 's'); }
  };
  for (const w of `${cat || ''} ${query || ''}`.split(/\s+/)) add(w);
  return terms;
}
export const inCategory = (c, support, terms) => {
  if (!terms.size) return true;
  // Include the SUPPORTING SOURCE TITLES — a legit pick's review page is titled for the
  // category ("Best Noise Cancelling Headphones - RTINGS") even when an individual
  // sentence about it doesn't repeat the noun; a cross-category leak's source is titled
  // for its OWN category (a shoe review), so it still fails the gate.
  const titles = (support || []).map((s) => s.source?.title || '').join(' ');
  const ctx = `${c.name} ${titles} ${(c.sents || []).map((s) => s.sentence).join(' ')}`.toLowerCase();
  for (const t of terms) if (ctx.includes(t)) return true;
  return false;
};
