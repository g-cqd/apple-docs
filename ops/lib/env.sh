#!/bin/bash
# Sourced by every ops/bin/ script. Loads ops/.env, validates required vars,
# and exports them for child processes.

OPS_DIR_FROM_LIB=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${OPS_DIR_FROM_LIB}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Copy ops/.env.example to ops/.env and edit it." >&2
  exit 78
fi

# shellcheck disable=SC1090
set -a
. "$ENV_FILE"
set +a

REQUIRED_VARS=(
  USER_NAME REPO_DIR OPS_DIR DATA_DIR BUN_BIN LABEL_PREFIX
  WEB_PORT MCP_PORT WEB_BACKEND_PORT MCP_BACKEND_PORT
  PUBLIC_WEB_HOST PUBLIC_MCP_HOST CADDY_ADMIN_ADDR
  TUNNEL_NAME_WEB TUNNEL_NAME_MCP
  CLOUDFLARED_CREDENTIALS_FILE_WEB CLOUDFLARED_CREDENTIALS_FILE_MCP
  CLOUDFLARED_BIN
)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: required variable ${var} is unset in ${ENV_FILE}" >&2
    exit 78
  fi
done

# Derived labels used everywhere (plists, sudoers, launchctl commands).
export LABEL_PROXY="${LABEL_PREFIX}.proxy"
export LABEL_WEB="${LABEL_PREFIX}.web"
export LABEL_MCP="${LABEL_PREFIX}.mcp"
export LABEL_TUNNEL_WEB="${LABEL_PREFIX}.cloudflared.web"
export LABEL_TUNNEL_MCP="${LABEL_PREFIX}.cloudflared.mcp"

# Optional tuning variables. Defaults are laptop-sized; bump on dedicated
# hardware. See ops/.env.example for guidance.
export APPLE_DOCS_MCP_CACHE_SCALE="${APPLE_DOCS_MCP_CACHE_SCALE:-1}"

# Optional: comma-separated list of legacy launchd labels to bootout+remove
# before installing the new daemons. Useful when a previous deployment used a
# different label scheme (e.g. migrating from an external ops directory).
export LEGACY_LAUNCHD_LABELS="${LEGACY_LAUNCHD_LABELS:-}"
