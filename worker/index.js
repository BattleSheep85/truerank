/**
 * Frank: Cloudflare Worker entry point.
 * Routes HTTP requests and processes Queue messages.
 * Server-rendered pages live under /research/:slug (permanent); the legacy
 * client-rendered /report/:id permalinks 301 there.
 */

import {
    handleStartResearch, handleResearchStatus, handleResearchStream, handleResearchEvents,
} from './handlers/research.js';
import { handleStartVerify, handleVerifyStatus } from './handlers/verify.js';
import { renderVerifyEntryPage, renderVerifyResultPage } from './pages/verify-page.js';
import { handleGetReport, handleFeedback } from './handlers/report.js';
import { handleAffiliateClick, handleAffiliateSearch } from './handlers/affiliate.js';
import { handleProductImage } from './handlers/image.js';
import { classifyQuery, userFacingRejection, defaultQuestionsForQuery } from './lib/classifier.js';
import { screenQuery, rejectionMessage } from './lib/safety.js';
import { checkRateLimit } from './lib/rate-limit.js';
import { checkBurstGate } from './lib/burst-gate.js';
import { canonicalizeQuery } from './lib/utils.js';
import { renderBrowse } from './pages/browse.js';
import { renderHome, renderBestIndex } from './pages/home.js';
import { renderHistoryPage } from './pages/history.js';
import { handleSubscribe } from './handlers/subscribe.js';
import { handleUnsubscribe } from './handlers/unsubscribe.js';
import { handleConfirm } from './handlers/confirm.js';
import { handleChat } from './handlers/chat.js';
import { handleNextJob, handleProgress, handleComplete } from './handlers/internal.js';
import { handleSignup, handleLogin, handleLogout, handleDeleteAccount, handleExportAccount, renderLoginPage, renderAccountPage } from './handlers/auth.js';
import { getSessionUser, getUserSearches } from './lib/auth.js';
import { handleFind } from './pages/find.js';
import { renderReviewsPage } from './pages/reviews.js';
import { handleMetrics } from './pages/metrics.js';
import { getLatestResearchLastmod, generateSitemap, generateAtomFeed, generateOgImage } from './lib/sitemap.js';
import { getResearchById } from './lib/db.js';
import { GUIDES_LASTMOD } from './lib/guides.js';
import { CACHE_VERSION } from './lib/flags.js';
import { notFound, redirect301, maybe304, withSecurityHeaders, htmlPageResponse, serveAsset } from './lib/http-response.js';
import { handleResearchPage, handleBestHub, handleNewResearch, handleSearchSuggest } from './routes/pages.js';
import { renderFrankPage } from './pages/frank-egg.js';
import { deadUrlResponse } from './lib/dead-urls.js';
import { isRetiredResearchSlug, retiredReportResponse } from './lib/retired.js';
import { processResearchMessage, processVerificationMessage, runScheduledTick } from './jobs.js';

// Dev-only HTTP Basic Auth wall. Active ONLY when BOTH DEV_AUTH_USER and
// DEV_AUTH_PASS are set in the environment — production never sets them, so this
// is a complete no-op there. When active it guards the ENTIRE surface (pages,
// API, assets) so the unshipped extraction build stays private. Returns a 401
// Response to short-circuit, or null to allow the request through.
function requireDevAuth(request, env) {
  const user = env.DEV_AUTH_USER;
  const pass = env.DEV_AUTH_PASS;
  if (!user || !pass) return null; // gate disabled (e.g. production)
  const header = request.headers.get('Authorization') || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = atob(header.slice(6)); } catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    if (idx >= 0 && decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass) {
      return null; // credentials valid
    }
  }
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Frank Dev", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export default {
    /**
     * HTTP request handler — routes to appropriate handler.
     */
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS preflight
        if (method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Max-Age': '86400',
                },
            });
        }

        // Dev-only password wall (no-op in production — see requireDevAuth).
        const devAuth = requireDevAuth(request, env);
        if (devAuth) return devAuth;

        try {
            // ── API routes ──────────────────────────────────────────────────
            if (path === '/api/research' && method === 'POST') {
                return handleStartResearch(request, env);
            }

            // Product-verification (Truth Audit) intake + poll. Additive —
            // separate handler/pipeline from the ranking flow above.
            if (path === '/api/verify' && method === 'POST') {
                return handleStartVerify(request, env);
            }

            const verifyPollMatch = path.match(/^\/api\/verify\/([a-z0-9-]+)$/);
            if (verifyPollMatch && method === 'GET') {
                return handleVerifyStatus(verifyPollMatch[1], env);
            }

            // Pre-research classify: powers the inquisitive UX. The home search box
            // calls this first; if the query has need-questions the client shows them
            // (with a one-tap "Just search for it" skip) before starting research.
            // Fail-OPEN — any error returns accept:true with default questions so research
            // is never blocked. KV-cached classify via canonicalizeQuery.
            if (path === '/api/classify' && method === 'POST') {
                let cbody;
                try { cbody = await request.json(); } catch { cbody = {}; }
                const cq = String(cbody.query || '').trim();
                const jres = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
                if (cq.length < 3 || cq.length > 500) return jres({ accept: true, clarifying_questions: defaultQuestionsForQuery(cq) });
                // Deterministic safety screen first (fail-closed, can't be jailbroken/fail-opened).
                const s = screenQuery(cq);
                if (s.blocked) return jres({ accept: false, reject_message: rejectionMessage(s.reason), clarifying_questions: [] });

                // Spend throttle: two-stage burst gate + hourly rate limit on classify calls.
                // Refusal fails open (HTTP 200 with default questions) rather than 429ing so
                // the search box UX is never blocked — the throttle protects spend while the
                // fail-open shape protects UX.
                const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
                const rateKey = `classify:${clientIp}`;
                const burst = await checkBurstGate(env.RL_BURST, rateKey);
                const velocity = burst.allowed
                    ? await checkRateLimit(env.KV, rateKey, 60, 3600)
                    : burst;
                if (!velocity.allowed) {
                    return jres({ accept: true, clarifying_questions: defaultQuestionsForQuery(cq) });
                }

                try {
                    const c = await classifyQuery(env, cq, canonicalizeQuery(cq));
                    if (!c.accept) return jres({ accept: false, reject_message: userFacingRejection(c.reject_reason), clarifying_questions: [] });
                    return jres({ accept: true, clarifying_questions: c.clarifying_questions || [], suggested_refinement: c.suggested_refinement || null });
                } catch {
                    return jres({ accept: true, clarifying_questions: defaultQuestionsForQuery(cq) }); // fail-open
                }
            }

            const eventsMatch = path.match(/^\/api\/research\/([a-z0-9-]+)\/events$/);
            if (eventsMatch && method === 'GET') {
                return handleResearchEvents(eventsMatch[1], url, env);
            }

            const streamMatch = path.match(/^\/api\/research\/([a-z0-9-]+)\/stream$/);
            if (streamMatch && method === 'GET') {
                return handleResearchStream(streamMatch[1], env, request);
            }

            const researchMatch = path.match(/^\/api\/research\/([a-z0-9-]+)$/);
            if (researchMatch && method === 'GET') {
                return handleResearchStatus(researchMatch[1], env);
            }

            const reportMatch = path.match(/^\/api\/report\/([a-z0-9-]+)$/);
            if (reportMatch && method === 'GET') {
                return handleGetReport(reportMatch[1], env);
            }

            if (path === '/api/feedback' && method === 'POST') {
                return handleFeedback(request, env);
            }

            // Email capture for "notify me when research completes / re-runs".
            if (path === '/api/subscribe' && method === 'POST') {
                return handleSubscribe(request, env);
            }

            // Self-serve one-click unsubscribe (GET link + RFC 8058 POST).
            if (path === '/unsubscribe' && (method === 'GET' || method === 'POST')) {
                return handleUnsubscribe(request, env);
            }

            // Double opt-in confirmation link from the signup email.
            if (path === '/confirm' && method === 'GET') {
                return handleConfirm(request, env);
            }

            // "Talk about it" chat — refine a query (home) or ask follow-ups
            // grounded in a completed report (research pages).
            if (path === '/api/chat' && method === 'POST') {
                return handleChat(request, env);
            }

            // Per-user search history (server-backed, cross-device). The "Your
            // searches" tab + /history page hit this; signed-out users get
            // {authed:false} and the client falls back to localStorage. Epoch
            // seconds are normalized to ms to match the localStorage shape.
            if (path === '/api/history' && method === 'GET') {
                const jres = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
                const user = await getSessionUser(request, env);
                if (!user) return jres({ authed: false, items: [] });
                try {
                    const rows = await getUserSearches(env.DB, user.id, 50);
                    const items = rows
                        .filter((r) => r && r.slug)
                        .map((r) => ({ slug: r.slug, query: r.query, ts: (r.created_at || 0) * 1000, status: r.status || null, category: r.category || null }));
                    return jres({ authed: true, email: user.email, items });
                } catch (err) {
                    console.error('[history] lookup failed:', err instanceof Error ? err.message : String(err));
                    return jres({ authed: true, email: user.email, items: [] });
                }
            }

            // Internal API for the off-Cloudflare research worker (track 2).
            // Both gated by the X-Worker-Secret header == env.WORKER_SECRET.
            if (path === '/api/internal/next-job' && method === 'POST') return handleNextJob(request, env);
            if (path === '/api/internal/progress' && method === 'POST') return handleProgress(request, env);
            if (path === '/api/internal/complete' && method === 'POST') return handleComplete(request, env);

            // Accounts: email/password sessions + per-user search history.
            if (path === '/api/auth/signup' && method === 'POST') return handleSignup(request, env);
            if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
            if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, env);
            if (path === '/api/account/delete' && method === 'POST') return handleDeleteAccount(request, env);
            if (path === '/api/account/export' && method === 'GET') return handleExportAccount(request, env);

            // Pull-based metrics snapshot (Bearer-token auth via METRICS_TOKEN).
            if (path === '/metrics' && method === 'GET') {
                return handleMetrics(request, env);
            }

            // Autocomplete for the server-rendered search bars. LIKE-based in
            // phase 1; phase 3 swaps in FTS5.
            if (path === '/api/search/suggest' && method === 'GET') {
                return handleSearchSuggest(url, env);
            }

            // Search-based affiliate redirect for static guide pages.
            // Must be checked before the generic /api/go/:id route below.
            if (path === '/api/go/search' && method === 'GET') {
                return handleAffiliateSearch(request, env, ctx);
            }

            const affiliateMatch = path.match(/^\/api\/go\/([a-z0-9-]+)$/);
            if (affiliateMatch && method === 'GET') {
                return handleAffiliateClick(affiliateMatch[1], request, env, ctx);
            }

            // Product image proxy (defeats hotlink/Referer blocks; edge-cached).
            const imgMatch = path.match(/^\/api\/img\/([a-z0-9-]+)$/);
            if (imgMatch && method === 'GET') {
                return handleProductImage(imgMatch[1], env);
            }

            // ── Feeds (replace the old static public/sitemap.xml) ───────────
            const isGetLike = method === 'GET' || method === 'HEAD';
            if (path === '/sitemap.xml' && isGetLike) {
                return withSecurityHeaders(
                    await generateSitemap(url.origin, env, request.headers.get('If-Modified-Since'), GUIDES_LASTMOD),
                    null,
                );
            }
            if (path === '/feed.xml' && isGetLike) {
                return withSecurityHeaders(
                    await generateAtomFeed(url.origin, env, request.headers.get('If-Modified-Since')),
                    null,
                );
            }

            // Search forms submit via GET; action buttons (re-run) via POST.
            if (path === '/research/new' && (isGetLike || method === 'POST')) {
                return handleNewResearch(request, url, env);
            }

            // ── Server-rendered pages ───────────────────────────────────────
            if (isGetLike) {
                // Homepage and the /best/ guide index are static assets with a
                // recent-reports marker; inject the live section so crawlers
                // landing on the site's best-linked pages have a path into the
                // report archive. See worker/pages/home.js.
                if (path === '/') {
                    return renderHome(request, env);
                }
                if (path === '/best' || path === '/best/') {
                    return renderBestIndex(request, env);
                }

                // Account pages — always per-user, never cached.
                if (path === '/login' || path === '/account') {
                    const page = path === '/login'
                        ? await renderLoginPage(request, env)
                        : await renderAccountPage(request, env);
                    if (page instanceof Response) return page; // auth redirect
                    return htmlPageResponse(page, env, { cacheControl: 'no-store', request });
                }

                if (path === '/history' || path === '/history/') {
                    return htmlPageResponse(renderHistoryPage(), env, { cacheControl: 'no-store', request });
                }

                // Hidden, unlinked easter-egg page. Never referenced from nav,
                // footer, or the sitemap — see worker/pages/frank-egg.js.
                if (path === '/frank') {
                    return htmlPageResponse(renderFrankPage(), env, { cacheControl: 'no-store', request });
                }

                // Monetized Google hand-off for not-sold-on-Amazon categories.
                if (path === '/find') {
                    const page = await handleFind(request, url, env);
                    if (page instanceof Response) return withSecurityHeaders(page, null);
                    return htmlPageResponse(page, env, { cacheControl: 'no-store', request });
                }

                const ogMatch = path.match(/^\/research\/([a-z0-9-]+)\/og\.svg$/);
                if (ogMatch) {
                    return withSecurityHeaders(await generateOgImage(ogMatch[1], env), null);
                }

                // Sitewide product-review directory.
                if (path === '/reviews' || path === '/reviews/') {
                    const html = await renderReviewsPage(url, env);
                    if (!html) return notFound();
                    return htmlPageResponse(html, env, {
                        cacheControl: 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
                        request,
                    });
                }

                if (path === '/research' || path === '/research/') {
                    const [html, latestLm] = await Promise.all([
                        renderBrowse(url, env),
                        getLatestResearchLastmod(env, CACHE_VERSION),
                    ]);
                    // renderBrowse returns null for a page past the last one
                    // that serves cards. A run of empty 200 pages is a crawl
                    // trap, so answer 404 (same contract as /reviews).
                    if (!html) return notFound();
                    const listingCc = 'public, max-age=60, s-maxage=60, stale-while-revalidate=3600';
                    const notModified = maybe304(request.headers.get('If-Modified-Since'), latestLm, listingCc);
                    if (notModified) return notModified;
                    return htmlPageResponse(html, env, { lastModifiedSec: latestLm, cacheControl: listingCc, request });
                }

                const slugMatch = path.match(/^\/research\/([a-z0-9-]+)$/);
                if (slugMatch) {
                    // Retired reports answer 410 before the KV page cache.
                    if (await isRetiredResearchSlug(env.DB, slugMatch[1])) return retiredReportResponse(request);
                    return handleResearchPage(slugMatch[1], url, request, env, ctx);
                }

                // Product-verification pages. /verify is the entry form; /verify/:slug
                // is a live "verifying…" poll page until complete, then the minimal
                // report (worker/pages/verify-page.js). Never KV-cached (mirrors the
                // ranking page's cache split, but verification volume is low enough
                // that a page cache isn't worth the complexity yet).
                if (path === '/verify' || path === '/verify/') {
                    const prefillProduct = url.searchParams.get('product') || '';
                    return htmlPageResponse(renderVerifyEntryPage(prefillProduct), env, { cacheControl: 'no-store', request });
                }
                const verifySlugMatch = path.match(/^\/verify\/([a-z0-9-]+)$/);
                if (verifySlugMatch) {
                    const result = await renderVerifyResultPage(verifySlugMatch[1], env);
                    if (!result) return notFound();
                    return htmlPageResponse(result.html, env, { cacheControl: 'no-store', request });
                }

                // Legacy permalinks. Old ids were 16-char [a-z0-9]; the old
                // tables are gone, but if an id happens to match a v2 research
                // row, send the visitor to its permanent page.
                if (path === '/report' || path === '/report/') {
                    return redirect301(new URL('/research', url.origin));
                }
                const legacyMatch = path.match(/^\/report\/([a-z0-9]+)/);
                if (legacyMatch) {
                    const row = await getResearchById(env.DB, legacyMatch[1]).catch(() => null);
                    return redirect301(new URL(row ? `/research/${row.slug}` : '/research', url.origin));
                }

                // Category hubs: /best/:slug. Static guide assets (e.g.
                // /best/mechanical-keyboards-under-100/) must keep winning, so
                // we probe ASSETS first and only fall back to the dynamic hub
                // when the asset genuinely 404s. The bare /best/ index is a
                // static asset and is left to serveAsset below.
                const bestMatch = path.match(/^\/best\/([a-z0-9-]+)\/?$/);
                if (bestMatch) {
                    return handleBestHub(bestMatch[1], request, env);
                }
            }

            // Known-dead pages that GSC still has impressions for. Answer
            // with a 301 (equivalent content moved) or 410 (genuinely gone)
            // instead of a plain 404, so Google drops or redirects the URL
            // instead of retrying it for months. See worker/lib/dead-urls.js.
            if (isGetLike) {
                const deadUrl = deadUrlResponse(path);
                if (deadUrl) return withSecurityHeaders(deadUrl, null);
            }

            // IndexNow ownership verification file. Must echo the key exactly,
            // as text/plain, at https://chrisputer.tech/<key>.txt. Matched
            // dynamically off env so the route follows the configured key.
            if (env.INDEXNOW_KEY && isGetLike && path === `/${env.INDEXNOW_KEY}.txt`) {
                return withSecurityHeaders(new Response(env.INDEXNOW_KEY, {
                    headers: {
                        'Content-Type': 'text/plain;charset=utf-8',
                        'Cache-Control': 'public, max-age=86400',
                    },
                }), null);
            }

            // Serve public/favicon.svg for /favicon.ico requests from crawlers and legacy clients.
            if (path === '/favicon.ico' && isGetLike) {
                return serveAsset(request, env, new URL('/favicon.svg', url.origin));
            }

            // Static assets (home, guides, css/js). HTML gets a fresh
            // per-request CSP nonce injected.
            return serveAsset(request, env, null);

        } catch (err) {
            console.error('Request error:', err);
            return new Response(JSON.stringify({ error: 'Internal server error' }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
    },

    /**
     * Queue message handler — processes research jobs.
     */
    async queue(batch, env) {
        for (const message of batch.messages) {
            if (message.body?.kind === 'verification') {
                await processVerificationMessage(message, env);
                continue;
            }
            await processResearchMessage(message, env);
        }
    },

    /**
     * Scheduled handler (cron every 10 min). Delegates to worker/jobs.js
     * (runScheduledTick) for the reap/flywheel/GSC-ingest/external-worker-
     * fallback logic.
     */
    async scheduled(event, env, ctx) {
        return runScheduledTick(event, env, ctx);
    },
};
