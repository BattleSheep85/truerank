#!/usr/bin/env node
// Judge-stage timing bench: same products, same claims, same evidence, two
// configs of the production judge stage (worker/engine/verify.js judgeClaims).
//
//   OLD: stanceModel minimax/minimax-m3, no fallback, concurrency 1
//        (production before 2026-10-08)
//   NEW: stanceModel xiaomi/mimo-v2.6-flash, fallback minimax/minimax-m3,
//        concurrency 12 (production now)
//
// Each config runs BENCH_RUNS times per product. The OLD/NEW order alternates
// per run to spread provider load. Products run one at a time.
//
// Usage: node benchmarks/judge-stage-timing.mjs <verify-*.json>...
// Env: BENCH_MAX_USD (default 1.5), BENCH_RUNS (default 2), BENCH_OUT_DIR.
// Reads OPENROUTER_API_KEY from .dev.vars. Never prints it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { callLLM } from '../worker/engine/llm.js';
import { judgeClaims, evidencePool } from '../worker/engine/verify.js';
import {
  loadOpenRouterKey,
  fetchListing,
  priceOf,
  createBudget,
  worstCallUsd,
  BudgetSkip,
} from './judge-bench.mjs';

const CONFIGS = Object.freeze([
  Object.freeze({ name: 'OLD', stanceModel: 'minimax/minimax-m3', stanceFallbackModel: undefined, concurrency: 1 }),
  Object.freeze({ name: 'NEW', stanceModel: 'xiaomi/mimo-v2.6-flash', stanceFallbackModel: 'minimax/minimax-m3', concurrency: 12 }),
]);
const DECIDED = new Set(['verified', 'partially-verified', 'contradicted']);

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_USD = numEnv('BENCH_MAX_USD', 1.5);
const RUNS = Math.floor(numEnv('BENCH_RUNS', 2));
const OUT_DIR = process.env.BENCH_OUT_DIR || new URL('./results/judge-stage-timing/', import.meta.url).pathname;

function loadProduct(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (!parsed.product || claims.length === 0 || evidence.length === 0) {
    throw new Error(`${path}: needs product, claims[] and evidence[]`);
  }
  // Same pool filter as judge-bench.mjs and the REPLAY mode of verify-product.mjs.
  const pool = evidencePool(evidence, parsed.product, parsed.productUrl ?? null);
  return Object.freeze({ file: basename(path), product: parsed.product, claims, pool });
}

// Production callLLM, unchanged options (no timeout override), with a
// cost-cap reservation before each call and real usage.cost after it.
function cappedCallLLM({ prices, budget, calls }) {
  return async (apiKey, model, messages, opts = {}) => {
    const price = prices.get(model);
    if (!price) throw new Error(`no price for ${model}`);
    const reserved = worstCallUsd(price, messages, opts.maxTokens);
    budget.reserve(reserved);
    let actual = reserved;
    try {
      const resp = await callLLM(apiKey, model, messages, opts);
      const cost = resp?.usage?.cost;
      actual = Number.isFinite(cost) ? cost : reserved;
      calls.push({ model, costUsd: actual, costKnown: Number.isFinite(cost) });
      return resp;
    } finally {
      // A failed call may still bill. Keep its reservation as spend.
      budget.settle(reserved, actual);
    }
  };
}

async function runStage({ cfg, item, apiKey, prices, budget }) {
  const calls = [];
  const started = performance.now();
  const judged = await judgeClaims({
    claims: item.claims,
    scoredEvidence: item.pool,
    config: { stanceModel: cfg.stanceModel, stanceFallbackModel: cfg.stanceFallbackModel },
    apiKey,
    callLLM: cappedCallLLM({ prices, budget, calls }),
    product: item.product,
    concurrency: cfg.concurrency,
  });
  const seconds = (performance.now() - started) / 1000;
  const errors = judged.filter((r) => r && 'error' in r);
  return {
    config: cfg.name,
    product: item.product,
    seconds,
    usd: calls.reduce((s, c) => s + c.costUsd, 0),
    llmCalls: calls.length,
    costUnknownCalls: calls.filter((c) => !c.costKnown).length,
    decided: judged.filter((r) => r && !('error' in r) && DECIDED.has(r.verdict.status)).length,
    claims: item.claims.length,
    errors: errors.length,
    budgetSkips: errors.filter((r) => r.error instanceof BudgetSkip).length,
    errorSample: errors[0] ? String(errors[0].error?.message ?? errors[0].error).slice(0, 200) : null,
    statuses: judged.map((r) => (r && 'error' in r ? 'error' : r.verdict.status)),
    judgeModels: judged.map((r) => (r && 'error' in r ? null : r.judgeModel)),
  };
}

function median(values) {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarize(runs) {
  const by = (name) => runs.filter((r) => r.config === name);
  const side = (rs) => ({
    medianS: median(rs.map((r) => r.seconds)),
    usd: rs.reduce((s, r) => s + r.usd, 0),
    decided: rs.map((r) => r.decided),
    errors: rs.reduce((s, r) => s + r.errors, 0),
  });
  const old = side(by('OLD'));
  const neu = side(by('NEW'));
  return { old, neu, speedup: old.medianS / neu.medianS };
}

function row(label, s) {
  const f = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
  return `| ${label} | ${f(s.old.medianS)} | ${f(s.neu.medianS)} | ${Number.isFinite(s.speedup) ? s.speedup.toFixed(2) : 'n/a'}x | $${s.old.usd.toFixed(4)} | $${s.neu.usd.toFixed(4)} | ${s.old.decided.join('/')} | ${s.neu.decided.join('/')} | ${s.old.errors}/${s.neu.errors} |`;
}

function table(results) {
  const lines = [
    '| product | OLD median s | NEW median s | speedup | OLD USD (all runs) | NEW USD (all runs) | OLD decided/run | NEW decided/run | errors OLD/NEW |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of results.products) lines.push(row(p.product, summarize(p.runs)));
  lines.push(row('**overall**', summarize(results.products.flatMap((p) => p.runs))));
  return lines.join('\n');
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('usage: judge-stage-timing.mjs <verify-*.json>...');
  const items = paths.map(loadProduct);
  const apiKey = loadOpenRouterKey();
  const listing = await fetchListing();
  const models = [...new Set(CONFIGS.flatMap((c) => [c.stanceModel, c.stanceFallbackModel].filter(Boolean)))];
  const prices = new Map(models.map((m) => {
    if (!listing.has(m)) throw new Error(`${m} is not listed on OpenRouter`);
    return [m, priceOf(listing.get(m))];
  }));
  const budget = createBudget(MAX_USD);
  mkdirSync(OUT_DIR, { recursive: true });
  const results = { startedAt: new Date().toISOString(), maxUsd: MAX_USD, runsPerConfig: RUNS, configs: CONFIGS, products: [] };

  for (const item of items) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const order = i % 2 === 0 ? CONFIGS : [...CONFIGS].reverse();
      for (const cfg of order) {
        const r = await runStage({ cfg, item, apiKey, prices, budget });
        runs.push({ ...r, run: i + 1 });
        console.log(`[stage] ${item.product} run ${i + 1} ${cfg.name}: ${r.seconds.toFixed(1)}s $${r.usd.toFixed(4)} decided ${r.decided}/${r.claims} errors ${r.errors} spent $${budget.spent().toFixed(4)}`);
      }
    }
    results.products.push({ file: item.file, product: item.product, claims: item.claims.length, pool: item.pool.length, runs });
    writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
  }

  results.finishedAt = new Date().toISOString();
  results.spentUsd = budget.spent();
  const md = table(results);
  writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${OUT_DIR}/table.md`, `${md}\n\nTotal spent: $${budget.spent().toFixed(4)} (cap $${MAX_USD})\n`);
  console.log(`\n${md}\n\nTotal spent: $${budget.spent().toFixed(4)} (cap $${MAX_USD})`);
}

main().catch((err) => {
  console.error(`[stage] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
