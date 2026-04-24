#!/bin/bash
# Ensure caddy is installed. Tries Homebrew first, then downloads the official
# release archive.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
INSTALL_DIR=${CADDY_INSTALL_DIR:-"$HOME/bin"}

if command -v caddy >/dev/null 2>&1; then
  command -v caddy
  exit 0
fi

if command -v brew >/dev/null 2>&1; then
  echo "Installing Caddy with Homebrew..."
  brew install caddy
  command -v caddy
  exit 0
fi

echo "Homebrew not found; downloading the official Caddy release binary instead..."

case "$(uname -m)" in
  arm64) caddy_arch="arm64" ;;
  x86_64) caddy_arch="amd64" ;;
  *)
    echo "ERROR: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

release_json=$(/usr/bin/curl -fsSL --retry 3 https://api.github.com/repos/caddyserver/caddy/releases/latest)
tag_name=$(printf '%s\n' "$release_json" | /usr/bin/sed -n 's/.*"tag_name": "\(v[0-9][^"]*\)".*/\1/p' | /usr/bin/head -n 1)
if [ -z "$tag_name" ]; then
  echo "ERROR: could not determine latest Caddy release tag" >&2
  exit 1
fi

version="${tag_name#v}"
archive="caddy_${version}_mac_${caddy_arch}.tar.gz"
url="https://github.com/caddyserver/caddy/releases/download/${tag_name}/${archive}"
tmp_dir=$(/usr/bin/mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

/usr/bin/curl -fL --retry 3 -o "$tmp_dir/$archive" "$url"
/usr/bin/tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
/bin/mkdir -p "$INSTALL_DIR"
/usr/bin/install -m 755 "$tmp_dir/caddy" "$INSTALL_DIR/caddy"

echo "Installed Caddy ${tag_name} to $INSTALL_DIR/caddy"
"$INSTALL_DIR/caddy" version
