#!/usr/bin/env node
// SearXNG vs the Serper-era baseline and live Exa, to gate the SearXNG cutover.
//
//   node benchmarks/bench-searxng.mjs [outDir]          (default /tmp/frank-bench-searxng)
//   PROVIDERS=sx-raw MAX_TOPICS=2 node benchmarks/bench-searxng.mjs /tmp/smoke
//
// Query set (deterministic):
// (a) topics: the first MAX_TOPICS entries of the Serper-era corpus
//     (benchmarks/results/google-top50-corpus.json, gitignored; CORPUS overrides
//     the path). Per topic: "best <cat>", "<cat> review", "best <cat> reddit".
// (b) products: the 8 products of bench-search-exa.mjs. Per product:
//     "<name> review", "<name> <measure>" (16 evidence queries), "<name> specs".
//
// Providers: sx-raw (SearXNG JSON as-is), sx-frank (worker/engine/searxng.js),
// exa (worker/engine/tools.js exaSearch). Env: PROVIDERS (default
// "sx-frank,exa"), MAX_TOPICS (24), SEARXNG_URL, CONCURRENCY (2 per provider),
// PACE_MS (400 between call starts per provider), CORPUS.
//
// EXA_API_KEY comes from .dev.vars only when exa is selected. It is never printed.
// Cost: SearXNG is free (but loads the upstream engines). Exa instant is $0.004
// per call: 24 topics x 3 + 24 product queries = 96 calls, about $0.40.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { isExpertDomain, isCommunityDomain, scoreSource } from '../worker/lib/credibility.js';

const OUT_DIR = process.argv[2] || '/tmp/frank-bench-searxng';
const PROVIDERS = (process.env.PROVIDERS || 'sx-frank,exa').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_TOPICS = Number(process.env.MAX_TOPICS || 24);
const SEARXNG_URL = (process.env.SEARXNG_URL || 'http://192.168.5.10:18095').replace(/\/$/, '');
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const PACE_MS = Number(process.env.PACE_MS || 400);
const CORPUS_PATH = process.env.CORPUS || new URL('./results/google-top50-corpus.json', import.meta.url).pathname;

const TOP_N = 10;
const SX_RAW_LIMIT = 15;
const SX_TIMEOUT_MS = 11000;
const CONTENT_CHARS = 300;
const JUNK_SCORE = 40;
const P50 = 0.5;
const P95 = 0.95;
const YEAR_NOW = new Date().getFullYear();
const FRESH_YEARS = [String(YEAR_NOW), String(YEAR_NOW - 1)];
const REFERENCE_LINE = 'Recorded 2026-10-09: Brave 40, Exa 32 evidence domains over 16 queries (compare with the evidence sum column)';
const KNOWN_PROVIDERS = ['sx-raw', 'sx-frank', 'exa'];

// Copied from bench-search-exa.mjs:21-33.
const PRODUCTS = [
  { name: 'Kindle Paperwhite 12th gen', makers: ['amazon.com'], model: /paperwhite/i, measure: 'battery life test' },
  { name: 'Logitech G Pro X Superlight 2', makers: ['logitechg.com', 'logitech.com'], model: /superlight[\s_-]*2|superlight-2/i, measure: 'click latency test' },
  { name: 'Bose QuietComfort 45', makers: ['bose.com'], model: /quietcomfort[\s_-]*45|qc[\s_-]*45/i, measure: 'battery life test' },
  { name: 'Garmin Venu 3', makers: ['garmin.com'], model: /venu[\s_-]*3(?!\d)/i, measure: 'battery life test' },
  { name: 'iRobot Roomba j7+', makers: ['irobot.com'], model: /j7/i, measure: 'cleaning performance test' },
  { name: 'JBL Charge 5', makers: ['jbl.com'], model: /charge[\s_-]*5(?!\d)/i, measure: 'battery life test' },
  { name: 'Ninja AF101', makers: ['ninjakitchen.com', 'sharkninja.com'], model: /af101/i, measure: 'cooking test' },
  { name: 'Sony A7 IV', makers: ['sony.com'], model: /a7[\s_-]*iv|a7m4|ilce-?7m4|alpha[\s_-]*7[\s_-]*iv/i, measure: 'dynamic range test' },
];
const RETAILERS = ['amazon.com', 'bestbuy.com', 'walmart.com', 'target.com', 'bhphotovideo.com', 'crutchfield.com', 'costco.com', 'rei.com', 'adorama.com'];
const EVIDENCE_DOMAINS = ['rtings.com', 'soundguys.com', 'techradar.com', 'tomsguide.com', 'nytimes.com/wirecutter', 'notebookcheck.net', 'dcrainmaker.com', 'pcmag.com', 'cnet.com', 'theverge.com', 'engadget.com', 'reddit.com'];

function loadKeys() {
  const path = new URL('../.dev.vars', import.meta.url);
  if (!existsSync(path)) return {};
  const pairs = readFileSync(path, 'utf8').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; });
  return Object.fromEntries(pairs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (url, d) => {
  const host = hostOf(url);
  const [dHost, dPath] = d.split(/\/(.*)/);
  const hostHit = host === dHost || host.endsWith(`.${dHost}`);
  return hostHit && (!dPath || url.includes(`/${dPath}`));
};
const isGood = (url) => isExpertDomain(url) || isCommunityDomain(url);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const share = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : NaN);
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};

// ─── Query set ────────────────────────────────────────────────────────────────

function loadTopics() {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
  if (!Array.isArray(corpus)) throw new Error(`corpus at ${CORPUS_PATH} is not an array`);
  return corpus.slice(0, MAX_TOPICS).map((e, i) => ({
    id: i,
    subject: e.cat || e.query,
    goodHosts: [...new Set((e.sources ?? []).map((s) => s.url).filter(isGood).map(hostOf).filter(Boolean))],
  }));
}

function buildQueries(topics) {
  const topicQs = topics.flatMap((t) => [
    { kind: 'topic', topic: t.id, q: `best ${t.subject}` },
    { kind: 'topic', topic: t.id, q: `${t.subject} review` },
    { kind: 'reddit', topic: t.id, q: `best ${t.subject} reddit` },
  ]);
  const productQs = PRODUCTS.flatMap((p, i) => [
    { kind: 'evidence', product: i, q: `${p.name} review` },
    { kind: 'evidence', product: i, q: `${p.name} ${p.measure}` },
    { kind: 'specs', product: i, q: `${p.name} specs` },
  ]);
  return [...topicQs, ...productQs];
}

// ─── Providers ────────────────────────────────────────────────────────────────

async function sxRaw(q) {
  try {
    const params = new URLSearchParams({ q, format: 'json' });
    const r = await fetch(`${SEARXNG_URL}/search?${params}`, { signal: AbortSignal.timeout(SX_TIMEOUT_MS) });
    if (!r.ok) { console.warn(`[sx-raw] HTTP ${r.status} for "${q}"`); return null; }
    const j = await r.json();
    return (j?.results ?? []).slice(0, SX_RAW_LIMIT)
      .map((x) => ({ url: x.url ?? '', title: x.title ?? '', content: x.content ?? '' }));
  } catch (err) {
    console.warn(`[sx-raw] ${err instanceof Error ? err.message : String(err)} for "${q}"`);
    return null;
  }
}

async function buildProviders(names, env) {
  const unknown = names.filter((n) => !KNOWN_PROVIDERS.includes(n));
  if (unknown.length) throw new Error(`unknown provider(s): ${unknown.join(', ')}`);
  const entries = await Promise.all(names.map(async (name) => {
    if (name === 'sx-raw') return [name, sxRaw];
    if (name === 'sx-frank') {
      const { searxngSearch } = await import('../worker/engine/searxng.js');
      return [name, (q) => searxngSearch(q, SEARXNG_URL, {})];
    }
    if (!env.EXA_API_KEY) throw new Error('EXA_API_KEY must be set in .dev.vars when exa is selected');
    const { exaSearch } = await import('../worker/engine/tools.js');
    return [name, (q) => exaSearch(q, env.EXA_API_KEY, {})];
  }));
  return Object.fromEntries(entries);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

// Spaces call starts PACE_MS apart for one provider, across its workers.
function makePacer(gapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
  };
}

const toRow = (x) => ({ url: x?.url ?? '', title: x?.title ?? '', content: String(x?.content ?? '').slice(0, CONTENT_CHARS) });

async function timedCall(provider, fn, query) {
  const t0 = performance.now();
  try {
    const res = await fn(query.q);
    const ms = Math.round(performance.now() - t0);
    const ok = Array.isArray(res);
    return { provider, query: query.q, kind: query.kind, topic: query.topic, product: query.product, ms, ok, rows: ok ? res.map(toRow) : [] };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[${provider}] error for "${query.q}": ${error}`);
    return { provider, query: query.q, kind: query.kind, topic: query.topic, product: query.product, ms: Math.round(performance.now() - t0), ok: false, rows: [], error };
  }
}

async function runProvider(provider, fn, queries) {
  const pace = makePacer(PACE_MS);
  const results = new Array(queries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queries.length) {
      const i = cursor++;
      await pace();
      const rec = await timedCall(provider, fn, queries[i]);
      process.stdout.write(`${provider.padEnd(9)} ${rec.ok ? 'ok ' : 'ERR'} ${String(rec.ms).padStart(5)}ms ${String(rec.rows.length).padStart(2)} ${rec.query}\n`);
      results[i] = rec;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  return results;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function topicRecall(calls, topics) {
  return topics.map((t) => {
    const got = new Set(calls.filter((c) => c.topic === t.id)
      .flatMap((c) => c.rows.map((r) => r.url)).filter(isGood).map(hostOf));
    const hit = t.goodHosts.filter((h) => got.has(h)).length;
    return { topic: t.subject, corpusGood: t.goodHosts.length, hit, recall: t.goodHosts.length ? hit / t.goodHosts.length : null };
  });
}

const evidenceDomainsOf = (rows) => new Set(rows.flatMap((r) => EVIDENCE_DOMAINS.filter((d) => onDomain(r.url, d))));

// evidenceDomainsSum is per query, summed (bench-search-exa.mjs evidenceDomainsTotal),
// so it compares with the recorded Brave 40 / Exa 32. evidenceDomains is distinct.
function evidenceMetrics(calls) {
  const top = calls.filter((c) => c.kind === 'evidence').map((c) => c.rows.slice(0, TOP_N));
  const rows = top.flat();
  const domains = evidenceDomainsOf(rows);
  const expertHosts = new Set(rows.filter((r) => isExpertDomain(r.url)).map((r) => hostOf(r.url)));
  return {
    evidenceDomains: domains.size,
    evidenceDomainsSum: top.reduce((n, r) => n + evidenceDomainsOf(r).size, 0),
    evidenceDomainList: [...domains].sort(),
    expertHosts: expertHosts.size,
    expertHostList: [...expertHosts].sort(),
  };
}

function specsHit(call) {
  const p = PRODUCTS[call.product];
  return call.rows.slice(0, TOP_N).some((r) => {
    const shop = [...p.makers, ...RETAILERS].some((d) => onDomain(r.url, d));
    return shop && p.model.test(`${r.url} ${r.title}`);
  });
}

function isJunk(row) {
  const { score, tags } = scoreSource({ url: row.url, title: row.title, content: row.content });
  return score < JUNK_SCORE || ((tags ?? []).includes('listicle') && !isExpertDomain(row.url));
}

const isFresh = (row) => FRESH_YEARS.some((y) => `${row.title} ${row.url} ${row.content}`.includes(y));

function providerMetrics(calls, topics) {
  const rows = calls.flatMap((c) => c.rows);
  const ms = calls.map((c) => c.ms);
  const perTopic = topicRecall(calls, topics);
  const recalls = perTopic.map((t) => t.recall).filter((r) => r !== null);
  const reddit = calls.filter((c) => c.kind === 'reddit');
  return {
    calls: calls.length,
    failRate: share(calls, (c) => !c.ok),
    emptyRate: share(calls, (c) => c.ok && c.rows.length === 0),
    resultsPerQuery: mean(calls.map((c) => c.rows.length)),
    p50ms: quantile(ms, P50),
    p95ms: quantile(ms, P95),
    goodPerQuery: mean(calls.map((c) => c.rows.filter((r) => isGood(r.url)).length)),
    topicRecall: mean(recalls),
    topicRecallPerTopic: perTopic,
    redditTop10: share(reddit, (c) => c.rows.slice(0, TOP_N).some((r) => onDomain(r.url, 'reddit.com'))),
    ...evidenceMetrics(calls),
    specsHit: share(calls.filter((c) => c.kind === 'specs'), specsHit),
    junkRate: share(rows, isJunk),
    freshRate: share(rows, isFresh),
  };
}

// ─── Output ───────────────────────────────────────────────────────────────────

const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a');
const num = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const COLUMNS = [
  ['provider', (_, p) => p],
  ['calls', (m) => String(m.calls)],
  ['fail', (m) => pct(m.failRate)],
  ['empty', (m) => pct(m.emptyRate)],
  ['res/q', (m) => num(m.resultsPerQuery)],
  ['p50 ms', (m) => String(m.p50ms)],
  ['p95 ms', (m) => String(m.p95ms)],
  ['good/q', (m) => num(m.goodPerQuery)],
  ['topic recall', (m) => pct(m.topicRecall)],
  ['reddit@10', (m) => pct(m.redditTop10)],
  ['evidence domains', (m) => String(m.evidenceDomains)],
  ['evidence sum', (m) => String(m.evidenceDomainsSum)],
  ['expert hosts', (m) => String(m.expertHosts)],
  ['specs hit', (m) => pct(m.specsHit)],
  ['junk', (m) => pct(m.junkRate)],
  ['fresh', (m) => pct(m.freshRate)],
];

function renderTable(metrics) {
  const header = `| ${COLUMNS.map(([h]) => h).join(' | ')} |`;
  const rule = `|${COLUMNS.map(() => '---').join('|')}|`;
  const body = Object.entries(metrics).map(([p, m]) => `| ${COLUMNS.map(([, f]) => f(m, p)).join(' | ')} |`);
  return [header, rule, ...body].join('\n');
}

async function main() {
  const env = PROVIDERS.includes('exa') ? loadKeys() : {};
  const providers = await buildProviders(PROVIDERS, env);
  const topics = loadTopics();
  const queries = buildQueries(topics);
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`${queries.length} queries x ${PROVIDERS.join(', ')} (searxng ${SEARXNG_URL})`);
  const perProvider = await Promise.all(Object.entries(providers).map(([p, fn]) => runProvider(p, fn, queries)));
  const records = perProvider.flat();
  const metrics = Object.fromEntries(PROVIDERS.map((p) => [p, providerMetrics(records.filter((r) => r.provider === p), topics)]));
  const config = { providers: PROVIDERS, maxTopics: MAX_TOPICS, searxngUrl: SEARXNG_URL, concurrency: CONCURRENCY, paceMs: PACE_MS, corpus: CORPUS_PATH, queries: queries.length, ranAt: new Date().toISOString() };
  writeFileSync(`${OUT_DIR}/bench-searxng.json`, JSON.stringify({ config, metrics, records }, null, 2));
  const table = renderTable(metrics);
  const md = `# SearXNG search benchmark\n\n${table}\n\n${REFERENCE_LINE}\n`;
  writeFileSync(`${OUT_DIR}/bench-searxng.md`, md);
  console.log(`\n${table}\n\n${REFERENCE_LINE}\nWrote ${OUT_DIR}/bench-searxng.json and .md`);
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
