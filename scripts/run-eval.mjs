#!/usr/bin/env node
// Golden-query eval: scores the LIVE site's research output against
// eval/golden-queries.json. This measures honesty at the OUTPUT layer —
// pick correctness, disclosure presence, depth thresholds, freshness —
// complementing the model-selection benchmarks that picked the synth tiers.
//
//   node scripts/run-eval.mjs                # audit existing pages (free)
//   node scripts/run-eval.mjs --spend        # also enqueue runs for missing
//                                            # queries (~$0.10 each, budget-
//                                            # governed server-side)
//   BASE_URL=http://localhost:8787 node scripts/run-eval.mjs   # against dev
//
// Default mode NEVER triggers paid research: missing queries are reported as
// "missing" and only run when --spend is passed. Zero dependencies.

import { readFileSync } from 'node:fs';
import { scorePage, hardFailures, pickExistingSlug } from './lib/eval-score.mjs';

const BASE = process.env.BASE_URL || 'https://chrisputer.tech';
const SPEND = process.argv.includes('--spend');
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const config = JSON.parse(readFileSync(new URL('../eval/golden-queries.json', import.meta.url), 'utf8'));

async function getJson(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Find an existing research page for a query without spending: suggest
// endpoint does LIKE matching over public (non-thin) pages. pickExistingSlug
// prefers the page in the query's own cache cluster and skips test runs.
async function findExisting(query) {
  const { body } = await getJson(`/api/search/suggest?q=${encodeURIComponent(query)}`);
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
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { body } = await getJson(`/api/research/${started.id}`);
    if (body?.status === 'completed') return { slug: body.slug };
    if (body?.status === 'error') return { error: body.error || 'research failed' };
  }
  return { error: 'timeout' };
}

// Everything needed is in the SSR page itself (Our-pick box, product cards,
// source count, disclosure text, CTA links). No structured API, no auth, no
// spend. Scoring lives in scripts/lib/eval-score.mjs so it is unit-tested.
async function scoreSlug(slug, golden) {
  const res = await fetch(`${BASE}/research/${slug}`);
  if (!res.ok) return { error: `page answered HTTP ${res.status}` };
  return { slug, ...scorePage(await res.text(), golden, config.checks) };
}

const results = [];
for (const g of config.queries) {
  let slug = await findExisting(g.query);
  if (!slug && SPEND) {
    process.stderr.write(`running: ${g.query}\n`);
    const run = await runAndWait(g.query);
    if (run.slug) slug = run.slug;
    else { results.push({ query: g.query, status: 'failed', error: run.error }); continue; }
  }
  if (!slug) {
    results.push({ query: g.query, status: 'missing', note: 'no live page; re-run with --spend' });
    continue;
  }
  const score = await scoreSlug(slug, g);
  if (score.error) { results.push({ query: g.query, status: 'failed', slug, error: score.error }); continue; }
  results.push({ query: g.query, status: 'scored', ...score, hard_failures: hardFailures(score) });
}

const scored = results.filter((r) => r.status === 'scored');
// "passed/judged" over the pages where the check applies (null = not judged).
const ratio = (rows, key) => {
  const judged = rows.filter((r) => r[key] != null);
  return judged.length ? `${judged.filter((r) => r[key]).length}/${judged.length}` : 'n/a';
};
const summary = {
  base: BASE,
  scored: scored.length,
  missing: results.filter((r) => r.status === 'missing').length,
  failed: results.filter((r) => r.status === 'failed').length,
  pick_accuracy: ratio(scored, 'pick_correct'),
  disclosure: ratio(scored, 'disclosure_present'),
  depth_ok: ratio(scored, 'products_ok'),
  fresh_ok: ratio(scored, 'fresh_ok'),
  // CP-415: non-product pages (service, local, experience).
  amazon_free: ratio(scored, 'amazon_free'),
  service_layout: ratio(scored, 'service_layout'),
  location_ok: ratio(scored, 'location_ok'),
};

console.log(JSON.stringify({ summary, results }, null, 2));
const hardFails = scored.filter((r) => r.hard_failures.length > 0).length;
process.exit(hardFails > 0 ? 1 : 0);
