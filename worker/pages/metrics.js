// /metrics: pull-based metrics snapshot for the Frank dashboard.
//
// Bearer-token auth via the METRICS_TOKEN env secret:
//   - 503 if METRICS_TOKEN is unset (endpoint not configured)
//   - 401 if the provided Bearer token does not match
//
// Returns a single JSON snapshot (no cursor) covering monthly spend vs budget,
// run stats, top pages, affiliate/guide clicks, subscribers, and the keyword
// flywheel queue. All SQL is parameterized; no user input is interpolated.
//
// Timestamp notes:
//   - research.created_at / completed_at are unix epoch SECONDS (INTEGER).
//   - affiliate_clicks.clicked_at / guide_clicks.clicked_at are TEXT datetimes
//     ('YYYY-MM-DD HH:MM:SS', UTC) written via datetime('now').
//
// Some tables (subscribers, keyword_queue) are owned by a sibling migration
// (schema/005) that may not be applied yet. Their queries are wrapped in
// try/catch and degrade to zero/empty results if the table is missing.

import { monthKey, monthlyBudgetUsd, monthlyLedgerUsd } from '../pipeline/orchestrator.js';
import { jsonResponse as sharedJsonResponse } from '../lib/http-response.js';
import {
  ingestGsc,
  getGscSummary,
  runUrlInspectionSample,
  listSitemaps,
  listSites,
  submitSitemap,
} from '../lib/gsc.js';

const DAY_SECONDS = 86400;
const THIRTY_DAYS_SECONDS = 30 * DAY_SECONDS;

function jsonResponse(body, status) {
  return sharedJsonResponse(body, status, {
    'Cache-Control': 'no-store',
  });
}

// `since` is unix seconds; the corresponding TEXT cutoff for clicked_at columns.
function isoSecondsToSqlDatetime(unixSeconds) {
  // 'YYYY-MM-DD HH:MM:SS' in UTC, matching SQLite's datetime('now') format.
  return new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// Group a flat list of {key, c} rows into a {key: count} object.
function countMap(rows, keyField) {
  const out = {};
  for (const row of rows ?? []) {
    const key = row[keyField] ?? 'unknown';
    out[key] = Number(row.c) || 0;
  }
  return out;
}

async function getMonthSpend(env, nowSeconds) {
  const month = monthKey(new Date(nowSeconds * 1000));
  let cached = 0;
  try {
    cached = Number(await env.KV.get(`cost:${month}`)) || 0;
  } catch {
    cached = 0;
  }
  // The D1 ledger is the race-free total; KV is a cache that can lag it.
  const spent = Math.max(cached, await monthlyLedgerUsd(env, month));
  const budget = monthlyBudgetUsd(env);
  return {
    month,
    spent_usd: spent,
    budget_usd: budget,
    remaining_usd: Math.round((budget - spent) * 1e6) / 1e6,
    pct_used: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null,
  };
}

async function getRunStats(env, sinceSeconds) {
  const [byStatus, byTier, costAgg, durationAgg] = await Promise.all([
    env.DB.prepare(
      'SELECT status, COUNT(*) AS c FROM research WHERE created_at >= ?1 GROUP BY status',
    ).bind(sinceSeconds).all(),
    env.DB.prepare(
      'SELECT tier, COUNT(*) AS c FROM research WHERE created_at >= ?1 GROUP BY tier',
    ).bind(sinceSeconds).all(),
    env.DB.prepare(
      `SELECT COUNT(cost_usd) AS n, SUM(cost_usd) AS total, AVG(cost_usd) AS avg
         FROM research
        WHERE created_at >= ?1 AND cost_usd IS NOT NULL`,
    ).bind(sinceSeconds).first(),
    env.DB.prepare(
      `SELECT AVG(completed_at - created_at) AS avg_secs
         FROM research
        WHERE created_at >= ?1
          AND completed_at IS NOT NULL
          AND completed_at >= created_at`,
    ).bind(sinceSeconds).first(),
  ]);

  return {
    window_days: 30,
    by_status: countMap(byStatus.results, 'status'),
    by_tier: countMap(byTier.results, 'tier'),
    cost_usd: {
      total: Math.round((Number(costAgg?.total) || 0) * 1e6) / 1e6,
      avg: costAgg?.avg != null ? Math.round(Number(costAgg.avg) * 1e6) / 1e6 : null,
      counted_runs: Number(costAgg?.n) || 0,
    },
    avg_duration_seconds:
      durationAgg?.avg_secs != null ? Math.round(Number(durationAgg.avg_secs) * 10) / 10 : null,
  };
}

async function getTopPages(env) {
  // CTR = affiliate clicks ÷ page views per page. This is the exact signal the
  // re-research flywheel keys on (high views + zero clicks → converting-but-wrong
  // page → re-run), so expose it here too. Clicks are joined through products.
  const res = await env.DB.prepare(
    `SELECT r.slug, r.query, r.view_count AS views,
            (SELECT COUNT(*) FROM products p WHERE p.research_id = r.id) AS product_count,
            (SELECT COUNT(*) FROM affiliate_clicks ac
               JOIN products p2 ON p2.id = ac.product_id
              WHERE p2.research_id = r.id) AS clicks
       FROM research r
      WHERE r.status = 'complete'
      ORDER BY r.view_count DESC
      LIMIT 20`,
  ).all();
  return (res.results ?? []).map((r) => {
    const views = Number(r.views) || 0;
    const clicks = Number(r.clicks) || 0;
    return {
      slug: r.slug,
      query: r.query,
      views,
      clicks,
      ctr_pct: views > 0 ? Math.round((clicks / views) * 1000) / 10 : null,
      product_count: Number(r.product_count) || 0,
    };
  });
}

async function getAffiliateClicks(env, sinceSqlDatetime) {
  const [totalRow, recentRow, topRows] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM affiliate_clicks').first(),
    env.DB.prepare(
      'SELECT COUNT(*) AS c FROM affiliate_clicks WHERE clicked_at >= ?1',
    ).bind(sinceSqlDatetime).first(),
    // Join products for the product name and research for the owning slug.
    env.DB.prepare(
      `SELECT ac.product_id,
              COUNT(*) AS clicks,
              p.name AS product_name,
              r.slug AS research_slug
         FROM affiliate_clicks ac
         LEFT JOIN products p ON p.id = ac.product_id
         LEFT JOIN research r ON r.id = p.research_id
        GROUP BY ac.product_id
        ORDER BY clicks DESC
        LIMIT 20`,
    ).all(),
  ]);

  return {
    total: Number(totalRow?.c) || 0,
    last_30d: Number(recentRow?.c) || 0,
    top_products: (topRows.results ?? []).map((r) => ({
      product_id: r.product_id,
      product_name: r.product_name ?? null,
      research_slug: r.research_slug ?? null,
      clicks: Number(r.clicks) || 0,
    })),
  };
}

// Demand the site couldn't serve — the content-roadmap signal — mined from
// EXISTING data (no new table needed): /find hand-offs (guide_clicks where
// network='google' = queries we redirected to Google because we don't research
// them) + failed/thin research runs (queries we tried but couldn't answer well).
async function getUnservedDemand(env) {
  const [findRes, weakRes] = await Promise.all([
    env.DB.prepare(
      `SELECT product_query AS query, COUNT(*) AS c
         FROM guide_clicks
        WHERE affiliate_network = 'google' AND product_query <> ''
        GROUP BY product_query
        ORDER BY c DESC
        LIMIT 20`,
    ).all().catch(() => ({ results: [] })),
    env.DB.prepare(
      `SELECT r.query, r.status,
              (SELECT COUNT(*) FROM products p WHERE p.research_id = r.id) AS product_count
         FROM research r
        WHERE r.status = 'failed'
           OR (r.status = 'complete'
               AND (SELECT COUNT(*) FROM products p WHERE p.research_id = r.id) < 3)
        ORDER BY r.created_at DESC
        LIMIT 20`,
    ).all().catch(() => ({ results: [] })),
  ]);
  return {
    find_handoffs: (findRes.results ?? []).map((r) => ({
      query: r.query,
      count: Number(r.c) || 0,
    })),
    weak_results: (weakRes.results ?? []).map((r) => ({
      query: r.query,
      status: r.status,
      product_count: Number(r.product_count) || 0,
    })),
  };
}

async function getGuideClicks(env) {
  const res = await env.DB.prepare(
    `SELECT guide_slug, COUNT(*) AS c
       FROM guide_clicks
      GROUP BY guide_slug
      ORDER BY c DESC
      LIMIT 20`,
  ).all();
  return countMap(res.results, 'guide_slug');
}

// Subscribers table arrives in schema/005 (sibling agent). Degrade to 0.
async function getSubscriberCount(env) {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM subscribers').first();
    return Number(row?.c) || 0;
  } catch {
    return 0;
  }
}

// keyword_queue arrives in schema/005 (sibling agent). Degrade to empty map.
async function getFlywheel(env) {
  try {
    const res = await env.DB.prepare(
      'SELECT status, COUNT(*) AS c FROM keyword_queue GROUP BY status',
    ).all();
    return countMap(res.results, 'status');
  } catch {
    return {};
  }
}

// Constant-time token compare (SHA-256 digests → fixed-length XOR scan) so the
// metrics Bearer check has no early-out timing side-channel — matches the
// internal-API auth pattern.
async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da), vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function handleMetrics(request, env) {
  const token = env.METRICS_TOKEN;
  if (!token) {
    return jsonResponse({ error: 'METRICS_TOKEN not configured' }, 503);
  }

  const auth = request.headers.get('Authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!(await timingSafeEqual(provided, token))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const sinceSeconds = nowSeconds - THIRTY_DAYS_SECONDS;
  const sinceSqlDatetime = isoSecondsToSqlDatetime(sinceSeconds);

  // Optional manual GSC ingest (?gsc_ingest=1) — handy for the first pull right
  // after the GSC_SA_KEY secret is set, instead of waiting for the daily cron.
  // Optional ?gsc_days=N widens the window for one-off historical backfills
  // (the daily cron always uses the 5-day default). GSC retains ~16 months.
  // Fail-soft: returns a {skipped}/{error} marker, never breaks the snapshot.
  let gscIngest = null;
  // Optional manual URL Inspection diagnostic (?gsc_inspect=1) — one-off run
  // over the curated sample described in worker/lib/gsc.js. Fail-soft: never
  // breaks the snapshot, always returns a {skipped}/{error} marker on failure.
  let gscInspect = null;
  // Optional read-only sitemap/property diagnostics (?gsc_sitemaps=1,
  // ?gsc_sites=1) and a best-effort submit attempt (?gsc_submit_sitemap=1),
  // which is expected to 403 under the webmasters.readonly scope. Fail-soft,
  // same pattern as gsc_ingest/gsc_inspect above.
  let gscSitemaps = null;
  let gscSites = null;
  let gscSubmitSitemap = null;
  try {
    const reqUrl = new URL(request.url);
    if (reqUrl.searchParams.get('gsc_ingest') === '1') {
      const daysParam = Number(reqUrl.searchParams.get('gsc_days'));
      const opts = Number.isFinite(daysParam) && daysParam > 0 ? { days: Math.min(daysParam, 480) } : undefined;
      gscIngest = await ingestGsc(env, opts).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    if (reqUrl.searchParams.get('gsc_inspect') === '1') {
      gscInspect = await runUrlInspectionSample(env, reqUrl.origin)
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    if (reqUrl.searchParams.get('gsc_sitemaps') === '1') {
      gscSitemaps = await listSitemaps(env).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    if (reqUrl.searchParams.get('gsc_sites') === '1') {
      gscSites = await listSites(env).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
    if (reqUrl.searchParams.get('gsc_submit_sitemap') === '1') {
      const feedpath = reqUrl.searchParams.get('gsc_feedpath') || `${reqUrl.origin}/sitemap.xml`;
      gscSubmitSitemap = await submitSitemap(env, feedpath)
        .catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    }
  } catch { /* bad URL — ignore */ }

  const [budget, runs, topPages, affiliate, guideClicks, subscribers, flywheel, unservedDemand, gsc] =
    await Promise.all([
      getMonthSpend(env, nowSeconds),
      getRunStats(env, sinceSeconds),
      getTopPages(env),
      getAffiliateClicks(env, sinceSqlDatetime),
      getGuideClicks(env),
      getSubscriberCount(env),
      getFlywheel(env),
      getUnservedDemand(env),
      getGscSummary(env),
    ]);

  return jsonResponse(
    {
      server_now: nowSeconds,
      budget,
      runs,
      top_pages: topPages,
      affiliate_clicks: affiliate,
      guide_clicks: guideClicks,
      subscribers,
      flywheel,
      unserved_demand: unservedDemand,
      gsc,
      ...(gscIngest ? { gsc_ingest: gscIngest } : {}),
      ...(gscInspect ? { gsc_inspect: gscInspect } : {}),
      ...(gscSitemaps ? { gsc_sitemaps: gscSitemaps } : {}),
      ...(gscSites ? { gsc_sites: gscSites } : {}),
      ...(gscSubmitSitemap ? { gsc_submit_sitemap: gscSubmitSitemap } : {}),
    },
    200,
  );
}
