# Documentation

This directory keeps both current operating docs and older project history.
For command syntax, the source of truth is always:

```bash
apple-docs --help
apple-docs <command> --help
```

## Current Guides

| Document | Purpose |
| --- | --- |
| [../README.md](../README.md) | Project overview, quickstart, common commands, and configuration summary |
| [self-hosting.md](self-hosting.md) | Run the web UI and MCP server yourself |
| [perf/README.md](perf/README.md) | Profiling, benchmark, and metrics workflow |
| [perf/e2e-local-snapshot-loop.md](perf/e2e-local-snapshot-loop.md) | End-to-end local snapshot build and install validation |
| [runbooks/mm18-symbols-fonts-cache-rebuild.md](runbooks/mm18-symbols-fonts-cache-rebuild.md) | Production runbook for rebuilding symbol/font caches on the reference host |
| [../ops/README.md](../ops/README.md) | Reference macOS + Caddy + Cloudflare Tunnel deployment |
| [../ops/cloudflare/README.md](../ops/cloudflare/README.md) | Cloudflare cache, header, and rate-limit configuration |
| [../SECURITY.md](../SECURITY.md) | Vulnerability reporting and security scope |

## Project History

These directories are intentionally retained, but they are not current command
reference material:

| Directory | Contents |
| --- | --- |
| [audits/](audits/) | Security, architecture, and code-quality audit reports plus closeout notes |
| [plans/](plans/) | Implementation plans and migration notes |
| [research/](research/) | Design, performance, frontend, font, icon, and UX research |
| [research/notes/](research/notes/) | Raw vendor and visual research notes |
| [research/screenshots/](research/screenshots/) | Captured screenshots used by research docs |

Archived docs may mention retired flags, historical defaults, or future plans.
Treat them as context. Current behavior is defined by the README, CLI help, and
the code.
