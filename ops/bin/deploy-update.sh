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

# 3b. Re-render templates, reload Caddy if its rendered config changed, and
# warn loudly if any installed plist drifted from its rendered template.
#
# Caddy reads its config straight from $OPS/caddy/Caddyfile, so a hash diff
# before/after rendering plus `caddy reload` is enough to ship template-only
# Caddyfile changes — `kickstart` of web/mcp does not touch Caddy.
#
# launchd plists are different: `kickstart -k` (used in step 7) sends SIGKILL
# and re-exec's the existing job WITHOUT re-reading the plist from disk. To
# pick up plist .tpl changes we'd need bootout + install (root-only) +
# bootstrap, which this script intentionally does not have rights to do.
# Surface the drift loudly so the operator can run `apple-docs-ops install`.
CADDYFILE="$OPS/caddy/Caddyfile"
PRE_CADDY_HASH=$(/usr/bin/shasum -a 256 "$CADDYFILE" 2>/dev/null | /usr/bin/awk '{print $1}' || echo "")
if run "$OPS/bin/render-all.sh"; then
  POST_CADDY_HASH=$(/usr/bin/shasum -a 256 "$CADDYFILE" 2>/dev/null | /usr/bin/awk '{print $1}' || echo "")
  if [ "$PRE_CADDY_HASH" != "$POST_CADDY_HASH" ]; then
    say "Caddyfile changed — reloading caddy"
    run "$OPS/bin/proxy-reload.sh" || say "WARN: caddy reload failed"
  else
    say "Caddyfile unchanged — skipping caddy reload"
  fi

  plist_drift=0
  for label in "${LABEL_PROXY}" "${LABEL_WEB}" "${LABEL_MCP}" "${LABEL_WATCHDOG}" "${LABEL_TUNNEL_WEB}" "${LABEL_TUNNEL_MCP}"; do
    rendered="$OPS/launchd/${label}.plist"
    installed="/Library/LaunchDaemons/${label}.plist"
    [ -f "$rendered" ] || continue
    [ -f "$installed" ] || { say "WARN: ${installed} not yet installed — run apple-docs-ops install"; plist_drift=1; continue; }
    if ! /usr/bin/cmp -s "$rendered" "$installed"; then
      say "WARN: plist drift for ${label} — rendered ${rendered} differs from installed copy"
      plist_drift=1
    fi
  done
  if [ "$plist_drift" = "1" ]; then
    say "WARN: one or more plists changed; kickstart will NOT pick them up. Run \`apple-docs-ops install\` to apply."
  fi
else
  say "WARN: render-all.sh failed; continuing with stale rendered config"
fi

# 4-6. Run ops commands. These can take a while; output streams to the log.
export PATH="$(dirname -- "$BUN"):$PATH"
run "$BUN" run "$REPO/cli.js" update            || say "(update returned $?)"
run "$BUN" run "$REPO/cli.js" sync --retry-failed || say "(sync --retry-failed returned $?)"
run "$BUN" run "$REPO/cli.js" doctor            || say "(doctor returned $?)"

# 6b. Rebuild the static site. Caddy serves ${STATIC_DIR} directly via
# `file_server`; this step is what makes the deploy actually visible to
# users. Incremental + resumable, so a partial run is safe and a re-run
# picks up where it left off (see src/web/build.js).
#
# Set REBUILD_STATIC_FULL=1 to force a full rebuild (clears the per-doc
# render index and writes via the staging directory).
if [ "${REBUILD_STATIC_FULL:-0}" = "1" ]; then
  run "$BUN" run "$REPO/cli.js" web build --full --out "$STATIC_DIR" --base-url "https://${PUBLIC_WEB_HOST}" || {
    say "ERROR: full static build failed — keeping existing ${STATIC_DIR}"
    exit 4
  }
else
  run "$BUN" run "$REPO/cli.js" web build --incremental --out "$STATIC_DIR" --base-url "https://${PUBLIC_WEB_HOST}" || {
    say "WARN: incremental static build failed — Caddy will keep serving the previous tree"
  }
fi

# 7. Cut over to the refreshed code + corpus.
#
#    Order matters: web/mcp first, then a short pause, then the watchdog.
#    Otherwise a `kickstart -k` of the watchdog can interrupt an in-flight
#    web/mcp kickstart it just initiated, leaving cooldown state stale and
#    extending the user-visible blip.
cutover_one() {
  local label="$1"
  local plist="/Library/LaunchDaemons/${label}.plist"
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
}

for label in "${LABEL_WEB}" "${LABEL_MCP}"; do
  cutover_one "$label"
done

# Let web/mcp settle before bouncing the watchdog so its first probe after
# restart sees the freshly-spawned backends, not the SIGKILLed ones.
sleep 3
cutover_one "${LABEL_WATCHDOG}"

# 8. Smoke tests
sleep 3
say "=== smoke tests ==="
if ! "$OPS/bin/smoke-test.sh" 2>&1 | tee -a "$LOG"; then
  say "WARN: one or more smoke tests failed"
fi

say "=== deploy-update done ==="
