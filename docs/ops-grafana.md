# Grafana dashboards

Drop-in dashboards and alert rules for the two Prometheus metric
families exposed by apple-docs: `apple_docs_web_*` and
`apple_docs_mcp_*`. Source files live under `ops/grafana/` in the
repository.

| File | Contents |
| --- | --- |
| `web.json` | Web server: request latency p50 / p95 / p99, requests by route + status, rate-limiter bucket count, cache byte usage, reader-pool pending / timeouts / backpressure, event-loop lag, RSS + heap. |
| `mcp.json` | MCP HTTP transport: heavy-tool semaphore (active, waiting, rejected/sec), response-cache hit ratio per tool, response-cache size, markdown render-cache hits/misses/evictions, reader-pool stats, RSS. |
| `alerts.example.yaml` | PromQL alert rules ready to drop into Prometheus's `rule_files`. |

The metric names referenced by the dashboards mirror what
`src/web/metrics-provider.js` and `src/mcp/metrics-provider.js` emit.
A `$job` template variable on each dashboard scopes the queries to
`apple-docs-web` or `apple-docs-mcp` so the two surfaces can share the
same metric names (`apple_docs_reader_pool_*`,
`apple_docs_process_*`).

## Local stack

Two supported boot paths — both auto-provision the dashboards and the
Prometheus datasource.

### Native (no Docker required)

```bash
brew install grafana prometheus
ops/grafana/run-native.sh start
open http://127.0.0.1:3000          # anonymous Admin, no login form
ops/grafana/run-native.sh stop      # tear down later
```

`run-native.sh` starts the apple-docs web (port 3030) and MCP (port
3031) servers with metrics ports 9101 / 9102, then Prometheus and
Grafana. Runtime state lives under `$TMPDIR/apple-docs-grafana/` so
the repo stays clean. Re-running `start` is idempotent.

### Docker Compose

`ops/grafana/docker-compose.yml` boots Prometheus + Grafana in
containers.

```bash
# 1. Start the apple-docs servers with metrics enabled. Bind the
#    metrics listener to 0.0.0.0 so the docker container can scrape it.
apple-docs web serve --metrics-port 9101 --metrics-host 0.0.0.0 &
apple-docs mcp serve --metrics-port 9102 --metrics-host 0.0.0.0 &

# 2. Boot Prometheus + Grafana.
cd ops/grafana
docker compose up -d

# 3. Open Grafana (anonymous Admin, no login form).
open http://localhost:3000
```

Grafana lands the dashboards under the **apple-docs** folder.
Prometheus is reachable at `http://localhost:9090` — verify both jobs
report `UP` under **Status → Targets** before debugging the dashboards
themselves.

Stop the stack with `docker compose down`. Add `-v` to also drop the
Prometheus and Grafana state volumes.

## Import into an existing Grafana

If you already run Grafana, skip the docker-compose and import the
JSONs directly: **Dashboards → Import → Upload JSON**, point them at a
Prometheus datasource whose UID is `Prometheus` (or edit the
`datasource.uid` field in each JSON if your datasource has a different
UID).

## Prerequisites

- Web server: started with `--metrics-port 9101` and
  `--metrics-host 0.0.0.0` (the default `127.0.0.1` is not reachable
  from a docker container).
- MCP HTTP server: started with `--metrics-port` (off unless the flag
  is passed). Same `--metrics-host` caveat applies.
- Prometheus configured to scrape both endpoints with `job` labels
  `apple-docs-web` and `apple-docs-mcp`.

## Customising

The dashboards reference the metric names emitted by the source. If
you rename a metric in a fork, search-replace `apple_docs_web_` /
`apple_docs_mcp_` across both the canonical `ops/grafana/*.json` files
and the provisioned copies under `ops/grafana/grafana/dashboards/`.

The Prometheus datasource is referenced by the UID `Prometheus`;
adjust if your deployment uses a different label.

## Alert rules

`alerts.example.yaml` covers:

- `WebP95LatencyHigh` — web p95 latency above the SLO.
- `WebReaderPoolTimeoutBurst` / `WebReaderPoolBackpressureBurst` —
  reader-pool failure modes on the web surface.
- `EventLoopLagHigh` — event-loop p95 lag above 200 ms.
- `WebRssGrowth` — coarse memory-leak detector on the web surface.
- `McpHeavyToolQueueSaturated` / `McpHeavyToolRejecting` — MCP heavy
  tool calls saturating their semaphore.
- `McpReaderPoolTimeoutBurst` — reader-pool timeout bursts on MCP.

Tune the thresholds to match your hardware and traffic profile before
enabling them in production.
