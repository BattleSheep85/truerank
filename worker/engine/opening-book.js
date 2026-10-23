// Opening book — deterministic template searches at start of research.
import { runSearch } from './tools.js';
import { urlKey } from './searxng.js';

// The list is a NAMED export so tests can pin it; changing it changes cross-run corpus overlap.
export const OPENING_BOOK_TEMPLATES = [
  'best {subject}',
  '{subject} review',
  'best {subject} reddit',
  '{subject} site:reddit.com',
];

function normalizeWhitespace(str) {
  return String(str ?? '').trim().replace(/\s+/g, ' ');
}

export function openingBookSubject(query, topicalCategory, facets) {
  if (facets?.is_comparative === true) return normalizeWhitespace(query);
  const cat = normalizeWhitespace(topicalCategory);
  return cat || normalizeWhitespace(query);
}

export function buildOpeningBookQueries(query, topicalCategory, facets) {
  const subject = openingBookSubject(query, topicalCategory, facets);
  if (!subject) return [];
  const queries = [];
  const seen = new Set();
  for (const tmpl of OPENING_BOOK_TEMPLATES) {
    const q = tmpl.replace('{subject}', subject);
    if (!seen.has(q)) {
      seen.add(q);
      queries.push(q);
    }
  }
  return queries;
}

export async function runOpeningBook(opts = {}) {
  const {
    query, topicalCategory, facets, env,
    recencySensitive = true, maxSearches = 4, deps = {},
  } = opts;

  const search = deps.search || runSearch;
  const limit = Math.max(0, maxSearches);
  if (limit < 1) return { queries: [], searched: 0, sources: [] };

  const subject = openingBookSubject(query, topicalCategory, facets);
  if (!subject) return { queries: [], searched: 0, sources: [] };

  const queries = buildOpeningBookQueries(query, topicalCategory, facets).slice(0, limit);
  if (queries.length === 0) return { queries: [], searched: 0, sources: [] };

  let searched = 0;
  const collected = [];

  for (const q of queries) {
    searched++;
    try {
      const found = await search(q, 'web', env, recencySensitive);
      if (Array.isArray(found)) collected.push(...found);
    } catch {
      // throwing provider never aborts the rest
    }
  }

  const seenKeys = new Set();
  const sources = [];
  for (const s of collected) {
    const key = urlKey(s?.url);
    if (key !== null && !seenKeys.has(key)) {
      seenKeys.add(key);
      sources.push(s);
    }
  }

  return { queries, searched, sources };
}
