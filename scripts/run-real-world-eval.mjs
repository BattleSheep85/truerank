#!/usr/bin/env node
// Real-world benchmark eval: scores LIVE pages against expert-review ground truth
// in eval/real-world-benchmark.json. No LLM judge — deterministic HTML scrape only.
//
//   node scripts/run-real-world-eval.mjs           # audit existing pages (free)
//   node scripts/run-real-world-eval.mjs --spend   # enqueue missing (~$0.10 each)
//   node scripts/run-real-world-eval.mjs --id rw-mesh-wifi
//   BASE_URL=http://localhost:8787 node scripts/run-real-world-eval.mjs
//
// Zero dependencies.

import { readFileSync } from 'node:fs';
import { productNames, pickExistingSlug, suggestQuery } from './lib/eval-score.mjs';

const BASE = process.env.BASE_URL || 'https://chrisputer.tech';
const SPEND = process.argv.includes('--spend');
const ID_FILTER = (() => {
  const i = process.argv.indexOf('--id');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const config = JSON.parse(
  readFileSync(new URL('../eval/real-world-benchmark.json', import.meta.url), 'utf8'),
);
const { min_products, min_sources, max_age_days } = config.checks;

let queries = config.queries;
if (ID_FILTER) {
  queries = queries.filter((q) => q.id === ID_FILTER);
  if (!queries.length) {
    console.error(`no query with id ${ID_FILTER}`);
    process.exit(1);
  }
}

async function getJson(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function findExisting(query) {
  const { body } = await getJson(`/api/search/suggest?q=${encodeURIComponent(suggestQuery(query))}`);
  return pickExistingSlug(query, body);
}

async function runAndWait(query) {
  const { body: started } = await getJson('/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!started?.id) return { error: started?.error || 'submit failed' };
  if (started.cached) return { slug: started.slug };
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const { body } = await getJson(`/api/research/${started.id}`);
    if (body?.status === 'completed') return { slug: body.slug };
    if (body?.status === 'error') return { error: body.error || 'research failed' };
  }
  return { error: 'timeout' };
}

async function scoreSlug(slug, entry) {
  const pageRes = await fetch(`${BASE}/research/${slug}`);
  const html = await pageRes.text();
  // The golden eval's card parser (CP-812: the old selectors read 0 products).
  const products = productNames(html);
  const topPick = products[0] || '';
  const topLower = topPick.toLowerCase();
  const accepted = entry.accepted_winners || [];
  const mustInclude = entry.must_include_any || [];

  const pickCorrect = entry.consensus_weak
    ? products.length >= (config.checks.min_products || 3)
    : accepted.some((w) => topLower.includes(w.toLowerCase()));

  const top5 = products.slice(0, 5).map((n) => n.toLowerCase());
  const recallOk = entry.consensus_weak
    ? products.length > 0
    : !mustInclude.length ||
      mustInclude.some((w) => top5.some((n) => n.includes(w.toLowerCase())));

  const antiPatterns = entry.anti_patterns || [];
  const antiHit = antiPatterns.some((p) =>
    products.some((n) => n.toLowerCase().includes(p.toLowerCase())),
  );

  const productCount = products.length;
  const sourceCount = (() => {
    const m = html.match(/Sources \((\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  })();
  const ageDays = (() => {
    const m = html.match(/datetime="(\d{4}-\d{2}-\d{2})"/g);
    if (!m?.length) return null;
    const newest = m.map((s) => Date.parse(s.slice(10, 20))).sort((a, b) => b - a)[0];
    return Math.floor((Date.now() - newest) / 86400000);
  })();

  return {
    slug,
    top_pick: topPick,
    top5: products.slice(0, 5),
    pick_correct: pickCorrect,
    recall_ok: recallOk,
    anti_pattern_hit: antiHit,
    disclosure_present: /may earn a commission/i.test(html),
    product_count: productCount,
    products_ok: productCount >= min_products,
    source_count: sourceCount,
    sources_ok: sourceCount == null ? null : sourceCount >= min_sources,
    age_days: ageDays,
    fresh_ok: ageDays == null ? null : ageDays <= max_age_days,
    consensus_weak: !!entry.consensus_weak,
  };
}

const results = [];
for (const entry of queries) {
  let slug = await findExisting(entry.query);
  if (!slug && SPEND) {
    process.stderr.write(`running: ${entry.query}\n`);
    const run = await runAndWait(entry.query);
    if (run.slug) slug = run.slug;
    else {
      results.push({ id: entry.id, query: entry.query, status: 'failed', error: run.error });
      continue;
    }
  }
  if (!slug) {
    results.push({
      id: entry.id,
      query: entry.query,
      status: 'missing',
      note: 'no live page; re-run with --spend',
      sources: entry.sources?.map((s) => s.publication || s.url).filter(Boolean),
    });
    continue;
  }
  const score = await scoreSlug(slug, entry);
  results.push({
    id: entry.id,
    query: entry.query,
    category: entry.category,
    tags: entry.tags,
    status: 'scored',
    sources: entry.sources,
    ...score,
  });
}

const scored = results.filter((r) => r.status === 'scored');
const scoredStrong = scored.filter((r) => !r.consensus_weak);
const summary = {
  base: BASE,
  benchmark: 'real-world-benchmark.json',
  curated: config.curated,
  total: queries.length,
  scored: scored.length,
  missing: results.filter((r) => r.status === 'missing').length,
  failed: results.filter((r) => r.status === 'failed').length,
  pick_accuracy: scoredStrong.length
    ? `${scoredStrong.filter((r) => r.pick_correct).length}/${scoredStrong.length}`
    : 'n/a',
  recall_top5: scoredStrong.length
    ? `${scoredStrong.filter((r) => r.recall_ok).length}/${scoredStrong.length}`
    : 'n/a',
  disclosure: scored.length
    ? `${scored.filter((r) => r.disclosure_present).length}/${scored.length}`
    : 'n/a',
  depth_ok: scored.length
    ? `${scored.filter((r) => r.products_ok).length}/${scored.length}`
    : 'n/a',
  anti_pattern_hits: scored.filter((r) => r.anti_pattern_hit).length,
};

console.log(JSON.stringify({ summary, results }, null, 2));

const hardFails = scoredStrong.filter(
  (r) => !r.pick_correct || !r.recall_ok || !r.disclosure_present || r.anti_pattern_hit,
).length;
process.exit(hardFails > 0 ? 1 : 0);
