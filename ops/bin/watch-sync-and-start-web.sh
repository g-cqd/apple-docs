#!/bin/bash
# Waits for an in-progress apple-docs sync PID to exit, then:
#   1. bootstraps the web daemon (if not already loaded),
#   2. kickstarts it to rebuild in-memory caches from the now-complete corpus,
#   3. kickstarts the MCP daemon so its per-tool LRU drops stale entries,
#   4. smoke-tests.
#
# Usage: SYNC_PID=<pid> ops/bin/watch-sync-and-start-web.sh
set -uo pipefail
BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

if [ -z "${SYNC_PID:-}" ]; then
  echo "ERROR: set SYNC_PID=<pid of apple-docs sync> before invoking this script" >&2
  exit 64
fi

LOG="$OPS/logs/watch-sync-and-start-web.log"
mkdir -p "$OPS/logs"
exec >>"$LOG" 2>&1
echo ""
echo "[$(date -Iseconds)] watcher started, waiting for PID $SYNC_PID"
while kill -0 "$SYNC_PID" 2>/dev/null; do sleep 15; done
echo "[$(date -Iseconds)] sync process exited"
echo "[$(date -Iseconds)] corpus disk usage:"
/usr/bin/du -sh "$DATA_DIR" || true

echo "[$(date -Iseconds)] ensuring web daemon is bootstrapped"
/usr/bin/sudo -n /bin/launchctl bootstrap system "/Library/LaunchDaemons/${LABEL_WEB}.plist" 2>&1 \
  || echo "(already bootstrapped or bootstrap failed — will kickstart anyway)"

echo "[$(date -Iseconds)] kickstarting web daemon to rebuild caches from completed corpus"
if /usr/bin/sudo -n /bin/launchctl kickstart -k "system/${LABEL_WEB}" 2>&1; then
  echo "[$(date -Iseconds)] web daemon kickstarted"
else
  echo "[$(date -Iseconds)] ERROR: could not kickstart web daemon (check sudoers drop-in)"
  exit 1
fi

echo "[$(date -Iseconds)] kickstarting MCP daemon to drop stale LRU entries post-corpus-refresh"
if /usr/bin/sudo -n /bin/launchctl kickstart -k "system/${LABEL_MCP}" 2>&1; then
  echo "[$(date -Iseconds)] mcp daemon kickstarted"
else
  echo "[$(date -Iseconds)] WARN: could not kickstart mcp daemon (check sudoers drop-in)"
fi

# Wait for the fresh bun process to start serving
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "[$(date -Iseconds)] local web responding 200 (attempt $i)"
    break
  fi
  echo "[$(date -Iseconds)] waiting for web daemon (attempt $i, got $code)..."
done

echo "[$(date -Iseconds)] cloudflare edge smoke test:"
"$OPS/bin/smoke-test.sh" || true
echo "[$(date -Iseconds)] watcher done"
