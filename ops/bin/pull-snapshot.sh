#!/bin/bash
# Detect the latest snapshot release on GitHub and, if newer than what's
# applied locally, download + verify + apply it via `apple-docs setup
# --tier full --force`. Designed to be safe to re-run: silent no-op when
# the corpus is already up to date.
#
# This script is the snapshot-driven counterpart to deploy-update.sh: where
# deploy-update.sh refreshes the corpus by crawling Apple's docs from this
# host, pull-snapshot.sh trusts the latest scheduled GH Actions snapshot
# build (.github/workflows/snapshot.yml) and swaps the on-disk DB +
# resources directories in one atomic-ish step.
#
# Flow:
#   1. GET the latest "snapshot-*" release from the apple-docs repo.
#   2. Compare its tag against $OPS/state/applied-snapshot.
#   3. If newer (or --force):
#      a. Stop watchdog + web + mcp (in that order — watchdog first so it
#         doesn't try to revive a partially-swapped backend).
#      b. Run `apple-docs setup --tier <tier> --force --downgrade`. The
#         `setup` command already downloads from the same release, verifies
#         the SHA-256, removes stale resource dirs (raw-json, markdown,
#         resources/symbols, resources/fonts/extracted, symbol-renders),
#         extracts the tar, and stamps snapshot_meta in the new DB.
#      c. Rebuild the static site (incremental — it picks up the new corpus
#         and refreshes only what changed since the last manifest).
#      d. Bootstrap services back up: web → mcp → watchdog.
#      e. Smoke test.
#      f. Persist the applied tag so the next invocation no-ops.
#
# Exit codes:
#   0 — applied a new snapshot (or already current)
#   1 — refused (uncommitted changes / lockfile drift / GH unreachable)
#   2 — setup or post-install verification failed; services restored to
#       their pre-run state where possible
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

REPO=${APPLE_DOCS_REPO:-$REPO_DIR}
BUN="$BUN_BIN"
LOG_DIR="$OPS/logs"
LOG="$LOG_DIR/pull-snapshot.log"
STATE_DIR="${OPS}/state"
APPLIED_FILE="${STATE_DIR}/applied-snapshot"
TIER="${SNAPSHOT_TIER:-full}"
FORCE=${FORCE_PULL:-0}
GITHUB_REPO_SLUG="${GITHUB_REPO_SLUG:-g-cqd/apple-docs}"

# Allow `pull-snapshot.sh --force` from the CLI without exporting an env var.
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --tier=*) TIER="${arg#--tier=}" ;;
    -h|--help)
      sed -n '2,60p' "$0"
      exit 0
      ;;
  esac
done

mkdir -p "$LOG_DIR" "$STATE_DIR"

say() { printf '[%s] %s\n' "$(/bin/date -Iseconds)" "$*" | tee -a "$LOG"; }
run() { say "\$ $*"; "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

if [ ! -d "$REPO" ]; then
  say "ERROR: repo directory ${REPO} does not exist"
  exit 1
fi

say "=== pull-snapshot starting (tier=${TIER}, force=${FORCE}) ==="

# 1. Discover the latest release tag. We intentionally use the public
# /releases/latest endpoint so this works without a token. If it fails,
# bail loudly — we won't blindly install something we can't verify.
api_url="https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest"
say "querying ${api_url}"
release_json=$(/usr/bin/curl --fail --silent --show-error \
  --max-time 30 \
  --header 'Accept: application/vnd.github+json' \
  --header 'User-Agent: apple-docs-ops/1.0' \
  "$api_url" 2>>"$LOG" || true)

if [ -z "$release_json" ]; then
  say "ERROR: could not fetch latest release from GitHub"
  exit 1
fi

# Pick the tag name. /usr/bin/python3 is bundled with macOS; jq isn't always.
latest_tag=$(/usr/bin/python3 -c '
import json, sys
data = json.load(sys.stdin)
print(data.get("tag_name") or "", end="")
' <<<"$release_json")

if [ -z "$latest_tag" ]; then
  say "ERROR: latest release has no tag_name"
  exit 1
fi
say "latest release: ${latest_tag}"

# 2. Compare with the applied tag.
applied_tag=""
if [ -f "$APPLIED_FILE" ]; then
  applied_tag=$(/bin/cat "$APPLIED_FILE")
fi
say "currently applied: ${applied_tag:-<none>}"

if [ "$applied_tag" = "$latest_tag" ] && [ "$FORCE" != "1" ]; then
  say "already at ${latest_tag} — nothing to do"
  say "=== pull-snapshot done (no-op) ==="
  exit 0
fi

# 3a. Drop watchdog first, then the web/mcp backends. Watchdog kicks
# stalled backends, so leaving it up while we tear down would race.
stop_one() {
  local label="$1"
  if /usr/bin/sudo -n /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    say "stopping $label"
    /usr/bin/sudo -n /bin/launchctl bootout "system/$label" 2>&1 | tee -a "$LOG" \
      || say "(bootout returned non-zero — continuing)"
  else
    say "$label not loaded — skipping bootout"
  fi
}
start_one() {
  local label="$1"
  local plist="/Library/LaunchDaemons/${label}.plist"
  if [ ! -f "$plist" ]; then
    say "WARN: ${plist} missing — cannot start ${label}"
    return 1
  fi
  say "bootstrapping $label"
  /usr/bin/sudo -n /bin/launchctl bootstrap system "$plist" 2>&1 | tee -a "$LOG" \
    || /usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label" 2>&1 | tee -a "$LOG"
}

for label in "${LABEL_WATCHDOG}" "${LABEL_WEB}" "${LABEL_MCP}"; do
  stop_one "$label"
done

# 3b. Run apple-docs setup. The Bun command does the actual GH download
# (via getLatestRelease in src/commands/setup.js), checksum verification,
# and atomic-ish DB swap. We pass --downgrade because the user may be
# applying a snapshot of a smaller tier than what's currently installed.
export PATH="$(/usr/bin/dirname -- "$BUN"):$PATH"
setup_status=0
run "$BUN" run "$REPO/cli.js" setup --tier "$TIER" --force --downgrade || setup_status=$?

if [ "$setup_status" != "0" ]; then
  say "ERROR: apple-docs setup failed (exit $setup_status). Restoring services."
  for label in "${LABEL_WEB}" "${LABEL_MCP}" "${LABEL_WATCHDOG}"; do
    start_one "$label" || true
  done
  exit 2
fi

# 3b. Rebuild the static site against the freshly-installed corpus.
# Incremental keeps the existing dist/ directory online if the rebuild
# fails — caddy won't 404 mid-deploy.
run "$BUN" run "$REPO/cli.js" web build --incremental \
  --out "$STATIC_DIR" \
  --base-url "https://${PUBLIC_WEB_HOST}" \
  || say "WARN: incremental static build failed — Caddy keeps the previous tree"

# 3c. Bring services back. Order matters (web first, watchdog last) for
# the same reason as deploy-update.sh.
for label in "${LABEL_WEB}" "${LABEL_MCP}"; do
  start_one "$label"
done
sleep 3
start_one "${LABEL_WATCHDOG}" || say "WARN: watchdog didn't restart"

# 3d. Smoke. If the test fails we don't roll back automatically — the new
# corpus is already on disk and a manual reinstall via --force is cheap.
sleep 3
if ! "$OPS/bin/smoke-test.sh" 2>&1 | tee -a "$LOG"; then
  say "WARN: smoke test reported failures — investigate before declaring success"
fi

# 3e. Stamp the applied tag so the next run is a no-op.
echo "$latest_tag" > "$APPLIED_FILE"
say "stamped applied-snapshot=${latest_tag}"

say "=== pull-snapshot done ==="
