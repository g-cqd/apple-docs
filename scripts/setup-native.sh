#!/usr/bin/env bash
# setup-native.sh — stand up the native ADDB apple-docs corpus from the SQLite source, from scratch.
#
# Local only (no network crawl): imports the existing SQLite corpus into a fresh ADDB corpus, rebuilds the
# FTS5 + denorm columns, and validates it. ~5 minutes for the full 358k-doc corpus (vs ~40 min for a live
# crawl). Pass --promote to swap the validated corpus in as the live one (the previous SQLite corpus is
# kept as <db>.sqlite.bak; rebuild + restart ad-server afterwards so the serve reads ADDB).
#
# Prereqs: a built ad-cli (swift build -c release --product ad-cli) and a SQLite corpus at $SQLITE.
set -euo pipefail

DATA="${APPLE_DOCS_DATA:-$HOME/.apple-docs}"
SQLITE="$DATA/apple-docs.db"
NATIVE="$DATA/apple-docs-native.db"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADCLI="${ADCLI:-$HERE/swift/.build/release/ad-cli}"

[ -f "$SQLITE" ] || { echo "setup-native: no SQLite corpus at $SQLITE" >&2; exit 1; }
[ -x "$ADCLI" ] || {
    echo "setup-native: ad-cli not built at $ADCLI" >&2
    echo "  build it: (cd $HERE/swift && swift build -c release --product ad-cli)" >&2
    exit 1
}

echo "==> fresh target: $NATIVE"
rm -f "$NATIVE" "$NATIVE"-* 2>/dev/null || true

echo "==> import (local, no network)"
time "$ADCLI" import "$SQLITE" --db "$NATIVE"

echo "==> validate (native ADDB backend)"
"$ADCLI" status --db "$NATIVE" | sed -n '1,7p'
echo "  frameworks: $("$ADCLI" frameworks --db "$NATIVE" | head -1)"
echo "  search:     $("$ADCLI" search "NavigationStack" --db "$NATIVE" | head -1)"
echo "  read:       $("$ADCLI" read swiftui/view --db "$NATIVE" | sed -n '2p')"

if [ "${1:-}" = "--promote" ]; then
    echo "==> promote: $SQLITE -> $SQLITE.sqlite.bak; $NATIVE -> $SQLITE"
    mv "$SQLITE" "$SQLITE.sqlite.bak"
    mv "$NATIVE" "$SQLITE"
    echo "promoted. Rebuild + restart ad-server so the serve opens the ADDB corpus."
    echo "Revert: mv \"$SQLITE\" \"$NATIVE\" && mv \"$SQLITE.sqlite.bak\" \"$SQLITE\""
fi
echo "==> done."
