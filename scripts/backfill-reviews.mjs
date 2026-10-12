#!/usr/bin/env node
// Backfill — re-run the worst EXISTING reviews through the current engine (recall-supplement +
// name-cleanup), IN PLACE. Setting a review's status back to 'pending' makes the blackbox poller
// re-claim + re-process it; persist does DELETE-then-insert, so the id/slug (and SEO) are
// preserved and products are replaced, not duplicated. The monthly-budget guard in
// claimNextPendingJob stops the blackbox claiming once spend hits the cap, so this can never
// overspend — worst case it processes fewer than requested.
//
//   bws-exec FRANK_CLOUDFLARE_API_TOKEN -- sh -c 'CLOUDFLARE_API_TOKEN="$FRANK_CLOUDFLARE_API_TOKEN" node scripts/backfill-reviews.mjs' [--limit=N] [--batch=5] [--dry-run]
//
// Targets = complete reviews that are THIN (<=3 products) OR carry a junk name. Resumable: each
// run re-queries the current targets, so re-running picks up whatever still needs work.
import { execSync } from 'node:child_process';

if (process.env.EXTERNAL_WORKER_ENABLED !== 'true') {
  console.error('Refusing to run: EXTERNAL_WORKER_ENABLED is not true. Plain pending rows will not be claimed by any poller when the external worker is disabled.');
  process.exit(1);
}

const DB = 'truerank-db';
const BASE = 'https://chrisputer.tech';
const arg = (k, d) => { const v = (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1]; return v === undefined ? d : v; };
const LIMIT = Number(arg('limit', '999'));
const BATCH = Number(arg('batch', '5'));
const DRY = process.argv.includes('--dry-run');

const PLATFORM = /\b(alexa|homekit|google home|smartthings|zigbee2mqtt|home assistant|apple ecosystem)\b/i;
const FRAGMENT = /\b(users|photograph|troubleshooting|comprehensive|marketed|alternatives|affordable|aesthetic|avoid|starting|lifetime|complications)\b/i;
const SPECFRAG = /^(standard |white \d|avoid |august \d|the )/i;
const isJunk = (n) => PLATFORM.test(n) || SPECFRAG.test(n) || FRAGMENT.test(n);

function d1(sql) {
  const out = execSync(`npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out)[0].results;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function statusOf(id) {
  try { const r = await fetch(`${BASE}/api/research/${id}`); return (await r.json()).status; } catch { return 'unknown'; }
}

// A LEGIT review query is worth re-running; gibberish/test queries are indexed garbage that
// should be deleted, not re-spent on. Heuristic: >=12 chars, >=2 real words, no vowel-less
// long token (keyboard-mash), and no test marker.
function isLegitQuery(q) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 8) return false;                                   // "stuff", "gpu"
  if (/fdsjkl|qwerty|asdfg|zxcv|xyzqq|gizmo xyz|search_term_string/i.test(s)) return false;
  if (/^(test|stuff|gpu|asdf)$/i.test(s) || /\btest (prompt|gizmo|query|search)\b/i.test(s) || /here is the test/i.test(s)) return false;
  if (!s.includes(' ') && s.length >= 10 && !/[aeiou].*[aeiou]/i.test(s)) return false; // keyboard-mash: long, spaceless, vowel-poor
  return true;
}

// Build the target set: FAILED reviews (recovery) + thin/junk-carrying complete reviews (improve).
const rows = d1("SELECT r.id, r.query, r.status st, COUNT(p.id) pc, GROUP_CONCAT(p.name, '||') names FROM research r LEFT JOIN products p ON p.research_id=r.id WHERE r.status IN ('complete','completed','failed') GROUP BY r.id");
const candidates = rows.filter((r) => r.st === 'failed' || r.pc <= 3 || String(r.names || '').split('||').some(isJunk));
const junkQueries = candidates.filter((r) => !isLegitQuery(r.query));
const targets = candidates.filter((r) => isLegitQuery(r.query)).sort((a, b) => a.pc - b.pc).slice(0, LIMIT);

console.log(`[backfill] ${targets.length} legit targets to re-run; ${junkQueries.length} junk/test reviews SKIPPED (delete candidates); batch=${BATCH}${DRY ? ' (DRY RUN)' : ''}`);
if (junkQueries.length) console.log(`[backfill] junk/test (not re-run): ${junkQueries.slice(0, 16).map((j) => JSON.stringify(j.query.slice(0, 24))).join(', ')}`);
if (DRY) { for (const t of targets.slice(0, 30)) console.log(`  [${t.pc}p] ${t.query.slice(0, 60)}`); process.exit(0); }

let done = 0, lifted = 0;
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  const ids = batch.map((b) => b.id);
  // Re-enqueue: flip to pending so the blackbox poller re-claims them.
  d1(`UPDATE research SET status='pending' WHERE id IN (${ids.map((x) => `'${x}'`).join(',')})`);
  console.log(`[backfill] batch ${Math.floor(i / BATCH) + 1}: re-enqueued ${ids.length} (${batch.map((b) => b.pc + 'p').join(',')})`);
  // Poll until the whole batch leaves pending/processing (or 6-min ceiling).
  const deadline = Date.now() + 6 * 60 * 1000;
  let remaining = ids.slice();
  while (remaining.length && Date.now() < deadline) {
    await sleep(12000);
    const sts = await Promise.all(remaining.map(statusOf));
    remaining = remaining.filter((_, k) => sts[k] === 'pending' || sts[k] === 'processing');
  }
  // Measure the lift for this batch.
  const after = d1(`SELECT research_id rid, COUNT(*) pc FROM products WHERE research_id IN (${ids.map((x) => `'${x}'`).join(',')}) GROUP BY research_id`);
  const afterMap = Object.fromEntries(after.map((r) => [r.rid, r.pc]));
  for (const b of batch) { const np = afterMap[b.id] || 0; if (np > b.pc) lifted++; done++; }
  console.log(`[backfill] progress ${done}/${targets.length} processed, ${lifted} lifted`);
}
console.log(`[backfill] DONE — ${done} processed, ${lifted} gained products. Re-run scripts/quality-monitor.mjs to see the corpus health move.`);
