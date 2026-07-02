#!/usr/bin/env bash
# Dev build wrapper for libAppleDocsCore / ad-server against the UNPUBLISHED
# g-cqd/AD* siblings. It exports the *_PATH manifest overrides (see the
# `Context.environment[...]` blocks in Package.swift) to local sibling checkouts,
# then execs `swift` with whatever args you pass:
#
#   ./build.sh build -c release                 # release dylib (matches CI `native`)
#   ./build.sh test                             # full suite (auto-enables APPLEDOCS_DEV)
#   APPLEDOCS_DEV=1 ./build.sh package --disable-sandbox lint
#
# Siblings are resolved as direct children of this repo's parent (the g-cqd
# checkout root); override the location with AD_SIBLINGS_ROOT=/abs/path. Once the
# siblings are published to github.com/g-cqd, plain `swift <args>` works without
# this wrapper and these jobs can re-enable in CI (AD_SWIFT_SIBLINGS_PUBLISHED).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# swift/ -> apple-docs/ -> <g-cqd root>; each AD* sibling is a direct child.
default_root="$(cd "$script_dir/../.." && pwd)"
siblings_root="${AD_SIBLINGS_ROOT:-$default_root}"

# "<dir-name> <ENV_VAR>" pairs. ADFoundation/ADJSON/ADDB/ADSQL/ADHTML + the server
# engine (ADServe) and the HTTP stack it is re-basing onto are required for ad-server;
# ADBuildTools is consumed only under APPLEDOCS_DEV but exported anyway (the manifest
# ignores it otherwise). ADConcurrency/ADMCP/ADTestKit are NO LONGER separate siblings —
# they were folded into ADFoundation/ADServe (see AD-FAMILY-CONSOLIDATION-PLAN) and
# resolve through those packages. Package resolution is global, so a missing override
# here fails EVERY product, not just ad-server.
siblings="
ADFoundation ADFOUNDATION_PATH
ADJSON ADJSON_PATH
ADDB ADDB_PATH
ADSQL ADSQL_PATH
ADHTML ADHTML_PATH
ADServe ADSERVE_PATH
HTTP HTTP_PATH
ADBuildTools ADBUILDTOOLS_PATH
"

missing=""
while read -r name var; do
    [ -z "$name" ] && continue
    path="$siblings_root/$name"
    if [ -f "$path/Package.swift" ]; then
        export "$var=$path"
    else
        missing="${missing}${missing:+$'\n'}  - $name ($path)"
    fi
done <<EOF
$siblings
EOF

if [ -n "$missing" ]; then
    {
        printf 'build.sh: missing sibling checkout(s) under %s:\n' "$siblings_root"
        printf '%s\n' "$missing"
        printf 'Clone them beside apple-docs, or set AD_SIBLINGS_ROOT=/abs/path.\n'
    } >&2
    exit 1
fi

# `test`/`package` resolve the dev-gated ADTestKit + ADBuildTools plugins; a plain
# `build`/`run` does not. Respect an explicit caller-set value (incl. empty).
case "${1:-}" in
    test | package) export APPLEDOCS_DEV="${APPLEDOCS_DEV:-1}" ;;
esac

cd "$script_dir"
exec swift "$@"
