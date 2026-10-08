// Reranked claim evidence (ENGINE_CONFIG.evidenceRerank). Each candidate
// source's clean text is split into sentence-aligned passages, the Jina
// reranker orders them against the claim text, and the judge gets the best
// passage of each of the top sources. The rows keep the shape that
// rankClaimEvidence returns (a copy of the source with its `passage`), so the
// stance prompt and the backstops do not change.
//
// Zero runtime deps. The rerank call is injected through `rerank` (see
// worker/lib/jina.js rerankPassages).

import { rerankPassages } from '../lib/jina.js';

// Passage length sent to the judge (same as DEFAULT_PASSAGE_CHARS in verify.js).
export const RERANK_PASSAGE_CHARS = 1200;
// Passages sent to the reranker per claim. 120 x 1,200 chars is about 40k
// tokens, well under the model's 131k-token limit for one call.
export const MAX_RERANK_PASSAGES = 120;
// Top term-ranked sources that give passages, and passages from each one, so
// one long page cannot fill the whole passage budget.
export const MAX_RERANK_SOURCES = 24;
export const MAX_PASSAGES_PER_SOURCE = 5;
// Shorter passages are menu or footer fragments.
const MIN_PASSAGE_CHARS = 40;

// A sentence ends after . ! or ? before whitespace, or at a line break.
const SENTENCE_END_RE = /[.!?]+(?=\s)|\n/g;

function sentenceEnds(text) {
  return [...[...text.matchAll(SENTENCE_END_RE)].map((m) => m.index + m[0].length), text.length];
}

/**
 * Splits text into passages of at most maxChars that end at a sentence end.
 * A sentence longer than maxChars is cut into maxChars pieces. Passages keep
 * the source's own characters (trimmed), so a quoted span stays verbatim.
 * Passages shorter than MIN_PASSAGE_CHARS are dropped.
 */
export function splitPassages(text, maxChars = RERANK_PASSAGE_CHARS) {
  const s = String(text ?? '');
  const pieces = [];
  let start = 0;
  let lastEnd = 0;
  for (const end of sentenceEnds(s)) {
    if (end - start <= maxChars) {
      lastEnd = end;
      continue;
    }
    if (lastEnd > start) {
      pieces.push(s.slice(start, lastEnd));
      start = lastEnd;
    }
    while (end - start > maxChars) {
      pieces.push(s.slice(start, start + maxChars));
      start += maxChars;
    }
    lastEnd = end;
  }
  if (lastEnd > start) pieces.push(s.slice(start, lastEnd));
  return pieces.map((p) => p.trim()).filter((p) => p.length >= MIN_PASSAGE_CHARS);
}

function distinctHits(passage, terms) {
  const lower = passage.toLowerCase();
  return terms.filter((t) => lower.includes(t)).length;
}

// The source's passages with the most distinct claim terms, at most `limit`.
function bestPassagesOf(text, terms, limit) {
  return splitPassages(text)
    .map((passage, i) => ({ passage, i, hits: distinctHits(passage, terms) }))
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.passage);
}

/**
 * Candidate passages for one claim: [{ source, passage }]. Sources in the
 * given (term-ranked) order, at most MAX_RERANK_SOURCES, at most
 * MAX_PASSAGES_PER_SOURCE each, at most MAX_RERANK_PASSAGES in total.
 */
export function rerankCandidates(ranked, textOf, terms) {
  const list = Array.isArray(ranked) ? ranked.slice(0, MAX_RERANK_SOURCES) : [];
  const lowerTerms = (Array.isArray(terms) ? terms : []).map((t) => String(t).toLowerCase());
  return list
    .flatMap((source) => bestPassagesOf(textOf(source), lowerTerms, MAX_PASSAGES_PER_SOURCE).map((passage) => ({ source, passage })))
    .slice(0, MAX_RERANK_PASSAGES);
}

/**
 * The judge's evidence for one claim from reranked passages: the best passage
 * of each source in rerank order, at most n sources. When fewer than n sources
 * have a passage, the rest of `ranked` (with its own passage) fills the list.
 *
 * `ranked`: rankClaimEvidence output over the whole pool (copies with `passage`).
 * `textOf(source)`: the clean evidence text of a source.
 * `rerank`: { apiKey, model, fetchImpl?, onUsage? }.
 * Throws when the rerank call fails; the caller falls back.
 */
export async function rerankClaimEvidence({ claim, ranked, textOf, terms, rerank, n }) {
  const candidates = rerankCandidates(ranked, textOf, terms);
  if (candidates.length === 0) return ranked.slice(0, n);
  const order = await rerankPassages({
    apiKey: rerank.apiKey,
    model: rerank.model,
    fetchImpl: rerank.fetchImpl,
    onUsage: rerank.onUsage,
    query: claim?.text ?? '',
    passages: candidates.map((c) => c.passage),
    topN: candidates.length,
  });
  const picked = new Map();
  for (const { index } of order) {
    if (picked.size >= n) break;
    const { source, passage } = candidates[index];
    if (!picked.has(source.url)) picked.set(source.url, { ...source, passage });
  }
  const fill = ranked.filter((s) => !picked.has(s.url)).slice(0, Math.max(0, n - picked.size));
  return [...picked.values(), ...fill];
}
