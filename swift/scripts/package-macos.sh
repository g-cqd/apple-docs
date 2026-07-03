#!/usr/bin/env bash
# package-macos.sh — build the distributable macOS artifact: the two native executables
# (`ad-cli`, `ad-server`) + the `libAppleDocsCore` dylib, staged into a versioned tarball.
#
# PLATFORM CONSTRAINT (real, not a TODO): macOS has NO static Swift stdlib — Apple ships the runtime
# in the OS (`/usr/lib/swift`), so `--static-swift-stdlib` is unavailable here and the binaries link
# the OS Swift runtime dynamically. "Standalone" therefore means "no Bun / no node_modules," not a
# static stdlib. Deployment floor: macOS 15 (macOS 26 when built with AD_HTTP3=1). The C deps
# (`libsqlite3`, `libzstd`, `libharfbuzz`) are `dlopen`ed from the OS/Homebrew at runtime, not bundled.
#
# CODESIGN / NOTARIZE: left as a documented TODO — it needs a Developer ID Application cert + an
# app-specific password. The hooks below are where they slot in (see the CODESIGN block).
#
# Usage:  ./scripts/package-macos.sh [--out DIR] [--version X.Y.Z]
#   Resolves siblings from the *_PATH env (see build.sh) or a sibling checkout; run under build.sh
#   or export the *_PATH vars yourself.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
swift_dir="$(cd "$script_dir/.." && pwd)"          # the SwiftPM package root (swift/)
repo_root="$(cd "$swift_dir/.." && pwd)"           # the apple-docs repo root

out_dir="$repo_root/dist"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -1)"
while [ $# -gt 0 ]; do
    case "$1" in
        --out) out_dir="$2"; shift 2 ;;
        --version) version="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
done
: "${version:=0.0.0}"

arch="$(uname -m)"                                  # arm64 / x86_64
stage="$(mktemp -d)"
pkgname="apple-docs-${version}-macos-${arch}"
trap 'rm -rf "$stage"' EXIT

echo "==> building ad-cli, ad-server, libAppleDocsCore (release)"
swift build -c release --package-path "$swift_dir" \
    --product ad-cli --product ad-server --product AppleDocsCore

bin_path="$(swift build -c release --package-path "$swift_dir" --show-bin-path)"
mkdir -p "$stage/$pkgname/bin" "$stage/$pkgname/lib"
cp "$bin_path/ad-cli" "$bin_path/ad-server" "$stage/$pkgname/bin/"
# The dylib name differs by platform; on macOS it is libAppleDocsCore.dylib.
cp "$bin_path/libAppleDocsCore.dylib" "$stage/$pkgname/lib/"
strip -x "$stage/$pkgname/bin/ad-cli" "$stage/$pkgname/bin/ad-server" 2>/dev/null || true

# CODESIGN (TODO — needs a Developer ID). Uncomment + set IDENTITY to enable:
#   IDENTITY="Developer ID Application: <NAME> (<TEAMID>)"
#   for f in "$stage/$pkgname/bin/"* "$stage/$pkgname/lib/"*; do
#     codesign --force --options runtime --timestamp --sign "$IDENTITY" "$f"
#   done
# Then notarize the tarball with `xcrun notarytool submit … --wait` and `xcrun stapler staple`.

cat > "$stage/$pkgname/MANIFEST.txt" <<EOF
apple-docs $version — macOS $arch (native Swift)
built: $(swift --version 2>/dev/null | head -1)
floor: macOS 15 (26 if AD_HTTP3=1); links the OS Swift runtime (no static stdlib on macOS)
runtime C deps (dlopen, not bundled): libsqlite3, libzstd, libharfbuzz
contents: bin/ad-cli, bin/ad-server, lib/libAppleDocsCore.dylib
codesign/notarize: NOT applied (see the script's CODESIGN block)
EOF

mkdir -p "$out_dir"
tar -C "$stage" -czf "$out_dir/$pkgname.tar.gz" "$pkgname"
echo "==> $out_dir/$pkgname.tar.gz"
tar -tzf "$out_dir/$pkgname.tar.gz"
