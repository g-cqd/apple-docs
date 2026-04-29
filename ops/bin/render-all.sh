#!/bin/bash
# Render every .tpl under ops/ into a sibling file.
#
# For launchd plists, the rendered filename uses the operator's label prefix
# (e.g. `${LABEL_MCP}.plist` = `local.apple-docs.mcp.plist`) so install-
# daemons.sh can locate the artifact for each label. For every other template
# (Caddyfile, cloudflared/*.yml, sudoers) the rendered filename is just the
# template basename without `.tpl`.
#
# Idempotent: re-run after editing .env to refresh generated config.
set -euo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

RENDER="${OPS}/lib/render.sh"

# Map known launchd template basenames to their rendered plist filenames.
# Templates are committed with readable, label-agnostic basenames so a reader
# can tell proxy/web/mcp/tunnel-web/tunnel-mcp apart at a glance. Rendered
# plists must match the LABEL_* schema so install-daemons.sh finds them.
plist_output_for() {
  case "$1" in
    apple-docs.proxy.plist.tpl)          echo "${LABEL_PROXY}.plist" ;;
    apple-docs.web.plist.tpl)            echo "${LABEL_WEB}.plist" ;;
    apple-docs.mcp.plist.tpl)            echo "${LABEL_MCP}.plist" ;;
    apple-docs.watchdog.plist.tpl)       echo "${LABEL_WATCHDOG}.plist" ;;
    cloudflared.apple-docs.plist.tpl)    echo "${LABEL_TUNNEL_WEB}.plist" ;;
    cloudflared.apple-docs-mcp.plist.tpl) echo "${LABEL_TUNNEL_MCP}.plist" ;;
    *) return 1 ;;
  esac
}

while IFS= read -r tpl; do
  dir=$(dirname -- "$tpl")
  name=$(basename -- "$tpl")
  if [ "$dir" = "${OPS}/launchd" ] && [ "$name" != "sudoers.apple-docs-launchctl.tpl" ]; then
    if mapped=$(plist_output_for "$name"); then
      out="${dir}/${mapped}"
    else
      echo "WARN: unknown launchd template ${name} — rendering at default path" >&2
      out="${tpl%.tpl}"
    fi
  else
    out="${tpl%.tpl}"
  fi
  "$RENDER" "$tpl" "$out"
done < <(find "$OPS" -type f -name '*.tpl' | sort)

echo "All templates rendered from ${OPS}/.env"
