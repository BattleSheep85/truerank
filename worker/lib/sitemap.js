import { displayQuery, escapeXml, publicResearchFilter, isNotModified } from './utils.js';
import { listableRowsSql, FEED_ORDER } from './listable.js';
import { listCategories, MIN_HUB_GUIDES } from '../pages/category.js';
import { STATIC_GUIDES, STATIC_GUIDE_SLUGS } from './guides.js';
// STATIC_GUIDES / STATIC_GUIDE_SLUGS are the single source of truth for the
// four static /best/ guide pages: we emit one <url> per guide below and skip
// any dynamic category hub whose slug collides with one (dedupe by slug, since
// Google treats the trailing-slash guide URL and the bare hub as one path).

// inlined from src/lib/static-assets.ts for phase 1
const OG_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<rect width="1200" height="630" fill="#020617"/>
<rect x="40" y="40" width="1120" height="550" rx="24" fill="#0f172a" stroke="#1e293b" stroke-width="2"/>
<rect x="80" y="100" width="80" height="80" rx="16" fill="#2563eb"/>
<text x="120" y="158" font-family="system-ui,sans-serif" font-size="36" font-weight="800" fill="#fff" text-anchor="middle">CL</text>
<text x="180" y="155" font-family="system-ui,sans-serif" font-size="42" font-weight="700" fill="#f1f5f9">Chrisputer Labs</text>
<text x="80" y="280" font-family="system-ui,sans-serif" font-size="52" font-weight="800" fill="#f1f5f9">AI-Powered Product Research</text>
<text x="80" y="350" font-family="system-ui,sans-serif" font-size="28" fill="#94a3b8">Every source, every angle, every detail.</text>
<text x="80" y="400" font-family="system-ui,sans-serif" font-size="28" fill="#94a3b8">No fluff. No sponsored picks. Just the truth.</text>
<rect x="80" y="460" width="200" height="56" rx="12" fill="#2563eb"/>
<text x="180" y="496" font-family="system-ui,sans-serif" font-size="22" font-weight="600" fill="#fff" text-anchor="middle">Try it free</text>
</svg>`;

// Newest completed or retired research timestamp — shared lastmod signal for home, browse,
// sitemap, and feed. The SELECT MAX + EXISTS subquery cost scales with the
// research table; KV-cache for 60s so cold home/browse requests don't re-run
// the query on every cache-miss burst.
const LASTMOD_CACHE_TTL = 60;
export async function getLatestResearchLastmod(env, cacheVersion) {
  const key = `lastmod:${cacheVersion}`;
  const cached = await env.KV.get(key);
  if (cached) {
    const n = parseInt(cached, 10);
    if (n > 0) return n;
  }
  // Retiring a row removes its URL from the listings, so the newest retired_at
  // counts too: otherwise conditional GETs keep answering 304 with the old list.
  const row = await env.DB.prepare(
    `SELECT MAX(
       COALESCE((SELECT MAX(COALESCE(research.completed_at, research.created_at))
                 FROM research WHERE ${publicResearchFilter('research')}), 0),
       COALESCE((SELECT MAX(retired_at) FROM research WHERE retired_at IS NOT NULL), 0)
     ) AS lm`
  ).first();
  const lm = row?.lm && row.lm > 0 ? row.lm : undefined;
  if (lm) await env.KV.put(key, String(lm), { expirationTtl: LASTMOD_CACHE_TTL });
  return lm;
}

// Cache-version namespace for the rendered XML blobs (sitemap + feed) and their
// lastmod lookups. This versions INDEPENDENTLY from index.js's page CACHE_VERSION:
// they key separate KV namespaces (`xml:` vs `page:`) with different bump cadences
// (XML structure changes rarely; page templates often). Bump this when the XML
// output shape changes; it does NOT need to track the page cache version.
const XML_CACHE_VERSION = 'tr1';
const XML_CACHE_TTL = 3600;

function notModifiedResponse(lastmodSec) {
  return new Response(null, {
    status: 304,
    headers: {
      'Last-Modified': new Date(lastmodSec * 1000).toUTCString(),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function xmlResponse(xml, contentType, lastmodSec) {
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' };
  if (lastmodSec) headers['Last-Modified'] = new Date(lastmodSec * 1000).toUTCString();
  return new Response(xml, { headers });
}

export async function generateSitemap(origin, env, ifModifiedSince, guidesLastmod) {
  // Conditional requests resolve from the KV-cached lastmod (60s TTL) — no
  // need to run the windowed query just to answer a 304.
  const latestLastmod = await getLatestResearchLastmod(env, XML_CACHE_VERSION);
  if (isNotModified(ifModifiedSince, latestLastmod)) {
    return notModifiedResponse(latestLastmod);
  }

  // Rendered XML is KV-cached with the lastmod signals baked into the key, so
  // a new research completion (or guide edit) naturally produces a fresh key.
  const cacheKey = `xml:${XML_CACHE_VERSION}:sitemap:${latestLastmod || 0}:${guidesLastmod}`;
  const cachedXml = await env.KV.get(cacheKey);
  if (cachedXml) {
    return xmlResponse(cachedXml, 'application/xml', latestLastmod);
  }

  // Only expose research pages with actual product cards. Honest-no-data results
  // (garbage queries, insufficient source data) are thin content and will hurt
  // ranking if Google crawls them.
  const rows = await env.DB.prepare(
    listableRowsSql({
      columns: 'r.id, r.slug, r.created_at, COALESCE(r.completed_at, r.created_at) AS lastmod',
      select: 'slug, created_at, lastmod',
      tail: 'LIMIT 5000',
    })
  ).all();

  const results = rows.results ?? [];
  const newestLastmod = latestLastmod || results[0]?.lastmod || 0;

  const entries = results.map((r) => {
    const date = new Date(r.lastmod * 1000).toISOString().split('T')[0];
    return `<url><loc>${origin}/research/${r.slug}</loc><lastmod>${date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
  }).join('\n');

  // Dynamic /best/:categorySlug hub URLs, deduped against the static guides.
  // Failure here must never break the sitemap, so degrade to no hub entries.
  const categories = await listCategories(env).catch(() => []);
  const hubLastmod = newestLastmod ? new Date(newestLastmod * 1000).toISOString().split('T')[0] : null;
  const hubEntries = categories
    .filter((c) => c.slug && !STATIC_GUIDE_SLUGS.has(c.slug) && (c.count ?? 0) >= MIN_HUB_GUIDES)
    .map((c) => {
      const lm = hubLastmod ? `<lastmod>${hubLastmod}</lastmod>` : '';
      return `<url><loc>${origin}/best/${c.slug}</loc>${lm}<changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    }).join('\n');

  // Home and /research are dynamic indexes — their lastmod is the newest
  // research completion. Signals freshness to crawlers for recrawl scheduling.
  const dynamicLastmod = newestLastmod ? `<lastmod>${new Date(newestLastmod * 1000).toISOString().split('T')[0]}</lastmod>` : '';

  // Static /best/ guide URLs, generated from the shared manifest so adding a
  // guide in lib/guides.js automatically lists it here (and in the dedupe set).
  const guideEntries = STATIC_GUIDES
    .map((g) => `<url><loc>${origin}/best/${g.slug}/</loc><lastmod>${guidesLastmod}</lastmod><changefreq>${g.changefreq}</changefreq><priority>${g.priority}</priority></url>`)
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>${origin}/</loc>${dynamicLastmod}<changefreq>daily</changefreq><priority>1.0</priority></url>
<url><loc>${origin}/research</loc>${dynamicLastmod}<changefreq>daily</changefreq><priority>0.8</priority></url>
<url><loc>${origin}/reviews</loc>${dynamicLastmod}<changefreq>daily</changefreq><priority>0.8</priority></url>
<url><loc>${origin}/about</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
<url><loc>${origin}/contact</loc><changefreq>yearly</changefreq><priority>0.3</priority></url>
<url><loc>${origin}/privacy</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
<url><loc>${origin}/terms</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>
<url><loc>${origin}/best/</loc><lastmod>${guidesLastmod}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
${guideEntries}
${hubEntries}
${entries}
</urlset>`;

  // Cache the rendered XML under the lastmod-keyed key so the next request
  // short-circuits the windowed query; a new completion changes the key.
  await env.KV.put(cacheKey, xml, { expirationTtl: XML_CACHE_TTL });
  return xmlResponse(xml, 'application/xml', newestLastmod > 0 ? newestLastmod : null);
}

export async function generateAtomFeed(origin, env, ifModifiedSince) {
  // Conditional requests resolve from the KV-cached lastmod (60s TTL) — answer
  // a 304 before running the windowed query.
  const latestLastmod = await getLatestResearchLastmod(env, XML_CACHE_VERSION);
  if (isNotModified(ifModifiedSince, latestLastmod)) {
    return notModifiedResponse(latestLastmod);
  }

  // Rendered XML is KV-cached with the lastmod baked into the key, so a new
  // research completion naturally produces a fresh key.
  const cacheKey = `xml:${XML_CACHE_VERSION}:feed:${latestLastmod || 0}`;
  const cachedXml = await env.KV.get(cacheKey);
  if (cachedXml) {
    return xmlResponse(cachedXml, 'application/atom+xml;charset=utf-8', latestLastmod);
  }

  const rows = await env.DB.prepare(
    listableRowsSql({
      columns: 'r.id, r.slug, r.query, r.summary, r.category, r.created_at, COALESCE(r.completed_at, r.created_at) AS updated',
      select: 'slug, query, summary, category, created_at, updated',
      orderBy: FEED_ORDER,
      tail: 'LIMIT 50',
    })
  ).all();

  const results = rows.results ?? [];
  const latestUpdated = latestLastmod || results[0]?.updated || Math.floor(Date.now() / 1000);
  const feedUpdated = new Date(latestUpdated * 1000).toISOString();

  const entries = results.map((r) => {
    const published = new Date(r.created_at * 1000).toISOString();
    const updated = new Date(r.updated * 1000).toISOString();
    const link = `${origin}/research/${r.slug}`;
    const summary = r.summary ? escapeXml(r.summary.slice(0, 500)) : '';
    const category = r.category ? `\n<category term="${escapeXml(r.category)}"/>` : '';
    return `<entry>
<id>${link}</id>
<title>${escapeXml(displayQuery(r.query))}</title>
<link href="${link}"/>
<published>${published}</published>
<updated>${updated}</updated>
<author><name>Chrisputer Labs</name><uri>${origin}/</uri></author>${category}
<summary>${summary}</summary>
</entry>`;
  }).join('\n');

  const currentYear = new Date(latestUpdated * 1000).getUTCFullYear();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Frank: Research Feed</title>
<link href="${origin}/feed.xml" rel="self"/>
<link href="${origin}/"/>
<id>${origin}/</id>
<updated>${feedUpdated}</updated>
<author><name>Chrisputer Labs</name><uri>${origin}/</uri></author>
<subtitle>Frank's latest product research</subtitle>
<icon>${origin}/favicon.svg</icon>
<logo>${origin}/og.png</logo>
<rights>© ${currentYear} Chrisputer Labs. All rights reserved.</rights>
<generator uri="${origin}/">Chrisputer Labs</generator>
${entries}
</feed>`;

  // Cache the rendered XML under the lastmod-keyed key; a new completion
  // changes the key and produces fresh XML.
  await env.KV.put(cacheKey, xml, { expirationTtl: XML_CACHE_TTL });
  return xmlResponse(xml, 'application/atom+xml;charset=utf-8', latestUpdated);
}

// Per-research OG SVG generator. Reuses the default OG image when slug has no
// matching row, so social scrapers following stale links still get a valid image.
export async function generateOgImage(slug, env) {
  const row = await env.DB.prepare(
    `SELECT r.query, r.category, r.summary,
       (SELECT COUNT(*) FROM products WHERE products.research_id = r.id) AS product_count
     FROM research r WHERE r.slug = ?`
  ).bind(slug).first();

  if (!row) {
    return new Response(OG_IMAGE_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
  }

  const pretty = displayQuery(row.query);
  const title = escapeXml(pretty.length > 60 ? pretty.slice(0, 57) + '...' : pretty);
  const category = row.category ? escapeXml(row.category) : '';
  const subtitle = row.product_count > 0
    ? `${row.product_count} products compared`
    : 'AI-powered analysis';
  const summaryText = row.summary
    ? escapeXml(row.summary.length > 120 ? row.summary.slice(0, 117) + '...' : row.summary)
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<rect width="1200" height="630" fill="#020617"/>
<rect x="40" y="40" width="1120" height="550" rx="24" fill="#0f172a" stroke="#1e293b" stroke-width="2"/>
<rect x="80" y="80" width="64" height="64" rx="14" fill="#2563eb"/>
<text x="112" y="124" font-family="system-ui,sans-serif" font-size="28" font-weight="800" fill="#fff" text-anchor="middle">CL</text>
<text x="160" y="120" font-family="system-ui,sans-serif" font-size="28" font-weight="700" fill="#f1f5f9">Chrisputer Labs</text>
${category ? `<rect x="80" y="180" width="${category.length * 11 + 24}" height="32" rx="16" fill="rgba(37,99,235,0.15)"/>
<text x="92" y="201" font-family="system-ui,sans-serif" font-size="16" font-weight="500" fill="#60a5fa">${category}</text>` : ''}
<text x="80" y="${category ? '260' : '220'}" font-family="system-ui,sans-serif" font-size="42" font-weight="800" fill="#f1f5f9">${title}</text>
${summaryText ? `<text x="80" y="${category ? '310' : '270'}" font-family="system-ui,sans-serif" font-size="22" fill="#94a3b8">${summaryText}</text>` : ''}
<rect x="80" y="460" width="240" height="52" rx="12" fill="#2563eb"/>
<text x="200" y="493" font-family="system-ui,sans-serif" font-size="20" font-weight="600" fill="#fff" text-anchor="middle">${escapeXml(subtitle)}</text>
<text x="1080" y="560" font-family="system-ui,sans-serif" font-size="16" fill="#64748b" text-anchor="end">chrisputer.tech</text>
</svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
