# BullshitBench numbers: where they came from (written 2026-10-18, CP-426)

In June 2026 a few model choices cited "BS-detection" scores that lived only in code
comments and one issues.md line. This file records them, says where they came from,
and says what later data replaced them. None of these numbers can be reproduced
from this repo.

## The numbers

| Model | Score | Where it appeared |
|---|---|---|
| anthropic/claude-opus-4.8, reasoning off | 94% BS detection | `worker/lib/tiers.js` comment (commit `0dc8b3a`, 2026-06-11), issues.md "Engine quality round" |
| anthropic/claude-opus-4.7 | 76% | same comment |
| anthropic/claude-sonnet-4.6 | 84% | issues.md only |
| google/gemini-2.5-flash (planner) | 15% detected, 77% fooled | issues.md only; later quoted as "~15% BS" in `benchmarks/landscape-2026-06.md` and `worker/lib/engine-config.js` |

issues.md describes the run as "BullshitBench v2 (3-judge consensus, 100 trap
questions)", with reasoning off scoring better than reasoning at xhigh.

## Where they came from

- The harness was external: BullshitBench v2 by petergpt
  (https://github.com/petergpt/bullshit-benchmark, results at petergpt.github.io).
  It asks questions with broken premises and checks whether the model pushes back.
- No script, prompt set, or raw output from that run was committed here. `tiers.js`
  was deleted in the tier removal (commit `57ac737`, 2026-07-28), so the comments
  only survive in git history.
- The questions are general nonsense prompts, not product research. A model sees no
  sources and no credibility tags, so the scores say little about how it behaves
  inside Frank's engine.

## What replaced them

- `benchmarks/engine-llm-bench-2026-06.md` (2026-06-16) tested the planner inside
  the real engine, with the deterministic credibility tags. gemini-2.5-flash flagged
  affiliate, listicle, and manufacturer conflicts in 5.5 of 6 cases (score 0.967).
  **The 15% did not reproduce.** The bench's top literature pick, qwen3.5-397b
  (78% on BullshitBench), returned empty notes on 4 of 6 items.
- `benchmarks/glm52-planner-skep.mjs` and `benchmarks/harness.mjs` hold local
  skepticism probes that anyone can rerun.
- The synthesis prompt still carries the guard added with the 15% figure:
  "the research notes were written by a planner model that is easily impressed by
  marketing language" (`worker/engine/prompts.js`). Credibility tags outrank note
  sentiment.
- None of the models above runs in production today. Current models and their
  benches are listed in `CLAUDE.md` and `worker/lib/engine-config.js`.

## Rule for next time

Treat any external leaderboard number as a hint for what to bench, not as a reason
to pick a model. Pick on a local bench whose script and raw output are in
`benchmarks/`.
