# Spec: SearXNG as frank's primary web search

## Requirements
1. SearXNG answers frank's queries with on-topic results: review sites, Reddit and forum threads, spec pages.
2. Frank cleans SearXNG answers: one entry per page (URL variants merged), junk domains removed, off-topic results removed, good sources ranked first.
3. A weak SearXNG answer (fewer than 3 usable results, or an error) falls through to the existing chain (Brave, Exa, Tavily).
4. A benchmark measures SearXNG against the Serper-era baseline and live Exa: good-source recall, Reddit presence, junk rate, freshness, latency, failure rate.
5. Cut over only when the benchmark passes the gate in plan.md.

## Architecture
- Blackbox SearXNG (`stacks/searxng/settings.yml` in the blackbox repo): the engine set that answers from the home IP (measured 2026-10-14): duckduckgo web, gmx, yahoo, yandex, swisscows, neosearch, zapmeta, s1search, yep, keenable. Google, Brave (scraper), DuckDuckGo (html), Qwant, Startpage and Mojeek are blocked or behind a captcha. The hostnames plugin removes content farms.
- Frank: `worker/engine/searxng.js` owns the SearXNG client, URL normalization, filter and rerank. `worker/engine/tools.js` calls it first in the web chain when `SEARXNG_URL` is set.
- Frank does not send `time_range`: SearXNG skips engines without time-range support, which left only Bing in the 2026-10-08 trial. Recency is a rerank boost.

## Out of scope
- The Amazon ASIN and product-image resolvers still need Serper (filed in issues.md).
