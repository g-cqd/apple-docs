#!/usr/bin/env bash
# Boot the local Grafana + Prometheus stack against the apple-docs
# servers running natively on this host (no docker required).
#
# Usage:
#   ops/grafana/run-native.sh start    # boots web + mcp + prometheus + grafana
#   ops/grafana/run-native.sh stop     # kills everything started by `start`
#   ops/grafana/run-native.sh status   # prints PID + URL summary
#
# Prerequisites:
#   brew install grafana prometheus
#   apple-docs CLI on PATH (bun link or standalone binary)
#
# Boot layout:
#   apple-docs web   → 127.0.0.1:3030   (moved off the default 3000 so
#                                        grafana can claim 3000)
#   apple-docs mcp   → 127.0.0.1:3031
#   web metrics      → 127.0.0.1:9101
#   mcp metrics      → 127.0.0.1:9102
#   prometheus       → 127.0.0.1:9090
#   grafana          → 127.0.0.1:3000   (anonymous Admin, no login form)
#
# Runtime state lives under /tmp/apple-docs-grafana so the repo stays clean.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRAFANA_DIR="${REPO_DIR}/ops/grafana"
STATE_DIR="${TMPDIR:-/tmp}/apple-docs-grafana"
PID_DIR="${STATE_DIR}/pids"
LOG_DIR="${STATE_DIR}/logs"
CONF_DIR="${STATE_DIR}/conf"

GRAFANA_HOMEPATH="$(brew --prefix grafana)/share/grafana"

mkdir -p "${PID_DIR}" "${LOG_DIR}" "${CONF_DIR}/grafana/provisioning/datasources" \
  "${CONF_DIR}/grafana/provisioning/dashboards" "${STATE_DIR}/prometheus-data" \
  "${STATE_DIR}/grafana-data" "${STATE_DIR}/grafana-logs" "${STATE_DIR}/grafana-plugins"

render_configs() {
  # Prometheus: swap host.docker.internal → 127.0.0.1 so the host-side
  # metrics listeners are reachable from a native binary.
  sed 's/host\.docker\.internal/127.0.0.1/g' "${GRAFANA_DIR}/prometheus/prometheus.yml" \
    | sed "s|/etc/prometheus/alerts.yml|${CONF_DIR}/alerts.yml|" \
    > "${CONF_DIR}/prometheus.yml"
  cp "${GRAFANA_DIR}/prometheus/alerts.yml" "${CONF_DIR}/alerts.yml"

  # Grafana datasource: pre-wired Prometheus pointing at the local prom.
  cat >"${CONF_DIR}/grafana/provisioning/datasources/prometheus.yml" <<EOF
apiVersion: 1
datasources:
  - name: Prometheus
    uid: Prometheus
    type: prometheus
    access: proxy
    url: http://127.0.0.1:9090
    isDefault: true
    editable: true
    jsonData:
      httpMethod: POST
      timeInterval: 15s
EOF

  # Grafana dashboards provisioner: absolute path to the project's
  # canonical dashboards directory.
  cat >"${CONF_DIR}/grafana/provisioning/dashboards/dashboards.yml" <<EOF
apiVersion: 1
providers:
  - name: apple-docs
    orgId: 1
    folder: apple-docs
    type: file
    disableDeletion: true
    allowUiUpdates: true
    updateIntervalSeconds: 30
    options:
      path: ${GRAFANA_DIR}/grafana/dashboards
      foldersFromFilesStructure: false
EOF
}

pidfile() { echo "${PID_DIR}/$1.pid"; }
logfile() { echo "${LOG_DIR}/$1.log"; }

start_one() {
  local name="$1"; shift
  local pid_file; pid_file="$(pidfile "${name}")"
  local log_file; log_file="$(logfile "${name}")"
  if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
    echo "[skip] ${name} already running (pid $(cat "${pid_file}"))"
    return 0
  fi
  echo "[start] ${name}"
  ( "$@" >"${log_file}" 2>&1 ) &
  echo $! > "${pid_file}"
}

stop_one() {
  local name="$1"
  local pid_file; pid_file="$(pidfile "${name}")"
  if [[ ! -f "${pid_file}" ]]; then
    echo "[skip] ${name} not running"
    return 0
  fi
  local pid; pid="$(cat "${pid_file}")"
  if kill -0 "${pid}" 2>/dev/null; then
    echo "[stop ] ${name} (pid ${pid})"
    kill "${pid}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "${pid}" 2>/dev/null || true
  fi
  rm -f "${pid_file}"
}

cmd_start() {
  render_configs

  # Stagger the two apple-docs processes: both try to set WAL mode on the
  # shared SQLite db at startup, and a simultaneous PRAGMA call from the
  # second process gets SQLITE_BUSY_RECOVERY. Letting the first one finish
  # its pragma block sidesteps that race entirely.
  start_one apple-docs-web apple-docs web serve \
    --port 3030 --host 127.0.0.1 \
    --metrics-port 9101 --metrics-host 127.0.0.1
  sleep 2

  start_one apple-docs-mcp apple-docs mcp serve \
    --port 3031 --host 127.0.0.1 \
    --metrics-port 9102 --metrics-host 127.0.0.1
  sleep 2

  start_one prometheus prometheus \
    --config.file="${CONF_DIR}/prometheus.yml" \
    --storage.tsdb.path="${STATE_DIR}/prometheus-data" \
    --storage.tsdb.retention.time=7d \
    --web.listen-address=127.0.0.1:9090 \
    --web.enable-lifecycle

  GF_PATHS_PROVISIONING="${CONF_DIR}/grafana/provisioning" \
  GF_PATHS_DATA="${STATE_DIR}/grafana-data" \
  GF_PATHS_LOGS="${STATE_DIR}/grafana-logs" \
  GF_PATHS_PLUGINS="${STATE_DIR}/grafana-plugins" \
  GF_AUTH_ANONYMOUS_ENABLED=true \
  GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
  GF_AUTH_DISABLE_LOGIN_FORM=true \
  GF_SERVER_HTTP_ADDR=127.0.0.1 \
  GF_SERVER_HTTP_PORT=3000 \
    start_one grafana grafana server \
      --homepath "${GRAFANA_HOMEPATH}"

  echo
  echo "Started. URLs:"
  echo "  Grafana    : http://127.0.0.1:3000"
  echo "  Prometheus : http://127.0.0.1:9090"
  echo "  Web metrics: http://127.0.0.1:9101/metrics"
  echo "  MCP metrics: http://127.0.0.1:9102/metrics"
  echo
  echo "Logs under ${LOG_DIR}/, PIDs under ${PID_DIR}/."
  echo "Stop with: ops/grafana/run-native.sh stop"
}

cmd_stop() {
  stop_one grafana
  stop_one prometheus
  stop_one apple-docs-mcp
  stop_one apple-docs-web
}

cmd_status() {
  for name in apple-docs-web apple-docs-mcp prometheus grafana; do
    local pid_file; pid_file="$(pidfile "${name}")"
    if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
      echo "${name}: running (pid $(cat "${pid_file}"))"
    else
      echo "${name}: stopped"
    fi
  done
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 {start|stop|status}" >&2; exit 2 ;;
esac
