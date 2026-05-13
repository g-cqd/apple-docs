#!/bin/sh
# Shim → JS implementation in ops/cmd/watchdog.js.
# Invoked by the LaunchDaemon plist for the apple-docs watchdog.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" watchdog "$@"
