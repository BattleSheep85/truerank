# GLM-5.2 vs the synth incumbent — empirical follow-up (2026-06-17)

_Z.ai released **GLM-5.2** on 2026-06-16 (753B open-weights MIT, 1M context). It leads the Artificial Analysis Intelligence Index for open models (51 vs kimi-k2.6's 43) — but that index is **coding/agentic-weighted**, and the [main engine bench](./engine-llm-bench-2026-06.md) already proved leaderboard rank ≠ honesty here (qwen3.5, gemini-3.5 topped charts but failed the trap test). So we ran GLM-5.2 through the **real synthesis honesty harness**._

## ⚠️ UPDATE 2026-06-17 (re-bench under the FIXED prompt) — the swap is REVERSED. KEEP kimi-k2.6.

The honesty audit (`benchmarks/results/` + issues.md) confirmed the synth prompt *mandated* fabrication (rating "inferred", price "never null"). After fixing the prompt (`worker/engine/prompts.js`: price source-or-null, rating editorial, no-fabrication/citation/date rules) we **re-ran the 6-scenario bench under the corrected prompt with a deterministic groundedness gate** (fraction of emitted prices/spec-numbers not traceable to the sources; null = grounded). This is what the audit demanded — and it **reversed the ranking the original (contaminated) judging produced:**

| config | ungrounded_price (old→new) | ungrounded_spec (old→new) | p50 latency | $/run | verdict |
|---|---|---|---|---|---|
| **opus-4.8** (ceiling) | 0.69 → **0.00** | 0.57 → **0.00** | 38s | $0.105 | perfectly grounded, but 8× cost |
| **kimi-k2.6** (incumbent) ✅ | 0.64 → **0.00** | 0.81 → **0.29** | 25s | $0.0097 | obeys "no invented price"; KEEP |
| **glm-5.2** (candidate) ✗ | 0.73 → **0.53** | 0.65 → **0.39** | 21s | $0.0131 | still invents prices/specs when told NOT to |

**What this means:** the R1 prompt fix is the real win — fabrication collapsed for every model (opus → 0/0). But under a prompt that explicitly says *"NEVER invent a price,"* **glm-5.2 keeps inventing** (53% of its prices are ungrounded; spot-checked: it stamped $299.99/$199.99/$249.99 on SSDs whose sources contain no prices, and $299.99 on all four office chairs incl. the trap). **kimi obeys** (0% ungrounded prices). The earlier "glm wins 6/6" was an artifact of the fabrication-mandating prompt + same-family judges scoring "who fabricates less flagrantly," exactly the contamination the audit flagged. kimi's "2.6× slower" was also variance — it ran 25s here, not 111s.

**Decision:** **DO NOT swap. Keep `moonshotai/kimi-k2.6`.** It is at least as honest as glm-5.2 on the clearest lie-metric (numeric fabrication) under the corrected prompt, and cheaper. opus-4.8 is the honesty ceiling but ~8× the cost — revisit only if the budget allows a premium-honesty tier.

### v2 update (tightened spec-grounding rule) — ALL models → 0/0, but note the variance

After adding a pointed specs-grounding rule (`prompts.js`: "include a spec ONLY when its exact value appears in a source… an empty specs object beats unsourced numbers"), the re-bench shows **every model at 0 ungrounded prices AND 0 ungrounded specs** (kimi spec 0.29→**0**; glm price 0.53→**0**, spec 0.39→**0**; opus 0/0). Two honest reads:

1. The prompt is now strong enough that even the previously-worst model (glm) complied — **kimi (the incumbent we keep) is at 0/0.** This is the deploy-worthy win.
2. glm's price fabrication swinging **0.53 → 0 between two runs is real run-to-run non-determinism.** So a single bench run cannot reliably *rank* models on fabrication (the n≥20 / multi-run point from the audit stands). It does NOT change the decision — keep the cheaper incumbent kimi at 0/0 — but it means the *guarantee* of no-lies comes from the **live groundedness monitor on production output**, not from one green bench run. Bench = pre-flight; production monitoring = the standing promise.

### Data check (2026-10-18, CP-409)

The raw files in `results/` were re-read and re-scored with the bench's own groundedness code. What holds and what does not:

| Run | Raw file | Configs × scenarios | Groundedness (prices, specs ungrounded / emitted) | Judges |
|---|---|---|---|---|
| First pass, old prompt | `glm52-synth-raw.json` | 4 × 2 = 8 outputs | not measured (metric added later) | 3 per output = **24** |
| Expanded, old prompt | `glm52-synth-raw-oldprompt.json` | 3 × 6 = 18 outputs | kimi 7/11, 39/48 · glm 11/15, 11/17 · opus 11/16, 13/23 | 3 per output = **54** |
| Fixed prompt v1 | `glm52-synth-raw-fixedv1.json` | 3 × 6 | kimi 0/3, 2/7 · glm 9/17, 7/18 · opus 0/2, 0/7 | none (deterministic gate) |
| Fixed prompt v2 | `glm52-synth-raw-fixedv2.json` | 3 × 6 | kimi 0/3, 0/6 · glm 0/3, 0/4 · opus 0/3, 0/3 | none |

- **24 vs 54 judges is not a contradiction once the runs are split:** 24 judged the 2-scenario first pass, 54 judged the 6-scenario expanded pass. Every fraction, cost, and p50 latency in the two tables above matches its raw file.
- **The judge scores themselves were never saved.** The judges were Claude sessions outside the bench script, and their outputs were not written to `results/`. So the honesty, faithfulness, trap, and conflict scores below (0.81 / 0.74 / 0.63, 0.91 / 0.87 / 0.82 / 0.74, and so on) cannot be checked against data. Treat them as historical notes. They are superseded anyway.
- **Two contradictions inside the superseded part:** the "Why" section gives glm-5.2 reasoning ON a faithfulness of 0.82 in the ranking and 0.90 in its bullet; and the trailing "Methodology" and "Caveats" describe the 2-scenario pass only. Both are marked below. With no saved judge data, neither number can be confirmed.
- `glm52-synth-raw-expanded.json` is a byte-identical copy of `glm52-synth-raw-fixedv2.json` (the expanded run's default file name was reused by the v2 run). The old-prompt expanded outputs live in `glm52-synth-raw-oldprompt.json`.
- Fixed prompt v1 also had glm-5.2 put the trap product in 1 of 6 reports (`trap_present_count: 1`); the other two configs left it out every time.
- The v2 "0/0" result rests on very few emitted numbers (3 prices per model). It shows the prompt works, not that the models rank equal.

_Everything below was the PRE-prompt-fix analysis that led to this reversal — kept for the audit trail; superseded by the box above._

---

## ~~TL;DR — SWAP synthesis to `z-ai/glm-5.2`~~ (SUPERSEDED — see the reversal above)

Two findings from the expanded **6-scenario** bench (keyboard, headphones, robot vacuum, office chair, portable SSD, + an email-marketing **service**):

1. **glm-5.2 (reasoning off) beats kimi-k2.6 on every honesty axis, on 6/6 scenarios** — and is ~2.6× faster. Swap (gated behind a `SYNTH_MODEL` env override for instant rollback). Keep **gemini-2.5-flash** for the planner. Reasoning stays **OFF** (the kimi gotcha reproduces).
2. **The bigger problem is the prompt, not the model.** Under a strict faithfulness judge, *every* config — including opus — fabricates: synthetic per-product **ratings** (4.4/4.2/4.0), invented **prices** ("$179.95"), and invented **freshness/date metadata** ("within the 12-month window") that no source supports, because the synthesis schema *mandates* those fields. Fixing the prompt lifts every config and is **higher-leverage than the model choice.** (See [issues.md] HIGH.)

**Authoritative result (at the time) — expanded consensus (6 scenarios × 3 configs × 3 judges = 54 judges; raw outputs `results/glm52-synth-raw-oldprompt.json`; judge scores not saved):**

| Synth config | Overall honesty | **Faithfulness** | Trap | Schema | $/call | **p50 latency** | Beats kimi on |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-opus-4.8` (ceiling, OFF) | 0.81 | 0.67 | 1.00 | 1.00 | $0.111 | 43s | — |
| **`z-ai/glm-5.2` (reasoning OFF)** ✅ | **0.74** | **0.59** | 1.00 | **0.933** | $0.0132 | **42s** | **6/6 scenarios** |
| `moonshotai/kimi-k2.6` (incumbent, OFF) | 0.63 | **0.44** | 0.99 | 0.834 | $0.0092 | **111s** ⚠ | — |

The initial **2-scenario** pass (below) had higher absolute scores (glm 0.91, kimi 0.84) under a less-broad test; the 6-scenario run is stricter and more varied, dropping everyone — but **glm's lead held on all 6 queries** (overall 0.69–0.86 vs kimi 0.55–0.72; faithfulness 6/6). The margin widened, not narrowed. glm-5.2-ON was dropped from the expanded run (already shown worse + the reasoning-starve gotcha).

### The systemic faithfulness finding (act on this regardless of the swap)

All three models invent, with citation-flavored language ("verified independently", "per RTINGS test rig"), data absent from the sources:
- **Synthetic numeric ratings** — the schema requires a `rating`, so models manufacture 4.x decimals with no source basis (and the UI renders them as stars → looks authoritative).
- **Invented prices** — exact figures ("$179.95", "~$110") stated as fact when no source carries a price.
- **Invented freshness/date metadata** — "all sources within the 12-month window" / "no outdated 2023 sources" when sources have NO dates.
- **kimi additionally drops legit, source-backed options** (omitted NuPhy Air75 in 2 separate runs despite hands-on + community backing — glm included it). This is the worst failure mode and is kimi-specific.

The synthesis prompt should explicitly forbid: inventing prices, fabricating numeric ratings (or mark them as editorial estimates, not measurements), and asserting freshness when sources are undated. That fix would raise *every* config's faithfulness and is the highest-leverage honesty work available.

## Why — faithfulness is the differentiator, and kimi is the weakest

_This section reports the **2-scenario first pass** (24 judges), not the 6-scenario table above. Judge scores were not saved (see the data check at the top)._

Every config nailed the **trap** (omitted the affiliate/listicle-hyped no-name product 2/2) and flagged conflict sourcing (~0.97–1.0). The trap is no longer the discriminator — **faithfulness** (claims traceable to the supplied sources, no ungrounded spec injection) is, and the consensus order is opus 0.91 > **glm-OFF 0.87** > glm-ON 0.82 > **kimi 0.74**.

- **kimi-k2.6 (0.74)** systematically launders ungrounded specs as fact — fabricated "35-hour battery", "Bluetooth 5.0", "40-hour ANC", **synthetic per-product ratings** (4.4/4.2/4.0), invented freshness metadata ("2024 within 12-month window of 2026" — internally inconsistent), and in one run **dropped a legit product** (NuPhy Air75) that had hands-on + community backing. That is precisely the dishonesty TrueRank exists to avoid.
- **glm-5.2 OFF (0.87)** bugs are milder and don't distort ranking: one source mislabel (RTINGS vs Reddit), one unsourced "~$100" price, a loose source count. Plus **perfect schema (1.0 vs 0.834)** — retires the off-spec-JSON / empty-synthesis risk kimi carries.
- **glm-5.2 ON (0.90; the ranking above says 0.82, and with no saved judge data neither can be confirmed)** is *worse* than OFF: +54% cost, ~2× latency, more unsourced enrichment, and it emitted **Chinese-language fabricated specs** ("电池续航长达35小时"). Reasoning ON also starves short structured calls (see planner below). Keep `synthReasoning:{enabled:false}`.

## Planner — keep `gemini-2.5-flash`

10-item skepticism / BS-detection probe (`glm52-planner-skep.mjs`):

| Planner config | skep_acc | BS-detect | ctrl | json | $/10 | p50 |
|---|---|---|---|---|---|---|
| **gemini-2.5-flash (incumbent)** ✅ | 1.00 | 1.00 | 1.00 | 1.00 | $0.0019 | **0.98s** |
| glm-5.2 (reasoning OFF) | 1.00 | 1.00 | 1.00 | 1.00 | $0.0056 | 8.2s |
| glm-5.2 (reasoning ON) | 0.20 | 0.14 | — | 0.20 | — | 16s (2 err) |

GLM-5.2 OFF *matches* gemini's perfect skepticism but at **3× cost and 8× latency** for a role fired dozens of times/run → no swap. Reasoning ON face-plants (starved JSON on a 400-token budget) — the gotcha, confirmed.

## Methodology

_Describes the 2-scenario first pass. The 6-scenario passes used the same script with `EXPANDED=1` (4 extra scenarios from `synth-fixture-glm-extra.mjs`, glm reasoning ON dropped)._

- **Synth:** the engine's real `buildSynthesisPrompt` against the planted-trap fixtures (`synth-fixture.mjs`: 2 scenarios, credible [hands-on]/[expert-domain] sources beside an affiliate/listicle-hyped no-name `trap`). Script: `glm52-synth-bench.mjs`. Raw outputs: `results/glm52-synth-raw.json`.
- **Honesty scoring:** 4 sub-axes (trap-handling, faithfulness, conflict-flagging, marketing-filter) + overall, **3 independent adversarial Claude judges per output × 8 outputs = 24 judges**, consensus by mean (off the OpenRouter budget; judge spread ≤ 0.10). Matches the project's "judge panel" precedent.
- **Cost/latency:** OpenRouter `usage.cost` (authoritative) + wall-clock p50. Pricing: glm-5.2 $1.40/$4.40, kimi $0.95/$4.00, opus $5/$25 per M.

## Caveats (carry into the rollout)

1. **2-scenario sample** — directionally strong (per-query GLM-OFF 0.89/0.93) but small n. Confirm on the full set via `node scripts/run-eval.mjs` after the swap.
2. **Off-spec JSON reduced, not zero** — GLM scored schema 1.0 here, but it's a new model; keep `validate.js` strict and watch the first ~20 live runs.
3. **Reasoning-default gotcha applies to GLM** — its honesty/output materially differ ON vs OFF, so the explicit `synthReasoning:{enabled:false}` MUST be carried over (don't assume GLM defaults off).

## Exact change (gated)

```js
// worker/lib/tiers.js line 20
synthModel: 'z-ai/glm-5.2',   // was moonshotai/kimi-k2.6 — keep synthReasoning:{enabled:false}
```

Recommended rollout: env-overridable (`env.SYNTH_MODEL || 'z-ai/glm-5.2'`) so a bad live run reverts to kimi without a redeploy, then `run-eval.mjs` to confirm on the full golden set. The off-CF blackbox worker runs the same engine → it needs the rsync+restart deploy too.

## Spend ledger

| Phase | Spend |
|---|---|
| Synth bench (4 configs × 2 scenarios) | $0.297 |
| Planner skepticism (3 configs × 10) | $0.009 |
| Expanded synth bench (3 configs × 6 scenarios) | $0.803 |
| Fixed-prompt re-bench v1 (3 × 6) | $0.769 |
| Fixed-prompt re-bench v2 (3 × 6) | $0.773 |
| 24 + 54 honesty judges + synthesis | $0 (off OpenRouter — Claude judges) |
| **Total** | **≈ $2.65 / $100 key cap** (the earlier ≈ $1.11 left out the two re-benches; spend figures from the `spend` field of each raw file) |
