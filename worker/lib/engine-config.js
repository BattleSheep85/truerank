// ENGINE CONFIG: the one model set and research depth used for every run.
//
// Benchmark-derived (see benchmarks/engine-llm-bench-2026-06.md):
//   - classifier: google/gemini-3.8-flash  (set in worker/lib/classifier.js)
//   - planner:    google/gemini-3.8-flash  (the older Gemini Flash generation won the
//                 planner bench: perfect skepticism + tool-calls, cheapest + fastest;
//                 the feared "15% BS" failure did not reproduce. Retired 2026-10, the
//                 current Gemini Flash replaces it, see docs/litellm-2026-10.md)
//   - synthesis:  minimax/minimax-m3             (owner no-OpenAI directive, 2026-07-24;
//                 was the synth-gold co-leader, see synthModel comment below)
//   - extract:    anthropic/claude-haiku-4.5     (owner no-OpenAI directive, 2026-07-24;
//                 only non-OpenAI extractor matching the incumbent on the extract-gold bench)
//
// Depth is tuned to "deep and sustainable" within Cloudflare's per-run limits
// (about 950 subrequests, about a 20-minute reaper). The off-Cloudflare
// research worker (track 2) removes that ceiling, so depth and parallelism
// can scale much higher.

export const ENGINE_CONFIG = {
  maxToolCalls: 70,
  maxSearches: 50,
  maxFetches: 20,
  agentLoopBudgetMs: 210_000, // ~3.5 min, safely under the 20-min reaper
  // synth — owner no-OpenAI directive (2026-07-24); minimax-m3 was the statistical
  // co-leader of the synthesis-gold bench (composite 7.69 vs gpt-5.4-mini 7.61,
  // 8/8 reliable, 1 num_ung across 8 reports; benchmarks/ft-data/README.md).
  // Cheaper + richer reports than the incumbent.
  // 2026-10-08 synth-gold rerun (same 8 queries and corpora, production prompt, blind
  // Sonnet 5.5 judge): mimo-v2.6-flash composite 7.63 (g 7.13 u 7.38 h 8.38), 0 fabricated
  // numbers, 8/8, $0.0044/report, 33 s; minimax-m3 4.71, 0 fabricated, $0.032/report, 31 s.
  synthModel: 'xiaomi/mimo-v2.6-flash',
  // 2026-10-08 planner bench (benchmarks/bench-planner-cost.mjs, presets A/PS, 4 queries x 2,
  // append context, other roles gemini-3.8-flash, blind Sonnet 5.5 judge): mistral-medium-3.1
  // quality 5.17 vs 5.00, $0.064/report vs $0.142 (cache-aware), median 132 s vs 137 s,
  // 0/6 failures, 0 tool-argument parse failures. glm-5.3 4.67 / $0.123; minimax-m3 5.00 /
  // $0.058 but median 149 s (slower). Served by OpenRouter (not in the LiteLLM map).
  plannerModel: 'mistralai/mistral-medium-3.1',
  synthReasoning: undefined,
  // verify stance judge. 2026-10-08 judge bench (benchmarks/judge-bench.mjs +
  // judge-grade.mjs, 5 products, 56 pinned claims, Sonnet 5.5 grader): mimo
  // 22 correct, 79% precision, 0 wrong-direction, $0.009/product, 2.2 s p50,
  // against minimax-m3 23 correct, 68%, $0.089/product, 9.5 s. Served by
  // OpenRouter (not in the LiteLLM map, so LiteLLM routes fall back to it).
  stanceModel: 'xiaomi/mimo-v2.6-flash',
  // Second judge, only for claims mimo leaves unsubstantiated. Graded benches on two
  // independent evidence sets (2026-10-08, Sonnet 5.5 grader, 104 claims): mimo -> minimax-m3
  // 42 correct, 0 wrong-direction, 76% precision; minimax-m3 alone 38, 75%; mimo alone 35.
  // gemini-3.5-flash-lite as fallback added 0 correct on set 2; glm-5.3-flash hit the length
  // cap live and pushed runs past the Worker time limit.
  stanceFallbackModel: 'minimax/minimax-m3',
  // Verify evidence: true reranks each claim's candidate passages with the Jina
  // reranker (worker/engine/verify-rerank.js) before the stance judge. Needs
  // JINA_API_KEY; without it, or on a rerank error, the term-ranked selection is used.
  evidenceRerank: false,
  rerankModel: 'jina-reranker-v3.5',
  // 2026-10-08 extract bench (benchmarks/extract-bench.mjs, 5 products, same
  // cached page text, Sonnet 5.5 grader): mimo 46 good claims, 3 flagged (2
  // checked as grader errors), $0.0006/product, 3.9 s; haiku-4.5 45 good, 1
  // made up, $0.006/product.
  extractModel: 'xiaomi/mimo-v2.6-flash',
  synthMaxTokens: 16000,
  // ── speed knobs (OpenRouter platform levers) ──────────────────────────────
  // The agent loop is tool-ROUTING, not deep reasoning — cap thinking tokens per
  // turn. Biggest accuracy-safe wall-clock lever on the sequential MAX_TURNS path.
  plannerReasoning: { effort: 'low' },
  // Hybrid con-SELECTOR model (used only when the engine runs SYNTH_ENGINE=extract):
  // a cheap model PICKS criticism from real source spans for products the deterministic
  // pass left thin; its groundedness gate drops anything not verbatim, so it adds con
  // recall without a fabrication surface. A cheap Flash model is plenty for selection.
  conSelectorModel: 'google/gemini-3.8-flash',
  // Gated LLM name-cleanup model (engine-shootout-v2 winner): cleans names + drops junk/
  // platforms/dupes over the ML candidate set, groundedness-gated. Stronger than the old Lite tier
  // (needs product/category understanding), still cheap (~$0.01/run).
  cleanupModel: 'google/gemini-3.8-flash',
  // Recall-supplement model (engine-shootout-v2 "C win"): proposes category leaders the harvest
  // missed; grounding-gated downstream (the name must appear in the gathered sources with credible
  // evidence, else it's dropped). Knowledge task → a cheap Gemini Flash model, ~$0.01/run.
  recallModel: 'google/gemini-3.8-flash',
  // NO provider object for the planner: the Gemini Flash planner is served by a SINGLE
  // provider (Google) on OpenRouter that does not expose a quantization tag, so a
  // `quantizations` filter 404s ("no endpoints"), and sort/max_price can only hurt
  // (filter to zero) with no routing benefit. The planner's real speed lever is
  // reasoning:{effort:'low'} above. Verified empirically 2026-06-22 on the older Flash
  // generation; not re-verified on gemini-3.8-flash.
  plannerProvider: null,
  // No provider routing pin for the synth model — left null after the openai/
  // gpt-5.4-mini era single-provider constraint; minimax-m3 has no quantization
  // tag either, so a routing object would still 404/filter to zero.
  synthProvider: null,
  // Cap a hung planner routing turn well below the synth budget (the loop retries
  // once on error, so a rare false abort self-heals). gemini tool turns finish in s.
  plannerHardMs: 45_000,
  // Planner context budget for pruneMessages (llm.js). In 'prune' mode, above plannerContextMaxChars the
  // middle tool outputs are truncated, then the oldest middle turns are dropped; the last
  // plannerContextKeepTail messages always survive. The planner is ~95% of research LLM
  // cost, almost all prompt tokens, so this budget is the main cost lever.
  // 2026-10-08 bench (4 queries x 2, blind Sonnet 5.5): 120000/10 quality 4.63, $0.0765,
  // 139.5 s; 60000/6 quality 5.13, $0.0719, 140.5 s; 40000/4 quality 4.13, $0.0827, 162 s.
  // plannerContextMode 'prune' is the budget above. 'append' sends the history unchanged
  // up to plannerContextMaxChars as a ceiling, then cuts once to about half, so the
  // Gemini implicit prompt cache keeps hitting (llm.js pruneAppendOnly). Any edit to an
  // earlier message re-bills everything after it at the full input price.
  // 2026-10-08 cache bench (bench-planner-cost.mjs P,Q,R, planner via LiteLLM, cache-aware
  // cost, blind Sonnet 5.5, 6 query/rep cells run by all three): append 600000/6 quality
  // 4.17, $0.1197/report, planner cached share 0.43, median 200.5 s; prune 60000/6 4.50,
  // $0.1407, 0.22, 226.5 s; prune 120000/10 4.00, $0.1312, 0.33, 215.5 s. 0 failures.
  // Peak planner context was 74 KB, so the 600000 ceiling did not trigger a cut.
  plannerContextMode: 'append',
  plannerContextMaxChars: 600_000,
  plannerContextKeepTail: 6,
  // ── verify (Truth Audit) speed, 2026-10-09 ──────────────────────────────
  // Stage deadlines of a product check (worker/engine/verify.js verifyBudget),
  // in ms; 0 turns one off. A stage that reaches its deadline goes on with the
  // page text that arrived; a page not read keeps its search snippet.
  // OFF by default: the ship rule needed a 6-product median under 60 s and a
  // median decided share not below the baseline (54%) in one clean round.
  // Measured with resolve 15_000, test 12_000, gather 15_000, planner 25_000,
  // stance 25_000, patience 3_000: 50.4 s / 50% (round 3), 67.6 s / 58%
  // (round 4, three products on Tavily after Brave ran out of credit, and a
  // slow extract model); baseline 80.3 s / 54%. Set those values to turn the
  // deadlines on after a clean re-measure (benchmarks/verify-product.mjs,
  // VP_CONFIG_JSON).
  verifyResolveReadMs: 0, // the product's own pages (all candidate reads at once)
  verifyTestReadMs: 0, // the claims' test pages
  verifyGatherReadMs: 0, // the gather's page reads
  verifyPlannerMs: 0, // the gather's planner call (fixed aspects on a timeout)
  verifyStanceCallMs: 0, // each stance call (a capped fallback keeps the primary verdict)
  // When `wanted` claim pages are usable but a better ranked candidate is still
  // being read, wait at most this long for it. 0 = wait for it.
  verifyClaimPatienceMs: 0,
  // When the primary stance call (a fast model, a few seconds as a rule) has
  // no verdict after this many ms, the fallback judge starts, and the first
  // decided verdict wins (never fewer decided claims). 0 = off.
  verifyHedgeMs: 10_000,
  // When the extract call (one call, 1 to 4 s as a rule) has no reply after
  // this many ms, a second request goes out; the first reply wins. 0 = off.
  verifyExtractHedgeMs: 5_000,
  // true starts the gather with the check: its planner call overlaps resolve
  // and extract, its searches wait for the claims, and its reads wait for the
  // test page reads. false runs it after the test pages.
  verifyOverlapGather: true,
  maxConcurrency: 6, // parallel sub-researchers on the CF queue consumer (6 = validated memory-safe; bumping to 12 gave no latency gain — bottleneck is the agent loop + synth, not gather)
  reportSections: ['summary', 'products', 'comparison', 'categories', 'pitfalls', 'buyerGuide', 'methodology'],
};

// Single source of truth for the user-facing research wait-time estimate.
// Any copy that quotes how long a run takes should import this constant
// rather than hard-coding a duration (keeps the estimate consistent site-wide).
export const RESEARCH_ETA = '1-2 minutes';
