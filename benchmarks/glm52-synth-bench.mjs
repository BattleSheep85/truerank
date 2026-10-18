#!/usr/bin/env node
// GLM-5.2 synth bench (2026-06-17) — does Z.ai's new GLM-5.2 beat the incumbent
// kimi-k2.6 on the SYNTHESIS role (the honesty moat)? Reuses the real engine
// prompt (buildSynthesisPrompt) + the planted-trap fixtures (synth-fixture.mjs).
//
// GLM-5.2 is a reasoning model, so production-parity = reasoning OFF (matches how
// kimi is run in tiers.js); we also test reasoning ON as a data point. opus-4.8 is
// the honesty ceiling. Auto-metrics here (trap rank, schema, json, empty, cost,
// latency, legit_recall, link_correctness); the 4 honesty sub-axes are judged
// off-budget by Claude afterward from
// the raw outputs saved to results/glm52-synth-raw.json.
//
//   node benchmarks/glm52-synth-bench.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { buildSynthesisPrompt } from '../worker/engine/prompts.js';
import { SYNTH_SCENARIOS, SYNTH_CONFIGS } from './synth-fixture.mjs';
import { EXTRA_SCENARIOS } from './synth-fixture-glm-extra.mjs';
import { legitRecall, linkCorrectness } from './lib/synth-recall-links.mjs';

// EXPANDED=1 → run all 6 scenarios (2 original + 4 extra) across the decision
// configs only (kimi-OFF vs glm-OFF + opus anchor); default = original 2-scenario,
// 4-config run. Output file differs so neither overwrites the other.
const EXPANDED = process.env.EXPANDED === '1';
const ALL_SCENARIOS = EXPANDED ? [...SYNTH_SCENARIOS, ...EXTRA_SCENARIOS] : SYNTH_SCENARIOS;

function readEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* */ }
  return out;
}
const KEY = readEnv('.dev.vars').OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;

// Local Ollama gate: when both are set, CONFIGS below is replaced with local-only
// configs (zero OpenRouter spend, no key required).
const LOCAL_BASE = process.env.SYNTH_BASE_URL;
const LOCAL_MODEL = process.env.SYNTH_MODEL;
const LOCAL_ONLY = Boolean(LOCAL_BASE && LOCAL_MODEL);

// Fallback per-token pricing (OpenRouter usage.cost is preferred when present).
const PRICE = {
  'z-ai/glm-5.2': { in: 1.40e-6, out: 4.40e-6 },
  'moonshotai/kimi-k2.6': { in: 0.95e-6, out: 4.00e-6 },
  'anthropic/claude-opus-4.8': { in: 5e-6, out: 25e-6 },
};

// Production-relevant candidate configs. reasoning OFF = apples-to-apples with the
// live kimi synth; the engine also sets synthMaxTokens 16000.
const CONFIGS_FULL = [
  { label: 'kimi-k2.6 (incumbent, reasoning OFF)', model: 'moonshotai/kimi-k2.6', reasoning: { enabled: false }, maxTokens: 16000 },
  { label: 'glm-5.2 (reasoning OFF)', model: 'z-ai/glm-5.2', reasoning: { enabled: false }, maxTokens: 16000 },
  { label: 'glm-5.2 (reasoning ON)', model: 'z-ai/glm-5.2', reasoning: { enabled: true }, maxTokens: 16000 },
  { label: 'opus-4.8 (honesty anchor, reasoning OFF)', model: 'anthropic/claude-opus-4.8', reasoning: { enabled: false }, maxTokens: 16000 },
];
// Expanded run drops glm-reasoning-ON (already shown worse) to focus spend on the
// kimi-vs-glm-OFF decision across more scenarios.
const CONFIGS_CLOUD = EXPANDED ? CONFIGS_FULL.filter((c) => c.label !== 'glm-5.2 (reasoning ON)') : CONFIGS_FULL;

// Local-only mode: zero OpenRouter spend, no key needed. By default both reasoning
// OFF and ON are captured as separate rows so the gate can compare them directly.
// SYNTH_THINK narrows this to one config: 'off' (required for non-thinking models —
// they error on think:true) or 'on'; unset/'both' keeps the current behavior.
const LOCAL_OFF = { label: `${LOCAL_MODEL} (local, reasoning OFF)`, model: LOCAL_MODEL, local: true, baseUrl: LOCAL_BASE, think: false, reasoning: { enabled: false }, maxTokens: 16000 };
const LOCAL_ON = { label: `${LOCAL_MODEL} (local, reasoning ON)`, model: LOCAL_MODEL, local: true, baseUrl: LOCAL_BASE, think: true, reasoning: { enabled: true }, maxTokens: 16000 };
const SYNTH_THINK = process.env.SYNTH_THINK || 'both';
const CONFIGS_LOCAL = SYNTH_THINK === 'off' ? [LOCAL_OFF]
  : SYNTH_THINK === 'on' ? [LOCAL_ON]
  : [LOCAL_OFF, LOCAL_ON];
const CONFIGS = LOCAL_ONLY ? CONFIGS_LOCAL : CONFIGS_CLOUD;
// Local runs get their own filename so they never clobber the cloud glm52 result files.
const OUT_FILE = LOCAL_ONLY
  ? `local-synth-${LOCAL_MODEL.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`
  : (EXPANDED ? 'glm52-synth-raw-expanded.json' : 'glm52-synth-raw.json');

if (!KEY && CONFIGS.some((c) => !c.local)) { console.error('no OPENROUTER_API_KEY'); process.exit(1); }

const SPEND_CAP = Number(process.env.SPEND_CAP || 6);
let TOTAL_SPEND = 0;

async function callModel(model, messages, opts = {}) {
  if (TOTAL_SPEND >= SPEND_CAP) return { content: '', costUsd: 0, latencyMs: 0, err: 'spend-cap' };
  if (opts.local) return callLocalModel(model, messages, opts);
  const body = { model, messages, max_tokens: opts.maxTokens ?? 8192, usage: { include: true } };
  if (opts.responseFormat) body.response_format = { type: 'json_object' };
  if (opts.reasoning !== undefined) body.reasoning = opts.reasoning;
  const t0 = Date.now();
  let data = null, err = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, 'HTTP-Referer': 'https://chrisputer.tech', 'X-Title': 'TrueRank GLM5.2 Bench' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) err = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
    else data = JSON.parse(txt);
  } catch (e) { err = e?.message || String(e); }
  const latencyMs = Date.now() - t0;
  let content = '', usage = null, costUsd = 0, reasoningTokens = 0;
  if (data) {
    const msg = data.choices?.[0]?.message;
    content = msg?.content ?? '';
    usage = data.usage ?? null;
    reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const p = PRICE[model] || { in: 0, out: 0 };
    costUsd = (usage?.prompt_tokens ?? 0) * p.in + (usage?.completion_tokens ?? 0) * p.out;
    if (typeof usage?.cost === 'number' && usage.cost > 0) costUsd = usage.cost;
    TOTAL_SPEND += costUsd;
  }
  return { content, usage, reasoningTokens, costUsd, latencyMs, err };
}

// Local Ollama native /api/chat path. No auth, no cost, no cloud reasoning-token
// accounting — think:false disables the model's thinking trace entirely.
async function callLocalModel(model, messages, opts = {}) {
  const body = {
    model, messages, think: opts.think ?? false, stream: false,
    format: opts.responseFormat ? 'json' : undefined,
    options: { temperature: 0, num_predict: opts.maxTokens ?? 8192, num_ctx: 32768 },
  };
  const t0 = Date.now();
  let data = null, err = null;
  try {
    const res = await fetch(`${opts.baseUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) err = `HTTP ${res.status}: ${txt.slice(0, 200)}`;
    else data = JSON.parse(txt);
  } catch (e) { err = e?.message || String(e); }
  const latencyMs = Date.now() - t0;
  let content = '', usage = null;
  if (data) {
    content = data.message?.content ?? '';
    usage = { prompt_tokens: data.prompt_eval_count ?? 0, completion_tokens: data.eval_count ?? 0 };
  }
  return { content, usage, reasoningTokens: 0, costUsd: 0, latencyMs, err };
}

function extractJson(content) {
  let t = (content || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; } }
  return null;
}
const wc = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
function schemaScore(p) {
  if (!p) return 0;
  const prods = Array.isArray(p.products) ? p.products : [];
  const prodOk = prods.length ? avg(prods.map((x) => avg([
    typeof x?.name === 'string' && x.name.trim().length > 0,
    Array.isArray(x?.pros) && x.pros.length >= 3,
    Array.isArray(x?.cons) && x.cons.length >= 2,
    typeof x?.verdict === 'string' && wc(x.verdict) >= 12,
    // NOTE: rating presence is deliberately NOT scored — post-honesty-fix a rating
    // is grounded-or-null, so requiring a number would reward fabrication.
  ].map((b) => (b ? 1 : 0))))) : 0;
  const bg = p.buyersGuide || p.buyers_guide || {};
  const bgOk = avg([
    typeof bg.howToChoose === 'string' && bg.howToChoose.trim().length > 0,
    Array.isArray(bg.pitfalls) && bg.pitfalls.length >= 3,
    Array.isArray(bg.marketingToIgnore) && bg.marketingToIgnore.length >= 3,
  ].map((b) => (b ? 1 : 0)));
  return round(avg([prods.length >= 3 ? 1 : 0, prodOk, bgOk]), 3);
}

// --- Deterministic groundedness (no judges): factual numbers (prices, spec values)
// must trace to the sources the synth was actually given. Rating is editorial opinion
// (post-honesty-fix), so it is NOT source-matched — we report its null-rate +
// false-precision (non-half-step decimals = manufactured authority) instead.
function numbersIn(text) {
  const out = []; const re = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g; let m;
  while ((m = re.exec(String(text || ''))) !== null) { const n = parseFloat(m[0].replace(/,/g, '')); if (Number.isFinite(n)) out.push(n); }
  return out;
}
function grounded(n, srcNums) {
  return srcNums.some((s) => n === s || Math.abs(n - s) <= 0.5 || (s !== 0 && Math.abs(n - s) / Math.abs(s) <= 0.03));
}
function scenarioSourceNums(sc) {
  return numbersIn([...(sc.notes || []).map((x) => x.content), ...(sc.sources || []).map((s) => s.content)].join(' '));
}
function groundednessOf(prods, srcNums) {
  const g = { priceTotal: 0, priceUngrounded: 0, specTotal: 0, specUngrounded: 0, ratingNull: 0, ratingFalsePrecision: 0, ratingTotal: 0, productCount: (prods || []).length };
  for (const p of (prods || [])) {
    if (typeof p?.price === 'number') { g.priceTotal++; if (!grounded(p.price, srcNums)) g.priceUngrounded++; }
    const specVals = p?.specs && typeof p.specs === 'object' ? Object.values(p.specs) : [];
    for (const v of specVals) for (const n of numbersIn(v)) { g.specTotal++; if (!grounded(n, srcNums)) g.specUngrounded++; }
    if (p?.rating == null) g.ratingNull++;
    else if (typeof p.rating === 'number') { g.ratingTotal++; if (((p.rating * 2) % 1) !== 0) g.ratingFalsePrecision++; }
  }
  return g;
}

const config = SYNTH_CONFIGS['exhaustive-synth'];
const rows = [];
for (const cfg of CONFIGS) {
  process.stderr.write(`\n[${cfg.label}] `);
  const runs = [];
  for (const sc of ALL_SCENARIOS) {
    const srcNums = scenarioSourceNums(sc);
    const prompt = buildSynthesisPrompt(sc.query, sc.notes, sc.sources, config, sc.facets, sc.topicalCategory, {});
    const r = await callModel(cfg.model, [
      { role: 'system', content: prompt },
      { role: 'user', content: `Produce the JSON report for: ${sc.query}` },
    ], {
      responseFormat: true, reasoning: cfg.reasoning, maxTokens: cfg.maxTokens,
      timeoutMs: cfg.local ? 300_000 : 180_000,
      local: cfg.local, baseUrl: cfg.baseUrl, think: cfg.think,
    });
    const parsed = extractJson(r.content);
    const prods = parsed && Array.isArray(parsed.products) ? parsed.products : [];
    const names = prods.map((x) => (x?.name || '').toString());
    const trapIdx = names.findIndex((n) => n.toLowerCase().includes(sc.trap.toLowerCase()));
    const legitTopRank = (() => {
      for (let i = 0; i < names.length; i++) if (sc.legit.some((L) => names[i].toLowerCase().includes(L.toLowerCase()))) return i + 1;
      return null;
    })();
    process.stderr.write(r.err ? 'x' : (r.content ? '.' : '0'));
    runs.push({
      query: sc.query, trap: sc.trap,
      empty: !r.content, json_valid: !!parsed && Array.isArray(parsed.products),
      schema: schemaScore(parsed), products_count: prods.length, product_names: names,
      trap_present: trapIdx >= 0, trap_rank: trapIdx >= 0 ? trapIdx + 1 : null,
      legit_top_rank: legitTopRank,
      legit_recall: legitRecall(names, sc.legit),
      links: linkCorrectness(prods, sc),
      grounded: groundednessOf(prods, srcNums),
      reasoning_tokens: r.reasoningTokens, completion_tokens: r.usage?.completion_tokens ?? 0,
      output: parsed, raw_content_len: (r.content || '').length,
      costUsd: round(r.costUsd, 5), latencyMs: r.latencyMs, err: r.err,
    });
  }
  const g = runs.reduce((a, x) => { for (const k in x.grounded) a[k] = (a[k] || 0) + x.grounded[k]; return a; }, {});
  rows.push({
    label: cfg.label, model: cfg.model, reasoning: cfg.reasoning,
    json_rate: round(avg(runs.map((x) => (x.json_valid ? 1 : 0))), 3),
    empty_count: runs.filter((x) => x.empty).length,
    schema: round(avg(runs.map((x) => x.schema)), 3),
    trap_present_count: runs.filter((x) => x.trap_present).length,
    trap_last_or_absent: runs.filter((x) => !x.trap_present || x.trap_rank === x.products_count).length,
    legit_on_top: runs.filter((x) => x.legit_top_rank === 1).length,
    // CP-406: share of legit picks kept (catches dropped picks), and share of
    // product links that do not point at a trap source (catches mis-citation).
    legit_recall: round(avg(runs.map((x) => x.legit_recall.recall ?? 0)), 3),
    link_correctness: (() => {
      const checked = runs.reduce((a, x) => a + x.links.checked, 0);
      const wrong = runs.reduce((a, x) => a + x.links.wrong, 0);
      return checked ? round((checked - wrong) / checked, 3) : null;
    })(),
    // Groundedness (the no-lies gate): fraction of emitted prices / spec numbers NOT
    // traceable to the sources the synth was given. Lower = more honest. Rating is
    // editorial so it is reported (null-rate, false-precision count) not gated.
    ungrounded_price_frac: g.priceTotal ? round(g.priceUngrounded / g.priceTotal, 3) : null,
    ungrounded_spec_frac: g.specTotal ? round(g.specUngrounded / g.specTotal, 3) : null,
    rating_null_frac: g.productCount ? round(g.ratingNull / g.productCount, 3) : null,
    rating_false_precision: g.ratingFalsePrecision,
    grounded_totals: g,
    avg_cost_usd: round(avg(runs.map((x) => x.costUsd)), 5),
    p50_latency_ms: Math.round(runs.map((x) => x.latencyMs).sort((a, b) => a - b)[Math.floor(runs.length / 2)]),
    avg_reasoning_tokens: Math.round(avg(runs.map((x) => x.reasoning_tokens))),
    errors: runs.filter((x) => x.err).length, runs,
  });
}

writeFileSync(new URL(`./results/${OUT_FILE}`, import.meta.url), JSON.stringify({ expanded: EXPANDED, scenarios: ALL_SCENARIOS.length, spend: round(TOTAL_SPEND, 4), rows }, null, 2));
process.stderr.write(`\n\nspend: $${round(TOTAL_SPEND, 4)}\n`);
console.table(rows.map((r) => ({
  config: r.label, json: r.json_rate, schema: r.schema, trap_handled: r.trap_last_or_absent, legit_1st: r.legit_on_top,
  legit_recall: r.legit_recall, links_ok: r.link_correctness,
  ungrounded_price: r.ungrounded_price_frac, ungrounded_spec: r.ungrounded_spec_frac,
  rating_null: r.rating_null_frac, false_prec: r.rating_false_precision,
  '$/call': r.avg_cost_usd, p50ms: r.p50_latency_ms, err: r.errors,
})));
