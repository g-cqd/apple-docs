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

# Concurrency probe: fan out 16 unique search_docs calls and verify every one
# succeeds and /healthz stays responsive while the burst is in flight.
echo
echo "concurrency probe (16x search_docs + healthz during burst):"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pids=()
for i in $(seq 1 16); do
  body=$(printf '{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"search_docs","arguments":{"query":"probe-%d-%s","limit":5}}}' \
    "$i" "$i" "$(date +%s%N)")
  /usr/bin/curl -sS -o "$tmp/req_$i.out" -w "%{http_code} %{time_total}\n" --max-time 30 \
    -X POST "http://127.0.0.1:${MCP_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "$body" > "$tmp/req_$i.meta" &
  pids+=("$!")
done

sleep 0.1
hz_code=000
hz_time=-1
for attempt in 1 2 3; do
  hz_code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${MCP_PORT}/healthz" 2>/dev/null || echo 000)
  hz_time=$(/usr/bin/curl -sS -o /dev/null -w "%{time_total}" --max-time 5 "http://127.0.0.1:${MCP_PORT}/healthz" 2>/dev/null || echo -1)
  case "$hz_code" in 2*) break ;; esac
  sleep 1
done
printf '  healthz during burst -> HTTP %s in %ss (attempts: %s)\n' "$hz_code" "$hz_time" "$attempt"
case "$hz_code" in
  2*) ;;
  *) status=1 ;;
esac

for pid in "${pids[@]}"; do wait "$pid" || true; done
fail=0
for i in $(seq 1 16); do
  meta=$(cat "$tmp/req_$i.meta" 2>/dev/null || echo "000 -1")
  code="${meta%% *}"
  case "$code" in
    2*) ;;
    *) fail=$((fail + 1)); printf '  req %d failed: HTTP %s\n' "$i" "$code" ;;
  esac
done
printf '  burst: 16 requests, %d failures\n' "$fail"
[ "$fail" -eq 0 ] || status=1

exit "$status"
