#!/bin/bash
# Render a `.tpl` file by substituting only the explicit variables listed below.
# Using a variable list (instead of a bare `envsubst`) prevents accidental
# expansion of unrelated `${…}` fragments inside templates.
#
# Usage:
#   ops/lib/render.sh <template-path> <output-path>

set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=ops/lib/env.sh
. "${BIN_DIR}/env.sh"

if [ "$#" -ne 2 ]; then
  echo "usage: render.sh <template> <output>" >&2
  exit 64
fi

TEMPLATE="$1"
OUTPUT="$2"

if [ ! -f "$TEMPLATE" ]; then
  echo "ERROR: template ${TEMPLATE} not found" >&2
  exit 66
fi

ALLOWED_VARS=(
  USER_NAME REPO_DIR OPS_DIR DATA_DIR BUN_BIN STATIC_DIR
  LABEL_PREFIX LABEL_PROXY LABEL_WEB LABEL_MCP
  LABEL_TUNNEL_WEB LABEL_TUNNEL_MCP LABEL_WATCHDOG
  WEB_PORT MCP_PORT WEB_BACKEND_PORT MCP_BACKEND_PORT
  PUBLIC_WEB_HOST PUBLIC_MCP_HOST CADDY_ADMIN_ADDR
  TUNNEL_NAME_WEB TUNNEL_NAME_MCP
  CLOUDFLARED_CREDENTIALS_FILE_WEB CLOUDFLARED_CREDENTIALS_FILE_MCP
  CLOUDFLARED_BIN APPLE_DOCS_MCP_CACHE_SCALE
)

mkdir -p "$(dirname -- "$OUTPUT")"

if command -v envsubst >/dev/null 2>&1; then
  vars=""
  for v in "${ALLOWED_VARS[@]}"; do vars+=" \${${v}}"; done
  envsubst "$vars" < "$TEMPLATE" > "$OUTPUT"
elif command -v python3 >/dev/null 2>&1 || [ -x /usr/bin/python3 ]; then
  PY=$(command -v python3 2>/dev/null || echo /usr/bin/python3)
  ALLOWED_LIST=$(IFS=,; echo "${ALLOWED_VARS[*]}")
  ALLOWED_LIST="$ALLOWED_LIST" "$PY" - "$TEMPLATE" "$OUTPUT" <<'PYEOF'
import os, re, sys
allowed = set(os.environ["ALLOWED_LIST"].split(","))
src = open(sys.argv[1]).read()
# Match the same identifier grammar as envsubst (`[A-Za-z_][A-Za-z0-9_]*`)
# so adding a lowercase or mixed-case variable to ALLOWED_VARS just works.
out = re.sub(
    r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
    lambda m: os.environ.get(m.group(1), m.group(0)) if m.group(1) in allowed else m.group(0),
    src,
)
open(sys.argv[2], "w").write(out)
PYEOF
else
  echo "ERROR: neither envsubst nor python3 found; install GNU gettext or Python 3." >&2
  exit 127
fi

if grep -q '\${' "$OUTPUT"; then
  echo "WARN: ${OUTPUT} still contains \${…} placeholders; check .env completeness" >&2
fi

echo "rendered: ${TEMPLATE} -> ${OUTPUT}"
