/**
 * Report API handlers.
 * GET /api/report/:id: serve cached report
 * POST /api/feedback: store a reader's vote; enough "No" votes start a re-run
 */

import { getResearchById, getResearchBySlug, getProductsByResearchId, insertFeedback } from '../lib/db.js';
import { parseJsonSafe, safeUserFacingError } from '../lib/utils.js';
import { apiStatus } from '../lib/status.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { checkBurstGate } from '../lib/burst-gate.js';
import { hashIp } from '../lib/ip-hash.js';
import { maybeStartDisagreementRerun } from '../lib/disagreement.js';

// Saved sources keep a ~200-character snippet each (CP-408), about 20 KB or
// more per report. Only the eval's groundedness check reads them, so the API
// sends them on ?snippets=1 only (CP-808).
const withoutSnippet = ({ snippet, ...source }) => source;

/**
 * Handle GET /api/report/:id
 * Returns the full report with sources and products (v2 research tables).
 * `includeSnippets` keeps each source's snippet (GET ...?snippets=1).
 */
export async function handleGetReport(reportId, env, { includeSnippets = false } = {}) {
    let row = await getResearchById(env.DB, reportId);
    if (!row) {
        row = await getResearchBySlug(env.DB, reportId);
    }
    // A retired report answers like a missing one (CP-804).
    if (!row || row.retired_at != null) {
        return jsonResponse({ error: 'Report not found' }, 404);
    }

    if (row.status === 'failed') {
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: apiStatus(row.status),
            error: safeUserFacingError(parseJsonSafe(row.result, {}).error),
        }, 200);
    }

    if (row.status !== 'complete') {
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: apiStatus(row.status),
            message: 'Report is still being generated',
        }, 202);
    }

    const productsResult = await getProductsByResearchId(env.DB, row.id);
    const report = parseJsonSafe(row.result, null);

    return jsonResponse({
        id: row.id,
        slug: row.slug,
        query: row.query,
        status: 'completed',
        report,
        sources: sourcesForApi(parseJsonSafe(row.sources, []), includeSnippets),
        products: productsResult.results || [],
        sourceCount: report?.source_count ?? 0,
        filteredCount: report?.filtered_count ?? 0,
        createdAt: row.created_at,
    });
}

function sourcesForApi(sources, includeSnippets) {
    if (includeSnippets || !Array.isArray(sources)) return sources;
    return sources.map((s) => (s && typeof s === 'object' ? withoutSnippet(s) : s));
}

/**
 * Handle POST /api/feedback
 * Stores a reader's vote on a report (one per visitor: a second vote replaces
 * the first). Enough "No" votes start one fresh run (worker/lib/disagreement.js).
 * Response: { success: true, rerun: boolean }.
 */
export async function handleFeedback(request, env) {
    // A vote can start a paid run, so a cross-site page must not cast votes
    // through its visitors' browsers. Non-browser callers send neither header.
    if (isCrossSiteBrowser(request)) {
        return jsonResponse({ error: 'Cross-site requests are not accepted' }, 403);
    }
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    // Salted IP hash: the key is stored in D1 (CP-808).
    const rateKey = await ipRateKey('feedback', clientIp, env);
    const burst = await checkBurstGate(env.RL_BURST, rateKey);
    const velocity = burst.allowed
        ? await checkRateLimit(env.KV, rateKey, 20, 3600, env.DB)
        : burst;
    if (!velocity.allowed) {
        const retryAfter = Math.max(1, Math.ceil((velocity.resetAt - Date.now()) / 1000));
        return jsonResponse(
            { error: 'Too many feedback submissions from your connection in the last hour. Please try again shortly.' },
            429,
            { 'Retry-After': String(retryAfter) },
        );
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { reportId, rating, comment } = body;

    if (!reportId) {
        return jsonResponse({ error: 'reportId is required' }, 400);
    }

    const ratingNum = parseInt(rating, 10);
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
        return jsonResponse({ error: 'rating must be between 1 and 5' }, 400);
    }

    const report = typeof reportId === 'string' ? await getResearchById(env.DB, reportId) : null;
    if (!report || report.retired_at != null) {
        return jsonResponse({ error: 'Report not found' }, 404);
    }

    await insertFeedback(env.DB, {
        reportId,
        rating: ratingNum,
        comment: typeof comment === 'string' ? comment.slice(0, 1000) : '',
        voterHash: await voterHashFor(clientIp, env),
    });

    // The vote is saved either way: a re-run failure only costs the re-run.
    let rerun = false;
    try {
        rerun = await maybeStartDisagreementRerun(env, report);
    } catch (err) {
        console.error(`[feedback] disagreement re-run check failed for ${reportId}:`, err instanceof Error ? err.message : String(err));
    }
    return jsonResponse({ success: true, rerun });
}

// Without a salt the vote is still saved, but it cannot count toward a re-run.
async function voterHashFor(ip, env) {
    if (ip === 'unknown') return null;
    try {
        return await hashIp(ip, env);
    } catch (err) {
        console.error('[feedback] voter hash unavailable:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

function isCrossSiteBrowser(request) {
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return true;
    const origin = request.headers.get('Origin');
    return Boolean(origin) && origin !== new URL(request.url).origin;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        },
    });
}
