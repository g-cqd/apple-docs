#!/bin/sh
# Shim → JS implementation in ops/cmd/proxy.js (verb: run).
# Invoked by the LaunchDaemon plist for the apple-docs caddy proxy.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" proxy run "$@"
