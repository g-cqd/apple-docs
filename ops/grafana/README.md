# Grafana + Prometheus stack

This directory ships everything needed to observe a local apple-docs
deployment: dashboards, alert rules, and a docker-compose that boots
Prometheus + Grafana with the dashboards auto-provisioned.

## Layout

```
ops/grafana/
├── docker-compose.yml             # local Prometheus + Grafana stack
├── web.json                       # canonical Grafana dashboard (web surface)
├── mcp.json                       # canonical Grafana dashboard (MCP surface)
├── alerts.example.yaml            # canonical Prometheus alert rules
├── prometheus/
│   ├── prometheus.yml             # scrape config (host.docker.internal:9101 / :9102)
│   └── alerts.yml                 # copy of alerts.example.yaml, loaded by Prometheus
└── grafana/
    ├── dashboards/                # copies of web.json + mcp.json, auto-loaded
    └── provisioning/
        ├── dashboards/dashboards.yml
        └── datasources/prometheus.yml
```

The `*.json` files at the top level are the canonical artefacts (the
ones you'd import into a foreign Grafana). The `grafana/dashboards/`
and `prometheus/alerts.yml` copies exist so the bundled stack can
mount them via volume — keep both in sync if you edit one.

## Local stack — quickstart

Two boot paths. Pick whichever matches your environment.

### Native (Homebrew, no Docker)

```bash
brew install grafana prometheus
ops/grafana/run-native.sh start
open http://127.0.0.1:3000          # anonymous Admin, no login form
ops/grafana/run-native.sh stop      # tear down later
```

`run-native.sh` starts four processes: `apple-docs web` (port 3030),
`apple-docs mcp` (port 3031), Prometheus, and Grafana. State lives
under `$TMPDIR/apple-docs-grafana/` (data dirs, logs, pid files,
generated configs). Re-running `start` is idempotent — already-running
services are skipped.

### Docker Compose

```bash
# 1. Start the apple-docs servers with metrics enabled. Bind the
#    metrics listener to 0.0.0.0 so the docker container can scrape it.
apple-docs web serve --metrics-port 9101 --metrics-host 0.0.0.0 &
apple-docs mcp serve --metrics-port 9102 --metrics-host 0.0.0.0 &

# 2. Boot Prometheus + Grafana.
cd ops/grafana
docker compose up -d

# 3. Open Grafana.
open http://localhost:3000          # anonymous Admin, no login form
```

Both dashboards land under the **apple-docs** folder in Grafana. The
Prometheus instance is reachable at `http://localhost:9090` (rules
under **Status → Rules**, targets under **Status → Targets** — both
jobs should be `UP` once the servers are running).

Stop the stack with `docker compose down`. Add `-v` to also drop the
Prometheus and Grafana state volumes.

## Importing the dashboards into an existing Grafana

If you already run Grafana, skip the docker-compose and import the
JSONs directly: **Dashboards → Import → Upload JSON**, point them at
a Prometheus datasource whose UID is `Prometheus` (or edit the
`datasource.uid` field in each JSON if your datasource has a different
UID).

The dashboards assume Prometheus is scraping two jobs:

- `apple-docs-web` → `apple-docs web serve --metrics-port …`
- `apple-docs-mcp` → `apple-docs mcp serve --metrics-port …`

If your scrape config uses different job labels, adjust the `$job`
template variable in each dashboard (it is a hidden constant by
default).

## Prerequisites

- The web server started with `--metrics-port` (and `--metrics-host
  0.0.0.0` if Prometheus runs in a container).
- The MCP HTTP server started with `--metrics-port` (same host caveat).
- Prometheus scraping both endpoints.

If neither server has `--metrics-port` set, no listener exists and
Prometheus reports the targets as `DOWN`.

## Customising

The dashboards reference the metric names emitted by
`src/web/metrics-provider.js` and `src/mcp/metrics-provider.js`. If you
rename a metric in a fork, update both the canonical `*.json` and the
provisioned copy under `grafana/dashboards/`.

## Alert rules

`alerts.example.yaml` (and its bundled copy `prometheus/alerts.yml`)
cover:

- Web p95 latency over a configurable SLO.
- Reader-pool timeout and backpressure-reject bursts on both surfaces.
- Event-loop lag p95.
- MCP heavy-tool queue saturation and rejection rates.
- Web RSS growth as a coarse leak detector.

Tune the thresholds to match your hardware and traffic profile before
enabling them in production.
