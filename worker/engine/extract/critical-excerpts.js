// CP-399: verbatim low-star review quotes for the "Why some reviewers rated it low" block.
// The block used to repeat the summarized cons; buyers want to read what real 1-2★
// reviewers wrote. Every quote is a sentence copied from a source, tagged with its star
// count and the page it came from, so nothing is paraphrased or invented. Pure and
// deterministic; no network.

import { sentences, stripMarkdown } from './text.js';
import { modelToken } from './candidates.js';

const MAX_LOW_STARS = 2;
const MAX_EXCERPTS = 2;
const MIN_QUOTE_CHARS = 30;
const MAX_QUOTE_CHARS = 240;
// A star sentence this short ("2 stars.") borrows the next sentence as its reason.
const SHORT_STAR_SENTENCE = 60;
// Pages whose criticism is not a buyer's own voice.
const SKIP_GENRES = new Set(['manufacturer', 'ai-injection', 'sponsored-content', 'incentivized-review']);

// "1/5" or "1 out of 5"; a spaced "1 / 5" is a carousel counter, not a rating.
const OUT_OF_FIVE = /(?<![\d.])(\d(?:\.\d)?)(?:\/|\s+out of\s+)5(?![\d.])/i;
const N_STARS = /(?<![\d.])(\d(?:\.\d)?)[\s-]*stars?\b/i;
const WORD_STARS = /\b(one|two)[\s-]stars?\b/i;
const GLYPH_STARS = /(★+)(☆+)/;
const WORD_VALUES = { one: 1, two: 2 };

/** The low star rating (1-2) a sentence gives, or null when it gives none or a higher one. */
export function starsIn(sentence) {
  const text = String(sentence || '');
  const glyph = text.match(GLYPH_STARS);
  if (glyph && glyph[1].length + glyph[2].length === 5) return lowOrNull(glyph[1].length);
  const word = text.match(WORD_STARS);
  if (word) return WORD_VALUES[word[1].toLowerCase()];
  const outOf = text.match(OUT_OF_FIVE);
  if (outOf) return lowOrNull(Number(outOf[1]));
  const n = text.match(N_STARS);
  if (n) return lowOrNull(Number(n[1]));
  return null;
}

function lowOrNull(stars) {
  return Number.isFinite(stars) && stars >= 1 && stars <= MAX_LOW_STARS ? stars : null;
}

function matchersFor(name) {
  const full = String(name || '').toLowerCase().trim();
  const out = full.length > 2 ? [full] : [];
  const code = modelToken(full.split(/\s+/));
  if (code && code.length >= 3) out.push(code);
  return out;
}

const mentions = (text, matchers) => {
  const low = String(text || '').toLowerCase();
  return matchers.some((m) => low.includes(m));
};

function usableSource(s) {
  if (!s || typeof s.url !== 'string' || !/^https:\/\//i.test(s.url)) return false;
  const tags = s.credibility?.tags || [];
  return !tags.some((t) => SKIP_GENRES.has(t));
}

function quoteAt(sents, i) {
  const first = sents[i].trim();
  const next = sents[i + 1]?.trim();
  const quote = first.length < SHORT_STAR_SENTENCE && next ? `${first} ${next}` : first;
  return quote.length > MAX_QUOTE_CHARS ? '' : quote;
}

function excerptsFromSource(s, self, rivals) {
  const sents = sentences(stripMarkdown(s.content || ''));
  const title = stripMarkdown(s.title || '').trim();
  // A star sentence that does not name the product counts only on a page about it alone.
  const pageIsAboutSelf = mentions(title, self) && !mentions(title, rivals);
  const found = [];
  for (let i = 0; i < sents.length; i++) {
    const stars = starsIn(sents[i]);
    if (stars == null) continue;
    const namesSelf = mentions(sents[i], self);
    if (mentions(sents[i], rivals) && !namesSelf) continue;
    if (!namesSelf && !pageIsAboutSelf) continue;
    const quote = quoteAt(sents, i);
    if (quote.length < MIN_QUOTE_CHARS || (mentions(quote, rivals) && !namesSelf)) continue;
    found.push({ quote, stars, sourceUrl: s.url, sourceTitle: title.slice(0, 120) });
  }
  return found;
}

/**
 * Up to `cap` verbatim 1-2★ quotes about one product, each with its star count and source.
 * @param {string} productName
 * @param {Array<{url:string,title?:string,content?:string,credibility?:{tags?:string[]}}>} sources
 * @param {string[]} rivalNames other products on the page (their quotes are never borrowed)
 */
export function criticalExcerpts(productName, sources, rivalNames = [], cap = MAX_EXCERPTS) {
  const self = matchersFor(productName);
  if (!self.length) return [];
  const rivals = (rivalNames || []).flatMap(matchersFor).filter((r) => !self.includes(r));
  const out = [];
  const seen = new Set();
  for (const s of (sources || []).filter(usableSource)) {
    for (const ex of excerptsFromSource(s, self, rivals)) {
      const key = ex.quote.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ex);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** A copy of the report where every product carries `criticalReviews` (possibly empty). */
export function attachCriticalReviews(report, sources) {
  if (!report || !Array.isArray(report.products)) return report;
  const names = report.products.map((p) => p.name);
  const products = report.products.map((p) => ({
    ...p,
    criticalReviews: criticalExcerpts(p.name, sources, names.filter((n) => n !== p.name)),
  }));
  return { ...report, products };
}
