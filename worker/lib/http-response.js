/**
 * HTTP response helpers shared by worker/index.js and worker/routes/pages.js:
 * JSON/404/redirect/304 helpers, the CSP policy, per-request nonce generation,
 * security-header wrapping, HTML page serving, and static-asset serving.
 */

import { isNotModified } from './utils.js';
import { requiresConsent, hasAdsConsent, hasConsentCookie, renderConsentBanner } from './consent.js';

export function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'X-Content-Type-Options': 'nosniff',
            ...extraHeaders,
        },
    });
}

export function suggestJson(data) {
    return new Response(JSON.stringify(data), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=600',
            'Vary': 'Accept-Encoding',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

// 404 response: small branded HTML 404 with links to / and /research when client accepts HTML,
// plain text otherwise. Both carry standard security headers.
export function notFound(requestOrAccept) {
    const accept = typeof requestOrAccept === 'string'
        ? requestOrAccept
        : (requestOrAccept?.headers?.get('Accept') || requestOrAccept?.headers?.get('accept') || '');
    const isHtml = accept.includes('text/html');

    if (isHtml) {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 Not Found | Frank</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem; background: #0f172a; color: #f8fafc; text-align: center; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; }
    h1 { font-size: 3rem; margin: 0 0 0.5rem 0; color: #38bdf8; }
    p { font-size: 1.125rem; color: #94a3b8; max-width: 480px; margin: 0 0 2rem 0; line-height: 1.5; }
    .links { display: flex; gap: 1rem; }
    a { color: #38bdf8; text-decoration: none; font-weight: 500; padding: 0.5rem 1rem; border: 1px solid #38bdf8; border-radius: 0.375rem; transition: background 0.2s; }
    a:hover { background: rgba(56, 189, 248, 0.1); }
  </style>
</head>
<body>
  <h1>404 Not Found</h1>
  <p>The page you requested could not be found.</p>
  <div class="links">
    <a href="/">Home</a>
    <a href="/research">Research</a>
  </div>
</body>
</html>`;
        return withSecurityHeaders(new Response(html, {
            status: 404,
            headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' },
        }), null);
    }

    return withSecurityHeaders(new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store' },
    }), null);
}

export function redirect301(destUrl) {
    return new Response(null, {
        status: 301,
        headers: {
            'Location': destUrl.toString(),
            'Cache-Control': 'public, max-age=86400',
        },
    });
}

// Returns a 304 Not Modified if the client's If-Modified-Since covers the
// resource's last-modified timestamp (date math shared via lib/utils.js).
export function maybe304(ifModifiedSince, lastModifiedSec, cacheControl) {
    if (!isNotModified(ifModifiedSince, lastModifiedSec)) return null;
    return new Response(null, {
        status: 304,
        headers: {
            'Last-Modified': new Date(lastModifiedSec * 1000).toUTCString(),
            'Cache-Control': cacheControl || 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
        },
    });
}

// --- HTML serving with a per-request CSP nonce -----------------------------
// Both static assets and server-rendered pages are templated with
// `__CSP_NONCE__` on every <script>. The worker swaps it for a fresh random
// nonce per request and sets a matching nonce + strict-dynamic CSP.

export const CSP = (nonce) =>
    "default-src 'self'; " +
    // AdSense display ads (googlesyndication/doubleclick) + Cloudflare beacon &
    // Turnstile are the only third-party script/frame origins. /find no longer
    // embeds a Google CSE widget (it 302-redirects to a plain Google search), so
    // the old cse.google.com / www.google.com / clients1.google.com grants are gone.
    // script-src uses nonce + strict-dynamic (Google's recommended "strict CSP"
    // for AdSense, answer/16283098) so the nonce'd loader transitively trusts the
    // ad scripts it injects — host allowlist entries here are ignored by modern
    // browsers but kept for non-strict-dynamic fallbacks. NOT adding 'unsafe-eval'
    // (Google lists it but it guts the CSP; revisit only on a confirmed eval CSP error).
    // fundingchoicesmessages.google.com = Google's certified GDPR consent message
    // (Funding Choices). Kept as a host fallback; under strict-dynamic the FC
    // script the nonce'd AdSense loader injects is already trusted transitively.
    "script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic' https://challenges.cloudflare.com https://static.cloudflareinsights.com https://pagead2.googlesyndication.com https://fundingchoicesmessages.google.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    // connect-src governs AdSense's measurement/anti-fraud beacons (NOT covered by
    // strict-dynamic): impression/click pings (pagead2/doubleclick/tpc) + the
    // mandatory Ad Traffic Quality beacons (ep1/ep2.adtrafficquality.google).
    "connect-src 'self' https://challenges.cloudflare.com https://cloudflareinsights.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://ep1.adtrafficquality.google https://ep2.adtrafficquality.google https://www.google.com https://fundingchoicesmessages.google.com; " +
    // frame-src governs the ad creative iframes: doubleclick + SafeFrame
    // (tpc.googlesyndication.com) + some formats served from www.google.com +
    // the GDPR consent dialog (fundingchoicesmessages.google.com). If the live
    // console logs a CSP frame violation from another *.googlesyndication.com
    // host during EEA verification, add that exact host here.
    "frame-src https://challenges.cloudflare.com https://googleads.g.doubleclick.net https://tpc.googlesyndication.com https://www.google.com https://fundingchoicesmessages.google.com; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

export function makeNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

export function withSecurityHeaders(res, nonce, body) {
    const headers = new Headers(res.headers);
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (nonce) headers.set('Content-Security-Policy', CSP(nonce));
    return new Response(body !== undefined ? body : res.body, { status: res.status, headers });
}

// Injects CSP nonce substitution, AdSense loader (or consent banner), and
// Cloudflare Insights beacon into HTML based on request consent and env config.
// Shared by htmlPageResponse, serveAsset, and any other static/rendered HTML paths.
export function injectHtml(body, env = {}, request) {
    const nonce = makeNonce();
    let out = body.replaceAll('__CSP_NONCE__', nonce);

    const needsConsent = requiresConsent(request);
    const hasConsent = hasAdsConsent(request);
    const consentDecided = hasConsentCookie(request);

    if (env?.ADSENSE_PUBLISHER_ID && (!needsConsent || hasConsent)) {
        if (out.includes('</head>')) {
            out = out.replace('</head>', `<script async nonce="${nonce}" src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${env.ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>\n</head>`);
        } else {
            out = `<script async nonce="${nonce}" src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-${env.ADSENSE_PUBLISHER_ID}" crossorigin="anonymous"></script>\n` + out;
        }
    } else if (env?.ADSENSE_PUBLISHER_ID && needsConsent && !consentDecided) {
        if (out.includes('</body>')) {
            out = out.replace('</body>', `${renderConsentBanner(nonce)}\n</body>`);
        } else {
            out += renderConsentBanner(nonce);
        }
    }
    if (env?.CF_ANALYTICS_TOKEN) {
        if (out.includes('</body>')) {
            out = out.replace('</body>', `<script defer nonce="${nonce}" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${env.CF_ANALYTICS_TOKEN}"}'></script></body>`);
        } else {
            out += `<script defer nonce="${nonce}" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${env.CF_ANALYTICS_TOKEN}"}'></script>`;
        }
    }
    return { html: out, nonce };
}

// Serve a server-rendered HTML page: nonce substitution, AdSense loader +
// Cloudflare Insights injection (nonce'd), Last-Modified, cache headers.
export function htmlPageResponse(body, env, { status = 200, lastModifiedSec, cacheControl, request } = {}) {
    const { html: out, nonce } = injectHtml(body, env, request);
    const headers = new Headers({
        'Content-Type': 'text/html;charset=utf-8',
        'Content-Language': 'en',
        'Vary': 'Accept-Encoding',
    });
    if (lastModifiedSec) {
        headers.set('Last-Modified', new Date(lastModifiedSec * 1000).toUTCString());
    }
    if (cacheControl) {
        headers.set('Cache-Control', cacheControl);
    } else if (lastModifiedSec) {
        headers.set('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
    } else if (status === 200) {
        headers.set('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=3600');
    } else {
        headers.set('Cache-Control', 'no-store');
    }
    return withSecurityHeaders(new Response(out, { status, headers }), nonce, out);
}

export async function serveAsset(request, env, overrideUrl) {
    const res = await env.ASSETS.fetch(overrideUrl ? new Request(overrideUrl, request) : request);
    if (res.status === 404 && !overrideUrl) {
        return notFound();
    }
    const contentType = res.headers.get('Content-Type') || '';
    const pathname = new URL(overrideUrl || request.url).pathname;
    const longLived = /\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|webmanifest)$/i.test(pathname);
    const cacheControl = longLived
        ? 'public, max-age=604800, stale-while-revalidate=2592000'
        : 'public, max-age=3600, stale-while-revalidate=604800';

    if (contentType.includes('text/html')) {
        const raw = await res.text();
        const { html, nonce } = injectHtml(raw, env, request);
        const out = withSecurityHeaders(res, nonce, html);
        out.headers.set('Cache-Control', cacheControl);
        return out;
    }
    // The [assets] binding serves static files with `max-age=0, must-revalidate`,
    // forcing a conditional round-trip on every repeat visit. Override with a
    // cacheable policy. Filenames aren't content-hashed, so use stale-while-
    // revalidate: repeat loads are always instant (fresh, or stale served while a
    // background revalidate runs) and edits still propagate quickly. Media/fonts
    // effectively never change → long fresh window; css/js change on deploy → short
    // fresh window so updates land within ~an hour.
    const out = withSecurityHeaders(res, null);
    out.headers.set('Cache-Control', cacheControl);
    return out;
}
