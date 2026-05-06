#!/bin/bash
# apple-docs watchdog
#
# Defends the deployment from four failure modes the launchd KeepAlive flag
# does not catch on its own:
#
#   1. Bun event-loop wedge — process is alive and listening but accept() is
#      starved. Detected by polling /healthz on the *backend* port (bypassing
#      Caddy) and counting consecutive failures.
#   2. Slow accumulation — observed once at +5 days uptime. Mitigated by an
#      optional daily kickstart at WATCHDOG_DAILY_RESTART_HOUR (local time).
#   3. RSS runaway — pure backstop. Web RSS is noisy because of the SQLite
#      mmap, so the threshold is set generously above any healthy baseline.
#   4. Operator absence — restarts itself happen unattended, with a cooldown
#      to avoid restart storms.
#
# Designed to run unprivileged. Uses passwordless `sudo launchctl kickstart`
# from the apple-docs sudoers drop-in (already grants kickstart on the LABEL_*
# labels).
set -uo pipefail

BIN_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
OPS=$(cd -- "$BIN_DIR/.." && pwd)
# shellcheck source=ops/lib/env.sh
. "${OPS}/lib/env.sh"

INTERVAL=${WATCHDOG_INTERVAL:-30}
FAILS_BUDGET=${WATCHDOG_FAILS:-3}
PROBE_TIMEOUT=${WATCHDOG_TIMEOUT:-5}
COOLDOWN=${WATCHDOG_COOLDOWN:-300}
WEB_RSS_LIMIT_MB=${WATCHDOG_WEB_RSS_LIMIT_MB:-3072}
MCP_RSS_LIMIT_MB=${WATCHDOG_MCP_RSS_LIMIT_MB:-8192}
DAILY_HOUR=${WATCHDOG_DAILY_RESTART_HOUR:-}
DAILY_TARGETS=${WATCHDOG_DAILY_RESTART_TARGETS:-web}

LOG_DIR="$OPS/logs"
mkdir -p "$LOG_DIR"

log() {
  printf '[%s] %s\n' "$(/bin/date -Iseconds)" "$*"
}

# The /healthz probe targets the *backend* port directly (bypassing Caddy)
# for two reasons:
#   1. Caddy now serves the prebuilt static site for /docs/* and /assets/* —
#      a wedged Bun process would still respond 200 through Caddy for those
#      paths. Probing Bun's port catches the API wedge specifically.
#   2. /healthz on Bun is implemented in src/web/serve.js with `Cache-Control:
#      no-store` and never touches the DB, so a healthy probe means accept()
#      is alive without conflating it with a slow DB query.
# Map a short name to (label, healthz URL, optional RSS limit, ps pattern).
# The ps pattern uses the absolute REPO_DIR path so it cannot match an
# unprivileged local user that runs `bun cli.js web serve` out of /tmp.
backend_label()    { case "$1" in web) echo "$LABEL_WEB" ;; mcp) echo "$LABEL_MCP" ;; *) return 1 ;; esac; }
backend_url()      { case "$1" in web) echo "http://127.0.0.1:${WEB_BACKEND_PORT}/healthz" ;; mcp) echo "http://127.0.0.1:${MCP_BACKEND_PORT}/healthz" ;; *) return 1 ;; esac; }
backend_rss_cap()  { case "$1" in web) echo "$WEB_RSS_LIMIT_MB" ;; mcp) echo "$MCP_RSS_LIMIT_MB" ;; *) return 1 ;; esac; }
backend_ps_match() { case "$1" in web) echo "${REPO_DIR}/cli.js web serve" ;; mcp) echo "${REPO_DIR}/cli.js mcp serve" ;; *) return 1 ;; esac; }

# Per-backend state kept in plain files so the script can be inspected/tailed
# without grovelling through bash arrays. 0700 so other users in `staff`
# cannot read counters or pre-create symlinks at our stamp paths.
state_dir="$LOG_DIR/.watchdog"
mkdir -m 0700 -p "$state_dir"
chmod 700 "$state_dir" 2>/dev/null || true

read_int()  { local v; v=$(/bin/cat "$1" 2>/dev/null || echo 0); [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }
write_int() { printf '%s\n' "$2" > "$1"; }

# Issue a kickstart, respecting the per-backend cooldown.
#
# The cooldown stamp is written *before* the launchctl call, not after. If the
# watchdog itself is killed (e.g. by deploy-update kickstarting LABEL_WATCHDOG)
# between the launchctl call and the stamp write, the next watchdog instance
# would otherwise see last_restart=0 and immediately re-kickstart, doubling
# the user-visible blip. Stamping first means worst case we miss one restart;
# the next probe failure within COOLDOWN will retry naturally.
kickstart() {
  local backend="$1" reason="$2"
  local label; label=$(backend_label "$backend")
  local now; now=$(/bin/date +%s)
  local last_file="$state_dir/${backend}.last_restart"
  local last; last=$(read_int "$last_file")
  if (( now - last < COOLDOWN )); then
    log "skip $backend kickstart (cooldown $((COOLDOWN - (now - last)))s remaining): $reason"
    return 1
  fi
  log "kickstart $backend ($label): $reason"
  write_int "$last_file" "$now"
  if /usr/bin/sudo -n /bin/launchctl kickstart -k "system/$label"; then
    write_int "$state_dir/${backend}.fails" 0
    return 0
  fi
  log "ERROR: sudo launchctl kickstart failed for $label"
  return 2
}

probe_one() {
  local backend="$1"
  local url; url=$(backend_url "$backend")
  local body_file; body_file=$(/usr/bin/mktemp -t "watchdog-${backend}")
  local code; code=$(/usr/bin/curl -s -o "$body_file" --max-time "$PROBE_TIMEOUT" -w '%{http_code}' "$url" 2>/dev/null || echo 000)
  local fails_file="$state_dir/${backend}.fails"
  # 2xx + matching body counts as healthy. Body match guards against another
  # local process squatting the loopback port and serving a generic 200.
  if [[ "$code" =~ ^2 ]] && /usr/bin/grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$body_file"; then
    /bin/rm -f "$body_file"
    write_int "$fails_file" 0
    return 0
  fi
  /bin/rm -f "$body_file"
  local fails; fails=$(read_int "$fails_file")
  fails=$((fails + 1))
  write_int "$fails_file" "$fails"
  log "$backend healthz probe failed (HTTP $code, fail $fails/$FAILS_BUDGET)"
  if (( fails >= FAILS_BUDGET )); then
    kickstart "$backend" "$fails consecutive /healthz failures (last status $code)"
  fi
}

check_rss() {
  local backend="$1"
  local cap; cap=$(backend_rss_cap "$backend")
  [ -z "$cap" ] && return 0
  [ "$cap" -gt 0 ] || return 0
  local pattern; pattern=$(backend_ps_match "$backend")
  # If multiple processes match (e.g. during a kickstart race where the old
  # bun is still being SIGKILLed and the new one has just spawned) we cannot
  # tell which RSS belongs to "the" backend — picking one risks misjudging
  # an already-dying process and triggering a second kickstart on top of the
  # first. Skip until pgrep returns exactly one match.
  local pids; pids=$(/usr/bin/pgrep -f "$pattern" 2>/dev/null || true)
  local count=0
  [ -n "$pids" ] && count=$(printf '%s\n' "$pids" | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  if [ "$count" -eq 0 ]; then
    return 0
  fi
  if [ "$count" -gt 1 ]; then
    log "WARN: $backend RSS check skipped — $count pids match '$pattern'"
    return 0
  fi
  local pid; pid=$pids
  local rss_kb; rss_kb=$(/bin/ps -o rss= -p "$pid" 2>/dev/null | /usr/bin/tr -d ' ')
  [[ "$rss_kb" =~ ^[0-9]+$ ]] || return 0
  local rss_mb=$((rss_kb / 1024))
  if (( rss_mb > cap )); then
    kickstart "$backend" "RSS ${rss_mb}MB > ${cap}MB cap"
  fi
}

# Daily preventive restart at WATCHDOG_DAILY_RESTART_HOUR (00..23) local time,
# applied to every backend listed in WATCHDOG_DAILY_RESTART_TARGETS (comma-
# separated). The cooldown prevents a double-fire if the loop overlaps the
# hour boundary; we additionally stamp `daily_restart_yyyymmdd` so a single
# day cannot trigger twice even if the cooldown is shortened.
daily_restart_check() {
  [ -n "$DAILY_HOUR" ] || return 0
  [[ "$DAILY_HOUR" =~ ^[0-9]+$ ]] || return 0
  local now_hour; now_hour=$(/bin/date +%H)
  # strip leading zeros for arithmetic
  now_hour=$((10#$now_hour))
  (( now_hour == DAILY_HOUR )) || return 0
  local today; today=$(/bin/date +%Y%m%d)
  local stamp_file="$state_dir/daily_${today}.done"
  [ -f "$stamp_file" ] && return 0
  IFS=',' read -r -a targets <<< "$DAILY_TARGETS"
  local did_restart=0
  for t in "${targets[@]}"; do
    t="${t//[[:space:]]/}"
    [ -z "$t" ] && continue
    # Defense-in-depth: reject anything that isn't a bare backend name before
    # the case statement gets to validate it.
    [[ "$t" =~ ^[a-z]+$ ]] || { log "WARN: skipping malformed target '$t'"; continue; }
    if ! backend_label "$t" >/dev/null; then
      log "WARN: WATCHDOG_DAILY_RESTART_TARGETS includes unknown target '$t' — skipping"
      continue
    fi
    if kickstart "$t" "daily preventive restart (hour $DAILY_HOUR)"; then
      did_restart=1
    fi
  done
  # Only stamp the day as done if at least one kickstart succeeded; otherwise
  # a transient cooldown collision at the daily hour would suppress the
  # restart for the rest of the day.
  if (( did_restart )); then
    /usr/bin/touch -- "$stamp_file"
  fi
  # Best-effort cleanup of yesterday's stamp. `-mtime +2` because BSD `find`
  # rounds 24h windows down — `+1` would only remove files older than 48h.
  /usr/bin/find "$state_dir" -maxdepth 1 -name 'daily_*.done' -mtime +2 -delete 2>/dev/null || true
}

log "watchdog starting (interval=${INTERVAL}s, fails=${FAILS_BUDGET}, timeout=${PROBE_TIMEOUT}s, cooldown=${COOLDOWN}s, daily_hour=${DAILY_HOUR:-off})"

trap 'log "watchdog stopping (signal)"; exit 0' TERM INT

while :; do
  for backend in web mcp; do
    probe_one "$backend"
    check_rss "$backend"
  done
  daily_restart_check
  /bin/sleep "$INTERVAL"
done
