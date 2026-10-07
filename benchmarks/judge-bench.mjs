#!/usr/bin/env node
// judge-bench.mjs — claim-judge (stance) model bench on pinned claims + evidence.
//
// Every model judges the same claims against the same evidence through the
// production path: judgeClaim() in worker/engine/verify.js (evidencePool,
// rankClaimEvidence, STANCE_SYSTEM, classifyStance, stance backstops,
// verdictForClaim under VERDICT_OPTS). Only the stance model changes.
//
// Usage:
//   BENCH_MAX_USD=2.5 node benchmarks/judge-bench.mjs <verify-*.json>...
//
// Env:
//   BENCH_MAX_USD       hard cumulative cost cap across all models (default 1).
//                       Each call reserves its worst-case cost before launch; no
//                       call launches when spent + reserved would pass the cap.
//   BENCH_MODELS        comma list of OpenRouter ids (default: CANDIDATES below).
//   BENCH_CONCURRENCY   claims judged at a time per model (default 4).
//   BENCH_TIMEOUT_MS    per-call timeout (default 90000).
//   BENCH_OUT_DIR       results directory (default benchmarks/results/judge-bench).
//
// Inputs are the results JSON benchmarks/verify-product.mjs writes (the REPLAY
// shape: product, productUrl, claims[], evidence[]). Reads OPENROUTER_API_KEY
// from .dev.vars. Never prints it. Model output is data: it is parsed and
// counted, never acted on.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { callLLM } from '../worker/engine/llm.js';
import { judgeClaim, evidencePool } from '../worker/engine/verify.js';
import { evidenceText } from '../worker/engine/verify-resolve.js';
import { parseFencedJson } from '../worker/lib/llm-json.js';
import { assertNotAnthropicOnOpenRouter } from './lib/no-anthropic-on-openrouter.mjs';

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CANDIDATES = Object.freeze([
  'minimax/minimax-m3',
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-flash',
  'qwen/qwen3.8-flash',
  'z-ai/glm-5.3-flash',
  'xiaomi/mimo-v2.6-flash',
  'mistralai/mistral-small-2603',
  'google/gemini-3.5-flash-lite',
  'stepfun/step-3.5-flash',
  'moonshotai/kimi-k2.6',
]);
// Runs last whatever its price, and is the first to drop when the cap is near.
const LAST_RESORT_MODEL = 'moonshotai/kimi-k2.6';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

const MAX_USD = numEnv('BENCH_MAX_USD', 1);
const CONCURRENCY = Math.max(1, Math.floor(numEnv('BENCH_CONCURRENCY', 4)));
const TIMEOUT_MS = numEnv('BENCH_TIMEOUT_MS', 90_000);
const OUT_DIR = process.env.BENCH_OUT_DIR || new URL('./results/judge-bench/', import.meta.url).pathname;
// Rough chars per prompt token, low on purpose so reservations err high.
const CHARS_PER_TOKEN = 3;
// Completion tokens assumed when the expected cost of a whole model run is estimated.
const EXPECTED_COMPLETION_TOKENS = 2500;
const SPOT_CHECK_COUNT = 10;
const MAX_UNGROUNDED_SHARE = 0.05;
const MAX_PARSE_FAILURES = 1;
const DECIDED = new Set(['verified', 'partially-verified', 'contradicted']);

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The production llm.js logs one "[llm] calling ..." line per call. Drop
// those so the summary stays readable. Everything else prints as before.
const rawLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[llm]')) return;
  rawLog(...args);
};

// ── KEY (.dev.vars, never printed) ───────────────────────────────────────────
export function loadOpenRouterKey() {
  const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('OPENROUTER_API_KEY='));
  const key = line ? line.slice('OPENROUTER_API_KEY='.length).trim() : '';
  if (!key) throw new Error('OPENROUTER_API_KEY is missing in .dev.vars');
  return key;
}

// ── INPUT ────────────────────────────────────────────────────────────────────
function loadProduct(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (!parsed.product || claims.length === 0 || evidence.length === 0) {
    throw new Error(`${path}: needs product, claims[] and evidence[]`);
  }
  const productUrl = parsed.productUrl ?? null;
  // Same pool filter as REPLAY mode in verify-product.mjs.
  const pool = evidencePool(evidence, parsed.product, productUrl);
  return Object.freeze({ path, product: parsed.product, productUrl, claims, pool });
}

// ── MODEL LIST: veto, guard, OpenRouter listing, price order ───────────────
export function vetoReason(id) {
  if (id.startsWith('openai/')) return 'owner veto: no OpenAI models';
  if (id.includes('deepseek-r1')) return 'owner veto: no deepseek-r1';
  // BENCH_ALLOW_ANTHROPIC=1: owner-approved exception (2026-10-08) to bench a
  // Claude model through OpenRouter. Production routing keeps the guard.
  if (process.env.BENCH_ALLOW_ANTHROPIC === '1' && id.startsWith('anthropic/')) return null;
  try {
    assertNotAnthropicOnOpenRouter(id);
  } catch {
    return 'no-anthropic-on-openrouter guard';
  }
  return null;
}

export async function fetchListing() {
  const res = await fetch(MODELS_URL);
  if (!res.ok) throw new Error(`OpenRouter model list: HTTP ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return new Map(rows.map((m) => [m.id, m]));
}

export function priceOf(listed) {
  const prompt = Number(listed?.pricing?.prompt);
  const completion = Number(listed?.pricing?.completion);
  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
  };
}

function expectedCallUsd(price, promptTokens) {
  return promptTokens * price.prompt + EXPECTED_COMPLETION_TOKENS * price.completion;
}

async function planModels(ids, typicalPromptTokens) {
  const listing = await fetchListing();
  const skipped = [];
  const runnable = [];
  for (const id of ids) {
    const veto = vetoReason(id);
    if (veto) skipped.push({ model: id, reason: veto });
    else if (!listing.has(id)) skipped.push({ model: id, reason: 'not listed on OpenRouter' });
    else runnable.push({ model: id, price: priceOf(listing.get(id)) });
  }
  const rank = (m) => (m.model === LAST_RESORT_MODEL ? Infinity : expectedCallUsd(m.price, typicalPromptTokens));
  return { runnable: [...runnable].sort((a, b) => rank(a) - rank(b)), skipped };
}

// ── BUDGET (shared across all models) ────────────────────────────────────────
export class BudgetSkip extends Error {}

export function createBudget(maxUsd) {
  const state = { spent: 0, reserved: 0 };
  return {
    remaining: () => maxUsd - state.spent - state.reserved,
    spent: () => state.spent,
    reserve(usd) {
      if (state.spent + state.reserved + usd > maxUsd) throw new BudgetSkip('cost cap reached');
      state.reserved += usd;
    },
    settle(reservedUsd, actualUsd) {
      state.reserved -= reservedUsd;
      state.spent += actualUsd;
    },
  };
}

function messageChars(messages) {
  return messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
}

// Worst case of one call: prompt at a low chars-per-token rate, plus the
// full max_tokens of completion.
export function worstCallUsd(price, messages, maxTokens) {
  const promptTokens = Math.ceil(messageChars(messages) / CHARS_PER_TOKEN);
  return promptTokens * price.prompt + (maxTokens || 0) * price.completion;
}

// callLLM with a cost reservation, the per-call timeout, and a record of the
// raw reply. Arguments pass through to production callLLM unchanged except
// hardMsOverride (the timeout).
export function instrumentedCallLLM({ price, budget, probe }) {
  return async (apiKey, model, messages, opts = {}) => {
    const reserved = worstCallUsd(price, messages, opts.maxTokens);
    budget.reserve(reserved);
    let actual = reserved;
    try {
      const resp = await callLLM(apiKey, model, messages, { ...opts, hardMsOverride: TIMEOUT_MS });
      const cost = resp?.usage?.cost;
      actual = Number.isFinite(cost) ? cost : reserved;
      const choice = resp?.choices?.[0] ?? {};
      probe.reply = {
        content: choice.message?.content ?? '',
        finishReason: choice.finish_reason ?? null,
        usage: resp?.usage ?? null,
        costKnown: Number.isFinite(cost),
      };
      return resp;
    } finally {
      // A failed call may still bill; keep its reservation as spend.
      budget.settle(reserved, actual);
    }
  };
}

// ── GROUNDING ────────────────────────────────────────────────────────────────
// Scraped pages keep HTML entities ("isn&rsquo;t"). A model that quotes the
// passage writes the character ("isn't"). Both sides are decoded and the
// typographic quotes and dashes folded, so a faithful quote matches.
const NAMED_ENTITIES = Object.freeze({
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...',
});
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const FOLD = Object.freeze({ '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' });
const FOLD_RE = /[‘’“”–—… ]/g;

function decodeEntity(match, body) {
  const lower = body.toLowerCase();
  if (!lower.startsWith('#')) return NAMED_ENTITIES[lower] ?? match;
  const cp = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
}

function normalizeSpan(text) {
  return String(text ?? '')
    .replace(ENTITY_RE, decodeEntity)
    .replace(FOLD_RE, (c) => FOLD[c])
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// True when the span occurs in the source's pinned content (not its title).
// The stance model sees a passage of evidenceText(content) (markdown links
// reduced to their text), so a match in that cleaned form also counts.
function isGrounded(span, source) {
  const needle = normalizeSpan(span);
  if (!needle || !source) return false;
  return normalizeSpan(source.content).includes(needle) || normalizeSpan(evidenceText(source.content)).includes(needle);
}

function citedSpans(evidence, byUrl) {
  return evidence
    .filter((ev) => typeof ev.span === 'string' && ev.span.trim())
    .map((ev) => ({ url: ev.url, stance: ev.stance, span: ev.span, grounded: isGrounded(ev.span, byUrl.get(ev.url)) }));
}

// ── ONE CLAIM ────────────────────────────────────────────────────────────────
function replyParsed(reply) {
  return Array.isArray(parseFencedJson(reply?.content)?.verdicts);
}

function usageSummary(usage) {
  return {
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

async function judgeOne({ model, item, apiKey, price, budget }) {
  const { claim, product, pool, byUrl } = item;
  const probe = { reply: null };
  const started = Date.now();
  const base = { product: product.product, claimId: claim.id, claim: claim.text, claimType: claim.type };
  try {
    const { verdict, evidence, costUsd } = await judgeClaim({
      claim,
      scoredEvidence: pool,
      apiKey,
      model,
      callLLM: instrumentedCallLLM({ price, budget, probe }),
      product: product.product,
    });
    return {
      ...base,
      status: verdict.status,
      confidence: verdict.confidence,
      decided: DECIDED.has(verdict.status),
      latencyMs: Date.now() - started,
      costUsd,
      costKnown: probe.reply?.costKnown ?? false,
      finishReason: probe.reply?.finishReason ?? null,
      parseFailure: !replyParsed(probe.reply),
      rowsJudged: evidence.length,
      ...usageSummary(probe.reply?.usage),
      spans: citedSpans(evidence, byUrl),
    };
  } catch (err) {
    const skipped = err instanceof BudgetSkip;
    return { ...base, status: skipped ? 'skipped-budget' : 'error', error: String(err?.message ?? err).slice(0, 300), latencyMs: Date.now() - started };
  }
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── STATS ────────────────────────────────────────────────────────────────────
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(model, records, productCount) {
  const ran = records.filter((r) => r.status !== 'skipped-budget' && r.status !== 'error');
  const count = (status) => ran.filter((r) => r.status === status).length;
  const spans = ran.flatMap((r) => r.spans);
  const ungrounded = spans.filter((s) => !s.grounded).length;
  const decisive = spans.filter((s) => s.stance !== 'neutral');
  const latencies = ran.map((r) => r.latencyMs);
  const totalUsd = ran.reduce((n, r) => n + (r.costUsd || 0), 0);
  return {
    model,
    claims: records.length,
    judged: ran.length,
    errors: records.filter((r) => r.status === 'error').length,
    budgetSkips: records.filter((r) => r.status === 'skipped-budget').length,
    decided: ran.filter((r) => r.decided).length,
    decidedPct: records.length ? (100 * ran.filter((r) => r.decided).length) / records.length : 0,
    verified: count('verified'),
    partial: count('partially-verified'),
    contradicted: count('contradicted'),
    spans: spans.length,
    ungrounded,
    ungroundedPct: spans.length ? (100 * ungrounded) / spans.length : 0,
    decisiveSpans: decisive.length,
    decisiveUngrounded: decisive.filter((s) => !s.grounded).length,
    parseFailures: ran.filter((r) => r.parseFailure).length,
    costUnknownCalls: ran.filter((r) => !r.costKnown).length,
    medianMs: percentile(latencies, 50),
    p90Ms: percentile(latencies, 90),
    totalUsd,
    usdPerProduct: productCount ? totalUsd / productCount : 0,
  };
}

// ── RUN ──────────────────────────────────────────────────────────────────────
export function slugOf(model) {
  return model.replace(/[^a-z0-9.]+/gi, '-').replace(/^-+|-+$/g, '');
}

async function runModel({ model, price }, items, ctx) {
  const expected = items.length * expectedCallUsd(price, ctx.typicalPromptTokens);
  if (expected > ctx.budget.remaining()) {
    return { skipped: { model, reason: `expected $${expected.toFixed(3)} > remaining $${ctx.budget.remaining().toFixed(3)}` } };
  }
  process.stderr.write(`[bench] ${model}: ${items.length} claims, expected ~$${expected.toFixed(3)}\n`);
  const records = await mapLimit(items, CONCURRENCY, (item) => judgeOne({ model, item, apiKey: ctx.apiKey, price, budget: ctx.budget }));
  const summary = summarize(model, records, ctx.productCount);
  writeFileSync(`${OUT_DIR}/${slugOf(model)}.json`, JSON.stringify({ model, price, summary, records }, null, 2));
  process.stderr.write(`[bench] ${model}: decided ${summary.decided}/${summary.claims}, $${summary.totalUsd.toFixed(4)}, spent so far $${ctx.budget.spent().toFixed(4)}\n`);
  return { summary, records };
}

function buildItems(products) {
  return products.flatMap((product) => {
    const byUrl = new Map(product.pool.map((s) => [s.url, s]));
    return product.claims.map((claim) => ({ claim, product, pool: product.pool, byUrl }));
  });
}

// Prompt size of a typical stance call: system + up to 15 passages of ~1,200 chars.
function typicalPromptTokens() {
  return Math.ceil((4000 + 15 * 1400) / CHARS_PER_TOKEN);
}

// ── REPORT ───────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  return ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`;
}

function printTable(summaries) {
  const head = ['model', 'decided', 'ver/part/contra', 'ungrounded', 'parseFail', 'err/skip', 'p50', 'p90', 'USD', 'USD/prod'];
  const rows = summaries.map((s) => [
    s.model,
    `${s.decided}/${s.claims} (${s.decidedPct.toFixed(0)}%)`,
    `${s.verified}/${s.partial}/${s.contradicted}`,
    `${s.ungrounded}/${s.spans} (${s.ungroundedPct.toFixed(1)}%)`,
    String(s.parseFailures),
    `${s.errors}/${s.budgetSkips}`,
    fmtMs(s.medianMs),
    fmtMs(s.p90Ms),
    `$${s.totalUsd.toFixed(4)}`,
    `$${s.usdPerProduct.toFixed(4)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  rawLog(line(head));
  rawLog(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const r of rows) rawLog(line(r));
}

function eligible(s) {
  return s.spans > 0 && s.ungroundedPct <= 100 * MAX_UNGROUNDED_SHARE && s.parseFailures + s.errors <= MAX_PARSE_FAILURES && s.budgetSkips === 0;
}

// Up to SPOT_CHECK_COUNT decided claims, round-robin across products, each with
// its first decisive span (support for verified/partial, contradict otherwise).
function spotCheck(records) {
  const decided = records.filter((r) => r.decided);
  const byProduct = new Map();
  for (const r of decided) byProduct.set(r.product, [...(byProduct.get(r.product) ?? []), r]);
  const queues = [...byProduct.values()];
  const picked = [];
  for (let i = 0; picked.length < SPOT_CHECK_COUNT && queues.some((q) => q.length > i); i++) {
    for (const q of queues) if (q[i] && picked.length < SPOT_CHECK_COUNT) picked.push(q[i]);
  }
  return picked.map((r) => {
    const want = r.status === 'contradicted' ? 'contradict' : 'support';
    const cite = r.spans.find((s) => s.stance === want) ?? r.spans.find((s) => s.stance !== 'neutral') ?? null;
    return { product: r.product, claim: r.claim, verdict: r.status, url: cite?.url ?? null, span: cite?.span ?? null, grounded: cite?.grounded ?? null };
  });
}

function printSpotChecks(top) {
  for (const { summary, records } of top) {
    rawLog(`\n### Spot check: ${summary.model}`);
    spotCheck(records).forEach((c, i) => {
      rawLog(`${i + 1}. [${c.verdict}] (${c.product}) ${c.claim}`);
      rawLog(`   ${c.url}`);
      rawLog(`   "${c.span}"${c.grounded ? '' : '  (UNGROUNDED)'}`);
    });
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('usage: node benchmarks/judge-bench.mjs <verify-*.json>...');
  const products = paths.map(loadProduct);
  const items = buildItems(products);
  const ids = process.env.BENCH_MODELS ? process.env.BENCH_MODELS.split(',').map((s) => s.trim()).filter(Boolean) : CANDIDATES;
  const ctx = { apiKey: loadOpenRouterKey(), budget: createBudget(MAX_USD), productCount: products.length, typicalPromptTokens: typicalPromptTokens() };
  const { runnable, skipped } = await planModels(ids, ctx.typicalPromptTokens);
  mkdirSync(OUT_DIR, { recursive: true });
  process.stderr.write(`[bench] ${products.length} products, ${items.length} claims, cap $${MAX_USD}, order: ${runnable.map((m) => m.model).join(', ')}\n`);

  const done = [];
  for (const m of runnable) {
    const out = await runModel(m, items, ctx);
    if (out.skipped) skipped.push(out.skipped);
    else done.push(out);
  }

  rawLog(`\nClaims: ${items.length} over ${products.length} products. Spent $${ctx.budget.spent().toFixed(4)} of cap $${MAX_USD}.\n`);
  printTable(done.map((d) => d.summary));
  for (const s of skipped) rawLog(`skipped ${s.model}: ${s.reason}`);
  const top = done.filter((d) => eligible(d.summary)).sort((a, b) => b.summary.decidedPct - a.summary.decidedPct).slice(0, 2);
  printSpotChecks(top);
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify({ cap: MAX_USD, spent: ctx.budget.spent(), summaries: done.map((d) => d.summary), skipped, spotChecks: top.map((d) => ({ model: d.summary.model, claims: spotCheck(d.records) })) }, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
