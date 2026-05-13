#!/bin/sh
# Shim → JS implementation in ops/cmd/install-daemons.js. Must be run as root.
set -eu
DIR=$(cd -- "$(dirname -- "$0")" && pwd)
. "$DIR/_exec.sh"
exec_bun_cli "$DIR/../cli.js" install "$@"
