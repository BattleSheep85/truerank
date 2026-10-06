/**
 * Injects a small "recent research" section of crawlable /research/:slug
 * links into otherwise-static pages. The homepage (public/index.html) and
 * the /best/ guide index (public/best/index.html) render zero links to
 * report pages on their own — a crawler landing on either page (both are
 * well-linked externally) has nowhere to go. Both files carry a
 * `<!--RECENT_REPORTS-->` marker; this module swaps it for a server-rendered
 * list of the newest completed reports at request time, so the links exist
 * in the HTML a crawler actually fetches (no client JS required).
 */

import { escapeHtml, displayQuery, timeAgo, parseJsonSafe } from '../lib/utils.js';
import { listableRowsSql } from '../lib/listable.js';
import { overallVerdict } from '../lib/verdict.js';
import { notFound, withSecurityHeaders, injectHtml } from '../lib/http-response.js';

const RECENT_HOME_LIMIT = 6;
const MARKER = '<!--RECENT_REPORTS-->';

export const VERDICTS_MARKER = '<!--RECENT_VERDICTS-->';
export const MIN_VERDICTS_TO_SHOW = 3;
const RECENT_VERDICTS_LIMIT = 6;
const VERDICT_CANDIDATES = 24;
const MIN_VERDICT_CLAIMS = 3;
const RECENT_VERDICTS_SQL = `SELECT slug, query, result, completed_at FROM research
 WHERE kind = 'verification' AND status = 'complete' AND retired_at IS NULL
 ORDER BY completed_at DESC, id DESC LIMIT ?1`;

// Fetches the newest completed, public reports for the homepage/best-index
// link section. Failure degrades to an empty string (never break the page).
export async function recentReportsSection(env, limit = RECENT_HOME_LIMIT) {
  const stmt = env.DB.prepare(
    listableRowsSql({
      select: 'slug, query, category, created_at',
      tail: 'LIMIT ?1',
    })
  ).bind(limit);
  const rows = (await stmt.all()).results ?? [];
  if (rows.length === 0) return '';

  const cards = rows.map((r) => `<a class="card" href="/research/${escapeHtml(r.slug)}">
${r.category ? `<div class="card-top"><span class="card-badge">${escapeHtml(r.category)}</span><span class="card-time readout">${timeAgo(r.created_at * 1000)}</span></div>` : `<div class="card-top"><span class="card-time readout">${timeAgo(r.created_at * 1000)}</span></div>`}
<h3>${escapeHtml(displayQuery(r.query))}</h3>
</a>`).join('');

  return `<section id="recent-reports" class="border-b border-line">
<div class="mx-auto max-w-5xl px-6 py-14 md:py-20">
<div class="flex flex-wrap items-baseline justify-between gap-3">
<h2 class="font-serif text-h2 font-semibold text-ink">Recent research</h2>
<a href="/research" class="font-mono text-xs uppercase tracking-wide text-accent hover:text-accent-hover">Browse every report &rarr;</a>
</div>
<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${cards}</div>
</div>
</section>`;
}

// Gives the verdict for a verification row, or null when the row does not
// qualify. Malformed result JSON gives null.
function qualifyingVerdict(row) {
  const claims = parseJsonSafe(row.result, null)?.claims;
  if (!Array.isArray(claims) || claims.length < MIN_VERDICT_CLAIMS) return null;
  const verdict = overallVerdict(claims);
  return typeof verdict.score === 'number' ? { row, verdict } : null;
}

function verdictCard({ row, verdict }) {
  return `<a class="card" href="/verify/${escapeHtml(row.slug)}">
<div class="card-top"><span class="card-badge">${verdict.score}/100</span><span class="card-time readout">Checked ${timeAgo(row.completed_at * 1000)}</span></div>
<h3>${escapeHtml(displayQuery(row.query))}</h3>
<p>${escapeHtml(verdict.label)}</p>
<p class="card-time readout">${verdict.checkedCount} of ${verdict.claimCount} claims checked</p>
</a>`;
}

// Lists the newest complete verifications that have a numeric score. Gives
// '' on any error, or when fewer than MIN_VERDICTS_TO_SHOW rows qualify.
export async function recentVerdictsSection(env, limit = RECENT_VERDICTS_LIMIT) {
  try {
    const rows = (await env.DB.prepare(RECENT_VERDICTS_SQL).bind(VERDICT_CANDIDATES).all()).results ?? [];
    const picked = rows.map(qualifyingVerdict).filter(Boolean).slice(0, limit);
    if (picked.length < MIN_VERDICTS_TO_SHOW) return '';
    return `<section id="recent-verdicts" class="border-b border-line">
<div class="mx-auto max-w-5xl px-6 py-14 md:py-20">
<h2 class="font-serif text-h2 font-semibold text-ink">Recent verdicts</h2>
<div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${picked.map(verdictCard).join('')}</div>
</div>
</section>`;
  } catch (err) {
    console.error('[home] recent verdicts failed:', err?.message ?? err);
    return '';
  }
}

// Serves the static asset behind `request`, swapping the recent-reports
// marker for the live section and applying the usual per-request CSP nonce.
// Falls back to the plain asset (still nonce'd) if the marker is missing.
async function injectRecentReports(request, env) {
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return notFound();

  const contentType = asset.headers.get('Content-Type') || '';
  const pathname = new URL(request.url).pathname;
  const longLived = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|webmanifest)$/i.test(pathname);
  const cacheControl = longLived
    ? 'public, max-age=604800, stale-while-revalidate=2592000'
    : 'public, max-age=3600, stale-while-revalidate=604800';

  if (!contentType.includes('text/html')) {
    const out = withSecurityHeaders(asset, null);
    out.headers.set('Cache-Control', cacheControl);
    return out;
  }

  let html = await asset.text();
  if (html.includes(MARKER)) {
    const section = await recentReportsSection(env).catch(() => '');
    html = html.replace(MARKER, () => section);
  }
  if (html.includes(VERDICTS_MARKER)) {
    const section = await recentVerdictsSection(env).catch(() => '');
    html = html.replace(VERDICTS_MARKER, () => section);
  }

  const { html: outHtml, nonce } = injectHtml(html, env, request);
  const out = withSecurityHeaders(asset, nonce, outHtml);
  out.headers.set('Cache-Control', cacheControl);
  return out;
}

export async function renderHome(request, env) {
  return injectRecentReports(request, env);
}

export async function renderBestIndex(request, env) {
  return injectRecentReports(request, env);
}
