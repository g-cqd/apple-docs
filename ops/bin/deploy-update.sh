#!/bin/bash
# Deploy-update flow for apple-docs:
#   1. Keep web + mcp serving while the repo and corpus refresh happen
#   2. Drop any uncommitted changes that are already on origin, fast-forward pull
#   3. bun install if lockfile or package.json changed
#   4. apple-docs update                  (pick up new roots / document changes)
#   5. apple-docs sync --retry-failed     (retry previously-failed crawl entries)
#   6. apple-docs doctor                  (schema migrations, re-resolve failures)
#   7. Cut over with a short restart/kickstart to pick up new code + fresh caches
#   8. Smoke test local + cloudflare edges
#
# Safe to re-run. Requires the sudoers drop-in from install-daemons.sh.
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

REPO=${APPLE_DOCS_REPO:-$REPO_DIR}
BUN="$BUN_BIN"
LOG_DIR="$OPS/logs"
LOG="$LOG_DIR/deploy-update.log"
KEEP_SERVING_DURING_REFRESH=${KEEP_SERVING_DURING_REFRESH:-1}
mkdir -p "$LOG_DIR"

say() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }
run() { say "\$ $*"; "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

if [ ! -d "$REPO" ]; then
  say "ERROR: repo directory ${REPO} does not exist"
  exit 1
fi

say "=== deploy-update starting ==="

if [ "$KEEP_SERVING_DURING_REFRESH" = "1" ]; then
  say "keeping web + mcp daemons online during refresh; cutover restart happens at the end"
else
  for label in "${LABEL_WEB}" "${LABEL_MCP}"; do
    say "stopping $label"
    /usr/bin/sudo -n /bin/launchctl bootout "system/$label" 2>&1 | tee -a "$LOG" || say "(already stopped or not loaded)"
  done
fi

# 2. Update repo
cd "$REPO" || { say "ERROR: $REPO missing"; exit 1; }
say "current HEAD: $(git rev-parse --short HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then
  say "working tree dirty — checking if changes are already on origin"
  git fetch origin --quiet
  if [ -z "$(git diff origin/main -- . 2>/dev/null)" ]; then
    say "local tree matches origin/main — resetting to drop local noise"
    run git reset --hard HEAD
    run git clean -fd -- src test cli.js
  else
    say "ERROR: local changes diverge from origin. Aborting deploy-update."
    say "Resolve manually: cd $REPO && git status"
    exit 2
  fi
fi

run git fetch origin --quiet
PRE_LOCK=$(git rev-parse HEAD:bun.lock 2>/dev/null || echo "")
PRE_PKG=$(git rev-parse HEAD:package.json 2>/dev/null || echo "")
if ! run git pull --ff-only origin main; then
  say "ERROR: git pull failed"
  exit 3
fi
say "new HEAD: $(git rev-parse --short HEAD)"
POST_LOCK=$(git rev-parse HEAD:bun.lock 2>/dev/null || echo "")
POST_PKG=$(git rev-parse HEAD:package.json 2>/dev/null || echo "")

# 3. Install deps if needed
if [ "$PRE_LOCK" != "$POST_LOCK" ] || [ "$PRE_PKG" != "$POST_PKG" ]; then
  say "package.json / bun.lock changed — running bun install"
  run "$BUN" install --frozen-lockfile || run "$BUN" install
else
  say "deps unchanged — skipping bun install"
fi

# 4-6. Run ops commands. These can take a while; output streams to the log.
export PATH="$(dirname -- "$BUN"):$PATH"
run "$BUN" run "$REPO/cli.js" update            || say "(update returned $?)"
run "$BUN" run "$REPO/cli.js" sync --retry-failed || say "(sync --retry-failed returned $?)"
run "$BUN" run "$REPO/cli.js" doctor            || say "(doctor returned $?)"

# 7. Cut over to the refreshed code + corpus
for label in "${LABEL_WEB}" "${LABEL_MCP}"; do
  plist="/Library/LaunchDaemons/${label}.plist"
  if /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    say "kickstarting $label for cutover"
    /usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label" 2>&1 | tee -a "$LOG" || say "ERROR: kickstart failed for $label"
  else
    say "bootstrapping $label"
    if /usr/bin/sudo -n /bin/launchctl bootstrap system "$plist" 2>&1 | tee -a "$LOG"; then
      say "bootstrapped $label"
    else
      say "bootstrap returned non-zero — attempting kickstart -k"
      /usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label" 2>&1 | tee -a "$LOG" || say "ERROR: kickstart failed for $label"
    fi
  fi
done

# 8. Smoke tests
sleep 3
say "=== smoke tests ==="
if ! "$OPS/bin/smoke-test.sh" 2>&1 | tee -a "$LOG"; then
  say "WARN: one or more smoke tests failed"
fi

say "=== deploy-update done ==="
