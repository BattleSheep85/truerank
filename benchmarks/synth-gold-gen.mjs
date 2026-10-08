#!/usr/bin/env node
// synth-gold-gen.mjs — GENERATION step of the blinded synthesis-quality gold
// benchmark (mirrors the stance-gold-bench pipeline: generate candidates →
// a frontier judge labels blind → score).
//
// This script is generation + deterministic scoring ONLY. It does NOT judge
// quality — that happens in a later step against the blinded bundles this
// script produces (see synth-gold-blind.mjs).
//
// Reuses the cached corpus (benchmarks/results/google-top50-corpus.json,
// 50 queries x ~149 sources) — NO fresh gather, $0 Serper spend. Picks 8
// diverse queries (deterministic seed 42, spread across category buckets)
// and runs 6 candidate synth models against the REAL production synthesis
// prompt (buildSynthesisPrompt), temperature 0, maxTokens 16000 — mirroring
// exactly how bench-synth-v2.mjs invokes synthesis so outputs match
// production format.
//
// 8 queries x 6 models = 48 synth calls. Estimated ~$1-2. Hard-capped at $3
// — the run aborts (writing whatever completed so far) if the accumulated
// cost would exceed the cap before the next call.
//
// Usage:
//   node benchmarks/synth-gold-gen.mjs
//
//   node benchmarks/synth-gold-gen.mjs --model <id> --label <label> \
//        [--reasoning-effort <value>]
//        # single-candidate mode: runs ONLY <id> over the same 8 queries
//        # (8 calls, not 48) and MERGES the result into the existing output
//        # files: rows for this label are replaced, every other label's
//        # stored rows are preserved untouched. Aborts after the FIRST call
//        # if its cost is wildly higher than a normal synth call (see
//        # FIRST_CALL_COST_SANITY_USD), a cheap early guard against an
//        # xhigh-reasoning model burning an unexpected amount of the 16000
//        # maxTokens budget on hidden reasoning. Same $3 hard cap applies.
//
//   Optional flags (added 2026-10-07; defaults keep the old behavior):
//     --out-dir <dir>          write synth-gold-runs.jsonl and
//                              synth-gold-deterministic.json under <dir>
//                              instead of benchmarks/ft-data/ (the committed
//                              files are then never touched)
//     --production-settings    call the model exactly as the engine does:
//                              ENGINE_CONFIG.synthMaxTokens, synthProvider,
//                              and no temperature override (default mode
//                              keeps maxTokens 16000 and temperature 0)
//   BENCH_MAX_USD=<n>          overrides the $3 hard spend cap for this process
//   Single-candidate mode refuses openai/ ids (owner veto, 2026-07-24).
//
// Outputs:
//   benchmarks/ft-data/synth-gold-runs.jsonl        — one line per (query, model)
//   benchmarks/ft-data/synth-gold-deterministic.json — grounding-gate scores per report

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { buildSynthesisPrompt } from '../worker/engine/prompts.js';
import { callLLMStreaming } from '../worker/engine/llm.js';
import { validateResearchResult } from '../worker/engine/validate.js';
import { ENGINE_CONFIG } from '../worker/lib/engine-config.js';
import { score } from './lib/synth-score.mjs';

// ── ENV ──────────────────────────────────────────────────────────────────────
function loadOpenRouterKey() {
  const devVarsPath = new URL('../.dev.vars', import.meta.url);
  if (!existsSync(devVarsPath)) {
    throw new Error('.dev.vars not found — need OPENROUTER_API_KEY');
  }
  const env = {};
  for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing from .dev.vars');
  return env.OPENROUTER_API_KEY;
}
const KEY = loadOpenRouterKey();

// ── SPEND GOVERNOR ────────────────────────────────────────────────────────────
const HARD_SPEND_CAP_USD = process.env.BENCH_MAX_USD ? Number(process.env.BENCH_MAX_USD) : 3.0;
if (!Number.isFinite(HARD_SPEND_CAP_USD) || HARD_SPEND_CAP_USD <= 0) throw new Error('BENCH_MAX_USD must be a positive number');
let spentUsd = 0;
// A normal synth call here costs a few cents (100 sources x 200 chars each,
// maxTokens 16000). If the very FIRST call of a single-candidate run costs
// much more than that, something is off (e.g. reasoning tokens consuming
// far more of the 16000 budget than expected). Abort before spending
// through the rest of the queries rather than discovering it at the $3 cap.
const FIRST_CALL_COST_SANITY_USD = 0.5;

// ── CLI args (single-candidate mode) ─────────────────────────────────────────
function parseArgs(argv) {
  let model = null;
  let label = null;
  let reasoningEffort = null;
  let outDir = null;
  let productionSettings = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') { model = argv[i + 1] || null; i += 1; }
    else if (argv[i] === '--out-dir') { outDir = argv[i + 1] || null; i += 1; }
    else if (argv[i] === '--production-settings') { productionSettings = true; }
    else if (argv[i] === '--label') { label = argv[i + 1] || null; i += 1; }
    else if (argv[i] === '--reasoning-effort') { reasoningEffort = argv[i + 1] || null; i += 1; }
  }
  return { model, label, reasoningEffort, outDir, productionSettings };
}
const cliArgs = parseArgs(process.argv.slice(2));

// ── CANDIDATES (6, or 1 in single-candidate mode) ────────────────────────────
const BANNED_MODEL_SUBSTRINGS = ['deepseek-r1'];
const DEFAULT_CANDIDATES = [
  { label: 'gpt-5.4-mini',    model: 'openai/gpt-5.4-mini',              reasoning: undefined }, // incumbent
  { label: 'minimax-m3',      model: 'minimax/minimax-m3',               reasoning: undefined },
  { label: 'deepseek-v4-flash', model: 'deepseek/deepseek-v4-flash',     reasoning: undefined },
  { label: 'gemma-4-26b',     model: 'google/gemma-4-26b-a4b-it:free',   reasoning: undefined },
  { label: 'gpt-5-nano',      model: 'openai/gpt-5-nano',                reasoning: undefined },
  { label: 'claude-haiku-4.5', model: 'anthropic/claude-haiku-4.5',      reasoning: undefined },
];
const CANDIDATES = cliArgs.model
  ? [{
      label: cliArgs.label || cliArgs.model.replace(/[/:]/g, '_'),
      model: cliArgs.model,
      reasoning: cliArgs.reasoningEffort || undefined,
    }]
  : DEFAULT_CANDIDATES;
for (const c of CANDIDATES) {
  if (BANNED_MODEL_SUBSTRINGS.some((b) => c.model.toLowerCase().includes(b))) {
    throw new Error(`refusing to benchmark vetoed model: ${c.model}`);
  }
}
if (cliArgs.model && cliArgs.model.toLowerCase().startsWith('openai/')) {
  throw new Error(`refusing to benchmark vetoed model (owner no-OpenAI directive): ${cliArgs.model}`);
}
if (cliArgs.model) {
  process.stderr.write(
    `[single-candidate mode] model=${cliArgs.model} label=${CANDIDATES[0].label} reasoning=${cliArgs.reasoningEffort || 'none'}\n`,
  );
}

// ── CORPUS ────────────────────────────────────────────────────────────────────
const CORPUS_PATH = new URL('./results/google-top50-corpus.json', import.meta.url);
if (!existsSync(CORPUS_PATH)) {
  throw new Error(`cached corpus not found: ${CORPUS_PATH.pathname} — this benchmark reuses it, no fresh gather`);
}
const allCorpora = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')).filter((c) => c.sources?.length);

// ── DETERMINISTIC QUERY SELECTION (seed 42, spread categories) ───────────────
// mulberry32 — small, fast, seedable PRNG (public-domain algorithm).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Category buckets, chosen for topical diversity (audio/kitchen/computing/
// outdoor/home-appliance/office/mobile-accessory/wearable-health). One query
// is drawn from each bucket, deterministically, with seed 42.
const CATEGORY_BUCKETS = {
  audio:              ['earbud', 'headphone', 'soundbar', 'gaming headset'],
  kitchen:            ['air fryer', 'blender', 'microwave', 'coffee maker', 'dishwasher', 'refrigerator'],
  computing:          ['laptop', 'cpu', 'ssd', 'gaming monitor', 'graphic card', 'mouse'],
  outdoor:            ['hiking boot', 'running shoe', 'lawn mower', 'dash cam'],
  home_appliance:     ['vacuum', 'robot vacuum', 'air purifier', 'vacuum cleaner'],
  office:             ['office chair', 'monitor arm', 'printer', 'label maker'],
  mobile_accessory:   ['phone case', 'portable charger', 'smart lock', 'tablet'],
  wearable_health:    ['smartwatch', 'massage gun', 'hair dryer', 'electric shaver'],
};
const SEED = 42;

function selectQueries(corpora, buckets, seed) {
  const rand = mulberry32(seed);
  const selected = [];
  for (const [bucketName, cats] of Object.entries(buckets)) {
    const candidates = corpora.filter((c) => cats.includes(c.cat));
    if (!candidates.length) throw new Error(`no corpus entries for bucket "${bucketName}"`);
    const idx = Math.floor(rand() * candidates.length);
    selected.push({ bucket: bucketName, corpus: candidates[idx] });
  }
  return selected;
}

const selection = selectQueries(allCorpora, CATEGORY_BUCKETS, SEED);
const corpora = selection.map((s) => s.corpus);
process.stderr.write(
  `selected ${corpora.length} queries (seed=${SEED}):\n` +
    selection.map((s) => `  [${s.bucket}] ${s.corpus.query} (${s.corpus.sources.length} src, ${s.corpus.notes.length} notes)`).join('\n') +
    '\n',
);

// ── SYNTH ─────────────────────────────────────────────────────────────────────
const cfg = ENGINE_CONFIG;

async function runSynth(corpus, cand) {
  const prompt = buildSynthesisPrompt(corpus.query, corpus.notes, corpus.sources, cfg, corpus.facets, corpus.cat, {});
  const msgs = [
    { role: 'system', content: prompt },
    { role: 'user', content: `Write the research report for: "${corpus.query}". Respond ONLY with valid JSON.` },
  ];
  const t0 = Date.now();
  let content = '', cost = 0, firstTokenMs = null;
  try {
    const r = await callLLMStreaming(KEY, cand.model, msgs,
      (chunk, acc) => { if (firstTokenMs === null && acc.length > 0) firstTokenMs = Date.now() - t0; },
      cliArgs.productionSettings
        ? { reasoning: cand.reasoning ?? cfg.synthReasoning, maxTokens: cfg.synthMaxTokens, provider: cfg.synthProvider }
        : { reasoning: cand.reasoning, maxTokens: 16000, temperature: 0 },
    );
    content = r.content;
    if (Number.isFinite(r.usage?.cost)) cost = r.usage.cost;
  } catch (err) {
    return { ok: false, error: String(err.message || err), ms: Date.now() - t0, cost, ttft: firstTokenMs };
  }
  const ms = Date.now() - t0;
  const mm = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  let parsed = null;
  try { parsed = JSON.parse((mm ? mm[1] : content).trim()); } catch {}
  if (!parsed) return { ok: false, error: 'json-parse-fail', ms, cost, ttft: firstTokenMs, raw: content.slice(0, 300) };
  try {
    const result = validateResearchResult(parsed);
    return { ok: true, result, ms, cost, ttft: firstTokenMs };
  } catch (err) {
    return { ok: false, error: `validate: ${err.message}`, ms, cost, ttft: firstTokenMs, raw: content.slice(0, 300) };
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
const OUT_BASE = cliArgs.outDir
  ? new URL(cliArgs.outDir.replace(/\/?$/, '/'), `file://${process.cwd()}/`)
  : new URL('./ft-data/', import.meta.url);
const RUNS_OUT = new URL('synth-gold-runs.jsonl', OUT_BASE);
const DETERMINISTIC_OUT = new URL('synth-gold-deterministic.json', OUT_BASE);
mkdirSync(OUT_BASE, { recursive: true });

// Labels this invocation is about to (re)generate. Used at write time to
// merge with, rather than clobber, whatever is already on disk (see
// extract-gold-gen.mjs, same pattern).
const labelsThisRun = new Set(CANDIDATES.map((c) => c.label));

function loadExistingRunLines() {
  if (!existsSync(RUNS_OUT)) return [];
  return readFileSync(RUNS_OUT, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !labelsThisRun.has(JSON.parse(l).label));
}
function loadExistingDeterministic() {
  if (!existsSync(DETERMINISTIC_OUT)) return [];
  return JSON.parse(readFileSync(DETERMINISTIC_OUT, 'utf8')).filter((r) => !labelsThisRun.has(r.model));
}

const runLines = [];
const deterministic = [];
const rows = [];
let aborted = false;
let callsCompleted = 0;

outer:
for (const corpus of corpora) {
  process.stderr.write(`\n▸ ${corpus.query} (${corpus.sources.length} sources, ${corpus.notes.length} notes)\n`);
  for (const cand of CANDIDATES) {
    if (spentUsd >= HARD_SPEND_CAP_USD) {
      process.stderr.write(`\n[SPEND CAP] $${spentUsd.toFixed(4)} >= $${HARD_SPEND_CAP_USD.toFixed(2)} — stopping gracefully, writing partial results\n`);
      aborted = true;
      break outer;
    }
    process.stderr.write(`  → ${cand.label}...\n`);
    const r = await runSynth(corpus, cand);
    spentUsd += r.cost || 0;
    callsCompleted += 1;
    process.stderr.write(
      `    ${cand.label}: ${r.ok ? `ok, ${r.result?.products?.length}p` : r.error} (${r.ms}ms, $${(r.cost || 0).toFixed(4)}, cum=$${spentUsd.toFixed(4)})\n`,
    );

    // First-call cost sanity check (single-candidate mode only). A
    // reasoning-heavy candidate could burn far more of the 16000-token
    // budget than expected, so catch that after ONE call, not after the cap.
    if (cliArgs.model && callsCompleted === 1 && (r.cost || 0) > FIRST_CALL_COST_SANITY_USD) {
      process.stderr.write(
        `\n[COST SANITY] first call cost $${(r.cost || 0).toFixed(4)} > sanity threshold $${FIRST_CALL_COST_SANITY_USD.toFixed(2)}, ` +
          `aborting before running the remaining queries. Investigate before re-running.\n`,
      );
      aborted = true;
      // still record this one call below, then fall through to write+exit.
    }

    runLines.push(JSON.stringify({
      query: corpus.query,
      model: cand.model,
      label: cand.label,
      ok: r.ok,
      error: r.ok ? undefined : r.error,
      report: r.ok ? r.result : null,
      cost: r.cost || 0,
      ms: r.ms,
      ttft: r.ttft ?? null,
    }));
    // --out-dir mode: checkpoint each call as it lands, so a killed run keeps its work.
    if (cliArgs.outDir) appendFileSync(new URL('synth-gold-runs.partial.jsonl', OUT_BASE), runLines[runLines.length - 1] + '\n');

    const base = { query: corpus.query, model: cand.label, ok: r.ok, ms: r.ms, cost: r.cost || 0, error: r.ok ? null : r.error };
    if (r.ok) {
      const s = score(r.result, corpus);
      deterministic.push({ ...base, ...s });
      rows.push({ query: corpus.query.slice(0, 24), model: cand.label, ok: '✓', ms: r.ms, cost_c: `$${((r.cost || 0) * 100).toFixed(3)}¢`, products: s.products, name_ung: s.name_ung, num_ung: s.num_ung });
    } else {
      deterministic.push({ ...base, products: 0, name_ung: 0, num_ung: 0 });
      rows.push({ query: corpus.query.slice(0, 24), model: cand.label, ok: '✗', ms: r.ms, cost_c: `$${((r.cost || 0) * 100).toFixed(3)}¢`, ERROR: r.error?.slice(0, 40) });
    }

    if (aborted) break outer; // cost-sanity abort, stop after recording this one call
  }
}

// Merge: existing rows for OTHER labels (untouched) + this run's rows.
const mergedRunLines = [...loadExistingRunLines(), ...runLines];
const mergedDeterministic = [...loadExistingDeterministic(), ...deterministic];

writeFileSync(RUNS_OUT, mergedRunLines.join('\n') + '\n');
writeFileSync(DETERMINISTIC_OUT, JSON.stringify(mergedDeterministic, null, 2));

console.log('\n══ PER-RUN RESULTS (this invocation only) ══════════════════════════════════════');
console.table(rows);

// Aggregate per model (completion rate + deterministic gate). Computed over
// the MERGED set so it reflects everyone on disk, not just this run.
const byModel = {};
for (const r of mergedDeterministic) {
  const k = r.model;
  byModel[k] ??= { runs: 0, ok: 0, cost: 0, products: 0, name_ung: 0, num_ung: 0 };
  const b = byModel[k];
  b.runs++;
  b.cost += r.cost || 0;
  if (r.ok) { b.ok++; b.products += r.products || 0; b.name_ung += r.name_ung || 0; b.num_ung += r.num_ung || 0; }
}
const agg = Object.entries(byModel).map(([model, b]) => ({
  model,
  completion: `${b.ok}/${b.runs}`,
  total_cost: `$${b.cost.toFixed(4)}`,
  avg_products: b.ok ? Math.round(10 * b.products / b.ok) / 10 : '—',
  name_ung_total: b.name_ung,
  num_ung_total: b.num_ung,
}));

console.log('\n══ AGGREGATE PER MODEL ══════════════════════════════════════════════════════');
console.table(agg);
console.log(`\ntotal spend: $${spentUsd.toFixed(4)} (cap $${HARD_SPEND_CAP_USD.toFixed(2)})${aborted ? ' — ABORTED early on spend cap' : ''}`);
console.log(`runs → ${RUNS_OUT.pathname}`);
console.log(`deterministic gate → ${DETERMINISTIC_OUT.pathname}`);
