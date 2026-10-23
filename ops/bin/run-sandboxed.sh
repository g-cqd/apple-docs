#!/bin/sh
# Run a long-lived apple-docs server under the Seatbelt profile in
# ops/sandbox/apple-docs-serve.sb. Used as the launchd ProgramArguments prefix
# for `web serve` and `mcp serve` only; setup, deploy and sync run unsandboxed.
#
#   run-sandboxed.sh --port PORT [--egress] -- COMMAND [ARG...]
#
# Environment (set by the launchd plist):
#   SANDBOX_SERVE  "on" (default) or "off". "off" runs COMMAND directly.
#   REPO_DIR DATA_DIR OPS_DIR BUN_BIN   as in ops/.env
#
# Optional: ops/sandbox/local.sb is appended to the profile when present, for
# host-specific additions (for example allowing another binary). It is
# operator-local and gitignored.
#
# Fails closed: with the sandbox on and no usable sandbox-exec, it refuses to
# start rather than silently running unconfined.
set -eu

port=""
egress="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="${2:?--port needs a value}"; shift 2 ;;
    --egress) egress="yes"; shift ;;
    --) shift; break ;;
    *) echo "run-sandboxed: unknown option: $1" >&2; exit 64 ;;
  esac
done
[ $# -gt 0 ] || { echo "run-sandboxed: no command given" >&2; exit 64; }

if [ "${SANDBOX_SERVE:-on}" = "off" ]; then
  echo "run-sandboxed: SANDBOX_SERVE=off, running unsandboxed" >&2
  exec "$@"
fi

[ -n "$port" ] || { echo "run-sandboxed: --port is required when the sandbox is on" >&2; exit 64; }
: "${REPO_DIR:?REPO_DIR is required}" "${DATA_DIR:?DATA_DIR is required}" "${OPS_DIR:?OPS_DIR is required}" "${BUN_BIN:?BUN_BIN is required}"

sandbox_exec=/usr/bin/sandbox-exec
if [ ! -x "$sandbox_exec" ]; then
  echo "run-sandboxed: $sandbox_exec not found; set SANDBOX_SERVE=off in ops/.env to run unsandboxed" >&2
  exit 69
fi

# Seatbelt matches fully resolved paths. (/usr/bin/realpath is not on every
# macOS release, so resolve with shell built-ins.)
resolve_dir() { (cd -P -- "$1" && pwd -P); }
resolve_file() {
  f=$1
  while [ -L "$f" ]; do
    target=$(readlink "$f")
    case "$target" in /*) f=$target ;; *) f="$(dirname -- "$f")/$target" ;; esac
  done
  printf '%s/%s\n' "$(resolve_dir "$(dirname -- "$f")")" "$(basename -- "$f")"
}
repo=$(resolve_dir "$REPO_DIR")
data=$(resolve_dir "$DATA_DIR")
mkdir -p -- "$OPS_DIR/logs" "$DATA_DIR/tmp"
logs=$(resolve_dir "$OPS_DIR/logs")
tmp=$(resolve_dir "$DATA_DIR/tmp")
bun=$(resolve_file "$BUN_BIN")

profile_file="$OPS_DIR/sandbox/apple-docs-serve.sb"
[ -r "$profile_file" ] || { echo "run-sandboxed: missing profile $profile_file" >&2; exit 66; }
profile=$(cat "$profile_file")
if [ -r "$OPS_DIR/sandbox/local.sb" ]; then
  profile="$profile
$(cat "$OPS_DIR/sandbox/local.sb")"
fi

# The sandbox has no git; resolve the commit here, outside it.
if [ -z "${APPLE_DOCS_COMMIT:-}" ]; then
  commit=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || true)
  [ -z "$commit" ] || export APPLE_DOCS_COMMIT="$commit"
fi

export TMPDIR="$tmp/"
export BUN_RUNTIME_TRANSPILER_CACHE_PATH="$tmp/bun-transpiler"

exec "$sandbox_exec" \
  -D "REPO_DIR=$repo" -D "BUN_BIN=$bun" -D "DATA_DIR=$data" \
  -D "LOG_DIR=$logs" -D "TMP_DIR=$tmp" -D "PORT=$port" -D "EGRESS=$egress" \
  -p "$profile" \
  "$@"
