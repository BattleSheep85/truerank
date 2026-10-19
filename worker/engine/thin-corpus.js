// CP-396: thin-corpus fallback. Some queries ("best linen shirts") end the gather with
// hundreds of sources but almost no readable review text: the big fashion pages block
// readers, so every source is a ~150-char search snippet and extraction finds 0 products.
// When a preview of the (deterministic, fast) extraction finds fewer than MIN_PRODUCTS
// products, this runs a few rewritten searches aimed at text-heavy pages (Reddit, forums,
// long-term reviews) and reads the most credible unread pages directly. It never
// fabricates: it only adds sources, and the products still pass the normal gates.

import { runSearch, readPageInto } from './tools.js';
import { urlKey } from './searxng.js';
import { NONCREDIBLE_GENRES } from '../lib/credibility.js';
import { MIN_CREDIBLE_SCORE } from './extract/scoring.js';
import { analyze } from './extract/engine.js';

export const MIN_PRODUCTS = 3;
// The same body floor the con-span miner uses (extract/engine.js conCandidateSpans).
const MIN_BODY_CHARS = 400;
const READ_TIMEOUT_MS = 15_000;
// Hosts whose pages read as video players or login walls, never as review text.
const UNREADABLE_HOSTS = /(?:^|\.)(?:youtube\.com|youtu\.be|instagram\.com|tiktok\.com|facebook\.com|pinterest\.com|x\.com|twitter\.com)$/i;

const isCredible = (s) => {
  const score = s?.credibility?.score ?? 0;
  const tags = s?.credibility?.tags || [];
  return score >= MIN_CREDIBLE_SCORE && !(tags.length && tags.every((t) => NONCREDIBLE_GENRES.has(t)));
};
const hasBody = (s) => String(s?.content || '').length >= MIN_BODY_CHARS;

/** Credible sources that hold real body text (not just a search snippet). For logs. */
export function readableBodyCount(sources) {
  if (!Array.isArray(sources)) return 0;
  return sources.filter((s) => isCredible(s) && hasBody(s)).length;
}

/** Rewritten searches for a thin corpus, aimed at text-heavy community and review pages. */
export function thinCorpusQueries(query, topicalCategory) {
  const subject = String(topicalCategory || query || '').trim();
  if (!subject) return [];
  return [`${subject} recommendations reddit`, `${subject} honest review`, `${subject} long term review forum`];
}

function readable(s) {
  if (!s || typeof s.url !== 'string' || !/^https:\/\//i.test(s.url) || hasBody(s) || !isCredible(s)) return false;
  try {
    return !UNREADABLE_HOSTS.test(new URL(s.url).hostname);
  } catch {
    return false;
  }
}

/** The `limit` most credible unread https pages worth a direct read. */
export function pickPagesToRead(sources, limit) {
  if (!Array.isArray(sources) || limit < 1) return [];
  return sources
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => readable(s))
    .sort((a, b) => ((b.s.credibility?.score ?? 0) - (a.s.credibility?.score ?? 0)) || (a.i - b.i))
    .slice(0, limit)
    .map(({ s }) => s);
}

async function defaultRead(source, env) {
  const copy = { ...source };
  await readPageInto(copy, env, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  return copy;
}

async function rewriteSearches(queries, opts) {
  const { search, env, recencySensitive } = opts;
  const found = [];
  for (const q of queries) {
    try {
      const res = await search(q, 'web', env, recencySensitive);
      if (Array.isArray(res)) found.push(...res);
    } catch { /* a failing provider never aborts the fallback */ }
  }
  return found;
}

function appendNew(sources, found) {
  const known = new Set(sources.map((s) => urlKey(s?.url)).filter((k) => k !== null));
  const added = [];
  for (const s of found) {
    const key = urlKey(s?.url);
    if (key === null || known.has(key)) continue;
    known.add(key);
    added.push(s);
  }
  return [...sources, ...added];
}

/**
 * @returns {Promise<{triggered:boolean, searched:number, read:number, sources:object[]}>}
 *   `sources` is the full list (old + new, read pages replaced by their read copies).
 */
export async function runThinCorpusFallback(opts = {}) {
  const { query, topicalCategory, sources, notes, facets, env, recencySensitive = true, maxSearches = 3, maxReads = 4, deps = {} } = opts;
  const list = Array.isArray(sources) ? sources : [];
  const count = deps.countProducts || ((src) => analyze(query, notes || [], src, facets || {}, topicalCategory || '').length);
  if (count(list) >= MIN_PRODUCTS) return { triggered: false, searched: 0, read: 0, sources: list };

  const queries = thinCorpusQueries(query, topicalCategory).slice(0, Math.max(0, maxSearches));
  const search = deps.search || runSearch;
  const found = await rewriteSearches(queries, { search, env, recencySensitive });
  const pool = appendNew(list, found);

  const read = deps.read || ((s) => defaultRead(s, env));
  const targets = pickPagesToRead(pool, maxReads);
  const results = await Promise.all(targets.map(async (s) => {
    try { return await read(s); } catch { return s; }
  }));
  const readByUrl = new Map(targets.map((s, i) => [s, results[i]]));
  const merged = pool.map((s) => readByUrl.get(s) || s);
  const readCount = results.filter((r, i) => r !== targets[i] && hasBody(r)).length;
  return { triggered: true, searched: queries.length, read: readCount, sources: merged };
}
