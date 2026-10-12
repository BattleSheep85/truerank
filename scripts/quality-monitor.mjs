#!/usr/bin/env node
// Quality monitor — audits EVERY live review on chrisputer.tech and scores the corpus on the
// two failure modes that actually hurt: thinness (too few products → weak "best X" list) and
// junk names (platforms/fragments/merges that survived extraction). Re-runnable: run it before
// and after any engine change to see the corpus move. Zero npm deps; reads prod D1 via wrangler.
//
//   bws-exec FRANK_CLOUDFLARE_API_TOKEN -- sh -c 'CLOUDFLARE_API_TOKEN="$FRANK_CLOUDFLARE_API_TOKEN" node scripts/quality-monitor.mjs' [--json] [--worst N]
//
// Exit code is non-zero when the corpus health score drops below THRESHOLD, so CI/cron can gate.
import { execSync } from 'node:child_process';

const DB = 'truerank-db';
const THRESHOLD = 0.45; // min fraction of reviews that are "healthy" (>=4 products, 0 junk)
const argJson = process.argv.includes('--json');
const worstN = Number((process.argv.find((a) => a.startsWith('--worst=')) || '').split('=')[1]) || 10;

function d1(sql) {
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out)[0].results;
}

// Junk-name detectors — heuristic, tuned on the 2026-06 corpus audit. PLATFORM is the big one
// (smart-home ecosystems mis-harvested as products); the rest catch sentence fragments + merges.
// PLATFORM = a voice/ecosystem name standing in as a product. NOT "matter"/"zigbee" alone —
// those are protocols real bulbs legitimately list as a feature ("LIFX ... Matter-enabled").
const PLATFORM = /\b(alexa|homekit|google home|smartthings|zigbee2mqtt|home assistant|apple ecosystem)\b/i;
const FRAGMENT = /\b(users|photograph|troubleshooting|comprehensive|marketed|alternatives|affordable|aesthetic|avoid|starting|lifetime|complications)\b/i;
const SPECFRAG = /^(standard |white \d|avoid |august \d|the )/i;
const MERGE = /[a-z0-9]\)[A-Z]| And [A-Z]\w+ [A-Z]/;
function classifyJunk(name) {
  if (PLATFORM.test(name)) return 'platform';
  if (SPECFRAG.test(name)) return 'specfrag';
  if (FRAGMENT.test(name)) return 'fragment';
  if (MERGE.test(name)) return 'merge';
  return null;
}

const statusRows = d1("SELECT status, COUNT(*) n FROM research GROUP BY status");
const status = Object.fromEntries(statusRows.map((r) => [r.status, r.n]));

const prod = d1(
  "SELECT p.name, p.research_id rid, r.query FROM products p JOIN research r ON r.id=p.research_id WHERE r.status IN ('complete','completed')",
);
const reviewRows = d1(
  "SELECT r.id, r.query, COUNT(p.id) pc FROM research r LEFT JOIN products p ON p.research_id=r.id WHERE r.status IN ('complete','completed') GROUP BY r.id",
);

// Per-review rollup: product count, junk count, near-duplicate names.
const byReview = new Map(reviewRows.map((r) => [r.id, { query: r.query, pc: r.pc, junk: 0, dupes: 0, junkNames: [] }]));
const namesByReview = new Map();
for (const p of prod) {
  const rv = byReview.get(p.rid); if (!rv) continue;
  const j = classifyJunk(p.name);
  if (j) { rv.junk++; rv.junkNames.push(`${p.name} [${j}]`); }
  if (!namesByReview.has(p.rid)) namesByReview.set(p.rid, []);
  namesByReview.get(p.rid).push(p.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
}
for (const [rid, names] of namesByReview) {
  const seen = new Set(); let d = 0;
  for (const n of names) { const k = n.split(' ').slice(0, 3).join(' '); if (seen.has(k)) d++; seen.add(k); }
  byReview.get(rid).dupes = d;
}

const reviews = [...byReview.values()];
const total = reviews.length;
const buckets = { empty: 0, thin: 0, ok: 0, good: 0 };
let junkProducts = 0, junkReviews = 0, healthy = 0;
for (const r of reviews) {
  if (r.pc === 0) buckets.empty++; else if (r.pc <= 3) buckets.thin++; else if (r.pc <= 6) buckets.ok++; else buckets.good++;
  junkProducts += r.junk; if (r.junk > 0) junkReviews++;
  if (r.pc >= 4 && r.junk === 0) healthy++;
}
const healthScore = total ? healthy / total : 0;
const worst = reviews.filter((r) => r.junk > 0 || r.pc <= 1)
  .sort((a, b) => (b.junk - a.junk) || (a.pc - b.pc)).slice(0, worstN);

const report = {
  generatedAt: new Date().toISOString(),
  status,
  totalComplete: total,
  totalProducts: prod.length,
  productBuckets: buckets,
  thinPct: total ? Math.round((100 * (buckets.empty + buckets.thin)) / total) : 0,
  junkProducts,
  junkReviews,
  healthScore: Number(healthScore.toFixed(3)),
  worst: worst.map((r) => ({ query: r.query, products: r.pc, junk: r.junk, junkNames: r.junkNames.slice(0, 4) })),
};

if (argJson) { console.log(JSON.stringify(report, null, 2)); }
else {
  console.log(`\nTrueRank quality monitor — ${report.generatedAt}`);
  console.log(`  status:        ${JSON.stringify(status)}`);
  console.log(`  reviews:       ${total} complete, ${prod.length} products`);
  console.log(`  product mix:   empty ${buckets.empty} | thin(1-3) ${buckets.thin} | ok(4-6) ${buckets.ok} | good(7+) ${buckets.good}`);
  console.log(`  THIN (<=3):    ${report.thinPct}% of reviews`);
  console.log(`  junk names:    ${junkProducts} products across ${junkReviews} reviews`);
  console.log(`  HEALTH SCORE:  ${(healthScore * 100).toFixed(1)}%  (>=4 products AND 0 junk; threshold ${THRESHOLD * 100}%)`);
  console.log(`  worst offenders:`);
  for (const w of report.worst) console.log(`    [${w.products}p ${w.junk}j] ${w.query.slice(0, 56)}${w.junkNames.length ? '  ·  ' + w.junkNames.join('; ').slice(0, 70) : ''}`);
  console.log('');
}

process.exit(healthScore < THRESHOLD ? 1 : 0);
