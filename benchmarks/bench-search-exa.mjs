#!/usr/bin/env node
// Brave vs Exa (instant, fast) on Frank's own search needs.
//
//   node benchmarks/bench-search-exa.mjs [outDir]
//
// (a) product-page finding: "<name>" and "<name> specs". Does the top 10 hold a
//     maker or major-retailer page for that exact model?
// (b) evidence finding: "<name> review" and "<name> <measurement> test". Count
//     independent review/test domains in the top 10, and URLs one provider has
//     that the other does not.
// (c) latency p50 per provider.
//
// Keys come from .dev.vars (BRAVE_API_KEY, EXA_API_KEY) and are never printed.
// Cost: 32 Exa instant calls ($0.004) + 32 Exa fast calls ($0.007), about $0.35.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const OUT_DIR = process.argv[2] || '/tmp/frank-bench-exa';
const TOP_N = 10;
const TIMEOUT_MS = 15000;

const PRODUCTS = [
  { name: 'Kindle Paperwhite 12th gen', makers: ['amazon.com'], model: /paperwhite/i, gen: /12th|2024|signature|\b16\s?gb/i, measure: 'battery life test' },
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
  const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const pairs = text.split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; });
  const env = Object.fromEntries(pairs);
  if (!env.BRAVE_API_KEY || !env.EXA_API_KEY) throw new Error('BRAVE_API_KEY and EXA_API_KEY must be set in .dev.vars');
  return env;
}

async function timed(fn) {
  const t0 = performance.now();
  try {
    const rows = await fn();
    return { ok: true, ms: Math.round(performance.now() - t0), rows };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function brave(query, key) {
  const params = new URLSearchParams({ q: query, count: String(TOP_N) });
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`brave HTTP ${r.status}`);
  const j = await r.json();
  return (j?.web?.results ?? []).map((x) => ({ url: x.url, title: x.title ?? '' }));
}

async function exa(query, key, type) {
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, numResults: TOP_N, type, contents: { highlights: { maxCharacters: 1000 } } }),
  });
  if (!r.ok) throw new Error(`exa HTTP ${r.status}`);
  const j = await r.json();
  exaCost += j?.costDollars?.total ?? 0;
  return (j?.results ?? []).map((x) => ({ url: x.url, title: x.title ?? '' }));
}

let exaCost = 0;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (url, d) => {
  const host = hostOf(url);
  const [dHost, dPath] = d.split(/\/(.*)/);
  const hostHit = host === dHost || host.endsWith(`.${dHost}`);
  return hostHit && (!dPath || url.includes(`/${dPath}`));
};

// A maker or retailer page whose URL or title names the exact model.
function hasProductPage(rows, p) {
  return rows.some((r) => {
    const shop = [...p.makers, ...RETAILERS].some((d) => onDomain(r.url, d));
    const text = `${r.url} ${r.title}`;
    return shop && p.model.test(text) && (!p.gen || p.gen.test(text));
  });
}

function evidenceDomains(rows) {
  return new Set(rows.flatMap((r) => EVIDENCE_DOMAINS.filter((d) => onDomain(r.url, d))));
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)) : NaN; };
const normUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();

async function main() {
  const env = loadKeys();
  mkdirSync(OUT_DIR, { recursive: true });
  const providers = {
    brave: (q) => brave(q, env.BRAVE_API_KEY),
    'exa-instant': (q) => exa(q, env.EXA_API_KEY, 'instant'),
    'exa-fast': (q) => exa(q, env.EXA_API_KEY, 'fast'),
  };
  const raw = [];
  for (const p of PRODUCTS) {
    const queries = [
      { kind: 'page', q: p.name },
      { kind: 'page', q: `${p.name} specs` },
      { kind: 'evidence', q: `${p.name} review` },
      { kind: 'evidence', q: `${p.name} ${p.measure}` },
    ];
    for (const { kind, q } of queries) {
      for (const [prov, fn] of Object.entries(providers)) {
        const res = await timed(() => fn(q));
        raw.push({ product: p.name, kind, q, provider: prov, ...res });
        process.stdout.write(`${prov.padEnd(12)} ${res.ok ? 'ok ' : 'ERR'} ${String(res.ms).padStart(5)}ms ${res.rows.length} ${q}\n`);
      }
    }
  }

  const summary = {};
  for (const prov of Object.keys(providers)) {
    const mine = raw.filter((r) => r.provider === prov);
    const pageHits = PRODUCTS.filter((p) => mine.some((r) => r.product === p.name && r.kind === 'page' && hasProductPage(r.rows, p))).length;
    const pageQueryHits = mine.filter((r) => r.kind === 'page' && hasProductPage(r.rows, PRODUCTS.find((p) => p.name === r.product))).length;
    const ev = mine.filter((r) => r.kind === 'evidence');
    const evDomains = ev.map((r) => evidenceDomains(r.rows).size);
    const uniqueVsBrave = ev.map((r) => {
      const b = raw.find((x) => x.provider === 'brave' && x.q === r.q);
      const bUrls = new Set((b?.rows ?? []).map((x) => normUrl(x.url)));
      return r.rows.filter((x) => !bUrls.has(normUrl(x.url))).length;
    });
    const domainsAddedToBrave = ev.map((r) => {
      const b = raw.find((x) => x.provider === 'brave' && x.q === r.q);
      const bDom = evidenceDomains(b?.rows ?? []);
      return [...evidenceDomains(r.rows)].filter((d) => !bDom.has(d)).length;
    });
    summary[prov] = {
      productsWithPage: `${pageHits}/${PRODUCTS.length}`,
      pageQueriesWithPage: `${pageQueryHits}/${PRODUCTS.length * 2}`,
      evidenceDomainsTotal: evDomains.reduce((a, b) => a + b, 0),
      evidenceDomainsMean: +(evDomains.reduce((a, b) => a + b, 0) / evDomains.length).toFixed(2),
      evidenceDomainsAddedToBrave: domainsAddedToBrave.reduce((a, b) => a + b, 0),
      evidenceUrlsNotInBrave: uniqueVsBrave.reduce((a, b) => a + b, 0),
      errors: mine.filter((r) => !r.ok).length,
      latencyP50ms: median(mine.filter((r) => r.ok).map((r) => r.ms)),
    };
  }
  summary.exaCostUsd = +exaCost.toFixed(4);

  writeFileSync(`${OUT_DIR}/raw.json`, JSON.stringify(raw, null, 1));
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
