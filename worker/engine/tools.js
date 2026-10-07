import { duckduckgoSearch } from '../lib/duckduckgo.js';
import { rssSearch } from '../lib/rss.js';
import { fetchPageContent } from '../lib/jina.js';
import { scoreSource, extractAmazonProductUrls } from '../lib/credibility.js';
import { fetchYoutubeDescription, isYouTube } from '../lib/youtube.js';
import { isFetchableUrl } from '../lib/url-guard.js';

// ─── Provider primitives (Serper + HN Algolia) ───────────────────────────────
// NOTE: Do NOT evaluate `new Date()` at module load. Cloudflare Workers freeze
// the clock at the Unix epoch (1970) during module initialization — real time
// is only available inside a request handler. Always compute year at call time.
const TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Serper.dev Google Search — https://serper.dev
// One provider, two flavors via the /search vs /news endpoint. Recency is
// applied via Google's tbs=qdr:y one-year filter (the analog of Tavily's
// time_range:'y').
// ─────────────────────────────────────────────────────────────────────────────

async function serperSearch(query, apiKey, opts = {}) {
  // No key configured: signal unavailability so the caller can fall back to
  // the fallback chain. This is the key-less environment path: Serper
  // would 403 anyway, so we skip the wasted subrequest. Returning [] here would
  // be indistinguishable from "0 hits" and would strand the agent.
  if (!apiKey) return null;
  try {
    const endpoint = opts.topic === 'news'
      ? 'https://google.serper.dev/news'
      : 'https://google.serper.dev/search';
    const body = {
      q: query,
      num: opts.maxResults ?? 10,
    };
    if (opts.timeRange === 'y') body.tbs = 'qdr:y';

    const response = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[serper] HTTP ${response.status} q="${query}" body=${text.slice(0, 200)}`);
      // Auth/quota failures (401/403/429) mean the provider is unusable for this
      // run: signal unavailability so the caller falls back through the fallback chain. Other
      // non-ok statuses are treated as a genuine empty result.
      if (response.status === 401 || response.status === 403 || response.status === 429) return null;
      return [];
    }
    const data = await response.json();
    const label = opts.sourceLabel ?? (opts.topic === 'news' ? 'news' : 'web');
    // /news returns `news`, /search returns `organic`.
    const items = opts.topic === 'news' ? (data?.news ?? []) : (data?.organic ?? []);
    console.log(`[serper] q="${query}" label=${label} → ${items.length}`);

    return items.map((r) => {
      // Serper emits `date` as a relative or absolute string on news/organic.
      // Normalize to epoch seconds; undefined when unparseable.
      let publishedAt;
      if (r.date) {
        const ms = Date.parse(r.date);
        if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000);
      }
      return {
        url: r.link,
        title: r.title,
        content: [
          r.date ? `[${r.date}]` : '',
          r.snippet ?? '',
        ].filter(Boolean).join('\n'),
        source: label,
        publishedAt,
      };
    });
  } catch (err) {
    console.log(`[serper] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// Brave Search API — the CF-reachable fallback when Serper is exhausted/unavailable.
// (The DuckDuckGo HTML scraper is blocked from Cloudflare edge IPs, so it can't be the
// real fallback.) Same result shape as serperSearch; returns null on auth/quota failure
// so the caller can degrade further (to DDG as a last resort).
async function braveSearch(query, apiKey, opts = {}) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const params = new URLSearchParams({ q: query, count: '10' });
    if (opts.timeRange === 'y') params.set('freshness', 'py'); // past year, matches serper recency
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      signal: controller.signal,
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[brave] HTTP ${response.status} q="${query}" body=${text.slice(0, 150)}`);
      if (response.status === 401 || response.status === 403 || response.status === 429) return null;
      return [];
    }
    const data = await response.json();
    const results = data?.web?.results ?? [];
    const label = opts.sourceLabel ?? 'web';
    console.log(`[brave] q="${query}" → ${results.length}`);
    return results.map((r) => {
      let publishedAt;
      const dt = r.page_age || r.age;
      if (dt) { const ms = Date.parse(dt); if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000); }
      return {
        url: r.url,
        title: r.title,
        content: [r.age ? `[${r.age}]` : '', r.description ?? ''].filter(Boolean).join('\n'),
        source: label,
        publishedAt,
      };
    });
  } catch (err) {
    console.log(`[brave] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tavily Search API — https://tavily.com (POST https://api.tavily.com/search)
// The original bench-engine search provider, re-added as a selectable provider and
// a fallback. Tavily returns LLM-optimized content snippets (cleaner than raw SERP),
// is CF-reachable, and supports a one-year recency window. Same result shape as
// serperSearch/braveSearch; returns null on auth/quota failure (or no key) so the
// caller can degrade further, and [] on other (transient) errors.
// ─────────────────────────────────────────────────────────────────────────────
async function tavilySearch(query, apiKey, opts = {}) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = {
      query,
      search_depth: 'advanced',
      topic: opts.topic === 'news' ? 'news' : 'general',
      max_results: 10,
    };
    if (opts.timeRange === 'y') body.time_range = 'year'; // one-year recency, matches serper/brave
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[tavily] HTTP ${response.status} q="${query}" body=${text.slice(0, 150)}`);
      if (response.status === 401 || response.status === 403 || response.status === 429) return null;
      return [];
    }
    const data = await response.json();
    const results = data?.results ?? [];
    const label = opts.sourceLabel ?? 'web';
    console.log(`[tavily] q="${query}" → ${results.length}`);
    return results.map((r) => {
      let publishedAt;
      if (r.published_date) {
        const ms = Date.parse(r.published_date);
        if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000);
      }
      return {
        url: r.url,
        title: r.title,
        content: r.content ?? '',
        source: label,
        publishedAt,
      };
    });
  } catch (err) {
    console.log(`[tavily] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SearXNG metasearch — self-hosted on blackbox (http://192.168.5.10:8095), tuned
// to a curated engine set (google + startpage + bing + mojeek + brave). Free, no
// quota, no key. Aggregates several indexes per call → high source breadth at $0,
// which the provider benchmark showed matches paid providers on credibility.
// Reads env.SEARXNG_URL. Returns null when the instance is unreachable / not
// configured (e.g. from the CF edge, which can't reach the LAN host) so the
// caller falls through to the next provider; [] on a transient query error.
// ─────────────────────────────────────────────────────────────────────────────
// SearXNG aggregates several engines per call, so it needs more headroom than a
// single-API provider — give it a dedicated ceiling above the shared TIMEOUT_MS.
const SEARXNG_TIMEOUT_MS = 11000;
async function searxngSearch(query, baseUrl, opts = {}) {
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARXNG_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ q: query, format: 'json' });
    if (opts.topic === 'news') params.set('categories', 'news');
    if (opts.timeRange === 'y') params.set('time_range', 'year');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/search?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      console.log(`[searxng] HTTP ${response.status} q="${query}"`);
      return null; // unreachable/blocked → let the caller degrade to another provider
    }
    const data = await response.json();
    const results = data?.results ?? [];
    const label = opts.sourceLabel ?? 'web';
    console.log(`[searxng] q="${query}" → ${results.length}`);
    // SearXNG merges many engines; cap to the top slice so one query can't flood
    // the source pool. Results arrive pre-ranked by SearXNG's score.
    return results.slice(0, 15).map((r) => {
      let publishedAt;
      if (r.publishedDate) {
        const ms = Date.parse(r.publishedDate);
        if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000);
      }
      return {
        url: r.url,
        title: r.title,
        content: r.content ?? '',
        source: label,
        publishedAt,
      };
    });
  } catch (err) {
    console.log(`[searxng] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serper.dev Video Search — https://serper.dev/videos
// Returns YouTube (and other) video results. Used by the `video` provider so
// hands-on review videos enter the source pool; their descriptions are then
// scraped (see youtube.js) to surface affiliate links for credibility scoring.
// Returns null when the provider is unavailable so the caller can fall back.
// ─────────────────────────────────────────────────────────────────────────────

async function serperVideos(query, apiKey) {
  if (!apiKey) return null;
  try {
    const response = await fetch('https://google.serper.dev/videos', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.log(`[serper-videos] HTTP ${response.status} q="${query}" body=${text.slice(0, 200)}`);
      if (response.status === 401 || response.status === 403 || response.status === 429) return null;
      return [];
    }
    const data = await response.json();
    // Serper /videos returns `videos: [{title, link, snippet, date, ...}]`.
    // Guard defensively in case the shape drifts or the key is missing.
    const items = Array.isArray(data?.videos) ? data.videos : [];
    console.log(`[serper-videos] q="${query}" → ${items.length}`);

    return items
      .filter((r) => r && typeof r.link === 'string')
      .map((r) => {
        let publishedAt;
        if (r.date) {
          const ms = Date.parse(r.date);
          if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000);
        }
        return {
          url: r.link,
          title: r.title ?? r.link,
          content: [
            r.date ? `[${r.date}]` : '',
            r.snippet ?? '',
          ].filter(Boolean).join('\n'),
          source: 'video',
          publishedAt,
        };
      });
  } catch (err) {
    console.log(`[serper-videos] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HackerNews via Algolia — free, no auth, works from CF Workers
// ─────────────────────────────────────────────────────────────────────────────

async function hackerNews(query) {
  try {
    const params = new URLSearchParams({
      query,
      tags: 'story',
      hitsPerPage: '10',
      // Stories from the past year (Unix timestamp)
      numericFilters: `created_at_i>${Math.floor(Date.now() / 1000) - 365 * 24 * 3600}`,
    });
    const response = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      console.log(`[hackerNews] HTTP ${response.status} q="${query}"`);
      return [];
    }

    const data = await response.json();
    const hits = data?.hits ?? [];
    console.log(`[hackerNews] q="${query}" → ${hits.length} hits (before filter)`);

    return hits
      .filter((h) => h.title && (h.points ?? 0) >= 10)
      .slice(0, 5)
      .map((h) => {
        let publishedAt;
        if (h.created_at) {
          const ms = Date.parse(h.created_at);
          if (!Number.isNaN(ms)) publishedAt = Math.floor(ms / 1000);
        }
        return {
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          title: h.title || '',
          content: [
            h.created_at ? `[${h.created_at}]` : '',
            `${h.points ?? 0} points, ${h.num_comments ?? 0} comments`,
            (h.story_text ?? '').slice(0, 2000),
            `Discussion: https://news.ycombinator.com/item?id=${h.objectID}`,
          ].filter(Boolean).join('\n'),
          source: 'hackernews',
          publishedAt,
        };
      });
  } catch (err) {
    console.log(`[hackerNews] ERROR q="${query}": ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── Tool definitions (OpenAI-compatible format for OpenRouter) ──────────────

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for product information, reviews, comparisons, and discussions. Call multiple times with different queries and providers for broad coverage.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. Be specific — include product names, model numbers, years.' },
          provider: {
            type: 'string',
            enum: ['web', 'news', 'video', 'hackernews', 'duckduckgo', 'tavily', 'searxng', 'rss'],
            description: 'Search provider. web=general web, news=recent articles, video=YouTube reviews, hackernews=tech discussions, duckduckgo=alternative web results, tavily=LLM-optimized web search (clean snippets), searxng=self-hosted metasearch aggregating google/bing/mojeek (free, broad), rss=expert review sites (Wirecutter/RTINGS/etc).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: 'Read the full content of a web page. Use on the most promising sources — expert reviews, detailed comparisons, hands-on tests. Skip listicles and thin SEO content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to read' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'note',
      description: 'Record a research finding. Use this to build structured knowledge about products as you discover information. The synthesis step will use these notes to write the final report.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['product', 'comparison', 'issue', 'pricing', 'recommendation'],
            description: 'product=specs/features, comparison=vs other products, issue=known problems/complaints, pricing=price/deal info, recommendation=expert picks/verdicts',
          },
          content: { type: 'string', description: 'The finding. Be specific — include model numbers, prices, specs, source attribution.' },
        },
        required: ['category', 'content'],
      },
    },
  },
];

// Builds the tool set exposed to the agent for this research.
export function buildAgentTools() {
  return AGENT_TOOLS;
}

// ─── Direct (no-agent-loop) wrappers for the parallel engine ─────────────────
// These reuse executeTool with a throwaway high-budget state so the parallel
// engine can fire searches/reads concurrently without an LLM in the loop.

// Run one search; returns its scored sources (does not mutate shared state).
export async function runSearch(query, provider, env, recencySensitive) {
  const state = { searchCount: 0, fetchCount: 0, sources: [], notes: [] };
  const tc = { function: { name: 'web_search', arguments: JSON.stringify({ query, provider: provider || 'web' }) } };
  try {
    await executeTool(tc, state, { maxSearches: 99999, maxFetches: 99999 }, { env, recencySensitive });
  } catch (err) {
    // A single bad provider call never aborts the burst, but it is logged:
    // a silent catch here hid a broken web search for weeks.
    console.warn(`[runSearch] ${provider || 'web'} "${query}" failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return state.sources;
}

// Read one page IN PLACE — enriches `source.content` with the full body (and
// re-scores credibility). Safe to call concurrently on distinct source objects.
export async function readPageInto(source, env) {
  const state = { searchCount: 0, fetchCount: 0, sources: [source], notes: [] };
  const tc = { function: { name: 'read_page', arguments: JSON.stringify({ url: source.url }) } };
  try {
    await executeTool(tc, state, { maxSearches: 99999, maxFetches: 99999 }, { env, recencySensitive: true });
  } catch (err) {
    // A read failure leaves the snippet content untouched.
    console.warn(`[readPageInto] ${source.url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return source;
}

// ─── Tool execution ──────────────────────────────────────────────────────────

// ToolContext shape (runtime — types erased):
//   {
//     env: { SERPER_API_KEY, ... },  // worker env; tools read keys + bindings
//     // When true, Serper-backed searches pass {tbs:'qdr:y'} to filter stale
//     // sources. Falls back to the permissive behavior for evergreen subjects
//     // (restaurants, hiking, classical books) where a 3-year-old review is
//     // still relevant.
//     recencySensitive?: boolean,
//   }

/** Returns [resultText, subrequestsUsed] */
export async function executeTool(
  toolCall,
  state,
  config,
  ctx,
) {
  const name = toolCall.function.name;
  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return ['Error: invalid JSON in tool arguments', 0];
  }

  switch (name) {
    case 'web_search':
      return executeSearch(args, state, config, ctx.env, ctx.recencySensitive ?? true);
    case 'read_page':
      return executeReadPage(args, state, config, ctx.env);
    case 'note':
      return [executeNote(args, state), 0];
    default:
      return [`Error: unknown tool "${name}"`, 0];
  }
}

async function executeSearch(
  args,
  state,
  config,
  env,
  recencySensitive,
) {
  if (state.searchCount >= config.maxSearches) {
    return ['Search budget exhausted. Use note() to record findings or stop.', 0];
  }

  const query = typeof args.query === 'string' ? args.query : '';
  const provider = typeof args.provider === 'string' ? args.provider : 'web';

  if (!query) return ['Error: query is required', 0];

  const serperApiKey = env?.SERPER_API_KEY;
  const braveApiKey = env?.BRAVE_API_KEY;
  const tavilyApiKey = env?.TAVILY_API_KEY;
  const searxngUrl = env?.SEARXNG_URL;

  state.searchCount++;
  let results;
  let subs = 0;

  // Apply a 1-year Serper filter when the classifier flagged the query as
  // recency-sensitive (tech, apps, current media). Evergreen subjects
  // (restaurants, hiking, classical works) drop the filter so we don't lose
  // still-valid older coverage. News always filters by year regardless.
  // Every web, searxng, and tavily call reads `tr`. Without this line each of
  // those searches threw a ReferenceError and returned no results.
  const tr = recencySensitive ? 'y' : undefined;
  // serperSearch returns null when the provider is unavailable (no key, or
  // auth/quota rejection). The fallback chain is SearXNG (self-hosted, free, no quota,
  // reachable on the blackbox engine host) -> Brave (CF-reachable) -> Tavily (LLM-tuned,
  // keyed). DuckDuckGo is CAPTCHA-blocked from datacenter IPs and returns empty results,
  // so it is removed from active fallbacks.
  const webFallback = async (q) => {
    const sx = searxngUrl ? await searxngSearch(q, searxngUrl, { timeRange: tr }) : null;
    if (sx !== null) return sx;
    const brave = braveApiKey ? await braveSearch(q, braveApiKey, { timeRange: tr }) : null;
    if (brave !== null) return brave;
    const tavily = tavilyApiKey ? await tavilySearch(q, tavilyApiKey, { timeRange: tr }) : null;
    if (tavily !== null) return tavily;
    return [];
  };
  switch (provider) {
    case 'web': {
      const serp = await serperSearch(query, serperApiKey, { sourceLabel: 'web', timeRange: tr });
      results = serp === null ? await webFallback(query) : serp;
      subs = 1;
      break;
    }
    case 'news': {
      const serp = await serperSearch(query, serperApiKey, { topic: 'news', timeRange: 'y', sourceLabel: 'news' });
      results = serp === null ? await webFallback(query) : serp;
      subs = 1;
      break;
    }
    case 'video': {
      // Serper /videos surfaces YouTube review videos. If unavailable, fall back to a
      // youtube-scoped web search (SearXNG/Brave/Tavily) so the agent still gets video-adjacent results.
      const vids = await serperVideos(query, serperApiKey);
      results = vids === null ? await webFallback(`${query} review youtube`) : vids;
      subs = 1;
      break;
    }
    case 'hackernews':
      results = await hackerNews(query);
      subs = 1;
      break;
    case 'duckduckgo':
      results = await duckduckgoSearch(query);
      subs = 1;
      break;
    case 'tavily': {
      // Tavily as an explicitly-selectable provider (LLM-optimized snippets). Falls back
      // through the standard web chain (SearXNG / Brave) when Tavily is unavailable.
      const tav = tavilyApiKey ? await tavilySearch(query, tavilyApiKey, { timeRange: tr }) : null;
      results = tav === null ? await webFallback(query) : tav;
      subs = 1;
      break;
    }
    case 'searxng': {
      // Self-hosted metasearch (free, broad). Falls back through the web chain
      // (Brave / Tavily) when the SearXNG instance is unreachable.
      const sx = searxngUrl ? await searxngSearch(query, searxngUrl, { sourceLabel: 'web', timeRange: tr }) : null;
      if (sx !== null) { results = sx; subs = 1; break; }
      const serp = await serperSearch(query, serperApiKey, { sourceLabel: 'web', timeRange: tr });
      results = serp === null ? await webFallback(query) : serp;
      subs = 1;
      break;
    }
    case 'rss':
      results = await rssSearch(query);
      subs = 6; // up to 6 RSS feeds fetched in parallel
      break;
    default: {
      const serp = await serperSearch(query, serperApiKey, { sourceLabel: 'web', timeRange: tr });
      results = serp === null ? await webFallback(query) : serp;
      subs = 1;
      break;
    }
  }

  // Deduplicate against existing sources
  const seenUrls = new Set(state.sources.map((s) => s.url));
  const newResults = results.filter((r) => !seenUrls.has(r.url));

  // Video provider: fetch YouTube descriptions in parallel. Descriptions carry
  // the affiliate-link evidence ("Buy here: amzn.to/...") that title+snippet
  // never expose. Each fetch is 1 extra subrequest; capped by newResults.length.
  let videoSubs = 0;
  if (provider === 'video' && newResults.length > 0) {
    const descriptions = await Promise.all(
      newResults.map((r) => (isYouTube(r.url) ? fetchYoutubeDescription(r.url) : Promise.resolve(''))),
    );
    for (let i = 0; i < newResults.length; i++) {
      const desc = descriptions[i];
      if (desc) {
        // Append to content so downstream synthesis + credibility scan see it.
        newResults[i].content = `${newResults[i].content}\n\n[description]\n${desc}`;
        videoSubs++;
      }
    }
  }

  // Score every new source before it enters state — tags/score persist with
  // the source through synthesis and into D1 storage.
  for (const r of newResults) {
    r.credibility = scoreSource({
      url: r.url,
      title: r.title,
      content: r.content,
      sourceType: r.source,
    });
    // Extract Amazon /dp/ASIN URLs embedded in this source's content. These
    // are the gold-standard affiliate targets — real SKUs dropped by review
    // authors. We surface the aggregate set to synth so it can attach real
    // URLs to ranked products instead of emitting empty productUrl.
    const amzUrls = extractAmazonProductUrls(r.content);
    if (amzUrls.length > 0) r.amazonUrls = amzUrls;
  }

  state.sources.push(...newResults);

  if (newResults.length === 0) {
    return [`Search "${query}" (${provider}): 0 new results (${results.length} duplicates filtered). Try a different query or provider.`, subs + videoSubs];
  }

  // Format results for the LLM — include credibility badge so the agent can
  // choose which pages are worth a read_page budget slot.
  const formatted = newResults
    .map((r, i) => {
      const badge = r.credibility ? ` ${r.credibility.tags.map((t) => `[${t}]`).join('')}` : '';
      return `${i + 1}. [${r.source}]${badge} ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 150)}`;
    })
    .join('\n\n');

  return [`Search "${query}" (${provider}): ${newResults.length} new results (${state.sources.length} total):\n\n${formatted}`, subs + videoSubs];
}

async function executeReadPage(
  args,
  state,
  config,
  env,
) {
  if (state.fetchCount >= config.maxFetches) {
    return ['Page-read budget exhausted. Use note() to record findings from snippets or stop.', 0];
  }

  const url = typeof args.url === 'string' ? args.url : '';
  if (!url || !isFetchableUrl(url)) return ['Error: valid public HTTPS URL is required', 0];

  state.fetchCount++;
  const content = await fetchPageContent(url, env?.JINA_API_KEY);

  if (!content) {
    return [`Could not read ${url} — page may be paywalled, JS-only, or blocked. Use the snippet instead.`, 1];
  }

  // Update the source entry if we have it, so synthesis gets the full text.
  // Re-score credibility now that we have the full page body — affiliate
  // links, hands-on testing language, and listicle structure are usually
  // only detectable from the full text, not the search snippet.
  const amzUrls = extractAmazonProductUrls(content);
  const existing = state.sources.find((s) => s.url === url);
  if (existing) {
    existing.content = content;
    existing.credibility = scoreSource({
      url: existing.url,
      title: existing.title,
      content,
      sourceType: existing.source,
    });
    if (amzUrls.length > 0) existing.amazonUrls = amzUrls;
  } else {
    const fresh = { url, title: url, content, source: 'fetched' };
    fresh.credibility = scoreSource({ url, title: url, content, sourceType: 'fetched' });
    if (amzUrls.length > 0) fresh.amazonUrls = amzUrls;
    state.sources.push(fresh);
  }

  // Return truncated for conversation context (full text is stored in sources for synthesis)
  const preview = content.length > 1500 ? content.slice(0, 1500) + '\n\n[...truncated, full text stored for synthesis]' : content;
  return [`Page content from ${url} (${content.length} chars):\n\n${preview}`, 1];
}

function executeNote(
  args,
  state,
) {
  const category = typeof args.category === 'string' ? args.category : 'product';
  const content = typeof args.content === 'string' ? args.content : '';

  if (!content) return 'Error: content is required';

  state.notes.push({ category, content });
  return `Noted (${category}): ${content.slice(0, 100)}${content.length > 100 ? '...' : ''} [${state.notes.length} total notes]`;
}
