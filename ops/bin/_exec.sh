# shellcheck shell=sh
# Resolve a bun binary in priority order and exec it. Sourced by each
# ops/bin/*.sh shim; not invoked directly.
#
# Priority:
#   1. /opt/homebrew/bin/bun  (Apple Silicon, default homebrew prefix)
#   2. /usr/local/bin/bun     (Intel macOS / linuxbrew)
#   3. `command -v bun`       (anything else on PATH)
#
# The launchd plists already set PATH to include /opt/homebrew/bin and
# /usr/local/bin, so the `command -v` fallback rarely fires under
# launchd. It exists for manual invocations from a minimal shell.
exec_bun_cli() {
  for _b in /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$_b" ]; then
      exec "$_b" "$@"
    fi
  done
  if command -v bun >/dev/null 2>&1; then
    exec bun "$@"
  fi
  echo "ops/bin: bun not found (install with brew or set PATH)" >&2
  exit 127
}
