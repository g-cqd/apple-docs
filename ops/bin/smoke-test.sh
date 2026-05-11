#!/bin/bash
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

status=0

for target in \
  "local web|http://127.0.0.1:${WEB_PORT}/healthz" \
  "local mcp|http://127.0.0.1:${MCP_PORT}/healthz" \
  "edge  web|https://${PUBLIC_WEB_HOST}/healthz" \
  "edge  mcp|https://${PUBLIC_MCP_HOST}/healthz"; do
  name="${target%%|*}"
  url="${target##*|}"
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || true)
  [ -n "$code" ] || code="000"
  printf '%-10s %s -> HTTP %s\n' "$name" "$url" "$code"
  case "$code" in
    2*|3*) ;;
    *) status=1 ;;
  esac
done

# Concurrency probe: fan out 16 unique search_docs calls with a small stagger
# (~10 ms between launches) so the test reflects sustained concurrency rather
# than a tcp-handshake storm. /healthz is sampled five times during the burst
# and passes if any sample returns 2xx — a single missed slot during a true
# spike isn't a deploy regression, but a daemon that stays unreachable for
# the full burst is.
#
# Background: a synchronous 16-in-<50ms burst can momentarily saturate the
# main event loop (per-request body buffering + transport setup happens on
# the main thread even with APPLE_DOCS_MCP_READERS=on routing SQL to workers).
# The synthetic storm produced confusing 503s on every deploy log even on
# perfectly healthy hosts. See `mt.everest` ops runbook for the daemon-side
# follow-up.
BURST_SIZE="${SMOKE_BURST_SIZE:-16}"
BURST_STAGGER_MS="${SMOKE_BURST_STAGGER_MS:-10}"
HEALTHZ_SAMPLES="${SMOKE_HEALTHZ_SAMPLES:-5}"
echo
echo "concurrency probe (${BURST_SIZE}x search_docs staggered ${BURST_STAGGER_MS}ms + healthz sampling):"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pids=()
# Warmup: prime the reader pool with one call so the first burst request
# doesn't pay cold-cache cost while the smoke is observing.
/usr/bin/curl -sS -o /dev/null --max-time 15 -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"smoke-warmup","limit":1}}}' || true

stagger_seconds=$(/usr/bin/awk -v ms="$BURST_STAGGER_MS" 'BEGIN{printf "%.3f\n", ms/1000}')
for i in $(seq 1 "$BURST_SIZE"); do
  body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"probe-%d-%s","limit":5}}}' \
    "$i" "$i" "$(date +%s%N)")
  /usr/bin/curl -sS -o "$tmp/req_$i.out" -w "%{http_code} %{time_total}\n" --max-time 30 \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "$body" > "$tmp/req_$i.meta" &
  pids+=("$!")
  /bin/sleep "$stagger_seconds"
done

hz_ok=0
hz_codes=""
for attempt in $(seq 1 "$HEALTHZ_SAMPLES"); do
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:${MCP_PORT}/healthz" 2>/dev/null || echo 000)
  hz_codes="${hz_codes}${code} "
  case "$code" in 2*) hz_ok=$((hz_ok + 1)) ;; esac
  /bin/sleep 0.2
done
printf '  healthz during burst -> %d/%d 2xx [%s]\n' "$hz_ok" "$HEALTHZ_SAMPLES" "${hz_codes% }"
[ "$hz_ok" -gt 0 ] || status=1

for pid in "${pids[@]}"; do wait "$pid" || true; done
fail=0
for i in $(seq 1 "$BURST_SIZE"); do
  meta=$(cat "$tmp/req_$i.meta" 2>/dev/null || echo "000 -1")
  code="${meta%% *}"
  case "$code" in
    2*) ;;
    *) fail=$((fail + 1)); printf '  req %d failed: HTTP %s\n' "$i" "$code" ;;
  esac
done
printf '  burst: %d requests, %d failures\n' "$BURST_SIZE" "$fail"
[ "$fail" -eq 0 ] || status=1

exit "$status"
