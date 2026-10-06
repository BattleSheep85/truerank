#!/usr/bin/env node
// Frank off-Cloudflare research worker (blackbox, track 2 / Approach B).
//
// Polls Cloudflare for pending research jobs, runs the PARALLEL engine on this
// host with no subrequest/time cap and high concurrency, then hands the finished
// result back to Cloudflare (which does ASIN/image/affiliate resolution + the D1
// write, where the bindings live). Dependency-free: plain Node + fetch, imports
// the same worker/ engine modules the CF Worker uses. No npm install.
//
//   WORKER_SECRET=… OPENROUTER_API_KEY=… SERPER_API_KEY=… node research-worker.mjs
//
// Env:
//   CF_BASE_URL     default https://chrisputer.tech
//   POLL_INTERVAL   seconds between empty polls (default 15)
//   MAX_CONCURRENCY parallel sub-researchers per job (default 16 — no CF cap here)
//   MAX_SEARCHES    override per-run search budget (default 0 = use the job's config)

import { runParallelEngine } from './worker/engine/parallel-engine.js';

// Synth model is set in worker/lib/tiers.js (ENGINE_CONFIG) — minimax/minimax-m3 as
// of 2026-07-24 (owner no-OpenAI directive; synth-gold co-leader vs the former
// openai/gpt-5.4-mini incumbent, which itself won the 50-query × 150-juror blind
// judge panel on 2026-06-26). The earlier 4-way A/B rotation here was retired once
// that bench settled it; the worker now just runs the job's config synthModel.

const CF_BASE = process.env.CF_BASE_URL || 'https://chrisputer.tech';
const SECRET = process.env.WORKER_SECRET;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
// Supplementary search providers (all optional — the engine degrades gracefully
// when a key/URL is absent). SEARXNG_URL points at the self-hosted metasearch on
// the homelab (free, broad); BRAVE/TAVILY are keyed fallbacks. Previously only
// SERPER was forwarded, so these never activated on the blackbox engine host.
const SEARXNG_URL = process.env.SEARXNG_URL;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const POLL_MS = (Number(process.env.POLL_INTERVAL) || 15) * 1000;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY) || 16;
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES) || 0;
const JOB_CONCURRENCY = Number(process.env.JOB_CONCURRENCY) || 3;

if (!SECRET || !OPENROUTER_API_KEY) {
  console.error('FATAL: WORKER_SECRET and OPENROUTER_API_KEY are required');
  process.exit(1);
}

// CDNs occasionally kill HTTP/2 sockets in ways undici surfaces outside any
// await; without these guards one rude host could crash the whole worker.
process.on('uncaughtException', (e) => console.error('uncaught:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message || e));

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function nextJob() {
  const r = await fetch(`${CF_BASE}/api/internal/next-job`, {
    method: 'POST', headers: { 'X-Worker-Secret': SECRET }, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) { console.error(`next-job HTTP ${r.status}`); return null; }
  return (await r.json()).job || null;
}

async function complete(payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(`${CF_BASE}/api/internal/complete`, {
        method: 'POST', headers: { 'X-Worker-Secret': SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
      });
      log(`  complete -> ${r.status} ${(await r.text()).slice(0, 160)}`);
      return;
    } catch (err) {
      console.error(`  complete POST failed (attempt ${attempt}/2): ${err?.message || err}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 10000));
    }
  }
  // Both attempts failed — the cron reaper will flip the row from 'processing' to
  // 'failed' after 20 min. Nothing more we can do here; the job result is lost.
}

// Push one live progress beat into CF's KV-backed SSE feed. Best-effort and
// fire-and-forget: a short timeout, errors swallowed, never awaited by the
// engine — the report still completes if the progress feed is down.
function postProgress(reportId, step, message) {
  fetch(`${CF_BASE}/api/internal/progress`, {
    method: 'POST', headers: { 'X-Worker-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportId, step, message: String(message).slice(0, 300) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

async function processJob(job) {
  const config = { ...job.config, maxConcurrency: MAX_CONCURRENCY };
  if (MAX_SEARCHES > 0) config.maxSearches = MAX_SEARCHES;
  const t0 = Date.now();
  log(`[job ${job.reportId}] "${job.query}" (conc=${config.maxConcurrency}, searches=${config.maxSearches}, synth=${config.synthModel})`);
  try {
    let step = 0;
    const onEvent = (_type, message) => { postProgress(job.reportId, ++step, message); };
    const { result, sources, totalCostUsd } = await runParallelEngine(
      job.query, config, OPENROUTER_API_KEY,
      { SERPER_API_KEY, SEARXNG_URL, BRAVE_API_KEY, TAVILY_API_KEY }, onEvent,
      job.facets, job.topicalCategory, job.clarifications || {},
    );
    log(`  gather+synth: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.products?.length ?? 0} products, ${sources.length} sources, $${(totalCostUsd || 0).toFixed(4)}`);
    await complete({
      reportId: job.reportId, query: job.query, slug: job.slug,
      facets: job.facets, topicalCategory: job.topicalCategory,
      result, sources,
      totalCostUsd, synthModel: config.synthModel,
    });
  } catch (err) {
    console.error(`  engine FAILED: ${err?.message || err}`);
    await complete({ reportId: job.reportId, query: job.query, error: String(err?.message || err).slice(0, 300), totalCostUsd: Number(err?.totalCostUsd) || 0 });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
log(`[truerank-worker] polling ${CF_BASE} every ${POLL_MS / 1000}s · ${JOB_CONCURRENCY} jobs in parallel × ${MAX_CONCURRENCY} sub-researchers`);
// Process up to JOB_CONCURRENCY jobs at once (each internally parallel). Keep the
// pool full so a flywheel backlog drains fast; idle-sleep when the queue's empty.
const inflight = new Set();
for (;;) {
  while (inflight.size < JOB_CONCURRENCY) {
    let job = null;
    try { job = await nextJob(); } catch (err) { console.error(`poll error: ${err?.message || err}`); break; }
    if (!job) break;
    const p = processJob(job).catch((e) => console.error(`job crashed: ${e?.message || e}`)).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  if (inflight.size === 0) await sleep(POLL_MS);
  else {
    let t;
    await Promise.race([...inflight, new Promise((r) => { t = setTimeout(r, POLL_MS); })]);
    clearTimeout(t);
  }
}
