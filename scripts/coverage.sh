#!/usr/bin/env bash
# Coverage gate for the pure-logic layer — zero npm, uses Node's built-in V8
# coverage. Exits non-zero if any threshold is missed. Run: bash scripts/coverage.sh
#
# Scope = the deterministic, runtime-free modules (validation, scoring, faceting,
# URL/affiliate tagging, pure render helpers). I/O modules (db, classifier, search
# providers, handlers, engine LLM, full SSR pages) need the Cloudflare runtime and
# are integration code — out of this unit-coverage target by design.
#
# Most modules sit at 100% line. Two known gaps keep the total just under it:
#   - affiliate-links.js has ONE unreachable defensive catch (the URL is
#     pre-validated by isValidHttpsUrl, so the inner new URL() cannot throw).
#   - smtp.js openCloudflareSocket() imports 'cloudflare:sockets', which plain
#     Node cannot load. Everything below that 3-line adapter is covered through
#     the injected-socket seam.
# Thresholds are set just under the real number so a regression fails the gate
# while those two known gaps do not.
set -euo pipefail
cd "$(dirname "$0")/.."

INCLUDES=(
  worker/lib/brand-quality.js
  worker/lib/foss-leaders.js
  worker/lib/product-search.js
  worker/lib/affiliate-links.js
  worker/lib/utils.js
  worker/lib/credibility.js
  worker/lib/status.js
  worker/lib/guides.js
  worker/lib/engine-config.js
  worker/lib/ads.js
  worker/lib/html.js
  worker/lib/search-bar.js
  worker/lib/burst-gate.js
  worker/lib/affiliate-gate.js
  worker/lib/llm-json.js
  worker/lib/pool.js
  worker/engine/stance-votes.js
  worker/lib/connection-gate.js
  worker/lib/mime.js
  worker/lib/smtp.js
  worker/lib/email-templates.js
  worker/lib/subscribe-flow.js
  worker/lib/listable.js
  worker/engine/validate.js
  worker/engine/prompts.js
  benchmarks/lib/grounding-check.mjs
  benchmarks/lib/outlet-lexicon.mjs
  benchmarks/lib/citation-scan.mjs
)
ARGS=()
for f in "${INCLUDES[@]}"; do ARGS+=("--test-coverage-include=$f"); done

exec node --test --experimental-test-coverage \
  --test-coverage-lines=99 \
  --test-coverage-functions=94 \
  --test-coverage-branches=85 \
  "${ARGS[@]}" \
  scripts/coverage.test.mjs
