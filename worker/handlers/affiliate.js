/**
 * Affiliate click tracking handler.
 * GET /api/go/:productId - redirect through affiliate link, log click.
 */

import { logAffiliateClick, logGuideClick } from '../lib/db.js';
import { buildAmazonSearchFallback } from '../lib/affiliate-links.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { hashIp } from '../lib/ip-hash.js';
import { isAffiliateFloodActive, isAffiliateHourlyCapHit } from '../lib/affiliate-gate.js';

// Bot/scraper defense for the affiliate redirect surface. /api/ is disallowed
// in robots.txt, so any traffic hitting these routes is already non-compliant
// with a well-behaved crawler's rules — this catches it anyway (UA sniffing is
// easily spoofed) and caps the blast radius (rate limit). Real incident
// 2026-06-21: 2,397 redirect hits from 6 IPs in a single day, no UA filter, no
// rate limit — polluted affiliate_clicks and sent non-human traffic through
// Amazon affiliate links, which risks Associates account suspension.
const BOT_UA_PATTERN = /bot|crawl|spider|scraper|curl|wget|python-requests|python-urllib|scrapy|headless|phantomjs|selenium|puppeteer|playwright|go-http-client|java\/|libwww|httpclient|axios\/|node-fetch|okhttp|postman|scan|monitor|uptime|pingdom|check_http|facebookexternalhit|slurp|ahrefs|semrush|mj12bot|dotbot/i;

// Per-visitor volume cap, unchanged since the 2026-06-21 incident. Generous for
// a real visitor clicking through product cards on one page; a script hammering
// the redirect endpoint from one address blows past it fast.
const PER_IP_CLICK_LIMIT = 30;
const PER_IP_WINDOW_SECONDS = 3600;

// Four layers, cheapest first, and each one on its own is enough to flag a
// request. UA runs before the site-wide gate on purpose: a self-identifying bot
// must not eat the shared budget and push real visitors over it.
async function isSuspiciousRequest(request, env, ip) {
    const ua = request.headers.get('User-Agent') || '';
    if (!ua || BOT_UA_PATTERN.test(ua)) return true;
    // Layer 2, added after the 2026-08-15 incident: site-wide volume, which is
    // the only view that sees an IP-rotating bot. Independent of the per-IP cap
    // below, and it never replaces it.
    if (await isAffiliateFloodActive(env)) return true;
    if (!env.KV) return false;
    try {
        const rateKey = await ipRateKey('go', ip, env);
        const rate = await checkRateLimit(env.KV, rateKey, PER_IP_CLICK_LIMIT, PER_IP_WINDOW_SECONDS);
        if (!rate.allowed) return true;
    } catch {
        return false;
    }
    // Layer 4 (CP-353): site-wide clicks per HOUR, for a slow, wide source
    // that stays under the per-minute gate. Last, so only clicks every other
    // layer let through spend the shared hourly budget.
    return isAffiliateHourlyCapHit(env);
}

// Strip Amazon's tag/ascsubtag query params so a flagged request still reaches
// its destination (doesn't look like a dead link to whatever is probing it)
// but never carries our affiliate tag through to Amazon.
function stripAmazonAffiliateParams(url) {
    if (!url) return url;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (host !== 'amazon.com' && !host.endsWith('.amazon.com')) return url;
        u.searchParams.delete('tag');
        u.searchParams.delete('ascsubtag');
        return u.toString();
    } catch {
        return url;
    }
}

// Recognize a usable, tagged Amazon /dp/ buy link (persisted by Phase 2).
// Search-results URLs (amazon.com/s?...) are intentionally NOT treated as a
// "real" product link here — we'd rather rebuild a fresh tagged search from the
// product name so the associate tag is guaranteed present.
function isAmazonProductUrl(url) {
    if (!url || !url.startsWith('https://')) return false;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const isAmazon = host === 'amazon.com' || host.endsWith('.amazon.com');
        if (!isAmazon) return false;
        const path = u.pathname.toLowerCase();
        // Reject bare search/browse paths; accept /dp/, /gp/product/, etc.
        if (path === '/s' || path.startsWith('/s/') || path === '/b') return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Handle GET /api/go/:productId
 * Logs the click and redirects to the affiliate URL.
 */
// Hostnames we accept as non-Amazon redirect destinations. Mirrors BUY_HOSTS in
// affiliate-links.js; kept inline so the handler can enforce the list without
// importing it (and to catch any DB row written outside the normal pipeline).
const KNOWN_RETAILER_HOSTS = new Set([
    'amazon.com', 'walmart.com', 'bestbuy.com', 'newegg.com',
    'target.com', 'bhphotovideo.com', 'adorama.com', 'costco.com', 'microcenter.com',
]);
function isKnownRetailerUrl(url) {
    if (!url || !url.startsWith('https://')) return false;
    try {
        const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        return KNOWN_RETAILER_HOSTS.has(host) || [...KNOWN_RETAILER_HOSTS].some((h) => host.endsWith(`.${h}`));
    } catch { return false; }
}

export async function handleAffiliateClick(productId, request, env, ctx) {
    const reportId = (new URL(request.url).searchParams.get('ref') || '').slice(0, 64);
    const network = (new URL(request.url).searchParams.get('network') || 'amazon').slice(0, 32);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Hash the IP for privacy (don't store raw IPs). Failures to hash must never block redirect.
    let ipHash = null;
    try {
        ipHash = await hashString(ip, env);
    } catch (err) {
        console.error('Click IP hashing failed:', err instanceof Error ? err.message : String(err));
    }
    const suspicious = await isSuspiciousRequest(request, env, ip);

    // Log the click asynchronously (don't block the redirect). Bot/rate-limited
    // hits or unhashed requests are excluded so affiliate_clicks reflects real visitors.
    const logPromise = (suspicious || !ipHash)
        ? Promise.resolve()
        : logAffiliateClick(env.DB, {
            productId,
            reportId,
            network,
            ipHash,
        }).catch(err => console.error('Click logging failed:', err));

    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(logPromise);
    } else {
        await logPromise;
    }

    // Look up the product's affiliate link (v2 schema: single affiliate_url,
    // with product_url as the untagged fallback). name/brand let us rebuild a
    // tagged Amazon search when no real /dp/ link was persisted.
    const product = await env.DB.prepare(
        `SELECT p.affiliate_url, p.product_url, p.name, p.brand, r.slug AS research_slug
           FROM products p LEFT JOIN research r ON r.id = p.research_id
          WHERE p.id = ?`
    ).bind(productId).first();

    const amazonTag = env.AMAZON_ASSOCIATE_TAG || env.AMAZON_AFFILIATE_TAG || '';
    const affiliateUrl = product?.affiliate_url || '';

    let redirectUrl;
    if (isAmazonProductUrl(affiliateUrl)) {
        // (a) Real tagged Amazon /dp/ link from Phase 2 — use it directly.
        redirectUrl = affiliateUrl;
    } else if (isKnownRetailerUrl(affiliateUrl) && !/^https?:\/\/(www\.)?amazon\.com\//i.test(affiliateUrl)) {
        // (b) A valid non-Amazon retailer affiliate link (Walmart, Best Buy, ...).
        // Honor it rather than fabricating an Amazon search for that product.
        redirectUrl = affiliateUrl;
    } else if (product?.name && product.name.trim().length >= 3) {
        // (c) No usable affiliate URL: redirect to an Amazon SEARCH for the product name
        // so the user lands directly on results for the product they clicked.
        const brand = (product.brand || '').trim();
        const name = product.name.trim();
        const query = brand && !name.toLowerCase().startsWith(brand.toLowerCase())
            ? `${brand} ${name}`
            : name;
        const tagSuffix = amazonTag ? `&tag=${encodeURIComponent(amazonTag)}` : '';
        redirectUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}${tagSuffix}`;
    } else if (product?.product_url && isKnownRetailerUrl(product.product_url)) {
        // (d) Last resort for short-name products: a known retailer product_url
        // beats dumping the user on the Amazon homepage. Gated by retailer allowlist.
        redirectUrl = product.product_url;
    } else {
        // (e) Fallback for unknown product or missing name: tagged Amazon homepage
        redirectUrl = amazonTag
            ? `https://www.amazon.com/?tag=${encodeURIComponent(amazonTag)}`
            : 'https://www.amazon.com/';
    }

    if (suspicious) {
        // Never carry our affiliate tag through to Amazon for a flagged request.
        redirectUrl = stripAmazonAffiliateParams(redirectUrl);
    } else {
        // Per-page EPC attribution: Amazon surfaces ascsubtag in the Associates
        // Orders report, so we can see which research page actually EARNS (not
        // just which gets clicks). No-op for non-Amazon redirects.
        redirectUrl = withAmazonSubtag(redirectUrl, product?.research_slug ? `tr-${product.research_slug}` : 'tr-direct');
    }

    return new Response(null, {
        status: 302,
        headers: {
            'Location': redirectUrl,
            'Cache-Control': 'no-cache, no-store',
        },
    });
}

// Append an Amazon Associates subtag (per-page EPC attribution). Only applied to
// amazon.com URLs; no-op elsewhere. Shows in the Associates Orders report. Keep it
// short and to [a-z0-9_-] — Amazon truncates/strips unusual characters.
function withAmazonSubtag(url, subtag) {
    if (!url || !subtag) return url;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (host !== 'amazon.com' && !host.endsWith('.amazon.com')) return url;
        const clean = subtag.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80);
        u.searchParams.set('ascsubtag', clean);
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Handle GET /api/go/search?q=...&ref=<guide-slug>
 * Redirect for static guide pages (no DB product). Builds an Amazon search
 * link with the associate tag server-side, so the tag stays out of static
 * files, and records a best-effort guide click.
 */
export async function handleAffiliateSearch(request, env, ctx) {
    const url = new URL(request.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const ref = (url.searchParams.get('ref') || '').slice(0, 64);
    const network = (url.searchParams.get('network') || 'amazon').slice(0, 32);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const suspicious = await isSuspiciousRequest(request, env, ip);

    const amazonTag = env.AMAZON_ASSOCIATE_TAG || env.AMAZON_AFFILIATE_TAG || '';
    const tagSuffix = amazonTag ? `&tag=${encodeURIComponent(amazonTag)}` : '';
    // Only ever build an amazon.com URL server-side. No user-controlled host,
    // so there is no open-redirect surface.
    const baseUrl = q
        ? `https://www.amazon.com/s?k=${encodeURIComponent(q)}${tagSuffix}`
        : `https://www.amazon.com/${amazonTag ? `?tag=${encodeURIComponent(amazonTag)}` : ''}`;
    // Per-page EPC attribution for guide pages, keyed by the guide slug (ref).
    // Flagged requests skip the tag entirely — never send suspected bot/script
    // traffic through the Amazon Associates link.
    const redirectUrl = suspicious
        ? stripAmazonAffiliateParams(baseUrl)
        : withAmazonSubtag(baseUrl, ref ? `tr-guide-${ref}` : 'tr-guide');

    // Best-effort analytics. Never let logging break the redirect. Skipped for
    // flagged requests so guide_clicks reflects real visitors.
    if (!suspicious) {
        const guidePromise = (async () => {
            try {
                const ipHash = await hashString(ip, env);
                await logGuideClick(env.DB, { guideSlug: ref, productQuery: q, network, ipHash });
            } catch (err) {
                console.error('Guide click logging failed:', err);
            }
        })();
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(guidePromise);
        } else {
            await guidePromise;
        }
    }

    return new Response(null, {
        status: 302,
        headers: {
            'Location': redirectUrl,
            'Cache-Control': 'no-cache, no-store',
        },
    });
}

// Salted, truncated one-way hash used for click analytics.
// Uses shared hashIp which fails closed if neither IP_HASH_SALT nor WORKER_SECRET is set.
async function hashString(str, env) {
    const full = await hashIp(str, env);
    return full.slice(0, 16);
}
