#!/bin/bash
# Installs apple-docs LaunchDaemons + sudoers drop-in. Must be run as root.
# Idempotent. Renders all .tpl files first from ops/.env.
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "This script must be run with sudo." >&2
  exit 1
fi

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

UID_OWNER=$(id -u "$USER_NAME")
# sudoers(5): files in /etc/sudoers.d/ whose names contain '.' are silently
# skipped by sudo. Strip dots from LABEL_PREFIX so a reverse-DNS-style prefix
# like "local.apple-docs" still yields a valid drop-in filename.
SUDOERS_STEM="${LABEL_PREFIX//./_}"
SUDOERS_FILE="/etc/sudoers.d/${SUDOERS_STEM}-launchctl"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$OPS/logs"

echo "=== rendering templates ==="
sudo -u "$USER_NAME" "$OPS/bin/render-all.sh"

# Each entry: <plist-basename>
DAEMONS=(
  "${LABEL_PROXY}.plist"
  "${LABEL_WEB}.plist"
  "${LABEL_MCP}.plist"
  "${LABEL_TUNNEL_WEB}.plist"
  "${LABEL_TUNNEL_MCP}.plist"
)
APP_DAEMONS=(
  "${LABEL_PROXY}.plist"
  "${LABEL_WEB}.plist"
  "${LABEL_MCP}.plist"
)

echo ""
echo "=== unloading any stale user LaunchAgents for ${USER_NAME} ==="
for plist in "${DAEMONS[@]}"; do
  label="${plist%.plist}"
  sudo -u "$USER_NAME" /bin/launchctl bootout "gui/${UID_OWNER}/${label}" 2>/dev/null || true
  rm -f "/Users/${USER_NAME}/Library/LaunchAgents/${plist}"
done

echo ""
echo "=== ensuring caddy is installed for ${USER_NAME} ==="
sudo -u "$USER_NAME" "$OPS/bin/ensure-caddy.sh"
sudo -u "$USER_NAME" "$OPS/bin/proxy-validate.sh"

echo ""
echo "=== unloading app daemons before reinstall ==="
for plist in "${APP_DAEMONS[@]}"; do
  label="${plist%.plist}"
  /bin/launchctl bootout "system/${label}" 2>/dev/null || true
done

echo ""
echo "=== installing plists to /Library/LaunchDaemons ==="
for plist in "${DAEMONS[@]}"; do
  src="$OPS/launchd/$plist"
  if [ -f "$src" ]; then
    install -o root -g wheel -m 644 "$src" /Library/LaunchDaemons/
  else
    echo "skip: $src missing"
  fi
done
ls -la "/Library/LaunchDaemons/${LABEL_PREFIX}".*

echo ""
echo "=== bootstrapping app daemons ==="
for plist in "${APP_DAEMONS[@]}"; do
  path="/Library/LaunchDaemons/${plist}"
  if [ -f "$path" ]; then
    if /bin/launchctl bootstrap system "$path" 2>&1; then
      echo "bootstrapped: ${plist}"
    else
      rc=$?
      echo "bootstrap of ${plist} returned ${rc} — attempting kickstart instead"
      label="${plist%.plist}"
      /bin/launchctl kickstart -k "system/${label}" 2>&1 || true
    fi
  fi
done

echo ""
echo "=== ensuring cloudflared daemons are loaded ==="
for plist in "${LABEL_TUNNEL_WEB}.plist" "${LABEL_TUNNEL_MCP}.plist"; do
  path="/Library/LaunchDaemons/${plist}"
  if [ -f "$path" ]; then
    label="${plist%.plist}"
    if /bin/launchctl print "system/${label}" >/dev/null 2>&1; then
      /bin/launchctl kickstart -k "system/${label}" 2>&1 || true
    elif /bin/launchctl bootstrap system "$path" 2>&1; then
      echo "bootstrapped: ${plist}"
    else
      echo "WARN: could not ensure ${plist} is loaded" >&2
    fi
  fi
done

echo ""
echo "=== validating + installing sudoers drop-in ==="
RENDERED_SUDOERS="$OPS/launchd/sudoers.apple-docs-launchctl"
/usr/sbin/visudo -cf "$RENDERED_SUDOERS"
install -o root -g wheel -m 440 "$RENDERED_SUDOERS" "$SUDOERS_FILE"
ls -la "$SUDOERS_FILE"

echo ""
echo "=== waiting 8s for tunnels and services to settle ==="
sleep 8

echo ""
echo "=== smoke tests ==="
if ! sudo -u "$USER_NAME" "$OPS/bin/smoke-test.sh"; then
  echo "WARN: one or more smoke tests failed" >&2
fi

echo ""
echo "DONE."
