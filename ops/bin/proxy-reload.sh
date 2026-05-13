#!/bin/sh
# Shim → JS implementation in ops/cmd/proxy.js (verb: reload).
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" proxy reload "$@"
