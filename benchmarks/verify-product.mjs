#!/usr/bin/env node
// verify-product.mjs — Truth Audit reference run: gather → resolve claim vs
// evidence sources → extract claims → score evidence → stance → verdict, end
// to end on ONE real product. Reuses existing engine/lib modules verbatim;
// does NOT touch the worker HTTP/queue/orchestrator/UI. Non-invasive.
//
// Usage:
//   node benchmarks/verify-product.mjs                       # default product
//   PRODUCT="..." node benchmarks/verify-product.mjs
//   node benchmarks/verify-product.mjs "Some Product Name"
//   PRODUCT_URL=https://example.com/product node benchmarks/verify-product.mjs
//
//   REPLAY=<path-to-prior-results.json> node benchmarks/verify-product.mjs
//     Skips gather + claim-extraction entirely; loads `claims` + `evidence`
//     from the given prior results JSON (same shape this script writes) and
//     runs ONLY stance + verdict against them. Lets you isolate a stance/
//     verdict-logic change (e.g. the independent-corroboration fix) from
//     gather/extraction non-determinism: same claims + same evidence pool in,
//     directly observe what changed. Output is written to a NEW file
//     (`verify-<slug>-replay.json`) so the pinned input is never overwritten.
//
//   STANCE_LOG=<path> node benchmarks/verify-product.mjs
//     Appends one JSON line per stance call to <path>: claim id, finish
//     reason, token usage, and the raw model reply. Use it to see why a claim
//     got no stance rows.
//
//   DIAG_DIR=<dir> node benchmarks/verify-product.mjs
//     Writes <dir>/<slug>.diag.json: every gathered source (url, provider,
//     length, tags, first 400 chars), the claim sources with their text, and
//     the raw extraction reply. Prints a provider count after the gather.
//
//   RESULTS_DIR=<dir> node benchmarks/verify-product.mjs
//     Writes the results JSON to <dir> instead of benchmarks/results/.
//
//   LEGACY_SELECTION=1 node benchmarks/verify-product.mjs
//     Judges with the older evidence selection (topEvidenceForClaim, whole
//     REPLAY pool) instead of the production one (evidencePool +
//     rankClaimEvidence). With REPLAY it gives the A/B on pinned evidence.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { gatherParallel } from '../worker/engine/parallel-engine.js';
import { callLLM } from '../worker/engine/llm.js';
import { verdictForClaim, overallVerdict } from '../worker/lib/verdict.js';
import { ENGINE_CONFIG } from '../worker/lib/engine-config.js';
import { llmRouteFromEnv } from '../worker/lib/llm-route.js';
import {
  VERDICT_OPTS,
  judgeClaim,
  resolveClaimSources,
  extractProductClaims,
  evidencePool,
  scoreEvidence,
  findClaimTests,
} from '../worker/engine/verify.js';
import { claimCandidateReason } from '../worker/engine/verify-resolve.js';

// ── ENV ──────────────────────────────────────────────────────────────────────
function loadDevVars() {
  const env = {};
  const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const devVars = loadDevVars();
const OPENROUTER_API_KEY = devVars.OPENROUTER_API_KEY;
const SERPER_API_KEY = devVars.SERPER_API_KEY;
const JINA_API_KEY = devVars.JINA_API_KEY;
// Search and read keys, as the worker env carries them. Brave and Tavily are
// the web fallbacks when Serper fails. Never logged.
const TOOL_ENV = Object.freeze({
  SERPER_API_KEY,
  JINA_API_KEY,
  BRAVE_API_KEY: devVars.BRAVE_API_KEY,
  TAVILY_API_KEY: devVars.TAVILY_API_KEY,
});

// REPLAY mode never gathers, so it only needs the OpenRouter key (for the
// stance LLM call) — SERPER_API_KEY is irrelevant when there's no search.
const REPLAY_PATH = process.env.REPLAY || null;
// LITELLM_BASE_URL + LITELLM_API_KEY in the environment route LLM calls through
// LiteLLM. NO_FALLBACK=1 drops the OpenRouter fallback.
const USE_LITELLM = Boolean(process.env.LITELLM_BASE_URL && process.env.LITELLM_API_KEY);
const LLM_KEY = USE_LITELLM
  ? llmRouteFromEnv({
      LLM_PROVIDER: 'litellm',
      LITELLM_BASE_URL: process.env.LITELLM_BASE_URL,
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      LITELLM_MODEL_MAP_JSON: process.env.LITELLM_MODEL_MAP_JSON,
      OPENROUTER_API_KEY: process.env.NO_FALLBACK === '1' ? '' : OPENROUTER_API_KEY,
    })
  : OPENROUTER_API_KEY;
if ((!USE_LITELLM && !OPENROUTER_API_KEY) || (!REPLAY_PATH && !SERPER_API_KEY)) {
  console.error('need OPENROUTER_API_KEY or LITELLM_BASE_URL+LITELLM_API_KEY (and SERPER_API_KEY unless REPLAY is set)');
  process.exit(1);
}
console.log(USE_LITELLM
  ? `[llm] route=litellm fallback=${LLM_KEY.fallback ? 'on' : 'off'}`
  : '[llm] route=openrouter');

function loadReplayInput(path) {
  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text);
  const claims = Array.isArray(parsed.claims) ? parsed.claims : [];
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (claims.length === 0 || evidence.length === 0) {
    throw new Error(`REPLAY input ${path} is missing claims[] or evidence[]`);
  }
  return { claims, evidence, product: parsed.product, productUrl: parsed.productUrl ?? null };
}

const replayInput = REPLAY_PATH ? loadReplayInput(REPLAY_PATH) : null;

const PRODUCT = process.env.PRODUCT || process.argv[2] || replayInput?.product || 'Anker Soundcore Space A40';
const PRODUCT_URL = process.env.PRODUCT_URL || replayInput?.productUrl || null;

// Same config as production verification: VERIFICATION_CONFIG in
// worker/pipeline/verify-orchestrator.js (not exported, so mirrored here).
const cfg = Object.freeze({
  ...ENGINE_CONFIG,
  maxFetches: 40,
  maxSearches: 60,
  maxToolCalls: 90,
  measurementSeedQueries: true,
});
const extractModel = cfg.extractModel || cfg.synthModel;
const stanceModel = cfg.stanceModel || cfg.synthModel;

let totalCostUsd = 0;

const SLUG = PRODUCT.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ── DIAGNOSTICS (DIAG_DIR) ────────────────────────────────────────────────────
const DIAG_DIR = process.env.DIAG_DIR || null;
const DIAG_HEAD_CHARS = 400;
const diag = { product: PRODUCT, providerCounts: {}, sources: [], claimSources: [], extraction: [] };

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function summarizeSource(s, headChars = DIAG_HEAD_CHARS) {
  const content = s.content || '';
  return {
    url: s.url,
    host: hostOf(s.url),
    provider: s.source ?? null,
    title: s.title ?? '',
    chars: content.length,
    tags: s.credibility?.tags ?? [],
    head: content.slice(0, headChars),
  };
}

function countBy(items, keyOf) {
  return items.reduce((acc, item) => {
    const key = keyOf(item) ?? 'none';
    return { ...acc, [key]: (acc[key] ?? 0) + 1 };
  }, {});
}

function writeDiag() {
  if (!DIAG_DIR) return;
  mkdirSync(DIAG_DIR, { recursive: true });
  writeFileSync(`${DIAG_DIR}/${SLUG}.diag.json`, JSON.stringify(diag, null, 2));
  process.stderr.write(`[diag] wrote ${DIAG_DIR}/${SLUG}.diag.json\n`);
}

// callLLM, plus a diag record of the raw extraction reply.
async function extractCallLLM(...args) {
  const resp = await callLLM(...args);
  const choice = resp?.choices?.[0] ?? {};
  diag.extraction.push({
    finishReason: choice.finish_reason ?? null,
    usage: resp?.usage ?? null,
    content: choice.message?.content ?? null,
  });
  return resp;
}

// ── 1. GATHER ─────────────────────────────────────────────────────────────────
async function gather() {
  process.stderr.write(`[gather] researching "${PRODUCT}"...\n`);
  const r = await gatherParallel(
    PRODUCT,
    cfg,
    LLM_KEY,
    TOOL_ENV,
    () => {},
    { is_buyable: true, sold_on_amazon: true, recency_sensitive: true },
    PRODUCT,
    {},
  );
  totalCostUsd += r.totalCostUsd || 0;
  const sources = r.sources || [];
  process.stderr.write(`[gather] ${sources.length} sources, ${r.notes?.length || 0} notes\n`);
  diag.providerCounts = countBy(sources, (s) => s.source);
  diag.sources = sources.map((s) => summarizeSource(s));
  process.stderr.write(`[gather] sources by provider: ${JSON.stringify(diag.providerCounts)}\n`);
  return sources;
}

// ── 2+3. RESOLVE + EXTRACT CLAIMS ────────────────────────────────────────────
// resolveClaimSources() and extractProductClaims() are the production steps of
// runVerification in worker/engine/verify.js. This wrapper only logs.
function logResolve(resolved) {
  process.stderr.write(`[resolve] queries: ${JSON.stringify(resolved.queries)}\n`);
  const ownSite = resolved.found
    .map((f) => ({ url: f.url, reason: claimCandidateReason(f, PRODUCT) }))
    .filter((f) => f.reason !== 'not-own-site');
  for (const f of ownSite) process.stderr.write(`[resolve] found ${f.reason}: ${f.url}\n`);
  process.stderr.write(`[resolve] ${resolved.found.length} search results, ${resolved.candidates.length} candidates\n`);
  for (const c of resolved.candidates) process.stderr.write(`[resolve] candidate ${c.url}\n`);
  for (const r of resolved.rejected) process.stderr.write(`[resolve] rejected ${r.reason} chars=${r.chars} ${r.url}\n`);
  diag.resolve = {
    queries: resolved.queries,
    found: resolved.found.map((f) => ({ url: f.url, title: f.title, reason: claimCandidateReason(f, PRODUCT) })),
    candidates: resolved.candidates.map((c) => c.url),
    rejected: resolved.rejected,
  };
}

async function resolveAndExtract() {
  process.stderr.write('[resolve] finding the product\'s own pages...\n');
  const resolved = await resolveClaimSources({ product: PRODUCT, productUrl: PRODUCT_URL, env: TOOL_ENV });
  logResolve(resolved);
  if (resolved.claimSources.length === 0 && !PRODUCT_URL) {
    writeDiag();
    console.log(`Could not resolve "${PRODUCT}"'s own product page. Re-run with PRODUCT_URL=<amazon/bestbuy/walmart/manufacturer url> to specify it.`);
    process.exit(0);
  }

  process.stderr.write('[extract-claims] calling LLM...\n');
  const { claims, claimSources, costUsd } = await extractProductClaims({
    product: PRODUCT,
    resolved,
    env: TOOL_ENV,
    apiKey: LLM_KEY,
    model: extractModel,
    callLLM: extractCallLLM,
  });
  totalCostUsd += costUsd;
  diag.claimSources = claimSources.map((c) => summarizeSource(c, 3000));
  for (const c of claimSources) process.stderr.write(`[resolve] claim source ${c.url} chars=${(c.content || '').length}\n`);
  process.stderr.write(`[resolve] ${claimSources.length} claim source(s)\n`);
  process.stderr.write(`[extract-claims] ${claims.length} claims\n`);
  return claims;
}


// ── 5. STANCE + VERDICT per claim ──────────────────────────────────────────────
// judgeClaim() in worker/engine/verify.js is the per-claim step of
// runVerification (claim-aware top evidence, STANCE_SYSTEM call, deterministic
// backstops, verdict under VERDICT_OPTS). The harness calls it as is, so a
// replay measures the production path.
const STANCE_LOG = process.env.STANCE_LOG || null;

// callLLM, plus one STANCE_LOG line per call when STANCE_LOG is set.
function stanceCallLLM(claimId) {
  if (!STANCE_LOG) return callLLM;
  return async (...args) => {
    const resp = await callLLM(...args);
    const choice = resp?.choices?.[0] ?? {};
    const line = {
      claimId,
      finishReason: choice.finish_reason ?? null,
      usage: resp?.usage ?? null,
      reasoningChars: String(choice.message?.reasoning ?? '').length,
      content: choice.message?.content ?? null,
    };
    appendFileSync(STANCE_LOG, `${JSON.stringify(line)}\n`);
    return resp;
  };
}

const LEGACY_SELECTION = process.env.LEGACY_SELECTION === '1';

async function judgeOne(claim, scoredEvidence) {
  const { verdict, evidence, costUsd } = await judgeClaim({
    claim,
    scoredEvidence,
    apiKey: LLM_KEY,
    model: stanceModel,
    callLLM: stanceCallLLM(claim.id),
    product: LEGACY_SELECTION ? undefined : PRODUCT,
  });
  totalCostUsd += costUsd;
  return { verdict, evidence };
}

// ── OUTPUT FORMATTING ──────────────────────────────────────────────────────────
function formatSourceLine(arrow, ev) {
  const flagTags = (ev.tags || []).filter((t) =>
    ['seeded-unit', 'incentivized-review', 'affiliate-conflict', 'embargo-nda'].includes(t),
  );
  const flags = flagTags.length ? ` {${flagTags.join(',')}}` : '';
  const span = ev.span ? ` — "${ev.span}"` : '';
  // ev.weight is populated by verdictForClaim's sortedSide() using the weigh
  // function of VERDICT_OPTS (the verification policy uses verificationWeight),
  // so this is the strict-(a) verification weight, not raw credibility×independence.
  const weight = Number.isFinite(ev.weight) ? ` weight=${ev.weight}` : '';
  return `      ${arrow} [cred=${ev.credibility} indep=${ev.independence}${weight}] ${ev.url}${span}${flags}`;
}

function printLedger({ overall, claimVerdicts, evidenceCount, spent }) {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`TRUTH AUDIT — ${PRODUCT}`);
  console.log(`Overall: ${overall.score}/100 — ${overall.label}`);
  console.log(`Claims: ${claimVerdicts.length}   Evidence sources: ${evidenceCount}   Spent: $${spent.toFixed(4)}`);
  console.log('══════════════════════════════════════════════════════════════════');

  for (const cv of claimVerdicts) {
    console.log(`\n[${cv.status}] (conf=${cv.confidence}) ${cv.claim.text}`);
    const supporting = cv.supporting.slice(0, 3);
    const contradicting = cv.contradicting.slice(0, 2);
    for (const ev of supporting) console.log(formatSourceLine('↑', ev));
    for (const ev of contradicting) console.log(formatSourceLine('↓', ev));
    if (supporting.length === 0 && contradicting.length === 0) {
      console.log('      (no source supports or contradicts the claim)');
    }
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
}

// ── FIX 3: REPLAY — load a prior run's pinned claims + evidence, skip
// gather/extraction, run only stance + verdict. `evidence` in a prior
// results JSON is already in the scored `{url,title,content,credibility,
// independence,tags}` shape scoreEvidence() produces, so it's used as-is.
async function loadClaimsAndEvidence() {
  if (replayInput) {
    process.stderr.write(`[replay] loaded ${replayInput.claims.length} claims, ${replayInput.evidence.length} evidence from ${REPLAY_PATH}\n`);
    // The production pool filter (evidencePool) also applies to pinned evidence.
    const scoredEvidence = LEGACY_SELECTION ? replayInput.evidence : evidencePool(replayInput.evidence, PRODUCT, PRODUCT_URL);
    process.stderr.write(`[replay] ${scoredEvidence.length} evidence after the pool filter (legacy=${LEGACY_SELECTION})\n`);
    return { claims: replayInput.claims, scoredEvidence };
  }

  // Same order as runVerification: resolve and extract, then gather.
  const claims = await resolveAndExtract();
  if (claims.length === 0) {
    writeDiag();
    console.error('[extract-claims] no claims extracted — cannot proceed');
    process.exit(1);
  }
  // Claim test searches and test page reads, as runVerification runs them.
  const tests = await findClaimTests({ claims, product: PRODUCT, env: TOOL_ENV });
  for (const q of tests.queries) process.stderr.write(`[tests] query: ${q}\n`);
  process.stderr.write(`[tests] ${tests.sources.length} results, ${tests.reads} test page reads, ${tests.filled} filled\n`);
  diag.tests = { queries: tests.queries, reads: tests.reads, filled: tests.filled };
  const sources = await gather();
  const evidence = evidencePool([...tests.sources, ...sources], PRODUCT, PRODUCT_URL);
  const full = evidence.filter((s) => (s.content || '').length >= 1500).length;
  process.stderr.write(`[evidence] ${evidence.length} independent source(s) of ${tests.sources.length + sources.length}, ${full} with page text\n`);

  writeDiag();
  return { claims, scoredEvidence: scoreEvidence(evidence) };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const { claims, scoredEvidence } = await loadClaimsAndEvidence();

  process.stderr.write('[stance] judging each claim...\n');
  const judged = [];
  for (const claim of claims) {
    const { verdict, evidence } = await judgeOne(claim, scoredEvidence);
    judged.push({ claim, verdict, evidence });
    process.stderr.write(
      `[stance] ${claim.id}: ${evidence.length} sources judged, ${verdict.supporting.length} support, ${verdict.contradicting.length} contradict\n`,
    );
  }

  const claimVerdicts = judged.map(({ claim, verdict }) => ({ ...verdict, claim, claimType: claim.type }));
  const overall = overallVerdict(claimVerdicts);

  process.stderr.write('[determinism] re-running verdictForClaim on pinned evidence...\n');
  let reproducible = true;
  const diffs = [];
  for (const { claim, verdict, evidence } of judged) {
    const again = verdictForClaim(claim, evidence, VERDICT_OPTS);
    const same = JSON.stringify(verdict) === JSON.stringify(again);
    if (!same) {
      reproducible = false;
      diffs.push({ claimId: claim.id, first: verdict, second: again });
    }
  }

  printLedger({ overall, claimVerdicts, evidenceCount: scoredEvidence.length, spent: totalCostUsd });

  if (reproducible) {
    console.log('verdict pass reproducible: ✓');
  } else {
    console.log('verdict pass reproducible: ✗');
    console.log(JSON.stringify(diffs, null, 2));
  }

  const resultsDir = process.env.RESULTS_DIR
    ? new URL(`file://${process.env.RESULTS_DIR.replace(/\/+$/, '')}/`)
    : new URL('./results/', import.meta.url);
  mkdirSync(resultsDir, { recursive: true });
  // REPLAY writes to a distinct filename so it never clobbers the pinned
  // input JSON it just read (even mid-run, if the same slug is reused).
  const outName = replayInput ? `verify-${SLUG}-replay.json` : `verify-${SLUG}.json`;
  const outPath = new URL(outName, resultsDir);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        product: PRODUCT,
        productUrl: PRODUCT_URL,
        overall,
        claims,
        claimVerdicts,
        evidence: scoredEvidence,
        reproducible,
        totalCostUsd,
        replay: replayInput ? REPLAY_PATH : null,
      },
      null,
      2,
    ),
  );
  process.stderr.write(`[output] wrote ${outPath.pathname}\n`);
}

main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
