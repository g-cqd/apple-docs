# Architecture

A short orientation for contributors. The long-form architecture
document — five-layer stack diagram, projection-boundary deep dive,
adapter and repository patterns, observability, Bun primitives — lives
at [`docs/architecture.md`](docs/architecture.md).

## TL;DR

A Bun-only CLI, MCP server, and local website over a single SQLite
corpus of Apple developer documentation. Three public surfaces share
one application core; one projection boundary keeps internal
infrastructure out of every public response.

## Where the code lives

```
src/
├── cli/            CLI entry layer (parsed argv → use cases)
├── mcp/            MCP server: stdio + Streamable HTTP transports, 9 tools
├── web/            Local website + static-site builder
├── output/         Public projection boundary (single chokepoint)
├── commands/       Use-case orchestration (search, lookup, sync, …)
├── pipeline/       Sync pipeline stages
├── search/         Search cascade (FTS + trigram + Levenshtein)
├── resources/      Apple fonts + SF Symbols pipelines
├── sources/        Eleven SourceAdapter implementations
├── storage/        bun:sqlite + repository pattern, reader pools
├── content/        DocC/HTML → Markdown extractors
├── apple/          Apple-format-specific helpers
└── lib/            Shared low-level utilities
```

Entry points:

- [`cli.js`](cli.js) — the `apple-docs` command.
- [`index.js`](index.js) — the legacy `apple-docs-mcp` shim
  (`apple-docs mcp start`).

## Invariants

- **No upward dependencies.** `lib/` does not import from `commands/`;
  `commands/` does not import from `cli/`, `mcp/`, or `web/`.
- **Parallel surfaces.** `cli/`, `mcp/`, and `web/` each depend on
  `commands/` and `output/`, never on each other.
- **One projection boundary.** Every public payload routes through one
  of the `project*()` helpers in
  [`src/output/projection.js`](src/output/projection.js) before
  leaving the process. Leak-guard tests
  ([`test/mcp/leak-guard.test.js`](test/mcp/leak-guard.test.js),
  [`test/unit/web/web-api-leak-guard.test.js`](test/unit/web/web-api-leak-guard.test.js),
  [`test/unit/cli/cli-json-leak-guard.test.js`](test/unit/cli/cli-json-leak-guard.test.js))
  fail if a field outside the allowlist appears.

## Where to read more

| Topic | Document |
| --- | --- |
| Five-layer stack diagram, projection boundary, adapter and repository patterns, observability | [`docs/architecture.md`](docs/architecture.md) |
| Daily ops, deployment topology, env vars, tuning | [`docs/self-hosting.md`](docs/self-hosting.md) |
| Profiling, benchmarks, metrics scrape | [`docs/perf/index.md`](docs/perf/index.md) |
| Security policy + hardened defaults | [`docs/security.md`](docs/security.md) |
| Reference self-hosted ops layer (launchd, Caddy, cloudflared) | [`ops/README.md`](ops/README.md) |
