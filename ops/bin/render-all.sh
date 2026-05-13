#!/bin/sh
# Shim → JS implementation in ops/cmd/render-all.js.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" render-all "$@"
