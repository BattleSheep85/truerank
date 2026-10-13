/**
 * Server-rendered page routes: the cached research result page, the
 * /best/:slug category hub, /research/new submission handling, and the
 * /api/search/suggest autocomplete endpoint. Extracted from worker/index.js.
 */

import { htmlPageResponse, maybe304, withSecurityHeaders, notFound, suggestJson, injectHtml } from '../lib/http-response.js';
import { CACHE_VERSION } from '../lib/flags.js';
import { renderResearchResult } from '../pages/research-page.js';
import { renderCategoryHub } from '../pages/category.js';
import { classifyQuery } from '../lib/classifier.js';
import { renderClarifyPage, extractClarifications } from '../pages/clarify.js';
import { handleStartResearch } from '../handlers/research.js';
import { displayQuery, escapeLikeWildcards, canonicalizeQuery } from '../lib/utils.js';
import { listableRowsSql } from '../lib/listable.js';

// --- Server-rendered research page with KV page cache ---------------------

export async function purgePageCache(env, slug) {
    if (!env?.KV || !slug) return;
    const cacheKey = `page:${CACHE_VERSION}:${slug}`;
    const cacheMetaKey = `page:${CACHE_VERSION}:${slug}:lm`;
    try {
        await Promise.all([
            env.KV.delete(cacheKey).catch(() => {}),
            env.KV.delete(cacheMetaKey).catch(() => {}),
        ]);
    } catch {
        // never throws
    }
}

export async function handleResearchPage(slug, url, request, env, ctx) {
    const fromQuery = url.searchParams.get('from');
    // ?src=... renders a clean-link (no affiliate tags) variant for community
    // posts; never cached, canonical still points at the clean URL.
    const cleanLinks = !!url.searchParams.get('src');
    const cacheKey = `page:${CACHE_VERSION}:${slug}`;
    const cacheMetaKey = `page:${CACHE_VERSION}:${slug}:lm`;
    const ifModifiedSince = request.headers.get('If-Modified-Since');

    if (!fromQuery && !cleanLinks) {
        const [cached, cachedLm] = await Promise.all([
            env.KV.get(cacheKey),
            env.KV.get(cacheMetaKey),
        ]);
        if (cached) {
            // Cached views still count — bump view_count out-of-band so the
            // KV fast path never blocks on D1.
            ctx.waitUntil(
                env.DB.prepare("UPDATE research SET view_count = view_count + 1 WHERE slug = ?1 AND status = 'complete'")
                    .bind(slug).run()
                    .catch((err) => console.error('View count update failed:', err)),
            );
            const lm = cachedLm ? parseInt(cachedLm, 10) || undefined : undefined;
            const notModified = maybe304(ifModifiedSince, lm);
            if (notModified) return notModified;
            return htmlPageResponse(cached, env, { lastModifiedSec: lm, request });
        }
    }

    const result = await renderResearchResult(slug, env, fromQuery, cleanLinks);
    if (result instanceof Response) {
        // Plain 404 in phase 1 (error pages port is phase 2); wrap it here so
        // even bare responses carry the security headers.
        return withSecurityHeaders(result, null);
    }

    // Cache completed pages only (not failed or in-flight processing variants).
    // Cached body is consent-neutral by construction; htmlPageResponse injects ads/banner per request.
    if (!fromQuery && !cleanLinks && result.status === 'complete') {
        ctx.waitUntil(env.KV.put(cacheKey, result.html, { expirationTtl: 3600 }));
        ctx.waitUntil(env.KV.put(cacheMetaKey, String(result.lastModified), { expirationTtl: 3600 }));
    }
    const notModified = maybe304(ifModifiedSince, result.lastModified);
    if (notModified) return notModified;
    return htmlPageResponse(result.html, env, { lastModifiedSec: result.lastModified, request });
}

// GET /best/:slug — static guide asset wins; dynamic category hub is the
// fallback. We probe ASSETS directly (not serveAsset, whose 404 path returns a
// styled page) so a real asset hit — including a redirect to a trailing-slash
// directory index — is detected and served through the nonce/security path. A
// genuine 404 means no static guide exists, so we render the category hub
// (renderCategoryHub returns null → 404 when no research matches the slug).
export async function handleBestHub(slug, request, env) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) {
        const contentType = asset.headers.get('Content-Type') || '';
        if (contentType.includes('text/html')) {
            const { html, nonce } = injectHtml(await asset.text(), env, request);
            return withSecurityHeaders(asset, nonce, html);
        }
        return withSecurityHeaders(asset, null);
    }

    const html = await renderCategoryHub(slug, env);
    if (!html) return notFound();
    return htmlPageResponse(html, env, {
        cacheControl: 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600',
        request,
    });
}

// GET|POST /research/new — target of the server-rendered search forms (GET)
// and action buttons like re-run (POST). q/fresh come from query params on
// GET, and from the form body (falling back to query params) on POST.
// Phase 1: no tiers/Turnstile/clarifying questions; submit and redirect.
export async function handleNewResearch(request, url, env) {
    // Speculative prefetch (Chrome prerender, link hover prefetchers) must
    // never enqueue research jobs or burn rate-limit quota.
    const purposeHeaders = `${request.headers.get('Sec-Purpose') || ''} ${request.headers.get('Purpose') || ''}`.toLowerCase();
    if (purposeHeaders.includes('prefetch')) {
        return new Response(null, { status: 204 });
    }

    let form = null;
    if (request.method === 'POST') {
        // Tolerates non-form bodies (formData() throws → query-param fallback).
        form = await request.formData().catch(() => null);
    }
    const param = (name) => {
        const fromForm = form?.get(name);
        if (typeof fromForm === 'string' && fromForm !== '') return fromForm;
        return url.searchParams.get(name) || '';
    };

    const query = param('q').trim();
    const fresh = param('fresh') === '1';
    if (!query) {
        return Response.redirect(new URL('/', url.origin).toString(), 302);
    }

    // Clarifying-questions interstitial. For a submission that is NOT a
    // re-run (fresh), does NOT already carry clarification answers, and was NOT
    // an explicit skip, ask the classifier (KV-cached, so cheap) whether the
    // query needs disambiguation. If it returns >=1 question, render the clarify
    // page instead of starting research. Prefetches already returned 204 above.
    const hasAnswers = Array.from(url.searchParams.keys()).some((k) => k.startsWith('clarify_'))
        || (form ? Array.from(form.keys()).some((k) => k.startsWith('clarify_')) : false);
    const skipClarify = param('skip_clarify') === '1';
    let clarifications = {};
    if (!fresh && !hasAnswers && !skipClarify) {
        try {
            const classification = await classifyQuery(env, query, canonicalizeQuery(query.toLowerCase()));
            if (classification.accept && classification.clarifying_questions.length > 0) {
                return htmlPageResponse(
                    renderClarifyPage(query, classification.clarifying_questions, env),
                    env,
                    { cacheControl: 'no-store', request },
                );
            }
        } catch { /* classifier failure: fall open and proceed without the grill */ }
    }
    if (hasAnswers) {
        // Extract directly from the request URL — works even if the classifier
        // failed open after the interstitial rendered, so the answers still land.
        clarifications = extractClarifications(url);
    }

    const apiBody = { query };
    if (fresh) apiBody.fresh = true;
    if (Object.keys(clarifications).length > 0) apiBody.clarifications = clarifications;

    const result = await handleStartResearch(new Request(new URL('/api/research', url.origin), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': request.headers.get('CF-Connecting-IP') || '127.0.0.1',
            // Forward the session cookie so signed-in users' searches land in
            // their /account history even via the server-rendered form path.
            ...(request.headers.get('Cookie') ? { 'Cookie': request.headers.get('Cookie') } : {}),
        },
        body: JSON.stringify(apiBody),
    }), env);

    if (result.ok) {
        const data = await result.json();
        if (data.slug) {
            const dest = new URL(`/research/${data.slug}`, url.origin);
            if (data.clustered) dest.searchParams.set('from', query);
            return Response.redirect(dest.toString(), 302);
        }
    }
    // Validation/rate-limit failure: land on browse with the query prefilled.
    return Response.redirect(new URL(`/research?q=${encodeURIComponent(query.slice(0, 200))}`, url.origin).toString(), 302);
}

// GET /api/search/suggest?q=... — LIKE-based autocomplete (FTS5 in phase 3).
export async function handleSearchSuggest(url, env) {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return suggestJson([]);
    const sanitized = q.replace(/[^\w\s-]/g, '').trim();
    if (!sanitized) return suggestJson([]);

    // The cluster winner comes from lib/listable.js, so autocomplete suggests
    // the same slug the listing and the sitemap link. Only the result ordering
    // is autocomplete's own (most-viewed first).
    const rows = await env.DB.prepare(
        listableRowsSql({
            columns: 'r.id, r.slug, r.query, r.category, r.view_count, r.created_at',
            select: 'slug, query, category, view_count',
            extraWhere: `r.query LIKE ?1 ESCAPE '\\'`,
            orderBy: 'view_count DESC, created_at DESC, id DESC',
            tail: 'LIMIT 6',
        })
    ).bind(`%${escapeLikeWildcards(sanitized)}%`).all();

    const pretty = (rows.results || []).map((r) => ({ ...r, query: displayQuery(r.query) }));
    return suggestJson(pretty);
}
