---
title: apple-docs
description: Apple Developer Documentation CLI and MCP server — search, read, and browse Apple docs locally.
layout: home
hero:
  name: apple-docs
  text: Apple Developer Documentation, served locally.
  tagline: CLI, MCP server, and local website over a single SQLite corpus of Apple developer documentation, the Swift Book, WWDC sessions, sample code, the Human Interface Guidelines, App Store Review Guidelines, Swift Evolution, archived Apple docs, and the Swift package catalog.
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
    details: A CLI for ad-hoc lookups, an MCP server (stdio and Streamable HTTP) for Claude / Codex / Cursor, and a local website. All three share the same SQLite-backed search engine.
  - title: Local-first, offline-friendly
    details: One full corpus on disk after `apple-docs setup` (prebuilt snapshot) or `apple-docs sync` (full crawl). Snapshots ship with a determinism gate.
  - title: Bun-native
    details: Strict-mode Bun runtime, bun&#58;sqlite, Bun.serve, Bun.spawn, Bun.gzipSync, Bun.escapeHTML, Bun.CryptoHasher, Bun.sleep. Compile a single-file executable with `bun build --compile`.
  - title: Public-output projection
    details: Every MCP response, CLI `--json` payload, and `/api/*` body routes through one allowlist boundary in `src/output/projection.js`. Leak-guard tests reject any field outside the public shape.
  - title: Eleven source adapters
    details: Apple DocC, HIG, App Store Review, WWDC, Swift Evolution, Swift Book, Swift.org, Swift compiler docs, sample code, archived Apple docs, and the Swift package catalog — all behind one `SourceAdapter` contract.
  - title: Observability included
    details: Prometheus metrics on dedicated ports, `/healthz` and `/readyz` probes, structured JSON logs with secret redaction, and starter Grafana dashboards under `ops/grafana/`.
---

## What it is

apple-docs is a local mirror of Apple's developer documentation that
exposes three public surfaces over the same SQLite corpus:

- **CLI** — `apple-docs search …`, `apple-docs read …`, plus commands to
  sync, browse, and maintain the corpus.
- **MCP server** — nine tools and four resource templates, available
  over stdio for local clients and Streamable HTTP for shared or remote
  deployments.
- **Local website** — `apple-docs web serve` for a Browse / Search UI;
  `apple-docs web build` for a static site.

## Quick install

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup        # deps + linked CLI + test prerequisites
apple-docs setup         # populate the corpus from the latest snapshot
```

See [Installing](/installing) for the three supported install paths
(dev / standalone binary / production self-host).

## Next

- [**Installing**](/installing) — dev, standalone binary, production self-host.
- [**Architecture**](/architecture) — five-layer stack, projection boundary, adapter and repository patterns.
- [**Self-hosting**](/self-hosting) — deploy the web UI and MCP HTTP server behind a reverse proxy.
- [**Public-instance update**](/runbooks/public-instance-update) — atomic snapshot rollover for a self-hosted public instance.
- [**Performance**](/perf/) — profiling, benchmarks, and metrics scrape.
- [**Security**](/security) — vulnerability reporting and hardened defaults.
