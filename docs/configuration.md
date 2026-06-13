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
| `compact` | ~4.6 GB | Compresses sections, makes the body index contentless, drops the embedded raw payloads, VACUUMs | Rendered on demand |
| `balanced` *(default)* | ~7.1 GB | Ships the snapshot as-is | Markdown cached on first read (7-day TTL) |
| `prebuilt` | ~10.5 GB | Materializes Markdown + HTML | Served from disk (fastest) |

A full setup from a snapshot is **a few minutes** end to end, depending on
download speed and system load. Measured from a local archive on Apple
Silicon as of `snapshot-20260611` (1.89 GB download, 353,325 documents),
including the semantic index build: **178 s balanced**, **322 s compact**
(body reindex + VACUUM), **304 s prebuilt** (materializes the full document
set to Markdown + HTML — 361,823 files each). The beta snapshot of the same
week (`snapshot-20260610-beta.3`, 1.90 GB, built on macOS 27) measures
within ~1.5% of these figures on every profile.

<sup>¹ `du` figures. All three carry the same ~1.3 GB of extracted fonts, SF Symbol renders, and the ~125 MB model2vec embedding model (~1.9 GB allocated on disk — 4 KB block rounding across 266k+ small resource files), plus ~0.7 GB of semantic chunk index built locally during setup (snapshots ship the model, never the vectors). The variable part is the DB (compact ~2.7 GB incl. semantic index vs balanced ~5.2 GB) and prebuilt's rendered files — only ~1.2 GB of actual content; the rest of its `du` is block rounding across 720k+ small files. `apple-docs storage stats` totals logical bytes, so it reads lower: 4.0 GB compact / 6.5 GB balanced / 7.7 GB prebuilt.</sup>

```bash
apple-docs setup --compact     # smallest, fully compacted in one step
apple-docs setup --prebuilt    # fastest, fully materialized
apple-docs setup               # balanced (default); prompts on a TTY
```

### Beta channel

Snapshots inherit the SF Symbols catalog of the macOS that builds them, so a
snapshot built on a newer or beta macOS carries symbols the stable CI builds
cannot produce. Such builds ship as GitHub prereleases
(`snapshot-YYYYMMDD-beta.N`, published with
`bun scripts/publish-beta-snapshot.mjs`).

```bash
apple-docs setup --beta --force   # install/update on the beta channel
```

The stable channel (default) never sees prereleases. On the beta channel a
candidate — beta or stable — is only eligible when its recorded build host
(`status.json` → `buildMacos`, also stamped into the DB as
`snapshot_meta.build_macos`) runs at least the same macOS as the installed
corpus — an update never sheds symbols the install already has, and a
stable built on the same-or-newer macOS supersedes the beta. A fresh
install (no corpus yet) picks the candidate with the newest build-host
macOS, ties broken by release recency — so a weekly stable published after
a beta but built on an older macOS never shadows that beta.

Self-hosted instances opt in with `SNAPSHOT_CHANNEL=beta` in `ops/.env`
(see [self-hosting → Channel selection](self-hosting.md#channel-selection)).

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

### Scoping the corpus (`scope.json`)

A `scope.json` at the root of the data directory opts a corpus into
**scoped coverage** — keep a few sources and frameworks instead of the
whole ~350k-page set:

```json
{
  "version": 1,
  "sources": ["apple-docc", "hig", "swift-book"],
  "appleDoccFrameworks": ["swiftui", "combine"],
  "keepFonts": true,
  "keepSymbols": false
}
```

- `sources` — adapter types to keep (`apple-docs kinds` and the README's
  corpus table list them); omitted = all sources.
- `appleDoccFrameworks` — framework slugs for the `apple-docc` source
  only (`apple-docs frameworks` lists slugs); omitted = all frameworks.
- `keepFonts` / `keepSymbols` — whether the Apple fonts and SF Symbols
  resources stay (default `true`).

Two consumers read the file:

| Command | Effect |
| --- | --- |
| `apple-docs prune [--dry-run] [--no-vacuum]` | Trim an EXISTING corpus to the scope without re-crawling: out-of-scope pages, documents, FTS rows, semantic vectors, and markdown/raw-json/html files are deleted, then the DB is VACUUMed. Requires `scope.json`; unknown framework slugs error with the valid list. |
| `apple-docs sync` | Skips out-of-scope adapters and apple-docc roots, so refreshes never grow the corpus past the scope. Scoped corpora also skip the Xcode enrichment merge (it would flood out-of-scope pages back in). |

No `scope.json` → both commands behave exactly as before (full coverage).
A typical flow: `apple-docs setup` → write `scope.json` → `apple-docs
prune` → periodic `apple-docs sync` stays scoped. Delete the file and
`sync` to return to full coverage.

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | Corpus location |
| `APPLE_DOCS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `APPLE_DOCS_DEBUG` | `false` | Bypass the public-output projection (raw envelopes leak through MCP/CLI/web). Local-debug only. |

## Semantic search

Snapshots ship the model2vec embedding model but **no vectors** — `setup`
builds the chunk index locally after extraction (`--skip-semantic` opts out;
`apple-docs index embeddings --full` builds or rebuilds it later). The chunk
store adds roughly 0.7 GB to the local DB on the full corpus. Defaults
preserve prior behavior; every knob below is an escape hatch, not a tuning
requirement.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_SEMANTIC` | (unset) | `off` hard-disables the semantic tier |
| `APPLE_DOCS_EMBED_MODEL` | `potion-retrieval-32M` | Registry model. Non-default models are a gated track for separate snapshot variants |
| `APPLE_DOCS_EMBED_DIMS` | model native (512) | Matryoshka truncation for feature-extraction models (potion ignores it) |
| `APPLE_DOCS_RESCORE` | on when int8 codes exist | `off` skips the int8 rescore stage (binary-only ranking) |
| `APPLE_DOCS_SEMANTIC_SHORTLIST` | `200` | Hamming shortlist size before rescore (16–5000) |
| `APPLE_DOCS_FUSION` | `hybrid` | `rrf` reverts to rank-only weighted-RRF fusion |
| `APPLE_DOCS_MMR` | on | `off` disables the MMR diversity pass |
| `APPLE_DOCS_MMR_LAMBDA` | `0.7` | MMR relevance↔diversity balance (0–1) |
| `APPLE_DOCS_ALLOW_REMOTE_MODELS` | unset | `1` lets the snapshot CI build fetch the model from HuggingFace (sha256-pinned; see `src/search/model-integrity.js`). Never needed by consumers |
| `APPLE_DOCS_MODELS_DIR` | `$APPLE_DOCS_HOME/resources/models` | Override the model directory |

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
| `APPLE_DOCS_ENRICH_FETCH` | unset | `1` lets `sync`'s Xcode-docs enrichment phase download the ~650 MB asset from Apple's CDN when no local Xcode asset exists (the snapshot CI sets it; local syncs use a local asset or skip) |
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

## Native bridge

**Native is the default.** Swift-native implementations (`libAppleDocsCore`,
loaded via `bun:ffi`) serve wherever the library and its data artifacts
exist; everywhere else the JavaScript implementations serve silently —
never an error, never different results. Outputs are **bit-identical** by
construction: the native embed path was proven byte-identical to the JS
path over the full production corpus (831k chunks, identical retrieval
metrics — `scripts/verify-embed-equivalence.mjs`), and fusion/archive carry
their own parity gates. Background: `rfcs/0001-swift-native-transition.md`
and `rfcs/0002-swift-embedder.md` in the repository (not part of this site).

> **Opting out**: set `APPLE_DOCS_NATIVE=off` to force the JavaScript
> implementations. Since the Stage-C cleanup, the DEFAULT embedding model
> has no JavaScript path anymore — with native off, semantic search
> degrades to lexical-only (results stay correct, the semantic tier goes
> dormant). Fusion/archive still serve identically from JS.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_NATIVE` | unset (**on**) | unset/`''`/`1`/`on` → native where available for every default-on module (`fusion`, `archive`, `embed`, `content`, `render`); **`off`/`0` → pure JS everywhere (the escape hatch)**; a comma list (`fusion,archive,embed,content,render`) enables exactly those modules |
| `APPLE_DOCS_NATIVE_LIB` | unset | Absolute path to a `libAppleDocsCore` build. When set it is the only load candidate — a wrong path falls back to JS with a warning, never to another build |

Checkout installs can fetch the prebuilt library for their host from the
release they install (`apple-docs setup --native` — sha256-verified, unpacked
into `dist/native/`); compiled-binary installs skip it. An absent or stale
bundle is never an error: the JS implementations serve.

Modules: `fusion` (result fusion math), `archive` (snapshot tar.zst writer),
`embed` (the default embedding model's tokenizer + matrix pipeline — the
ONLY implementation for the default model since Stage C). New snapshots
ship the ~129 MB weights artifact (`matrix-v1.admx`) directly; on older
onnx-bearing snapshots it is derived once (integrity-verified, atomic)
next to the model files. `@huggingface/transformers`/onnxruntime remain
optional dependencies used solely by gated non-default models.
