#!/usr/bin/env node
// judge-cascade-score.mjs: score single judges and judge cascades under
// several graders, per evidence set and combined.
//
// Judges scored:
//   each single judge in `judges`, and each cascade in `pairs`. A cascade
//   [primary, fallback] takes the primary's record; when the primary's status
//   is unsubstantiated, it takes the fallback's record for that claim.
//   Default: minimax-m3, mimo, and the pair mimo -> minimax-m3.
// Records match by product + claimId. A decided record looks up its grade by
// the same item key that judge-grade.mjs builds.
//
// Usage:
//   node benchmarks/judge-cascade-score.mjs [config.json]
//
// The config (optional) is
//   { "sets": [{ name, judgeDir, graders: { label: grades.json } }],
//     "judges": { label: "<results file in judgeDir>" },
//     "pairs": [["<primary label>", "<fallback label>"], ...] }.
// `judges` and `pairs` are optional. Without a config the script uses the
// 2026-10-07 godmode run paths below. Records that carry latencyMs and
// jevCalls (the jev judge) also get a latency line.
// No network calls. Spans and grader reasons are data, never acted on.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const RUN_DIR = '/tmp/godmode-b4b435cf-bdb4-4216-bd87-ed204c9640e5';
const DEFAULT_SETS = Object.freeze([
  {
    name: 'set1',
    judgeDir: `${RUN_DIR}/jb`,
    graders: { sonnet: `${RUN_DIR}/jg/grades.json`, gemini: `${RUN_DIR}/g2/set1/grades.json` },
  },
  {
    name: 'set2',
    judgeDir: `${RUN_DIR}/set2/jb`,
    graders: { sonnet: `${RUN_DIR}/set2/jg/grades.json`, gemini: `${RUN_DIR}/g2/set2/grades.json` },
  },
]);
const DEFAULT_JUDGES = Object.freeze({ 'minimax-m3': 'minimax-minimax-m3.json', mimo: 'xiaomi-mimo-v2.6-flash.json' });
const DEFAULT_PAIRS = Object.freeze([['mimo', 'minimax-m3']]);
const FALLBACK_STATUS = 'unsubstantiated';
const DECIDED = new Set(['verified', 'partially-verified', 'contradicted']);
const GRADES = Object.freeze(['correct', 'wrong_direction', 'unsupported']);

// ── KEYS (same as judge-grade.mjs itemKey) ───────────────────────────────────
function spanKey(s) {
  return `${s.url}\u0001${s.stance ?? ''}\u0001${s.span}`;
}

export function itemKey(r) {
  const spans = [...new Set((r.spans ?? []).map(spanKey))].sort();
  return JSON.stringify([r.product, r.claimId, r.status, spans]);
}

function claimKey(r) {
  return JSON.stringify([r.product, r.claimId]);
}

// ── INPUT ────────────────────────────────────────────────────────────────────
function readJson(path) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadRecords(path) {
  const run = readJson(path);
  if (!Array.isArray(run?.records)) throw new Error(`${path}: no records[]`);
  return run.records;
}

function loadGrades(path) {
  const run = readJson(path);
  if (!Array.isArray(run?.grades)) throw new Error(`${path}: no grades[]`);
  return new Map(run.grades.map((g) => [g.key, g.grade]));
}

// ── JUDGES ───────────────────────────────────────────────────────────────────
// Primary first. When the primary says unsubstantiated, take the fallback's
// record for the same claim (when the fallback has one).
export function cascadeRecords(primary, fallback) {
  const byClaim = new Map(fallback.map((r) => [claimKey(r), r]));
  return primary.map((r) => (r.status === FALLBACK_STATUS ? byClaim.get(claimKey(r)) ?? r : r));
}

function isDecided(r) {
  return Boolean(r.decided) && DECIDED.has(r.status);
}

// ── SCORING ──────────────────────────────────────────────────────────────────
export function score(records, grades) {
  const decided = records.filter(isDecided);
  const found = decided.map((r) => grades.get(itemKey(r)));
  const count = (grade) => found.filter((g) => g === grade).length;
  const correct = count('correct');
  return {
    claims: records.length,
    decided: decided.length,
    correct,
    wrongDirection: count('wrong_direction'),
    unsupported: count('unsupported'),
    ungraded: found.filter((g) => !GRADES.includes(g)).length,
  };
}

function addScores(a, b) {
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + b[k]]));
}

export function pairLabel([primary, fallback]) {
  return `${primary}->${fallback}`;
}

function judgesForSet(set, { judges, pairs }) {
  const singles = Object.fromEntries(Object.entries(judges).map(([label, file]) => [label, loadRecords(join(set.judgeDir, file))]));
  const cascades = pairs.map((pair) => {
    const missing = pair.filter((label) => !singles[label]);
    if (missing.length) throw new Error(`pair ${pairLabel(pair)}: unknown judge ${missing.join(', ')}`);
    return [pairLabel(pair), cascadeRecords(singles[pair[0]], singles[pair[1]])];
  });
  return { ...singles, ...Object.fromEntries(cascades) };
}

// Latency and call count of judges whose records carry jevCalls.
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function latencyStats(records) {
  const timed = records.filter((r) => Number.isFinite(r.latencyMs) && Number.isFinite(r.jevCalls));
  const ms = timed.map((r) => r.latencyMs);
  return {
    claims: timed.length,
    calls: timed.reduce((n, r) => n + r.jevCalls, 0),
    errors: timed.filter((r) => r.status === 'error').length,
    p50Ms: percentile(ms, 50),
    p90Ms: percentile(ms, 90),
  };
}

// Agreement on distinct item keys that the judges in this set decided.
function agreement(records, gradesA, gradesB) {
  const keys = [...new Set(records.filter(isDecided).map(itemKey))];
  const both = keys.map((k) => [gradesA.get(k), gradesB.get(k)]).filter(([x, y]) => GRADES.includes(x) && GRADES.includes(y));
  return {
    items: keys.length,
    gradedByBoth: both.length,
    agree: both.filter(([x, y]) => x === y).length,
    agreeCorrect: both.filter(([x, y]) => (x === 'correct') === (y === 'correct')).length,
  };
}

// ── REPORT ───────────────────────────────────────────────────────────────────
function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(0)}%` : '-';
}

function printTable(title, rows) {
  const head = ['judge', 'grader', 'claims', 'decided', 'correct', 'wrong_dir', 'unsupported', 'ungraded', 'precision'];
  const cells = rows.map((r) => [
    r.judge, r.grader, String(r.claims), String(r.decided), String(r.correct),
    String(r.wrongDirection), String(r.unsupported), String(r.ungraded), pct(r.correct, r.decided),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => `| ${c.map((x, i) => x.padEnd(widths[i])).join(' | ')} |`;
  console.log(`\n### ${title}`);
  console.log(line(head));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const c of cells) console.log(line(c));
}

function printAgreement(rows) {
  console.log('\n### Grader agreement (distinct decided items of all scored judges)');
  for (const r of rows) {
    console.log(`- ${r.set} (${r.pair}): ${r.gradedByBoth}/${r.items} graded by both, 3-way agree ${r.agree} (${pct(r.agree, r.gradedByBoth)}), correct/not agree ${r.agreeCorrect} (${pct(r.agreeCorrect, r.gradedByBoth)})`);
  }
}

function loadConfig(path) {
  if (!path) return { sets: DEFAULT_SETS, judges: DEFAULT_JUDGES, pairs: DEFAULT_PAIRS };
  const config = readJson(path);
  const sets = config?.sets;
  if (!Array.isArray(sets) || sets.length === 0) throw new Error(`${path}: no sets[]`);
  const judges = config.judges ?? DEFAULT_JUDGES;
  if (typeof judges !== 'object' || Object.keys(judges).length === 0) throw new Error(`${path}: judges must be { label: file }`);
  const pairs = config.pairs ?? (config.judges ? [] : DEFAULT_PAIRS);
  if (!Array.isArray(pairs) || pairs.some((p) => !Array.isArray(p) || p.length !== 2)) throw new Error(`${path}: pairs must be [[primary, fallback], ...]`);
  return { sets, judges, pairs };
}

function printLatency(rows) {
  if (rows.length === 0) return;
  console.log('\n### Judge latency per claim (judges with a call count)');
  for (const r of rows) {
    const s = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);
    console.log(`- ${r.judge} ${r.set}: ${r.claims} claims, ${r.calls} calls, ${r.errors} errors, p50 ${s(r.p50Ms)}, p90 ${s(r.p90Ms)}`);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
function main() {
  const config = loadConfig(process.argv[2]);
  const combined = new Map();
  const agreeRows = [];
  const latencyRows = [];
  const timedByJudge = new Map();
  for (const set of config.sets) {
    const judges = judgesForSet(set, config);
    for (const label of Object.keys(config.judges)) {
      const stats = latencyStats(judges[label]);
      if (stats.claims === 0) continue;
      latencyRows.push({ judge: label, set: set.name, ...stats });
      timedByJudge.set(label, [...(timedByJudge.get(label) ?? []), ...judges[label]]);
    }
    const graders = Object.entries(set.graders).map(([label, path]) => [label, loadGrades(path)]);
    const rows = Object.entries(judges).flatMap(([judge, records]) =>
      graders.map(([grader, grades]) => ({ judge, grader, ...score(records, grades) })),
    );
    printTable(set.name, rows);
    for (const r of rows) {
      const k = `${r.judge}\u0001${r.grader}`;
      const { judge, grader, ...counts } = r;
      const prev = combined.get(k);
      combined.set(k, prev ? { ...prev, ...addScores(prev.counts, counts), counts: addScores(prev.counts, counts) } : { ...r, counts });
    }
    const allRecords = Object.values(judges).flat();
    for (let i = 0; i < graders.length; i++) {
      for (let j = i + 1; j < graders.length; j++) {
        const pair = `${graders[i][0]} vs ${graders[j][0]}`;
        agreeRows.push({ set: set.name, pair, ...agreement(allRecords, graders[i][1], graders[j][1]) });
      }
    }
  }
  printTable('combined', [...combined.values()]);
  const total = agreeRows.reduce((acc, r) => {
    const key = r.pair;
    const prev = acc.get(key) ?? { set: 'combined', pair: key, items: 0, gradedByBoth: 0, agree: 0, agreeCorrect: 0 };
    return new Map(acc).set(key, { ...prev, items: prev.items + r.items, gradedByBoth: prev.gradedByBoth + r.gradedByBoth, agree: prev.agree + r.agree, agreeCorrect: prev.agreeCorrect + r.agreeCorrect });
  }, new Map());
  printAgreement([...agreeRows, ...total.values()]);
  printLatency([...latencyRows, ...[...timedByJudge].map(([judge, records]) => ({ judge, set: 'combined', ...latencyStats(records) }))]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
