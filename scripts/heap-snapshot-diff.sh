#!/usr/bin/env bash
#
# heap-snapshot-diff.sh — capture two Bun heap snapshots separated by a
# workload, then summarize the delta. Phase 3.4 of the JavaScript
# performance SOTA plan.
#
# Workflow this captures:
#   1. Cold start: Bun web serve + heap-prof
#   2. Warmup workload (curl bursts so the trigram cache, render cache,
#      reader pool, FTS prepared statements all populate).
#   3. Quiesce.
#   4. Second snapshot via SIGUSR2 (Bun's --heap-prof file lands on exit;
#      between exits we use the file system mtime to compare runs).
#
# Usage:
#   scripts/heap-snapshot-diff.sh [--port 3030] [--workload curl_bursts] [--out reports/profiles]
#
# Outputs:
#   reports/profiles/cold-<timestamp>/Heap.<n>.<pid>.heapsnapshot
#   reports/profiles/warm-<timestamp>/Heap.<n>.<pid>.heapsnapshot
#   reports/profiles/heap-diff.<timestamp>.txt
#
# The diff is intentionally simple: file size of each profile + RSS at
# quiesce, because Bun's heap-prof output is opaque enough that
# automated bytewise diffing isn't useful. Operators load both
# .heapsnapshot files into Chrome DevTools (Memory tab → Comparison
# view) for the actual analysis.

set -euo pipefail

PORT=3030
WORKLOAD="curl_bursts"
OUT_DIR="reports/profiles"
WARMUP_SECONDS=20

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)      PORT="$2"; shift 2 ;;
    --workload)  WORKLOAD="$2"; shift 2 ;;
    --out)       OUT_DIR="$2"; shift 2 ;;
    --warmup)    WARMUP_SECONDS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

ts="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

cold_dir="$OUT_DIR/cold-$ts"
warm_dir="$OUT_DIR/warm-$ts"
mkdir -p "$cold_dir" "$warm_dir"

echo "==> phase 1: cold-start snapshot ($cold_dir)"
bun --heap-prof --heap-prof-dir "$cold_dir" cli.js web serve --port "$PORT" --metrics-port $((PORT + 70)) &
cold_pid=$!

# Give the server time to bind + warm the SQLite handle.
sleep 3

# Probe once so the cold profile contains *something* beyond bare boot.
curl -sS -o /dev/null "http://127.0.0.1:$PORT/healthz" || true

echo "==> stopping cold instance to flush profile"
kill -TERM "$cold_pid"
wait "$cold_pid" 2>/dev/null || true

# Phase 2: warm run with the configured workload.
echo "==> phase 2: warm snapshot after $WARMUP_SECONDS s of $WORKLOAD ($warm_dir)"
bun --heap-prof --heap-prof-dir "$warm_dir" cli.js web serve --port "$PORT" --metrics-port $((PORT + 70)) &
warm_pid=$!
sleep 3

case "$WORKLOAD" in
  curl_bursts)
    # Hammer a mix of routes so the render cache, search cache, and
    # reader-pool prepared statements all warm. Each curl has its own
    # 2s timeout; the loop sleeps to bound concurrent fan-out. Errors
    # tolerated — the goal is to drive load, not validate.
    end=$(($(date +%s) + WARMUP_SECONDS))
    while [[ $(date +%s) -lt $end ]]; do
      curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true
      curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/api/search?q=View" 2>/dev/null || true
      curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/api/search?q=NavigationStack&framework=swiftui" 2>/dev/null || true
      curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$PORT/api/symbols/search?q=heart" 2>/dev/null || true
    done
    ;;
  none)
    sleep "$WARMUP_SECONDS"
    ;;
  *)
    echo "unknown workload: $WORKLOAD (expected curl_bursts | none)" >&2
    kill "$warm_pid" 2>/dev/null || true
    exit 2
    ;;
esac

# Capture RSS before kill so the diff text can show the gain. `ps`
# returns nonzero if the pid is already gone — wrap in `|| true` so
# the diff still writes when the process raced ahead.
rss_kb=$( { ps -o rss= -p "$warm_pid" 2>/dev/null || true; } | tr -d ' ')

echo "==> stopping warm instance to flush profile"
kill -TERM "$warm_pid" 2>/dev/null || true
wait "$warm_pid" 2>/dev/null || true
# Bun's --heap-prof flush completes after the worker thread tears down.
# Give it a generous moment so the file system catches up.
sleep 2

# Bun writes Heap.<n>.<pid>.heapsnapshot inside the prof dir. Take the latest.
cold_file=$(ls -1t "$cold_dir"/Heap.*.heapsnapshot 2>/dev/null | head -1 || true)
warm_file=$(ls -1t "$warm_dir"/Heap.*.heapsnapshot 2>/dev/null | head -1 || true)

diff_path="$OUT_DIR/heap-diff.$ts.txt"
{
  echo "Heap snapshot diff — $ts"
  echo "  workload: $WORKLOAD ($WARMUP_SECONDS s)"
  echo "  cold profile: ${cold_file:-<missing>}"
  echo "  warm profile: ${warm_file:-<missing>}"
  echo "  warm RSS at quiesce: ${rss_kb:-?} KB"
  echo
  if [[ -f "$cold_file" && -f "$warm_file" ]]; then
    cold_size=$(wc -c < "$cold_file")
    warm_size=$(wc -c < "$warm_file")
    echo "  cold file size: $cold_size bytes"
    echo "  warm file size: $warm_size bytes"
    echo "  warm-cold size delta: $((warm_size - cold_size)) bytes"
  else
    echo "  (one or both profile files missing — re-run with logs for diagnosis)"
  fi
  echo
  echo "Next step: open both .heapsnapshot files in Chrome DevTools (Memory"
  echo "tab) and use 'Comparison' to find which constructors retained more"
  echo "after warmup. Common offenders: trigram cache (Map<string, Array>),"
  echo "render cache, prepared-statement strings, FTS row arrays."
} | tee "$diff_path"

echo
echo "Done. Diff at: $diff_path"
