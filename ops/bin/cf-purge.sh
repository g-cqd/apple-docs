#!/bin/bash
# Wipe the Cloudflare edge cache for the apple-docs zone.
#
# Run by deploy-update.sh and pull-snapshot.sh after a successful corpus
# refresh + static rebuild. Without this, edge-cached /api/search and
# /api/filters responses would stay served for up to their max-age (5 min)
# after the underlying corpus changed.
#
# Uses purge_everything (single API call, single quota slot) rather than
# enumerating URLs:
#   - Refreshes API JSON, static HTML, and search artifacts in one shot.
#   - Single Mac mini deploy cadence is far below CF's purge_everything rate
#     limits, so we are not at risk of running out.
#   - No URL list to keep in sync with the routes that actually emit a
#     Cache-Control header.
#
# Soft-fails if the token / zone is not configured: prints a warning, exits 0
# so the deploy as a whole still reports success. The token only needs
# Zone.Cache Purge for the single zone.
#
# Exit codes:
#   0  purge succeeded, OR token/zone not configured (warned)
#   1  configured but the API call returned a non-success payload
set -uo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

LOG_DIR="$OPS/logs"
LOG="$LOG_DIR/cf-purge.log"
mkdir -p "$LOG_DIR"

say() { printf '[%s] %s\n' "$(/bin/date -Iseconds)" "$*" | tee -a "$LOG"; }

token="${CLOUDFLARE_API_TOKEN:-}"
zone="${CLOUDFLARE_ZONE_ID:-}"

if [ -z "$token" ] || [ -z "$zone" ]; then
  say "WARN: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID not set in ${OPS}/.env — skipping edge purge"
  say "      Stale /api/search and /api/filters may persist at the edge for up to 5 min."
  exit 0
fi

say "purging zone ${zone:0:8}…"

# Capture both body and HTTP status so we can decide success without parsing
# Cloudflare's payload twice. --fail-with-body would also work but its support
# matrix is curl 7.76+, and we want to stay portable to whatever ships with
# stock macOS.
response_file=$(/usr/bin/mktemp)
http_status=$(/usr/bin/curl -s -o "$response_file" -w '%{http_code}' \
  --max-time 30 \
  -X POST "https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}' 2>>"$LOG" || echo 000)

if [ "$http_status" != "200" ]; then
  say "ERROR: Cloudflare purge HTTP ${http_status}"
  /bin/cat "$response_file" | tee -a "$LOG" || true
  /bin/rm -f "$response_file"
  exit 1
fi

# Cloudflare returns 200 with success:false on auth/permission failures, so
# the body has to be checked even when the HTTP code looks healthy.
if ! /usr/bin/grep -q '"success":true' "$response_file"; then
  say "ERROR: Cloudflare purge response did not report success"
  /bin/cat "$response_file" | tee -a "$LOG" || true
  /bin/rm -f "$response_file"
  exit 1
fi

/bin/rm -f "$response_file"
say "purge ok"
