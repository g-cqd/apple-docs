# apple-docs

`apple-docs` builds and serves a local, searchable copy of Apple's developer
documentation.

It gives you three interfaces over the same corpus:

- **CLI** for searching, reading, syncing, and maintaining the corpus.
- **MCP server** for Claude, Codex, Cursor, and other MCP clients.
- **Local website** for browsing the docs in a browser or publishing a static
  site.

The corpus covers Apple DocC documentation, Human Interface Guidelines, App
Store Review Guidelines, Swift Evolution, Swift.org documentation, Swift Book
content, WWDC sessions, Apple sample code, archived Apple developer docs, and a
Swift package catalog.

## Quick Start

Requirements: **Bun 1.1+**. See [`docs/installing.md`](docs/installing.md)
for the three supported install paths (dev / standalone binary /
production self-host) and their verification steps.

Fastest path — dev install + prebuilt snapshot:

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup
apple-docs setup
```

`bun run dev:setup` is idempotent and a strict superset of
`bun install && bun link`: it also installs 7zip (for archive
tests), Python `fontTools` + `brotli` (for font-subset tests), and
Playwright Chromium (for the browser-worker test). See
[`docs/installing.md`](docs/installing.md) for the breakdown.

`setup` installs one full snapshot shape: database, Markdown, raw JSON,
extracted Apple fonts, and pre-rendered SF Symbols. ~60 seconds, ~6 GB
on disk.

If you want to build the corpus yourself instead:

```bash
apple-docs sync
```

`sync` is resumable and idempotent. It performs the whole refresh pipeline:
HEAD checks, discovery, crawl, download, conversion, body index refresh, Apple
typography and SF Symbols sync, symbol pre-render, schema migrations,
consolidation, and raw JSON minification.

For a standalone Bun-compiled binary (no toolchain required after
build) see the [Standalone binary](docs/installing.md#standalone-binary)
section of the install guide. For self-hosting a public MCP HTTP
server, see [Production self-host](docs/installing.md#production-self-host).

By default `sync` uses 100 in-flight fetches and a 500 requests/sec rate limit.
Use `--rate <n>` to lower the request rate, `APPLE_DOCS_CONCURRENCY=<n>` to set
fetch concurrency explicitly, or `--aggressive` to opt into the legacy 500
in-flight profile.

## Common CLI Usage

Search:

```bash
apple-docs search "NavigationStack"
apple-docs search "Swift Testing" --source wwdc --year 2024
apple-docs search "privacy" --framework app-store-review --read
apple-docs search "UIImagePickerController" --deprecated exclude
```

Read:

```bash
apple-docs read swiftui/view
apple-docs read View --framework swiftui
apple-docs read app-store-review/3.1
apple-docs read swiftui/view --section Overview
```

Browse and inspect the corpus:

```bash
apple-docs frameworks
apple-docs browse swiftui
apple-docs kinds
apple-docs kinds --field sourceType
apple-docs status
apple-docs storage stats
```

Maintenance:

```bash
apple-docs sync
apple-docs sync --full
apple-docs consolidate --dry-run
apple-docs index rebuild body
apple-docs index rebuild trigram
apple-docs storage gc --drop markdown,html
```

Use built-in help as the exhaustive command reference:

```bash
apple-docs --help
apple-docs search --help
apple-docs sync --help
apple-docs web --help
apple-docs mcp --help
```

## Local Website

Start the local docs site:

```bash
apple-docs web serve
```

It binds to `http://127.0.0.1:3000` by default.

Useful serving options:

```bash
apple-docs web serve --port 3030 --host 0.0.0.0
apple-docs web serve --metrics-port 9101
apple-docs web serve --rate-limit
```

Build a static site:

```bash
apple-docs web build --out dist/web
apple-docs web build --incremental --out dist/web
apple-docs web build --workers 6 --incremental --out dist/web
```

Print deployment notes:

```bash
apple-docs web deploy github-pages
apple-docs web deploy cloudflare
apple-docs web deploy vercel
apple-docs web deploy netlify
```

## MCP Server

Install local MCP client configuration:

```bash
apple-docs mcp install
```

Run the stdio server directly:

```bash
apple-docs mcp start
```

Run Streamable HTTP for remote or shared access:

```bash
apple-docs mcp serve --port 3031 --host 127.0.0.1 \
  --allow-origin https://mcp.example.com
```

HTTP endpoints:

| Path | Method | Purpose |
| --- | --- | --- |
| `/mcp` | `POST` | JSON-RPC requests |
| `/mcp` | `GET` | Server-initiated SSE stream |
| `/mcp` | `DELETE` | Terminate a session |
| `/healthz` | `GET` | Liveness probe |
| `/readyz` | `GET` | DB and reader-pool readiness probe |

There is no built-in authentication. Keep HTTP MCP on loopback unless a
reverse proxy, tunnel, or private network boundary handles access control.
When `--allow-origin` is omitted, browser `Origin` requests are denied except
loopback origins; native clients without an `Origin` header are allowed.

Tools:

- `search_docs`
- `read_doc`
- `list_frameworks`
- `browse`
- `list_taxonomy`
- `search_sf_symbols`
- `list_apple_fonts`
- `render_sf_symbol`
- `render_font_text`

Resources:

- `apple-docs://doc/{key}`
- `apple-docs://framework/{slug}`
- `apple-docs://sf-symbol/{scope}/{name}.{format}`
- `apple-docs://font/{id}`

### Public MCP Instance

A best-effort public deployment is available at:

```text
https://apple-docs-mcp.everest.mt/mcp
```

It is suitable for casual use and has no uptime SLA. Self-host for production
or privacy-sensitive workflows.

Claude Code:

```bash
claude mcp add -s user --transport http apple-docs https://apple-docs-mcp.everest.mt/mcp
```

Codex CLI through the `mcp-remote` stdio bridge:

```bash
codex mcp add apple-docs -- bunx mcp-remote https://apple-docs-mcp.everest.mt/mcp
```

Print remote client snippets for other tools:

```bash
apple-docs mcp install --http https://apple-docs-mcp.everest.mt/mcp
```

## Corpus Sources

| Source type | Coverage |
| --- | --- |
| `apple-docc` | Apple Developer Documentation: frameworks, APIs, technologies, release notes |
| `hig` | Human Interface Guidelines |
| `guidelines` | App Store Review Guidelines |
| `swift-evolution` | Swift Evolution proposals |
| `swift-book` | The Swift Programming Language |
| `swift-docc` | Swift documentation archives such as compiler, SwiftPM, and migration guides |
| `swift-org` | Swift.org documentation and articles |
| `apple-archive` | Archived Apple developer documentation |
| `wwdc` | WWDC session catalog and transcripts |
| `sample-code` | Apple sample code catalog |
| `packages` | Swift package catalog, enriched with repository README content |

The `packages` source defaults to a curated official allowlist and raw README
fetching from `raw.githubusercontent.com`. To include the full Swift Package
Index catalog, run a full sync or set the env var explicitly:

```bash
apple-docs sync --full
APPLE_DOCS_PACKAGES_SCOPE=full apple-docs sync
APPLE_DOCS_PACKAGES_FETCH=api GITHUB_TOKEN=... apple-docs sync --full
```

`APPLE_DOCS_PACKAGES_FETCH=api` adds richer GitHub REST metadata when a token is
available and degrades to raw README fetching when it is not.

## Snapshots

Build a portable snapshot from an existing corpus:

```bash
apple-docs snapshot build --out dist
apple-docs snapshot build --tag snapshot-20260511
```

This writes:

```text
dist/apple-docs-full-<tag>.tar.gz
dist/apple-docs-full-<tag>.tar.gz.sha256
dist/apple-docs-full-<tag>.manifest.json
```

Install from a local snapshot:

```bash
apple-docs setup --archive dist/apple-docs-full-<tag>.tar.gz --force
```

## Configuration

CLI flags take precedence over environment variables. Every variable is
validated at startup against the zod schema in
[`src/config.js`](src/config.js); a misconfigured env aborts the process
with a multi-line summary listing every offending field.

### Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | Corpus location |
| `APPLE_DOCS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `APPLE_DOCS_DEBUG` | `false` | Bypass the public-output projection (raw envelopes leak through MCP/CLI/web). Local-debug only. |

### Outbound HTTP (crawl)

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_RATE` | `500` for `sync`, `5` otherwise | Requests per second across all hosts |
| `APPLE_DOCS_BURST` | At least the active rate | Token-bucket burst size |
| `APPLE_DOCS_CONCURRENCY` | `100` for `sync`, `5` otherwise | Outbound fetch concurrency |
| `APPLE_DOCS_PARALLEL` | `10` | Number of DocC roots crawled in parallel during `sync` |
| `APPLE_DOCS_TIMEOUT` | `30000` | HTTP timeout in ms |
| `APPLE_DOCS_GITHUB_TIMEOUT` | `45000` or `APPLE_DOCS_TIMEOUT` | GitHub timeout override |
| `APPLE_DOCS_API_BASE` | Apple tutorial data URL | Override Apple's DocC API base |
| `APPLE_DOCS_HOST_BUCKET_MAX` | `256` | Per-host limiter LRU cap |

### Sync & sources

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_PACKAGES_SCOPE` | `official` | `official` or `full` Swift Package Index scope |
| `APPLE_DOCS_PACKAGES_FETCH` | `raw` | `raw` README fetch or `api` (richer GitHub metadata) |
| `APPLE_DOCS_PACKAGES_LIMIT` | unset | Cap package count during discovery |
| `APPLE_DOCS_SKIP_RESOURCES` | `false` | Skip post-extract font + SF Symbols re-index |
| `APPLE_DOCS_DOWNLOAD_FONTS` | unset | Force-download Apple fonts even if system-installed |
| `APPLE_DOCS_SYMBOLS_OFFLINE` | `false` | Skip the live SF Symbols renderer (use bundled prerenders only) |

### Auth

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | GitHub token for release downloads or package API metadata |
| `APPLE_DOCS_NO_GIT_AUTH` | unset | Disable local-credential detection (set to `1` in CI) |

### MCP server (HTTP transport)

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_MCP_CACHE` | `on` | Per-tool LRU cache. Set to `off` for raw projection traces. |
| `APPLE_DOCS_MCP_CACHE_SCALE` | `1.0` | Uniform multiplier on per-tool LRU sizes |
| `APPLE_DOCS_MCP_CONCURRENCY` | `8` | Max in-flight heavy-tool calls |
| `APPLE_DOCS_MCP_QUEUE` | `64` | Max queued heavy-tool calls before HTTP 503 |
| `APPLE_DOCS_MCP_READERS` | unset (off) | Set to `on` to enable the worker-thread reader pool. Opt-in. |
| `APPLE_DOCS_MCP_READER_WORKERS` | runtime-derived | Pool size when the pool is on (default: `availableParallelism() − 2`, capped at 12). |
| `APPLE_DOCS_MCP_DEEP_READERS` | runtime-derived | Deep-pool size when the pool is on. |

### Web server

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_WEB_HOST` | `127.0.0.1` | Bind address (pass `0.0.0.0` for LAN reach) |
| `APPLE_DOCS_WEB_RATE` / `APPLE_DOCS_WEB_BURST` | `60` / `120` | Per-IP rate-limit defaults |
| `APPLE_DOCS_WEB_RATE_LIMIT` | `false` | Enable per-IP rate limit (off by default; CLI `--rate-limit` overrides) |
| `APPLE_DOCS_WEB_DEEP_INFLIGHT` / `APPLE_DOCS_WEB_DEEP_QUEUE` | `4` / `8` | Deep-search gate sizing |
| `APPLE_DOCS_WEB_READERS` / `APPLE_DOCS_WEB_DEEP_READERS` / `APPLE_DOCS_WEB_READER_WORKERS` | runtime-derived | Reader-pool sizing |
| `APPLE_DOCS_WEB_RENDER_CONCURRENCY` | runtime-derived | On-demand render-pipeline concurrency |
| `APPLE_DOCS_WEB_SEARCH_CACHE` / `APPLE_DOCS_WEB_SEARCH_CACHE_BYTES` | runtime-derived | Search-result LRU sizing |
| `APPLE_DOCS_WEB_FONT_SUBSET_WORKERS` / `APPLE_DOCS_WEB_FONT_SUBSET_CONCURRENCY` / `APPLE_DOCS_WEB_FONT_SUBSET_LRU` / `APPLE_DOCS_WEB_FONT_SUBSET_LRU_BYTES` | runtime-derived | Font-subset pool sizing |
| `APPLE_DOCS_FONT_SUBSET_PYTHON` | `python3` | Python interpreter for the pyftsubset pool |

### Content rendering

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_NO_HIGHLIGHT` | `false` | Disable Shiki syntax highlighting |
| `APPLE_DOCS_HIGHLIGHT_MAX` | unset | Cap input chars sent through Shiki |
| `APPLE_DOCS_MD_MAX_BYTES` | unset | Cap rendered Markdown payload size |
| `APPLE_DOCS_RENDER_CACHE_BYTES` / `APPLE_DOCS_RENDER_CACHE_TTL_DAYS` | runtime-derived | Render cache sizing |

## Documentation

- [Documentation index](docs/README.md) — site map for the full docs.
- [Installing](docs/installing.md) — dev, standalone binary, or
  production install paths.
- [Architecture](docs/architecture.md) — five-layer stack, projection
  boundary, adapter and repository patterns.
- [Self-hosting](docs/self-hosting.md) — deployment topology and
  tuning.
- [Performance](docs/perf/index.md) — profiling, benchmarks, and
  metrics scrape.
- [Public-instance update runbook](docs/runbooks/public-instance-update.md)
- [Grafana dashboards](docs/ops-grafana.md)
- [Reference ops deployment](ops/README.md)
- [Cloudflare configuration](ops/cloudflare/README.md)
- [Security policy](docs/security.md) (long form; root [`SECURITY.md`](SECURITY.md) is the GitHub-facing reporting stub).

The documentation also builds into a static site via VitePress:

```bash
bun run docs:dev      # live preview
bun run docs:build    # static site at docs/.vitepress/dist/
```

## Development

```bash
bun run ci
```

Useful extra checks:

```bash
bun run test:web
bun run audit
bun run bench
bun run test:mutate
```

## License

See [LICENSE](LICENSE).
