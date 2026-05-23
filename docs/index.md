---
title: apple-docs
description: Apple Developer Documentation CLI and MCP server — search, read, and browse Apple docs locally.
layout: home
hero:
  name: apple-docs
  text: Apple Developer Documentation, served locally.
  tagline: CLI, MCP server, and static site over a unified SQLite corpus of ~329k Apple docs, the Swift Book, WWDC sessions, sample code, HIG, App Store Review guidelines, Swift Evolution, and the Swift package catalog.
  actions:
    - theme: brand
      text: Install
      link: /installing
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: GitHub
      link: https://github.com/g-cqd/apple-docs
features:
  - title: Three surfaces, one corpus
    details: Use the CLI for ad-hoc lookups, the MCP server (stdio + Streamable HTTP) from Claude / Codex / Cursor, or a local website. All three share the same SQLite-backed search engine.
  - title: Offline + fresh
    details: Full corpus on disk after one `apple-docs setup` (≈60 s prebuilt snapshot) or `apple-docs sync` (≈25 min crawl). Weekly snapshots ship with a determinism gate.
  - title: Bun-native
    details: Strict-mode Bun runtime, bun&#58;sqlite, Bun.serve, Bun.spawn, Bun.gzipSync, Bun.escapeHTML, Bun.CryptoHasher, Bun.sleep. Compile to a single ~78 MB executable with `bun build --compile`.
  - title: Public-API boundary
    details: Every MCP / CLI --json / web /api/* response routes through a strict allowlist. Leak-guard tests reject any field outside the public shape.
  - title: 11 source adapters
    details: Apple DocC, HIG, App Store Review, WWDC, Swift Evolution, Swift Book, Swift.org, Swift compiler docs, sample code, apple-archive, package catalog — all behind one uniform `SourceAdapter` contract.
  - title: Observability ready
    details: Prometheus metrics on dedicated ports, /healthz + /readyz, structured JSON logs with secret redaction, starter Grafana dashboards under ops/grafana.
---

## Why apple-docs

The official Apple developer site is unfriendly to programmatic access. apple-docs is a local mirror that indexes every public DocC framework, the Swift Book, every WWDC transcript (1997 — current), Apple sample code, Swift Evolution proposals, the Human Interface Guidelines, the App Store Review Guidelines, Swift package catalog metadata, and Apple's archived documentation. ~329 k indexed pages, FTS5 + trigram + Levenshtein cascade, ~0.5 ms p95 search latency.

It exposes three public surfaces over the same data:

- **CLI** — `apple-docs search NavigationStack`, `apple-docs read swiftui/view --section Overview`, ~16 commands grouped Query / Setup & Sync / Hosting / Maintenance.
- **MCP server** — 8 tools + 4 resource templates, stdio for local clients and Streamable HTTP for remote / shared deployments. Connect Claude Code / Codex / Cursor.
- **Local website** — `apple-docs web serve` for a Browse / Search UI; `apple-docs web build` for a static site.

## Quick install

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup        # one-shot: deps + linked CLI + test prerequisites
apple-docs setup         # populate the corpus (≈60 s prebuilt snapshot)
```

Full install paths in [Installing](/installing).

## Next

- [**Installing**](/installing) — dev / standalone binary / production self-host.
- [**Architecture**](/architecture) — five-layer stack, projection boundary, adapter pattern, repos.
- [**Self-hosting**](/self-hosting) — deploy a public MCP HTTP server behind Caddy + Cloudflare.
- [**Public-instance update runbook**](/runbooks/public-instance-update) — atomic snapshot rollover.
