#!/bin/bash
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

CONFIG="$OPS/caddy/Caddyfile"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: ${CONFIG} not found. Run ops/bin/render-all.sh first." >&2
  exit 66
fi

CADDY_BIN=$(command -v caddy || true)
if [ -z "$CADDY_BIN" ]; then
  echo "ERROR: caddy not found in PATH" >&2
  exit 127
fi

exec "$CADDY_BIN" validate --config "$CONFIG" --adapter caddyfile
