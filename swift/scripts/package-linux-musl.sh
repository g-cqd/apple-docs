#!/usr/bin/env bash
# package-linux-musl.sh — RECIPE (+ best-effort attempt) for a static Linux artifact.
#
# SCOPE: on Linux the shippable pieces are `ad-cli` + `libAppleDocsCore.so` ONLY — `ad-server` is
# Apple-native (Network.framework transport) and is NOT built on Linux (see Package.swift:147).
#
# STATIC LINKING via the swift-linux-musl SDK (`--swift-sdk … --static-swift-stdlib`) links the Swift
# runtime statically (unlike macOS). The HARD PART is the C dependencies: `ad-cli`/the dylib `dlopen`
# `libsqlite3` / `libzstd` / `libharfbuzz` at RUNTIME (not link time). A fully-static musl binary has
# no dynamic loader, so `dlopen` of a system .so does not work from a static executable — those libs
# must either be (a) statically archived into the binary (needs musl-built .a's + a source change to
# link rather than dlopen), or (b) the binary built as "mostly static" (static stdlib, dynamic libc)
# so `dlopen` still functions. Option (b) is the pragmatic target; option (a) is a larger change.
#
# This script attempts option (b) and REPORTS the outcome; if the musl SDK / C-dep resolution is not
# in place, it prints the precise blocker rather than failing silently.
#
# Prereqable:
#   swift sdk install <swift-6.4 musl SDK bundle>   # e.g. from swift.org static-linux-sdk
#   apt/apk: sqlite/zstd/harfbuzz dev packages for the target, if archiving statically
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
swift_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$swift_dir/.." && pwd)"
out_dir="${1:-$repo_root/dist}"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -1)"
: "${version:=0.0.0}"

# Discover an installed musl SDK id (empty ⇒ not installed).
musl_sdk="$(swift sdk list 2>/dev/null | grep -iE 'musl' | head -1 | awk '{print $1}')"
if [ -z "$musl_sdk" ]; then
    cat >&2 <<EOF
BLOCKER: no swift-linux-musl SDK installed.
  Install one: \`swift sdk install <URL-to-swift-6.4-static-linux-sdk>\` (see swift.org/download).
  Then re-run. Without it a static Linux build cannot be produced.
This recipe is validated to the point of SDK discovery; the static link + dlopen-C-dep resolution
(see the header) is the remaining work, documented for the operator.
EOF
    exit 3
fi

arch="$(uname -m)"
pkgname="apple-docs-${version}-linux-musl-${arch}"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT

echo "==> building ad-cli + libAppleDocsCore against $musl_sdk (static stdlib)"
# NOTE: ad-server intentionally omitted (Apple-only).
if ! swift build -c release --package-path "$swift_dir" \
    --swift-sdk "$musl_sdk" --static-swift-stdlib \
    --product ad-cli --product AppleDocsCore 2>"$stage/build.err"; then
    echo "BLOCKER: musl build failed — likely the dlopen'd C deps (sqlite3/zstd/harfbuzz). Detail:" >&2
    tail -20 "$stage/build.err" >&2
    exit 4
fi

bin_path="$(swift build -c release --package-path "$swift_dir" --swift-sdk "$musl_sdk" --show-bin-path)"
mkdir -p "$stage/$pkgname/bin" "$stage/$pkgname/lib" "$out_dir"
cp "$bin_path/ad-cli" "$stage/$pkgname/bin/"
cp "$bin_path/libAppleDocsCore.so" "$stage/$pkgname/lib/"
tar -C "$stage" -czf "$out_dir/$pkgname.tar.gz" "$pkgname"
echo "==> $out_dir/$pkgname.tar.gz (ad-cli + libAppleDocsCore.so; ad-server is Apple-only)"
