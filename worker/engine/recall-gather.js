// Recall gather — post-planner gather driver for missing category leaders.
import { proposeMissingLeaders } from './extract/recall-supplement.js';
import { runSearch } from './tools.js';
import { harvestCandidates } from './extract/candidates.js';
import { routeHasKey } from '../lib/llm-route.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nameEvidenced(name, sources) {
  const target = String(name || '').trim();
  if (!target || !Array.isArray(sources)) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(target)}([^a-z0-9]|$)`, 'i');
  return sources.some((s) => {
    const title = String(s?.title || '');
    const content = String(s?.content || '');
    return pattern.test(title) || pattern.test(content);
  });
}

export function unevidencedProposals(proposed, sources, limit = 4) {
  if (!Array.isArray(proposed) || limit < 1) return [];
  const out = [];
  const seen = new Set();
  for (const raw of proposed) {
    const name = String(raw || '').trim();
    if (name.length < 3) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (!nameEvidenced(name, sources)) {
      out.push(name);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function recallQueriesFor(name) {
  const n = String(name || '').trim();
  return [`${n} review`, `${n} reddit`];
}

export async function runRecallGather(opts = {}) {
  const {
    query, topicalCategory, sources, notes, openrouterKey, recallModel,
    env, recencySensitive = true, maxNames = 4, maxSearches = 8, deps = {},
  } = opts;

  const propose = deps.propose || proposeMissingLeaders;
  const search = deps.search || runSearch;

  if (!routeHasKey(openrouterKey) || !recallModel || maxSearches < 1 || !Array.isArray(sources) || sources.length === 0) {
    return { proposed: 0, searched: 0, recovered: 0, sources: [] };
  }

  const cands = harvestCandidates(sources, notes || [], {});
  const existingNames = [];
  const seenNames = new Set();
  for (const c of cands) {
    const nm = c?.name;
    if (nm && !seenNames.has(nm.toLowerCase())) {
      seenNames.add(nm.toLowerCase());
      existingNames.push(nm);
      if (existingNames.length >= 40) break;
    }
  }

  let proposals = [];
  try {
    const res = await Promise.race([
      propose(query, topicalCategory || '', existingNames, sources, openrouterKey, recallModel),
      new Promise((resolve) => setTimeout(() => resolve([]), 20000)),
    ]);
    if (Array.isArray(res)) proposals = res;
  } catch {
    proposals = [];
  }

  const targets = unevidencedProposals(proposals, sources, maxNames);
  let searched = 0;
  const collected = [];

  for (const target of targets) {
    if (searched >= maxSearches) break;
    for (const q of recallQueriesFor(target)) {
      if (searched >= maxSearches) break;
      searched++;
      try {
        const found = await search(q, 'web', env, recencySensitive);
        if (Array.isArray(found)) collected.push(...found);
      } catch { /* throwing provider never aborts gather */ }
    }
  }

  const knownUrls = new Set(sources.map((s) => s?.url).filter(Boolean));
  const newSources = [];
  for (const s of collected) {
    if (s && s.url && !knownUrls.has(s.url)) {
      knownUrls.add(s.url);
      newSources.push(s);
    }
  }

  let recovered = 0;
  for (const target of targets) {
    if (nameEvidenced(target, newSources)) recovered++;
  }

  return { proposed: proposals.length, searched, recovered, sources: newSources };
}
