#!/bin/bash
# Render every .tpl under ops/ into a sibling file without the .tpl suffix.
# Idempotent: re-run after editing .env to refresh generated config.
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

RENDER="${OPS}/lib/render.sh"

while IFS= read -r tpl; do
  out="${tpl%.tpl}"
  "$RENDER" "$tpl" "$out"
done < <(find "$OPS" -type f -name '*.tpl' | sort)

echo "All templates rendered from ${OPS}/.env"
