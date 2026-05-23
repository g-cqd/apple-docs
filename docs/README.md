# Documentation

Documentation source for the apple-docs project. The same files are
rendered as a static site via VitePress; see `bun run docs:dev` for a
local preview and `bun run docs:build` for the static site under
`docs/.vitepress/dist/`.

For exhaustive command syntax, always defer to:

```bash
apple-docs --help
apple-docs <command> --help
```

## Site map

- [Introduction](index.md)
- [Installing](installing.md) — dev, standalone, or production install.
- [Architecture](architecture.md) — five-layer stack, projection
  boundary, adapter and repository patterns.
- [Self-hosting](self-hosting.md) — deployment topology, environment
  variables, tuning.
- [Public-instance update runbook](runbooks/public-instance-update.md)
- [Performance](perf/index.md) — profiling, benchmarks, metrics scrape.
- [End-to-end snapshot loop](perf/e2e-local-snapshot-loop.md)
- [Grafana dashboards](ops-grafana.md)
- [Security policy](security.md)

## Repository pointers

- [`../README.md`](../README.md) — GitHub project landing.
- [`../ops/README.md`](../ops/README.md) — reference ops topology
  (templated launchd plists, Caddyfile, cloudflared configs).
- [`../ops/grafana/README.md`](../ops/grafana/README.md) — starter
  Grafana dashboards (the source for the rendered Grafana page above).
- [`../ops/cloudflare/README.md`](../ops/cloudflare/README.md) —
  Cloudflare cache, header, and rate-limit configuration.
