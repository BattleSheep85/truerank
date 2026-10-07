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
  synthModel: 'minimax/minimax-m3',
  plannerModel: 'google/gemini-3.8-flash',
  synthReasoning: undefined,
  // verify stance judge. 2026-10-08 judge bench (benchmarks/judge-bench.mjs +
  // judge-grade.mjs, 5 products, 56 pinned claims, Sonnet 5.5 grader): mimo
  // 22 correct, 79% precision, 0 wrong-direction, $0.009/product, 2.2 s p50,
  // against minimax-m3 23 correct, 68%, $0.089/product, 9.5 s. Served by
  // OpenRouter (not in the LiteLLM map, so LiteLLM routes fall back to it).
  stanceModel: 'xiaomi/mimo-v2.6-flash',
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
  maxConcurrency: 6, // parallel sub-researchers on the CF queue consumer (6 = validated memory-safe; bumping to 12 gave no latency gain — bottleneck is the agent loop + synth, not gather)
  reportSections: ['summary', 'products', 'comparison', 'categories', 'pitfalls', 'buyerGuide', 'methodology'],
};

// Single source of truth for the user-facing research wait-time estimate.
// Any copy that quotes how long a run takes should import this constant
// rather than hard-coding a duration (keeps the estimate consistent site-wide).
export const RESEARCH_ETA = '1-2 minutes';
