#!/bin/sh
# Shim → JS implementation in ops/cmd/watch-sync.js.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" watch-sync "$@"
