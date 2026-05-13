#!/bin/sh
# Shim → JS implementation in ops/cmd/proxy.js (verb: status).
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" proxy status "$@"
