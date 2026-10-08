#!/usr/bin/env bash
# Periodic Frank health and quality watch. Run by the systemd user timer
# frank-metrics.timer (every 6 hours). Appends a report to
# ~/.local/state/frank-metrics/<UTC date>.log and raises a desktop
# notification plus a line in alerts.log when a threshold is crossed:
#   failed runs > 0, product-check decided share < 30%, mean product check
#   > 300 s, OpenRouter key headroom < $5, SearXNG answering without the gate.
# Secrets come from .cf-token (Cloudflare) and BWS (OpenRouter provisioning
# key); none are printed or written to the log.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/frank-metrics"
BASELINE="${FRANK_METRICS_BASELINE:-2026-10-08 14:00}"
OR_KEY_HASH="e187b167885220dd4ea3e5da1885ed7fc0a1780528086da372b7c681db828d62"
mkdir -p "$STATE"
LOG="$STATE/$(date -u +%F).log"
ALERTS=()

cd "$REPO" || exit 1
set -a
# shellcheck disable=SC1091
. <(grep -v '^#' .cf-token)
# shellcheck disable=SC1091
. "$HOME/.config/environment.d/bws.conf"
set +a

{
  echo "=== $(date -u '+%F %T') UTC ==="
  RECENT="$(scripts/live-metrics.sh "$(date -u -d '6 hours ago' '+%F %T')" 2>&1)"
  SINCE="$(scripts/live-metrics.sh "$BASELINE" 2>&1)"
  echo "-- last 6 hours"; echo "$RECENT"
  echo "-- since baseline"; echo "$SINCE"
} >> "$LOG"

# Thresholds on the last 6 hours.
failed=$(echo "$RECENT" | grep -oE 'failed=[0-9]+' | cut -d= -f2 | awk '{s+=$1} END {print s+0}')
[ "${failed:-0}" -gt 0 ] 2>/dev/null && ALERTS+=("$failed failed run(s) in the last 6 h")
ver_line="$(echo "$RECENT" | grep '^verification' || true)"
if [ -n "$ver_line" ]; then
  pct=$(echo "$ver_line" | grep -oE '\(([0-9]+)%\)' | tr -dc '0-9')
  [ -n "$pct" ] && [ "$pct" -lt 30 ] && ALERTS+=("product checks decided only ${pct}% of claims")
  secs=$(echo "$ver_line" | grep -oE 'mean_s=[0-9]+' | cut -d= -f2)
  [ -n "$secs" ] && [ "$secs" -gt 300 ] && ALERTS+=("mean product check took ${secs} s")
fi

P=$(bws secret list 2>/dev/null | jq -r '.[] | select(.key=="OPENROUTER_PROVISIONING_KEY") | .value')
headroom=$(curl -s -m 20 "https://openrouter.ai/api/v1/keys/$OR_KEY_HASH" -H "Authorization: Bearer $P" \
  | jq -r '.data | (.limit - .usage)' 2>/dev/null)
unset P
echo "openrouter headroom: \$${headroom:-unknown}" >> "$LOG"
if [ -z "$headroom" ] || [ "$headroom" = "null" ]; then
  ALERTS+=("could not read OpenRouter headroom")
elif awk "BEGIN{exit !($headroom < 5)}"; then
  ALERTS+=("OpenRouter key headroom is \$$headroom")
fi

gate=$(curl -s -m 20 -o /dev/null -w '%{http_code}' 'https://litellm.wafflemedia.net/search?q=test&format=json')
echo "searxng without header: HTTP $gate" >> "$LOG"
[ "$gate" != "403" ] && ALERTS+=("SearXNG gate answered $gate without the header (expected 403)")

if [ "${#ALERTS[@]}" -gt 0 ]; then
  msg="$(printf '%s; ' "${ALERTS[@]}")"
  echo "ALERT: $msg" >> "$LOG"
  echo "$(date -u '+%F %T') $msg" >> "$STATE/alerts.log"
  command -v notify-send >/dev/null && notify-send -u critical "Frank needs attention" "$msg"
else
  echo "OK" >> "$LOG"
fi
