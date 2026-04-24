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

if ! command -v envsubst >/dev/null 2>&1; then
  echo "ERROR: envsubst not found. Install GNU gettext (macOS: \`brew install gettext\`)." >&2
  exit 127
fi

VARS='${USER_NAME} ${REPO_DIR} ${OPS_DIR} ${DATA_DIR} ${BUN_BIN}'
VARS+=' ${LABEL_PREFIX} ${LABEL_PROXY} ${LABEL_WEB} ${LABEL_MCP}'
VARS+=' ${LABEL_TUNNEL_WEB} ${LABEL_TUNNEL_MCP}'
VARS+=' ${WEB_PORT} ${MCP_PORT} ${WEB_BACKEND_PORT} ${MCP_BACKEND_PORT}'
VARS+=' ${PUBLIC_WEB_HOST} ${PUBLIC_MCP_HOST} ${CADDY_ADMIN_ADDR}'
VARS+=' ${TUNNEL_NAME_WEB} ${TUNNEL_NAME_MCP}'
VARS+=' ${CLOUDFLARED_CREDENTIALS_FILE_WEB} ${CLOUDFLARED_CREDENTIALS_FILE_MCP}'
VARS+=' ${CLOUDFLARED_BIN} ${APPLE_DOCS_MCP_CACHE_SCALE}'

mkdir -p "$(dirname -- "$OUTPUT")"
envsubst "$VARS" < "$TEMPLATE" > "$OUTPUT"

if grep -q '\${' "$OUTPUT"; then
  echo "WARN: ${OUTPUT} still contains \${…} placeholders; check .env completeness" >&2
fi

echo "rendered: ${TEMPLATE} -> ${OUTPUT}"
