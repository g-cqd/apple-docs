# shellcheck shell=sh
# Resolve a bun binary in priority order and exec it. Sourced by each
# ops/bin/*.sh shim; not invoked directly.
#
# Priority:
#   1. $BUN_BIN          — explicit override (e.g. set in ops/.env)
#   2. /opt/homebrew/bin/bun  (Apple Silicon, default homebrew prefix)
#   3. /usr/local/bin/bun     (Intel macOS / linuxbrew)
#   4. $HOME/.bun/bin/bun     (default `bun upgrade` install location)
#   5. `command -v bun`       (anything else on PATH)
#
# The launchd plists set PATH to /opt/homebrew/bin:/usr/local/bin:... and
# HOME to /Users/<operator> but do not set BUN_BIN — that's why we walk
# all four well-known locations before falling back to PATH.
exec_bun_cli() {
  if [ -n "${BUN_BIN:-}" ] && [ -x "$BUN_BIN" ]; then
    exec "$BUN_BIN" "$@"
  fi
  for _b in /opt/homebrew/bin/bun /usr/local/bin/bun "${HOME:-}/.bun/bin/bun"; do
    if [ -n "$_b" ] && [ -x "$_b" ]; then
      exec "$_b" "$@"
    fi
  done
  if command -v bun >/dev/null 2>&1; then
    exec bun "$@"
  fi
  echo "ops/bin: bun not found (set BUN_BIN or install bun)" >&2
  exit 127
}
