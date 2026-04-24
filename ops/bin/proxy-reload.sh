#!/bin/bash
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

CONFIG="$OPS/caddy/Caddyfile"
ADMIN_ADDR=${CADDY_ADMIN_ADDRESS:-$CADDY_ADMIN_ADDR}
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CADDY_BIN=$(command -v caddy || true)
if [ -z "$CADDY_BIN" ]; then
  echo "ERROR: caddy not found in PATH" >&2
  exit 127
fi

"$OPS/bin/proxy-validate.sh"
exec "$CADDY_BIN" reload --config "$CONFIG" --adapter caddyfile --address "$ADMIN_ADDR"
