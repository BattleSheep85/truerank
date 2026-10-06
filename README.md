# Frank

Honest product research. We search real reviews across the web (expert review sites, forums, and communities), filter out fakes and affiliate bait, and give you a sourced comparison report.

> **Current stack of record:** `CLAUDE.md` is the authoritative, always-current description of the models, search providers, and architecture. This README is a high-level overview; if the two disagree, `CLAUDE.md` wins.

> **Name:** the product was renamed from TrueRank to Frank. Infrastructure identifiers keep the old name on purpose (Worker `truerank`, D1 `truerank-db`, queues, the `truerank-research-worker` container, `TRUERANK_*` secret keys in BWS, browser storage keys), because renaming them needs a coordinated redeploy and data migration.

## What it does

1. You type a product query (e.g. "best NAS for home media server")
2. A research engine runs ~50 web/news searches (Serper + SearXNG + HN Algolia + RSS feeds) and reads the strongest sources
3. Sources are scored for credibility (hands-on vs listicle vs affiliate-conflict) and an honest synthesis ranks the products with sourced pros/cons
4. You get a ranked comparison with trust signals, pros/cons traceable to sources, and links to buy

## Stack

| Component | Technology | Cost |
|-----------|-----------|------|
| Frontend | Static HTML + JS + prebuilt Tailwind CSS | Free |
| API | Cloudflare Workers (plain JS) | $5/mo |
| Database | Cloudflare D1 (SQLite) | Free tier |
| Cache | Cloudflare KV | Free tier |
| Background jobs | Cloudflare Queues (+ off-CF research worker) | Free tier |
| AI - classifier | `google/gemini-2.5-flash-lite` via OpenRouter | paid |
| AI - planner/agent | `google/gemini-2.5-flash` via OpenRouter | paid |
| AI - synthesis | `minimax/minimax-m3` via OpenRouter | paid |
| AI - extract (claims) | `anthropic/claude-haiku-4.5` via OpenRouter | paid |
| AI - stance judge | `minimax/minimax-m3` via OpenRouter | paid |
| Search | Serper.dev (primary) + SearXNG + Brave/Tavily (fallback) + HN Algolia + RSS | mostly free |

AI cost is governed by `MONTHLY_BUDGET_USD` (default $60): each run increments a KV cost counter and `/api/research` returns 503 once the month's spend hits the cap.

Zero **runtime** package managers. The deployed Worker is plain JS with zero runtime dependencies — everything shipped is vendored or CDN-loaded. (A dev-only Miniflare/vitest test harness lives in `devDependencies` and is never bundled — see `CLAUDE.md`.)

## Setup

### Prerequisites

- Cloudflare account (paid Workers plan, $5/mo)
- OpenRouter account (free, no credit card)
- Serper.dev account (optional, 2500 free searches)
- Amazon Associates account (for affiliate links)

### Deploy

```bash
# 1. Create Cloudflare resources
npx wrangler d1 create truerank-db
npx wrangler kv namespace create KV
npx wrangler queues create truerank-research
npx wrangler queues create truerank-dlq

# 2. Update wrangler.toml with the IDs from step 1

# 3. Run database migrations — apply ALL of them, in order. The live app uses
#    the v2 `research`/`products` tables from 003 onward; 001 is legacy and
#    applying only 001/002 leaves the app pointed at tables that don't exist.
for f in schema/00*_*.sql; do npx wrangler d1 execute truerank-db --file="$f"; done

# 4. Set secrets (see CLAUDE.md "Secrets" for the full, current list)
npx wrangler secret put OPENROUTER_API_KEY    # required — classifier/planner/synth
npx wrangler secret put SERPER_API_KEY        # primary web/news search
npx wrangler secret put WORKER_SECRET         # gates /api/internal/* + salts IP hashes
# Optional search fallbacks / tuning:
npx wrangler secret put BRAVE_API_KEY         # optional search fallback
npx wrangler secret put TAVILY_API_KEY        # optional search fallback
npx wrangler secret put JINA_API_KEY          # optional — lifts read_page rate cap
#   SEARXNG_URL, MONTHLY_BUDGET_USD, EXTERNAL_WORKER_ENABLED, FLYWHEEL_DAILY_MAX,
#   AMAZON_AFFILIATE_TAG and the Impact/BHphoto affiliate IDs are [vars]/secrets
#   documented in CLAUDE.md and wrangler.toml.

# 5. Build the production CSS (standalone Tailwind binary, no package manager)
curl -fsSL -o /tmp/tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/download/v3.4.17/tailwindcss-linux-x64
chmod +x /tmp/tailwindcss
/tmp/tailwindcss -c tailwind.config.cjs -i build/input.css -o public/css/tailwind.css --minify

# 6. Deploy
#    Production: push to main (GitHub Actions — see .github/workflows/deploy.yml).
#    Manual:
npx wrangler deploy
```

### Build CSS

Tailwind is compiled ahead of time into `public/css/tailwind.css` with the
standalone Tailwind CLI binary (a single download, not an npm dependency), so
there is no runtime CDN. Rebuild it whenever classes or `tailwind.config.cjs`
change, using the command in step 5 above. The CSS variable palette lives in
`public/css/app.css`; `tailwind.config.cjs` aliases the tokens via `color-mix`.

### Security headers and CSP

The Worker (`worker/index.js`, with `run_worker_first = true`) serves all HTML
and injects a fresh per-request nonce into every `<script>`, then sets a
matching `script-src 'nonce-...' 'strict-dynamic'` Content-Security-Policy plus
X-Content-Type-Options, Referrer-Policy, X-Frame-Options, and Permissions-Policy.
The CSP allowlists Google AdSense, Google Fonts, and Cloudflare (Insights +
managed challenge). Cloudflare Web Analytics and any bot challenge are zone-level
features configured in the Cloudflare dashboard, not in this code.

### Monetization

Google AdSense auto-ads load via the publisher loader in each page head
(`ca-pub-6952672558994325`). Affiliate links route through `/api/go/...`.

The Open Graph share image `public/og.png` was generated by screenshotting an
HTML card with headless chromium and can be regenerated the same way.

### Local development

```bash
npx wrangler dev
```

## Architecture

```
public/              Static frontend (served by Cloudflare Pages/Assets)
  index.html         Homepage with search
  report.html        Permalink report viewer
  best/              Evergreen affiliate buying guides (SEO)
    index.html       Guides hub
    <slug>/index.html  One guide per topic
  js/render.js       Shared report rendering (one source of truth)
  js/app.js          Theme, search, SSE, ?q deep-link prefill
  js/report.js       Permalink report loader
  css/tailwind.css   Prebuilt Tailwind utilities (see tailwind.config.cjs)
  css/app.css        Design tokens (CSS variables) + base styles
  og.png             Open Graph share image (1200x630)
  robots.txt         Crawl rules
  sitemap.xml        Sitemap
  _headers           Security headers (CSP, etc.)

tailwind.config.cjs  Tailwind build config (standalone CLI)
build/input.css      Tailwind entrypoint for the build

worker/              Cloudflare Worker (API + Queue consumer)
  index.js           Router + queue handler
  handlers/          HTTP route handlers
  pipeline/          Research pipeline (search → analyze → synthesize → enrich)
  lib/               Shared utilities (LLM client, search, DB, rate limiting)

schema/              D1 database migrations
```

## Research pipeline

```
User query
  → Classifier: facets, rejection, clarifying questions, Amazon-viability
  → Opening book: runs fixed template searches ("best <subject>", "<subject> review",
    "best <subject> reddit", "<subject> site:reddit.com") based on topical category
    or raw query to seed an overlapping corpus for run-to-run stability
  → Agent loop: planner fans out searches (Serper/HN/DDG/RSS/video),
    reads pages, takes notes
  → Reserve search recall: reserves 8 of 50 searches after the planner loop
    to query for missing category leaders unevidenced in gathered sources
  → Deterministic credibility scoring on every source (twice: URL+title at
    snippet time, full text after fetch): +25 hands-on / +15 expert-domain /
    +5 community / -15 manufacturer / -30 listicle / -45 affiliate-conflict.
    Discounts, not exclusions: conflicted sources need corroboration and
    the conflict is disclosed in the verdict. Marketplace star reviews are
    never ingested at all.
    (NOTE: this is source-GENRE credibility, not per-review fake detection:
    see PRD §3b. No surface should claim "fake review detection".)
  → Synthesis: deterministic extraction synthesis (SYNTH_ENGINE=extract,
    worker/engine/extract/) builds every field from a real source span with gated,
    timeout-bounded LLM helpers (name cleanup, con selector, recall supplement).
    Generative fallback path uses minimax/minimax-m3 via OpenRouter.
  → ASIN resolver attaches exact Amazon /dp/ links; affiliate tagging
  → Permanent SSR page at /research/:slug with sources + JSON-LD
```

### Query clustering and cache

To avoid redundant runs, `worker/lib/utils.js` canonicalizes incoming queries before running research:
- `canonicalizeQuery`: strips stopwords and filler (prices, years), singularizes each token with a small hand-rolled rule set (`singularizeToken`: "ies" to "y", strips "es" after ses/xes/zes/ches/shes, strips a plain trailing "s", with a no-touch list for non-plurals: series, lens, glass, chess, gps, nas, ups, class, plus), then sorts and de-duplicates the tokens.
- `squashQuery`: runs the same token pipeline but preserves original token order and joins with no separator (for example, "light bulb" becomes "lightbulb").

Each research row stores both forms (`research.canonical_query` and `research.squashed_query`, added and backfilled by `schema/014_squashed_query.sql`).
`findResearchByCanonicalQuery` matches on either form within a 14-day window. Queries like "lightbulb", "lightbulbs", and "light bulb" hit the same cached research instead of starting separate runs.

## Buying guides (SEO + affiliate)

Evergreen guides live under `public/best/` as static, cacheable pages (served
directly by the catch-all asset route, no extra routing needed). They are the
SEO and direct-conversion surface that complements the live research tool.

Guide "Check price" links route through `GET /api/go/search?q=<query>&ref=<slug>`,
which appends the `AMAZON_ASSOCIATE_TAG` server-side (so the tag never lives in
static files), records a best-effort click in `guide_clicks`, and 302-redirects
to an Amazon search. The handler only ever builds `amazon.com` URLs, so there is
no open-redirect surface.

> Note: canonical URLs, Open Graph tags, and `sitemap.xml` use
> `https://truerank.io`. Update that domain if you deploy elsewhere.

## Configuration

Secrets (set via `wrangler secret put`):
- `OPENROUTER_API_KEY`: paid OpenRouter key (classifier, planner, synthesis, extract, stance)
- `SERPER_API_KEY`: primary web and news search (optional, 2500 free Google searches)
- `WORKER_SECRET`: authentication secret for internal endpoints (`/api/internal/*`) and authorized internal requests
- `AMAZON_ASSOCIATE_TAG`: your Amazon Associates tracking tag

Environment variables (in `wrangler.toml`):
- `RATE_LIMIT_MAX`: max research jobs per IP per window (default: 5)
- `RATE_LIMIT_WINDOW_SECONDS`: rate limit window (default: 3600)
- `CACHE_TTL_SECONDS`: how long to cache reports (default: 86400)

### Internal requests and forceFresh

`POST /api/research` supports an internal `forceFresh: true` parameter that bypasses the 14-day canonical query cache and starts a genuinely new research run. This flag is honored only when the request carries an `X-Worker-Secret` header matching `WORKER_SECRET` (the same authentication as `/api/internal/*`). Any `forceFresh` parameter sent by a public caller is ignored. It exists for an external benchmark harness that measures run-to-run stability. The public `fresh` flag (for user re-runs) remains separate.

## License

MIT
