#!/bin/bash
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

ADMIN_ADDR=${CADDY_ADMIN_ADDRESS:-$CADDY_ADMIN_ADDR}

echo "== Caddy upstream status =="
curl -fsS "http://$ADMIN_ADDR/reverse_proxy/upstreams" || {
  echo "ERROR: could not query Caddy admin API at $ADMIN_ADDR" >&2
  exit 1
}
echo ""
