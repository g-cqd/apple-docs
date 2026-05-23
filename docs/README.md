# Documentation

For command syntax, the source of truth is always:

```bash
apple-docs --help
apple-docs <command> --help
```

| Document | Purpose |
| --- | --- |
| [../README.md](../README.md) | Project overview, quickstart, common commands, and configuration summary |
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Five-layer stack diagram + key patterns (projection / adapter / repository) |
| [installing.md](installing.md) | Three install paths — dev / standalone binary / production self-host |
| [self-hosting.md](self-hosting.md) | Run the web UI and MCP server yourself |
| [runbooks/public-instance-update.md](runbooks/public-instance-update.md) | Roll a new snapshot to a self-hosted public instance |
| [runbooks/symbols-fonts-cache-rebuild.md](runbooks/symbols-fonts-cache-rebuild.md) | Reference-host runbook for rebuilding symbol/font caches |
| [perf/README.md](perf/README.md) | Profiling, benchmark, and metrics workflow |
| [perf/e2e-local-snapshot-loop.md](perf/e2e-local-snapshot-loop.md) | End-to-end local snapshot build and install validation |
| [../ops/README.md](../ops/README.md) | Reference macOS + Caddy + Cloudflare Tunnel deployment |
| [../ops/grafana/README.md](../ops/grafana/README.md) | Starter Grafana dashboards + Prometheus alert rules |
| [../ops/cloudflare/README.md](../ops/cloudflare/README.md) | Cloudflare cache, header, and rate-limit configuration |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting and security scope |

A clean static-site build of this content lives under `docs/.vitepress/dist/`
after `bun run docs:build`. Run `bun run docs:dev` for live preview.
