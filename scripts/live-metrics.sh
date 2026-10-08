#!/usr/bin/env bash
# Live quality, speed, and cost of Frank runs from production D1.
# Usage: scripts/live-metrics.sh [SINCE] [UNTIL]
#   SINCE / UNTIL: dates or datetimes SQLite understands (UTC), e.g. 2026-10-08 or
#   "2026-10-08 18:00". Defaults: SINCE = 7 days ago, UNTIL = now.
# Needs CLOUDFLARE_API_TOKEN in the environment (for example from .cf-token).
# Prints one row per run kind: runs, complete, failed, needs_input, mean seconds
# and stored cost of complete runs, and for product checks the share of claims
# that got a decision (verified, partially-verified, or contradicted).
set -euo pipefail

SINCE="${1:-$(date -u -d '7 days ago' +%F)}"
UNTIL="${2:-$(date -u '+%F %T')}"

case "$SINCE$UNTIL" in
  *\'*) echo "live-metrics: quotes are not allowed in dates" >&2; exit 2 ;;
esac

QUERY="SELECT COALESCE(kind,'research') kind, COUNT(*) runs,
  SUM(status='complete') complete, SUM(status='failed') failed,
  SUM(status='needs_input') needs_input,
  ROUND(AVG(CASE WHEN status='complete' THEN completed_at-created_at END)) mean_secs,
  ROUND(AVG(CASE WHEN status='complete' THEN cost_usd END),4) mean_usd,
  SUM(CASE WHEN kind='verification' AND status='complete'
      THEN json_array_length(result,'\$.claims') END) claims,
  SUM(CASE WHEN kind='verification' AND status='complete'
      THEN (SELECT COUNT(*) FROM json_each(result,'\$.claims') j
            WHERE json_extract(j.value,'\$.status') IN ('verified','partially-verified','contradicted'))
      END) decided
FROM research
WHERE created_at >= strftime('%s','$SINCE') AND created_at < strftime('%s','$UNTIL')
  AND query NOT LIKE '%order by%'
GROUP BY kind ORDER BY kind"

cd "$(dirname "$0")/.."
echo "window: $SINCE .. $UNTIL (UTC)"
npx wrangler d1 execute DB --remote --json --command "$QUERY" 2>/dev/null \
  | jq -r '.[0].results[]
      | [.kind, "runs=\(.runs)", "complete=\(.complete)", "failed=\(.failed)",
         "needs_input=\(.needs_input)", "mean_s=\(.mean_secs)", "mean_usd=\(.mean_usd)",
         (if .claims then "decided=\(.decided)/\(.claims) (\((.decided*100/.claims)|floor)%)" else "" end)]
      | @tsv'
