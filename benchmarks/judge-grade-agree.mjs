#!/usr/bin/env node
// judge-grade-agree.mjs: compare two judge-grade.mjs runs (two graders) on the
// same judge verdicts.
//
// Per judge model: correct by grader A, correct by grader B, the agreement
// rate on items both graders graded, and correct-by-both.
//
// Usage:
//   node benchmarks/judge-grade-agree.mjs <grades-A.json> <grades-B.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GRADES = new Set(['correct', 'wrong_direction', 'unsupported']);

function load(path) {
  const run = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(run?.grades)) throw new Error(`${path}: no grades[]`);
  return { grader: run.grader ?? path, byKey: new Map(run.grades.map((g) => [g.key, g])), table: run.table ?? [] };
}

export function agreementRows(a, b) {
  const models = [...new Set([...a.byKey.values()].flatMap((g) => g.models))];
  return models.map((model) => {
    const keys = [...a.byKey.values()].filter((g) => g.models.includes(model)).map((g) => g.key);
    const pairs = keys.map((k) => [a.byKey.get(k)?.grade, b.byKey.get(k)?.grade]);
    const both = pairs.filter(([x, y]) => GRADES.has(x) && GRADES.has(y));
    const decided = a.table.find((r) => r.model === model)?.decided ?? keys.length;
    return {
      model,
      decided,
      correctA: pairs.filter(([x]) => x === 'correct').length,
      correctB: pairs.filter(([, y]) => y === 'correct').length,
      gradedByBoth: both.length,
      agree: both.filter(([x, y]) => x === y).length,
      agreeCorrect: both.filter(([x, y]) => (x === 'correct') === (y === 'correct')).length,
      correctBoth: both.filter(([x, y]) => x === 'correct' && y === 'correct').length,
      ungradedB: pairs.filter(([, y]) => !GRADES.has(y)).length,
    };
  }).sort((p, q) => q.correctBoth - p.correctBoth || q.correctA - p.correctA);
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(0)}%` : '-';
}

function printTable(rows, a, b) {
  const head = ['judge model', 'decided', `correct(${a.grader})`, `correct(${b.grader})`, 'agree 3-way', 'agree correct/not', 'correct by both', 'ungraded B'];
  const cells = rows.map((r) => [
    r.model, String(r.decided), String(r.correctA), String(r.correctB),
    `${r.agree}/${r.gradedByBoth} (${pct(r.agree, r.gradedByBoth)})`,
    `${r.agreeCorrect}/${r.gradedByBoth} (${pct(r.agreeCorrect, r.gradedByBoth)})`,
    String(r.correctBoth), String(r.ungradedB),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => `| ${c.map((x, i) => x.padEnd(widths[i])).join(' | ')} |`;
  console.log(line(head));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const c of cells) console.log(line(c));
}

function main() {
  const [pathA, pathB, outPath] = process.argv.slice(2);
  if (!pathA || !pathB) throw new Error('usage: node benchmarks/judge-grade-agree.mjs <grades-A.json> <grades-B.json> [out.json]');
  const a = load(pathA);
  const b = load(pathB);
  const rows = agreementRows(a, b);
  const items = [...a.byKey.keys()].map((k) => [a.byKey.get(k)?.grade, b.byKey.get(k)?.grade]).filter(([x, y]) => GRADES.has(x) && GRADES.has(y));
  console.log(`Items graded by both: ${items.length}. Overall 3-way agreement ${pct(items.filter(([x, y]) => x === y).length, items.length)}, correct/not agreement ${pct(items.filter(([x, y]) => (x === 'correct') === (y === 'correct')).length, items.length)}.\n`);
  printTable(rows, a, b);
  if (outPath) writeFileSync(outPath, JSON.stringify({ graderA: a.grader, graderB: b.grader, rows }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
