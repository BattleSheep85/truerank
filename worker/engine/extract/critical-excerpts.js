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

// "1/5", "1 out of 5", "1 of 5". Not a date ("1/5/2025"), a fraction ("1/5 the price",
// "1/5 of the price", "1/5 as much"), or a spaced carousel counter ("1 / 5").
const OUT_OF_FIVE = /(?<![\d./])(\d(?:\.\d)?)(?:\/|\s+(?:out\s+)?of\s+)5(?![\d./])(?!\s+(?:the|of\s+the|as\s+(?:much|many|big|long|fast|loud))\b)(?:\s*stars?\b)?/gi;
const N_STARS = /(?<![\d./])(\d(?:\.\d)?)[\s-]*stars?\b/gi;
const WORD_STARS = /\b(one|two|three|four|five)[\s-]stars?\b/gi;
const GLYPH_STARS = /(★+)(☆*)/g;
const WORD_VALUES = { one: 1, two: 2, three: 3, four: 4, five: 5 };
// "knocked off one star", "minus 2 stars": a deduction, not a rating.
const DEDUCTION = /\b(?:knock(?:ed|s|ing)?|dock(?:ed|s|ing)?|minus|tak(?:e|es|ing)|took|los(?:e|es|ing)|lost|deduct(?:ed|s|ing)?|drop(?:ped|s|ping)?)\b(?:\s+off)?\s+(?:one|two|a|1|2)(?:\.\d)?[\s-]*stars?\b/gi;

function ratingsIn(text) {
  const out = [];
  for (const m of text.matchAll(GLYPH_STARS)) if (m[1].length + m[2].length === 5) out.push(m[1].length);
  for (const m of text.matchAll(WORD_STARS)) out.push(WORD_VALUES[m[1].toLowerCase()]);
  for (const m of text.matchAll(OUT_OF_FIVE)) out.push(Number(m[1]));
  // "1 out of 5 stars": the "5 stars" is the scale, not a second rating.
  for (const m of text.replace(OUT_OF_FIVE, ' ').matchAll(N_STARS)) out.push(Number(m[1]));
  return out.filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
}

/** The low star rating (1-2) a sentence gives, or null when it gives none, a higher one, or both. */
export function starsIn(sentence) {
  const ratings = ratingsIn(String(sentence || '').replace(DEDUCTION, ' '));
  if (!ratings.length || ratings.some((n) => n > MAX_LOW_STARS)) return null;
  return ratings[0];
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

// Clean and split each usable source ONCE; every product then scans the prepared text.
function prepareSources(sources) {
  return (sources || []).filter(usableSource).map((s) => ({
    url: s.url,
    title: stripMarkdown(s.title || '').trim(),
    sents: sentences(stripMarkdown(s.content || '')),
  }));
}

function quoteAt(sents, i) {
  const first = sents[i].trim();
  const next = sents[i + 1]?.trim();
  const quote = first.length < SHORT_STAR_SENTENCE && next ? `${first} ${next}` : first;
  return quote.length > MAX_QUOTE_CHARS ? '' : quote;
}

// Matchers for one product. When one name contains the other ("AirPods Pro 2" vs "AirPods
// Pro"), the longer name is blanked out before looking for the shorter one, both ways.
function productMatcher(productName, rivalNames) {
  const self = matchersFor(productName);
  const rivals = (rivalNames || []).flatMap(matchersFor).filter((r) => !self.includes(r));
  const longerThan = (names, others) => names.filter((n) => others.some((o) => n.includes(o))).sort((a, b) => b.length - a.length);
  const blank = (text, names) => names.reduce((t, n) => t.split(n).join(' '), String(text || '').toLowerCase());
  const rivalShadows = longerThan(rivals, self);
  const selfShadows = longerThan(self, rivals);
  return {
    self,
    rivals,
    namesSelf: (text) => mentions(blank(text, rivalShadows), self),
    namesRival: (text) => mentions(blank(text, selfShadows), rivals),
  };
}

function excerptsFromSource(src, m) {
  const { sents, title } = src;
  // A star sentence that does not name the product counts only on a page about it alone.
  const pageIsAboutSelf = m.namesSelf(title) && !m.namesRival(title);
  const found = [];
  for (let i = 0; i < sents.length; i++) {
    const stars = starsIn(sents[i]);
    if (stars == null) continue;
    const namesSelf = m.namesSelf(sents[i]);
    if (!namesSelf && (m.namesRival(sents[i]) || !pageIsAboutSelf)) continue;
    const quote = quoteAt(sents, i);
    if (quote.length < MIN_QUOTE_CHARS || (!namesSelf && m.namesRival(quote))) continue;
    found.push({ quote, stars, sourceUrl: src.url, sourceTitle: title.slice(0, 120) });
  }
  return found;
}

function excerptsFor(productName, prepared, rivalNames, cap) {
  const m = productMatcher(productName, rivalNames);
  if (!m.self.length) return [];
  const out = [];
  const seen = new Set();
  for (const src of prepared) {
    for (const ex of excerptsFromSource(src, m)) {
      const key = ex.quote.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ex);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Up to `cap` verbatim 1-2★ quotes about one product, each with its star count and source.
 * @param {string} productName
 * @param {Array<{url:string,title?:string,content?:string,credibility?:{tags?:string[]}}>} sources
 * @param {string[]} rivalNames other products on the page (their quotes are never borrowed)
 */
export function criticalExcerpts(productName, sources, rivalNames = [], cap = MAX_EXCERPTS) {
  return excerptsFor(productName, prepareSources(sources), rivalNames, cap);
}

/** A copy of the report where every product carries `criticalReviews` (possibly empty). */
export function attachCriticalReviews(report, sources) {
  if (!report || !Array.isArray(report.products)) return report;
  const prepared = prepareSources(sources);
  const names = report.products.map((p) => p.name);
  const products = report.products.map((p) => ({
    ...p,
    criticalReviews: excerptsFor(p.name, prepared, names.filter((n) => n !== p.name), MAX_EXCERPTS),
  }));
  return { ...report, products };
}
