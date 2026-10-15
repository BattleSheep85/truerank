# Frank: Honest Product Research Tool

## Overview
Product research web app that scrapes real reviews, filters out fakes/affiliate garbage,
and produces honest comparison reports. Monetized via affiliate links (Amazon Associates, etc.).

## Stack (ZERO package managers)
- **Frontend**: Static HTML/CSS/JS, Tailwind via CDN (no runtime JS dependencies)
- **API**: Cloudflare Workers (plain JS, no npm)
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Background jobs**: Cloudflare Queues (consumer + cron `scheduled` reaper)
- **AI** (bench-picked 2026-10-08; `worker/lib/engine-config.js`; calls go through LiteLLM when `LLM_PROVIDER=litellm`, with OpenRouter fallback, see `docs/litellm-2026-10.md`):
  - **Classifier, recall, cleanup, con-selector**: `google/gemini-3.8-flash` (Gemini 2.5 ids are retired)
  - **Research planner**: `mistralai/mistral-medium-3.1` (planner bench: quality 5.17 vs 5.00, $0.064 vs $0.142 per report vs gemini-3.8-flash; history kept append-only so the provider can cache it)
  - **Synthesis**: `xiaomi/mimo-v2.6-flash` (synth-gold rerun: composite 7.63 vs 4.71 for minimax-m3, 0 fabricated numbers)
  - **Extract (verify claims)**: `xiaomi/mimo-v2.6-flash` (extract bench: 46 good claims vs 45 for claude-haiku-4.5, about 10x cheaper)
  - **Stance (verify judge)**: `xiaomi/mimo-v2.6-flash`, with `minimax/minimax-m3` as second opinion for claims mimo leaves unsubstantiated (216 graded claims, two graders: 77 vs 69 correct for minimax alone). Claims are judged 12 at a time.
  - Bench tools: `benchmarks/judge-bench.mjs`, `judge-grade.mjs`, `judge-cascade-score.mjs`, `extract-bench.mjs`, `bench-planner-cost.mjs`, `synth-gold-*.mjs`.
  - **One engine config for every run (2026-06-16):** one model set and about 50 searches of deep research for every run. `worker/lib/engine-config.js` exports a single `ENGINE_CONFIG`. There is no tier selector. Rationale and data: `benchmarks/engine-llm-bench-2026-06.md`.
- **Search**: self-hosted SearXNG (primary since 2026-10-15, CP-593; Blackbox stack `searxng`, public at `https://litellm.wafflemedia.net/search` behind the X-Edge-Gate header). The instance loads ten free engines that answer from the home IP (duckduckgo web, gmx, yahoo, yandex, swisscows, neosearch, zapmeta, s1search, yep, keenable; settings in the blackbox repo `stacks/searxng/settings.yml`). `worker/engine/searxng.js` normalizes and merges URLs, drops blocked and off-topic results, reranks (expert, community, fresh, multi-engine first), never sends `time_range` (SearXNG skips engines without date filters), and returns null on an error or fewer than 3 usable results, so the next provider with a key answers (in production: Exa). Benchmark `benchmarks/bench-searxng.mjs` (2026-10-14, 96 queries): SearXNG 7.1 good sources per query, 65% recall of the Serper-era corpus, 55 evidence domains over 16 queries, Reddit in the top 10 for 100% of Reddit queries, 0% failures, p95 1.3 s on the LAN; Exa 2.5, 43%, 29, 0%, 0%; recorded Brave 40 evidence domains. Plan and gate: `docs/searxng-2026-10/plan.md`. Production chain since 2026-10-15 (CP-652, PM decision, do not top up Brave): SearXNG, then Exa (`exaSearch`, type `instant`, $4 per 1,000, also the selectable `exa` provider). Brave, Serper, and Tavily have no production key, so the code skips them. The code still supports Brave (paced 25 ms apart, retries one 429) and Tavily when a key is set, for local benchmarks. HN Algolia (free), RSS expert feeds. Serper was removed from production on 2026-10-08 (owner decision): the code still calls it first when `SERPER_API_KEY` is set and skips it otherwise; the Amazon ASIN resolver (`asin-resolver.js`) uses Serper, else SearXNG site: searches (Brave as a per-query backup), else Brave; the product-image resolver (`image-resolver.js`) needs Serper or Brave. Production Brave answered HTTP 402 (out of credit) on 2026-10-14; its key was deleted from production on 2026-10-15, so product images do not resolve. Tavily is configured locally only. Older provider benchmark: `benchmarks/bench-providers.mjs`.
- **Cost governor**: `MONTHLY_BUDGET_USD` (default 60): each run increments a
  KV `cost:YYYY-MM` counter; `POST /api/research` returns 503 once the month's
  spend hits the cap. Per-run cost persists to `research.cost_usd`.
- **Deployment**: GitHub → GitHub Actions (`.github/workflows/deploy.yml`) → Cloudflare Workers

## Key Constraint
NO RUNTIME package managers. The deployed Worker is plain JS with ZERO runtime
dependencies: everything that ships is vendored or loaded via CDN. Supply chain
security is a hard requirement for anything that reaches production.

**One scoped exception (2026-06-18): dev/test tooling.** A Miniflare-backed Workers
test harness (`vitest` + `@cloudflare/vitest-plugin`, the renamed successor of `@cloudflare/vitest-pool-workers`) lives in `devDependencies`
ONLY. It is never bundled into the worker (wrangler bundles `worker/index.js`'s import
graph; `node_modules`/test specs aren't in it). `node_modules/` is gitignored;
`package.json` + `package-lock.json` are committed for reproducible installs. The runtime
zero-dependency rule is unchanged: do NOT add a dependency that ships to the worker.

## Commands
- Local dev: `npx wrangler dev` (wrangler is the only CLI tool, used ad-hoc not as a dependency)
- Deploy: **push to `main`** runs unit tests + `wrangler deploy` via GitHub Actions. Manual fallback: `bws-exec FRANK_CLOUDFLARE_API_TOKEN -- sh -c 'CLOUDFLARE_API_TOKEN="$FRANK_CLOUDFLARE_API_TOKEN" npx wrangler deploy'`. The repo needs the `CLOUDFLARE_API_TOKEN` secret (Workers Scripts Edit). The token is BWS key `FRANK_CLOUDFLARE_API_TOKEN` (the metrics token is `FRANK_METRICS_TOKEN`). `.cf-token` is a leftover copy: some scripts still read it until they move to BWS.
- DB migrations: `npx wrangler d1 execute DB --file=schema/001_initial.sql`
- Build CSS (after changing Tailwind classes): the standalone Tailwind binary: see README "Build CSS" (`tailwindcss -c tailwind.config.cjs -i build/input.css -o public/css/tailwind.css --minify`). Not in CI; rebuild + commit public/css/tailwind.css when you add new utility classes.
- Tests: `node scripts/run-tests.mjs` (about 1,300 assertions in 37 suites)
- Coverage gate: `bash scripts/coverage.sh` (Node built-in V8 coverage, zero npm; ~99.9% line on the 14-module pure-logic layer)
- Integration tests (I/O modules, real D1/KV via Miniflare): `npx vitest run` (or `--coverage`). Specs in `test/integration/*.spec.js`, config in `vitest.config.js`. Needs `npm install` first (dev deps only).
- Output eval: `node scripts/run-eval.mjs` (golden-query honesty audit against the live site; `--spend` enqueues missing runs, ~$0.10 each)
- Real-world benchmark: `node scripts/run-real-world-eval.mjs` (expert-review ground truth in `eval/real-world-benchmark.json`; free audit of live pages)

## Architecture
- `/public/`: Static frontend files (served by Cloudflare Pages)
- `/worker/`: Cloudflare Worker source (plain JS)
- `/worker/engine/`: Ported research engine: `engine.js` (agent loop + synthesis
  orchestration), `llm.js` (OpenRouter streaming/non-streaming + context pruning),
  `tools.js` (web_search/read_page/note; SearXNG + Exa + HN + RSS providers, Brave and Tavily when keyed), `searxng.js` (SearXNG client, cleanup and rerank),
  `prompts.js` (agent + synthesis prompts), `validate.js` (result sanitization),
  `opening-book.js` (deterministic template searches), `recall-gather.js` (post-planner
  recall searches for unevidenced category leaders)
- `/worker/lib/`: Shared utilities (`db.js`, `engine-config.js`, `classifier.js`,
  `affiliate-links.js`, `credibility.js`, `duckduckgo.js`, `rss.js`, `jina.js`,
  `rate-limit.js`, `utils.js`, `worker-auth.js`). NOTE: the old `lib/llm.js` and `lib/search.js`
  were removed: the engine owns its LLM + Serper layers now.
- `/worker/pipeline/`: `orchestrator.js` only: classify → runEngine → validate →
  persist. The old `search.js`/`analyze.js`/`synthesize.js`/`affiliate.js`
  stages were deleted (the engine subsumes them).
- `/worker/handlers/`: HTTP route handlers (research, report, affiliate)
- `/schema/`: D1 database migrations

## Query clustering
Queries hit a 14-day cluster cache via `findResearchByCanonicalQuery` before starting a new run.
`worker/lib/utils.js` provides two canonical forms:
- `canonicalizeQuery`: strips stopwords and filler (prices, years), singularizes tokens via `singularizeToken` (handles "ies" to "y", strips "es" after ses/xes/zes/ches/shes, strips trailing "s" while preserving no-touch non-plurals: series, lens, glass, chess, gps, nas, ups, class, plus), then sorts and de-duplicates tokens.
- `squashQuery`: applies the same token normalization but preserves original token order without delimiters (for example, "light bulb" becomes "lightbulb").
Research rows store both `canonical_query` and `squashed_query` columns (added by `schema/014_squashed_query.sql`). `findResearchByCanonicalQuery` matches on either form, allowing variations like "lightbulb", "lightbulbs", and "light bulb" to hit the same 14-day cache instead of starting separate runs.

## Gather shape
Research runs operate with a 50-search budget (`ENGINE_CONFIG.maxSearches = 50`):
- **Opening book (`worker/engine/opening-book.js`)**: before the planner's first turn, every run executes a fixed template search set built from the classified topical category and facets: "best <subject>", "<subject> review", "best <subject> reddit", "<subject> site:reddit.com". The subject is the topical category, or the raw query for comparative queries. These searches count against `maxSearches`, their results enter the normal source pool, and a system message tells the planner they already ran. This ensures repeat runs of the same query share an overlapping corpus so top ranks stay stable.
- **Planner loop**: the agent loop executes up to 42 searches, reading sources and taking notes.
- **Reserved search recall (`worker/engine/recall-gather.js`)**: 8 of the 50 searches are reserved for a recall phase after the planner loop ends. The engine asks the recall model which category leaders the harvest missed, drops proposals already evidenced in gathered sources, and runs direct "<name> review" and "<name> reddit" searches for up to 4 unevidenced names, appending results before synthesis. It respects subrequest and time budgets and skips silently when either is spent, logging `[recall-gather] proposed N, searched M, recovered K`. The post-hoc recall supplement inside `synthesizeHonest` continues to run during synthesis.

## Secrets (values in BWS, pushed to the Worker with `wrangler secret put`)
- OPENROUTER_API_KEY: paid OpenRouter key (classifier/planner/synth models)
- SERPER_API_KEY: removed from production 2026-10-08; optional (ASIN resolver uses SearXNG without it; image resolver stays off)
- WORKER_SECRET: authentication secret gating /api/internal/* and internal worker requests
- BRAVE_API_KEY: not set in production (deleted 2026-10-15, CP-652, out of credit). Optional; when set, Brave is the web fallback before Exa. Rollback: put the BWS value `BRAVE_API_KEY` back with `wrangler secret put` after a top-up.
- TAVILY_API_KEY: optional; Tavily LLM-tuned web search (selectable provider + fallback)
- EXA_API_KEY: optional; Exa neural web search (selectable `exa` provider + the production web fallback after SearXNG; $4 per 1,000)
- SEARXNG_URL: `https://litellm.wafflemedia.net` in production (set 2026-10-15, CP-593). The `searxng`
  provider leads the web chain and sends `X-Edge-Gate` from LITELLM_GATE_TOKEN (BWS LITELLM_EDGE_GATE).
  Rollback: `wrangler secret delete SEARXNG_URL` (search falls back to Exa).
- JINA_API_KEY: optional; lifts Jina Reader's free rate cap for `read_page`
- AMAZON_ASSOCIATE_TAG: optional; `AMAZON_AFFILIATE_TAG` ([vars]) is the default tag

## Internal endpoints and forceFresh
`POST /api/research` accepts `forceFresh: true` to bypass the canonical-query cache and start a genuinely new run. It is honored ONLY when the request carries the `X-Worker-Secret` header matching `WORKER_SECRET` (the same auth as `/api/internal/*`, verified via constant-time comparison in `worker/lib/worker-auth.js`). A public caller's `forceFresh` is ignored. It exists for an external benchmark harness that measures run-to-run stability. The public `fresh` flag (re-run button) is unchanged.
