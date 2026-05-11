#!/bin/bash
# Sourced by every ops/bin/ script. Loads ops/.env, validates required vars,
# and exports them for child processes.
#
# Parses .env as KEY=VALUE data rather than `source`-ing it: `source` would
# execute the file as bash, so a compromised .env (writable by another
# user, dropped by a misconfigured deploy) could embed `$(rm -rf /)` and
# run as the ops owner. Ownership + mode 0600 are also enforced.

OPS_DIR_FROM_LIB=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${OPS_DIR_FROM_LIB}/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Copy ops/.env.example to ops/.env and edit it." >&2
  exit 78
fi

# Ownership + mode check. macOS stat: -f %Su (owner), %p (mode). Linux
# stat: -c %U / %a. Try both forms.
if stat -f %Su "$ENV_FILE" >/dev/null 2>&1; then
  ENV_OWNER=$(stat -f %Su "$ENV_FILE")
  ENV_MODE=$(stat -f '%A' "$ENV_FILE")  # decimal mode like 600
else
  ENV_OWNER=$(stat -c %U "$ENV_FILE")
  ENV_MODE=$(stat -c %a "$ENV_FILE")
fi
RUN_USER=$(id -un)
if [ "$ENV_OWNER" != "$RUN_USER" ]; then
  echo "ERROR: ${ENV_FILE} owner is ${ENV_OWNER}, expected ${RUN_USER}. Refusing to load." >&2
  exit 78
fi
if [ "$ENV_MODE" != "600" ] && [ "$ENV_MODE" != "0600" ]; then
  echo "ERROR: ${ENV_FILE} mode is ${ENV_MODE}, expected 0600. Run: chmod 0600 ${ENV_FILE}" >&2
  exit 78
fi

# Parse KEY=VALUE lines as data. Skips comments and blank lines. Strips
# surrounding single/double quotes from VALUE so the file format is the
# same KEY="value" syntax operators are used to writing — but no shell
# expansion runs, so a value of `$(rm -rf /)` lands as the literal string.
while IFS= read -r line || [ -n "$line" ]; do
  # Trim leading whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  case "$line" in
    ''|\#*) continue ;;
  esac
  # Require KEY=VALUE shape
  case "$line" in
    *=*) ;;
    *) continue ;;
  esac
  key="${line%%=*}"
  value="${line#*=}"
  # Reject keys that aren't valid identifiers (defense against header smuggling)
  if ! printf '%s' "$key" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
    echo "WARN: skipping invalid key in ${ENV_FILE}: ${key}" >&2
    continue
  fi
  # Strip matching outer quotes (single or double)
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  export "${key}=${value}"
done < "$ENV_FILE"

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
export LABEL_WATCHDOG="${LABEL_PREFIX}.watchdog"

# Where Caddy serves the prebuilt static site from. Defaults to
# ${REPO_DIR}/dist/web; override in .env to point elsewhere.
export STATIC_DIR="${STATIC_DIR:-${REPO_DIR}/dist/web}"

# Optional tuning variables. Defaults are laptop-sized; bump on dedicated
# hardware. See ops/.env.example for guidance.
export APPLE_DOCS_MCP_CACHE_SCALE="${APPLE_DOCS_MCP_CACHE_SCALE:-1}"

# Optional: comma-separated list of legacy launchd labels to bootout+remove
# before installing the new daemons. Useful when a previous deployment used a
# different label scheme (e.g. migrating from an external ops directory).
export LEGACY_LAUNCHD_LABELS="${LEGACY_LAUNCHD_LABELS:-}"
