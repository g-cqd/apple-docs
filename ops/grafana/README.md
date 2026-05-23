# Grafana dashboards (starter)

Drop-in dashboards for the two Prometheus metric families exposed by the
project (`apple_docs_web_*`, `apple_docs_mcp_*`). Import each `.json`
file into Grafana via Dashboards → Import → Upload JSON, then point at
your Prometheus datasource.

Files:
- `web.json` — request latency p50/p95/p99, rate-limit rejections, cache
  hit ratio, reader-pool pending / timeouts, event-loop lag, RSS.
- `mcp.json` — equivalent for the MCP HTTP transport: per-tool latency,
  cache hits, heavy-tool semaphore (active / waiting / rejected),
  reader-pool stats.
- `alerts.example.yaml` — PromQL alert rules ready to drop into
  Prometheus's `rule_files`.

## Prerequisites

- Web server: started with `--metrics-port 9101` (or via launchd template).
- MCP HTTP server: started with `--metrics-port` (default off; on by
  presence of the flag).
- Prometheus scraping both endpoints.

## Customising

The dashboards assume the default metric prefixes. If you renamed them
via fork, search-replace `apple_docs_web_` / `apple_docs_mcp_` in each
JSON. Datasource is referenced by name `Prometheus` — adjust if your
deployment uses a different datasource label.
