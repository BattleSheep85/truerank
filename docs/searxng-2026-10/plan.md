# Plan: SearXNG cutover

After this ships, frank's web search runs on the free self-hosted SearXNG with results that match the Serper-era quality, and the paid providers only answer when SearXNG gives a weak answer.

## Baseline (ASSUMED)
Serper answers HTTP 400 (no credit) and the local Brave key answers HTTP 402, so a live Serper run is not possible. The baseline is:
- the Serper-era corpus `benchmarks/results/google-top50-corpus.json` (June 2026, Serper-powered runs): recall of its good domains per topic;
- live Exa on the same queries;
- the recorded 2026-10-09 evidence bench: Brave 40 and Exa 32 review domains over 16 evidence queries.

## Pieces
| id | class | files | gate | dominant risk |
|---|---|---|---|---|
| P1 | CHANGE | worker/engine/searxng.js, worker/engine/tools.js, test/unit/searxng.test.js (+ scripts/run-tests.mjs registration) | `node scripts/run-tests.mjs` | the filter drops good results or the fallback never fires |
| P2 | ADD | benchmarks/bench-searxng.mjs | scripted run, JSON report | bench load gets engines suspended |
| P3 | CHANGE (infra) | blackbox stacks/searxng/settings.yml | live probe + bench | engines rate-limit the home IP; recovery: restore the previous settings.yml and restart |
| P4 | CHANGE (ops) | Worker secrets SEARXNG_URL, LITELLM_GATE_TOKEN; CLAUDE.md, README | prod smoke search | bad results in production; rollback: `wrangler secret delete SEARXNG_URL` |

## Gate for cutover
On the bench query set, SearXNG (after frank's rerank) must reach: good-domain recall of the Serper corpus at least 90% of Exa's, at least 36 distinct review domains over the 16 evidence queries (90% of Brave's 40), Reddit in the top 10 for at least 80% of "reddit" queries, junk rate no higher than Exa's, failure rate under 5%, p95 latency under 8 s.
