# Architecture

A 2-minute orientation. For day-to-day operator concerns see
[`docs/self-hosting.md`](docs/self-hosting.md); for project history see
[`docs/`](docs/README.md).

## What apple-docs is

A Bun-only CLI + MCP server + local website over a single SQLite corpus
of Apple developer documentation (~329 k pages across DocC, WWDC,
Swift Evolution, the Swift Book, sample code, App Store Review,
Human Interface Guidelines, archives, and the Swift package catalog).
Three public surfaces share one application core; one central public
projection boundary keeps internal infrastructure out of every response.

## Five-layer stack

```
                  ┌─────────────────────────────────────┐
                  │  Entry points: cli.js, index.js     │
                  └────┬───────────┬────────┬───────────┘
                       │           │        │
                       ▼           ▼        ▼
                   ┌───────┐  ┌───────┐  ┌────────┐
                   │  cli/ │  │  mcp/ │  │  web/  │   ← Surfaces (inbound adapters)
                   └───┬───┘  └───┬───┘  └────┬───┘
                       └─────┬────┴───────────┘
                             ▼
                      ┌─────────────┐
                      │   output/   │              ← Public projection boundary
                      └──────┬──────┘
                             ▼
                      ┌─────────────┐
                      │  commands/  │              ← Use-cases (application core)
                      └──────┬──────┘
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐ ┌────────────┐ ┌────────────┐
        │ pipeline/│ │  search/   │ │ resources/ │  ← Domain orchestrators
        └────┬─────┘ └─────┬──────┘ └─────┬──────┘
             └──────┬──────┴──────────────┘
                    ▼
             ┌──────────────┐
             │   storage/   │                      ← Persistence (repository pattern)
             └──────┬───────┘
                    ▼
          ┌─────────────────┐
          │ content/ apple/ │                      ← Domain models + vendor glue
          │   sources/      │
          └────────┬────────┘
                   ▼
             ┌───────────┐
             │   lib/    │                         ← Foundational utilities
             └───────────┘
```

Invariants enforced by import discipline:

- No upward dependencies. `lib/` doesn't know about `commands/`;
  `commands/` doesn't know about `cli/` / `mcp/` / `web/`.
- The three surfaces are parallel — they know about `commands/` and
  `output/`, not about each other.
- Every public payload routes through one of the `project*()` functions in
  [`src/output/projection.js`](src/output/projection.js) before leaving the
  process.

## Key patterns

### Public projection boundary (`src/output/`)

`projection.js` is the single chokepoint for the public API. It defines
the allowlist for each surface response (`SearchHit`, `DocMetadata`,
`Framework`, `Taxonomy`, asset render outputs, status fields) and strips
everything else. `confidence.js` collapses the internal `matchQuality`
cascade enum to the public three-level `'exact' | 'partial' |
'approximate'`. `schemas.js` declares strict zod schemas the MCP SDK
validates `structuredContent` against.

`APPLE_DOCS_DEBUG=1` short-circuits both the projection allowlist and
the strict schemas — local-debug-only escape hatch. Leak-guard tests
(`test/mcp/leak-guard.test.js`, `test/unit/web-api-leak-guard.test.js`,
`test/unit/cli-json-leak-guard.test.js`) walk every surface response
and reject any field outside the allowlist.

### Source adapter pattern (`src/sources/`)

Twelve `SourceAdapter` subclasses (Apple DocC, HIG, Guidelines, WWDC,
Swift DocC / Org / Book / Evolution, packages, packages-official,
sample-code, Apple Archive). Every adapter implements:

```js
static type, static displayName, static syncMode
async discover(ctx)
async fetch(key, ctx)
async check(key, prevState, ctx)
normalize(key, payload)
extractReferences(key, payload)
renderHints()
```

[`src/sources/base.js`](src/sources/base.js) defines the contract and
the `validate*Result()` helpers every adapter calls before returning.
[`src/sources/registry.js`](src/sources/registry.js) maps source name
→ class. Adding a new source means dropping in a new adapter file and
adding one line to the registry.

### Storage repository pattern (`src/storage/repos/`)

Nine repos (documents, search, roots, assets-fonts, assets-symbols,
crawl, operations, plus tier-aware variants) following the same
shape: each exports a `createXxxRepo(db, opts?)` factory that builds
prepared statements once at construction and returns a methods
object. Methods are thin wrappers; no raw DB rows leak past the repo
boundary. Schema migrations live under
[`src/storage/migrations/`](src/storage/migrations/) — append-only,
versioned `v1` through `v20+`.

The reader pool ([`src/storage/reader-pool.js`](src/storage/reader-pool.js))
runs SQLite reads on worker threads with classifier-based shard
selection so cheap reads don't queue behind deep body searches.

### Three surfaces, one application core

| Surface | Entry | Tool surface |
| --- | --- | --- |
| **CLI** | [`cli.js`](cli.js) | 14 user-facing commands grouped Query / Setup & Sync / Hosting / Maintenance & Build. Advanced flags live under a per-command `Advanced` subsection. `--json` routes through the public projection. |
| **MCP** | [`index.js`](index.js) → [`src/mcp/server.js`](src/mcp/server.js) | 8 tools (`search_docs`, `read_doc`, `browse`, `list_frameworks`, `list_taxonomy`, `search_sf_symbols`, `list_apple_fonts`, `render_sf_symbol`, `render_font_text`) + 4 resource templates. Stdio + Streamable HTTP transports. |
| **Web** | [`src/web/serve.js`](src/web/serve.js) | Static site builder (`apple-docs web build`) + dev server (`web serve`). 12 route files, content-hashed `/data/*` artifacts, SSR for `/docs/*`. |

All three flow through `src/commands/*.js` for use-case logic and
[`src/output/projection.js`](src/output/projection.js) for response
shaping.

## Distribution

- **Source install:** `git clone … && bun install && bun link` (developer
  setup).
- **Snapshot install:** `apple-docs setup` (downloads a pre-built tarball;
  DB + raw JSON + Markdown + extracted Apple fonts + pre-rendered SF
  Symbols matrix).
- **Standalone binary:** `bun run build:cli` produces a single-file
  ~78 MB executable via `bun build --compile`. The
  `release-binaries.yml` workflow attaches darwin-arm64, linux-x64, and
  linux-arm64 binaries to GitHub releases alongside the snapshot
  tarball.

## Observability

Optional Prometheus metrics on a dedicated port for both servers (web:
`--metrics-port 9101`, MCP: `--metrics-port`). Health/readiness
endpoints (`/healthz`, `/readyz`) on both. Structured JSON logs via
[`src/lib/logger.js`](src/lib/logger.js) with secret redaction.

## Bun-native primitives

The codebase leans into Bun rather than Node compatibility. Specifically:

- `bun:sqlite` for the corpus DB; reader pool uses Bun's `Worker`.
- `Bun.serve()` for both HTTP servers; `Bun.spawn()` for archive and
  symbol-render subprocesses.
- `Bun.gzipSync`, `Bun.inflateSync`, `Bun.CryptoHasher`,
  `Bun.escapeHTML`, `Bun.sleep` instead of the `node:zlib` /
  `node:crypto` / `setTimeout` idioms.
- `Bun.file()` / `Bun.write()` for all reads/writes.

## What's NOT in this stack

- No port to Node — Bun is the only target runtime.
- No TypeScript compile step — JavaScript with JSDoc types validated
  by `bun x tsc --noEmit`.
- No background workers beyond Bun's reader pool and the static-site
  build fan-out.
- No external service dependencies at runtime (the corpus is local;
  the public hosted instance is the only optional network artefact).

## Documentation index

- [`README.md`](README.md) — usage, configuration, MCP setup.
- [`docs/self-hosting.md`](docs/self-hosting.md) — deployment topology.
- [`docs/perf/README.md`](docs/perf/README.md) — profiling workflow.
- [`docs/runbooks/`](docs/runbooks/) — operational runbooks.
- [`SECURITY.md`](SECURITY.md) — security policy + hardened defaults.
- [`ops/README.md`](ops/README.md) — reference self-hosted deployment.
