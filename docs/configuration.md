# Configuration

CLI flags take precedence over environment variables. Every variable is
validated at startup against the zod schema in [`src/config.js`](../src/config.js);
a misconfigured env aborts the process with a multi-line summary listing every
offending field.

For exhaustive command syntax, defer to the built-in help:

```bash
apple-docs --help
apple-docs <command> --help
```

## Storage profiles

The storage profile is the headline install choice — it trades disk for
serving speed. `setup` applies it in one step; there is no follow-up command.

| Profile | On disk¹ | What `setup` does | Reads |
| --- | --- | --- | --- |
| `compact` | ~3 GB (3.1) | Compresses sections, makes the body index contentless, drops the embedded raw payloads, VACUUMs | Rendered on demand |
| `balanced` *(default)* | ~5.5 GB (5.5) | Ships the snapshot as-is | Markdown cached on first read (7-day TTL) |
| `prebuilt` | ~8.6 GB (8.6) | Materializes Markdown + HTML | Served from disk (fastest) |

A full setup from a snapshot is **about 5 minutes** end to end, depending on
download speed and system load (the ~1.53 GB download dominates; post-download
work was ~1 min balanced, ~2–3 min compact, ~3–4 min prebuilt).

<sup>¹ Parenthesised values are measured with `du` as of `snapshot-20260609` (1.53 GB download, 353,295 documents). All three carry the same ~1.3 GB of extracted fonts, SF Symbol renders, and the ~125 MB model2vec embedding model. The variable part is the DB and rendered files:</sup>

| | DB | + Markdown | + HTML | total (`du`) |
| --- | --- | --- | --- | --- |
| `compact` | 1.9 GiB | — | — | **3.1 GB** |
| `balanced` | 4.3 GiB | — | — | **5.5 GB** |
| `prebuilt` | 4.2 GiB | 1.6 GB | 1.6 GB | **8.6 GB** |

<sup>`compact` more than halves the DB (4.3 → 1.9 GiB) by dropping the 353,238 embedded raw payloads, making the body index contentless, and zstd-compressing sections. `prebuilt`'s Markdown + HTML are only ~1.12 GB of actual content (504 MB + 615 MB across 706,590 files); the rest of the ~3.2 GB `du` is 4 KB filesystem-block rounding on hundreds of thousands of tiny files. `apple-docs storage stats` totals logical content bytes, so it reads below the `du` "space consumed on the volume" figure. Install time after the ~1.53 GB download was ~1 min (balanced), ~2–3 min (compact: body reindex + VACUUM), and ~3–4 min (prebuilt: rendering all 353k docs).</sup>

```bash
apple-docs setup --compact     # smallest, fully compacted in one step
apple-docs setup --prebuilt    # fastest, fully materialized
apple-docs setup               # balanced (default); prompts on a TTY
```

`compact` is a one-way trade: it sheds redundant data (the raw payloads and
the body index's duplicate text copy) in exchange for per-read decompression.
Sections and search stay intact, so reading and searching are unaffected —
but `storage materialize raw-json` can no longer regenerate loose raw JSON
once the payloads are dropped.

### Managing storage after install

| Command | Purpose |
| --- | --- |
| `apple-docs storage stats` | Disk-usage breakdown by category |
| `apple-docs storage profile [name]` | Show or change the active profile |
| `apple-docs storage materialize --format markdown\|html\|raw-json` | Render artifacts to disk |
| `apple-docs storage compact [--keep-raw]` | Shrink an existing install (what `setup --compact` runs) |
| `apple-docs storage gc --drop markdown,html` | Reclaim cached materializations |

`storage compact` refuses a `prebuilt` install unless `--force`, since adding
per-read decompression to the fast path defeats the point of prebuilt.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | Corpus location |
| `APPLE_DOCS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `APPLE_DOCS_DEBUG` | `false` | Bypass the public-output projection (raw envelopes leak through MCP/CLI/web). Local-debug only. |

## Outbound HTTP (crawl)

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

## Sync & sources

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_PACKAGES_SCOPE` | `official` | `official` or `full` Swift Package Index scope |
| `APPLE_DOCS_PACKAGES_FETCH` | `raw` | `raw` README fetch or `api` (richer GitHub metadata) |
| `APPLE_DOCS_PACKAGES_LIMIT` | unset | Cap package count during discovery |
| `APPLE_DOCS_SKIP_RESOURCES` | `false` | Skip post-extract font + SF Symbols re-index |
| `APPLE_DOCS_DOWNLOAD_FONTS` | unset | Force-download Apple fonts even if system-installed |
| `APPLE_DOCS_SYMBOLS_OFFLINE` | `false` | Skip the live SF Symbols renderer (use bundled prerenders only) |

The `packages` source defaults to a curated official allowlist and raw README
fetching from `raw.githubusercontent.com`. To include the full Swift Package
Index catalog:

```bash
apple-docs sync --full
APPLE_DOCS_PACKAGES_SCOPE=full apple-docs sync
APPLE_DOCS_PACKAGES_FETCH=api GITHUB_TOKEN=... apple-docs sync --full
```

`APPLE_DOCS_PACKAGES_FETCH=api` adds richer GitHub REST metadata when a token
is available and degrades to raw README fetching when it is not.

## Auth

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | GitHub token for release downloads or package API metadata |
| `APPLE_DOCS_NO_GIT_AUTH` | unset | Disable local-credential detection (set to `1` in CI) |

## MCP server (HTTP transport)

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_MCP_CACHE` | `on` | Per-tool LRU cache. Set to `off` for raw projection traces. |
| `APPLE_DOCS_MCP_CACHE_SCALE` | `1.0` | Uniform multiplier on per-tool LRU sizes |
| `APPLE_DOCS_MCP_CONCURRENCY` | `8` | Max in-flight heavy-tool calls |
| `APPLE_DOCS_MCP_QUEUE` | `64` | Max queued heavy-tool calls before HTTP 503 |
| `APPLE_DOCS_MCP_READERS` | unset (off) | Set to `on` to enable the worker-thread reader pool. Opt-in. |
| `APPLE_DOCS_MCP_READER_WORKERS` | runtime-derived | Pool size when the pool is on (default: `availableParallelism() − 2`, capped at 12). |
| `APPLE_DOCS_MCP_DEEP_READERS` | runtime-derived | Deep-pool size when the pool is on. |

## Web server

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_WEB_HOST` | `127.0.0.1` | Bind address (pass `0.0.0.0` for LAN reach) |
| `APPLE_DOCS_WEB_RATE` / `APPLE_DOCS_WEB_BURST` | `60` / `120` | Per-IP rate-limit defaults |
| `APPLE_DOCS_WEB_RATE_LIMIT` | `false` | Enable per-IP rate limit (off by default; CLI `--rate-limit` overrides) |
| `APPLE_DOCS_CONTENT_SIGNAL` | `search=yes, ai-input=yes, ai-train=yes` | AI-usage content-signal policy emitted in `robots.txt`, the `_headers` file, and the `Content-Signal` response header |
| `APPLE_DOCS_WEB_DEEP_INFLIGHT` / `APPLE_DOCS_WEB_DEEP_QUEUE` | `4` / `8` | Deep-search gate sizing |
| `APPLE_DOCS_WEB_READERS` / `APPLE_DOCS_WEB_DEEP_READERS` / `APPLE_DOCS_WEB_READER_WORKERS` | runtime-derived | Reader-pool sizing |
| `APPLE_DOCS_WEB_RENDER_CONCURRENCY` | runtime-derived | On-demand render-pipeline concurrency |
| `APPLE_DOCS_WEB_SEARCH_CACHE` / `APPLE_DOCS_WEB_SEARCH_CACHE_BYTES` | runtime-derived | Search-result LRU sizing |
| `APPLE_DOCS_WEB_FONT_SUBSET_WORKERS` / `APPLE_DOCS_WEB_FONT_SUBSET_CONCURRENCY` / `APPLE_DOCS_WEB_FONT_SUBSET_LRU` / `APPLE_DOCS_WEB_FONT_SUBSET_LRU_BYTES` | runtime-derived | Font-subset pool sizing |
| `APPLE_DOCS_FONT_SUBSET_PYTHON` | `python3` | Python interpreter for the pyftsubset pool |

## Content rendering

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_NO_HIGHLIGHT` | `false` | Disable Shiki syntax highlighting |
| `APPLE_DOCS_HIGHLIGHT_MAX` | unset | Cap input chars sent through Shiki |
| `APPLE_DOCS_MD_MAX_BYTES` | unset | Cap rendered Markdown payload size |
| `APPLE_DOCS_RENDER_CACHE_BYTES` / `APPLE_DOCS_RENDER_CACHE_TTL_DAYS` | runtime-derived | Render cache sizing |
