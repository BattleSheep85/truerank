/**
 * Retired report URLs (refocus 2026-10, piece 3). A research row with
 * retired_at set answers 410 Gone so search engines drop the URL. The page
 * is standalone HTML with no AdSense loader (no ads on error pages).
 */

import { withSecurityHeaders } from './http-response.js';
import { escapeHtml } from './utils.js';

export const RETIRED_REASON_SEO_FLYWHEEL = 'seo-flywheel';

const RETIRED_CACHE_CONTROL = 'public, max-age=3600';

function retiredPage(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} | Frank</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #0f172a; color: #f8fafc; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
    h1 { font-size: 2.25rem; margin: 0 0 0.5rem 0; color: #38bdf8; }
    p { font-size: 1.125rem; color: #94a3b8; max-width: 480px; margin: 0 0 2rem 0; line-height: 1.5; }
    .links { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; }
    a { color: #38bdf8; text-decoration: none; font-weight: 500; padding: 0.5rem 1rem; border: 1px solid #38bdf8; border-radius: 0.375rem; transition: background 0.2s; }
    a:hover { background: rgba(56, 189, 248, 0.1); }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

const RETIRED_HTML = retiredPage('This report is gone', `  <h1>This report is gone.</h1>
  <p>Frank no longer publishes &quot;best of&quot; lists made from search keywords. To check a product, paste its link or name on the home page.</p>
  <div class="links">
    <a href="/">Check a product</a>
    <a href="/best/">Read the buying guides</a>
  </div>`);

/**
 * True when the research row with this slug has retired_at set.
 * Missing row: false. Any error: console.error with context, then false (fail-open).
 */
export async function isRetiredResearchSlug(db, slug) {
    try {
        const row = await db
            .prepare('SELECT retired_at FROM research WHERE slug = ?1')
            .bind(slug)
            .first();
        return row?.retired_at != null;
    } catch (err) {
        console.error(`[retired] retired_at lookup failed for slug "${slug}", serving the report: ${err?.message || err}`);
        return false;
    }
}

/**
 * 410 Gone. HTML body when Accept includes text/html, else text/plain "Gone".
 */
export function retiredReportResponse(request) {
    const accept = request?.headers?.get('Accept') || '';
    const isHtml = accept.includes('text/html');
    const body = isHtml ? RETIRED_HTML : 'Gone';
    const contentType = isHtml ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
    return withSecurityHeaders(new Response(body, {
        status: 410,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': RETIRED_CACHE_CONTROL,
            'X-Robots-Tag': 'noindex',
        },
    }), null);
}

/**
 * Retired verification report: { query } when the kind = 'verification' row
 * with this slug has retired_at set, else null.
 * Any error: console.error with context, then null (fail-open).
 */
export async function getRetiredVerification(db, slug) {
    try {
        const row = await db
            .prepare("SELECT query, retired_at FROM research WHERE slug = ?1 AND kind = 'verification'")
            .bind(slug)
            .first();
        return row?.retired_at != null ? { query: row.query } : null;
    } catch (err) {
        console.error(`[retired] verification retired_at lookup failed for slug "${slug}", serving the report: ${err?.message || err}`);
        return null;
    }
}

function retiredVerificationHtml(query) {
    const href = `/verify?product=${encodeURIComponent(query || '')}`;
    return retiredPage('This claim check is out of date', `  <h1>This claim check is out of date.</h1>
  <p>Frank retired this report because it was made by an older version of the checker.</p>
  <div class="links">
    <a href="${escapeHtml(href)}">Check this product again</a>
    <a href="/">Check a product</a>
  </div>`);
}

/**
 * 410 Gone for a retired verification. HTML body (with a link to check the
 * product again) when Accept includes text/html, else text/plain "Gone".
 */
export function retiredVerificationResponse(request, query) {
    const accept = request?.headers?.get('Accept') || '';
    const isHtml = accept.includes('text/html');
    const body = isHtml ? retiredVerificationHtml(query) : 'Gone';
    const contentType = isHtml ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8';
    return withSecurityHeaders(new Response(body, {
        status: 410,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': RETIRED_CACHE_CONTROL,
            'X-Robots-Tag': 'noindex',
        },
    }), null);
}
