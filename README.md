# apple-docs

`apple-docs` builds and serves a local, searchable copy of Apple's developer
documentation, with three interfaces over the same corpus:

- **CLI** — search, read, sync, and maintain the corpus.
- **MCP server** — for Claude, Codex, Cursor, and other MCP clients.
- **Local website** — browse in a browser, or publish a static site.

It covers Apple DocC docs, Human Interface Guidelines, App Store Review
Guidelines, Swift Evolution, Swift.org, the Swift Book, WWDC sessions, Apple
sample code, archived developer docs, and a Swift package catalog.

## Quick start

Requirements: **Bun 1.1+**.

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup          # bun install + bun link, plus test tooling
apple-docs setup --compact # download + install a prebuilt snapshot
```

Then `apple-docs search "NavigationStack"` works offline.

`setup` downloads one verified snapshot (**1.53 GB**, 353,295 documents) and
installs it — **about 5 minutes** end to end, depending on your download speed
and system load. Pick the shape that fits with a single flag:

| Flag | Result | On disk¹ | Install² |
| --- | --- | --- | --- |
| `--compact` | Smallest. Fully compacted in one step (raw payloads dropped, contentless index). Renders on demand. | **~3 GB** (3.1) | +~2–3 min |
| *(none)* | `balanced` default — snapshot as-is; caches Markdown on first read. | **~5.5 GB** (5.5) | +~1 min |
| `--prebuilt` | Fastest. Markdown + HTML materialized up front. | **~8.6 GB** (8.6) | +~3–4 min |

<sup>¹ Parenthesised values are measured (`du`) as of `snapshot-20260609` (353,295 docs). `balanced` is a 4.3 GiB DB + 1.3 GB of extracted fonts, SF Symbol renders, and the ~125 MB model2vec embedding model. `compact` more than halves the DB (→1.9 GiB). `prebuilt` adds ~3.2 GB of Markdown + HTML — only ~1.12 GB is content; the rest is 4 KB block rounding across 706,590 small files. `apple-docs storage stats` reports logical bytes, which run smaller. Add ~0.5 GB to the DB on every profile for the semantic chunk index, which is built locally (snapshots ship the model, never the vectors).</sup>


<sup>² Post-download work, measured from a local archive; on top of the 1.53 GB download. Includes the semantic index build (~1.5–2 min for 353k docs on Apple Silicon; `--skip-semantic` opts out).</sup>

Each profile finishes in that one `setup` call. See
[`docs/configuration.md`](docs/configuration.md#storage-profiles) for the full
tradeoff and how to switch later.

> Prefer a standalone binary or a production self-host? See
> [`docs/installing.md`](docs/installing.md).

## Common usage

```bash
# Search
apple-docs search "NavigationStack"
apple-docs search "Swift Testing" --source wwdc --year 2024
apple-docs search "privacy" --framework app-store-review --read

# Read
apple-docs read swiftui/view
apple-docs read View --framework swiftui
apple-docs read swiftui/view --section Overview

# Browse / inspect
apple-docs frameworks
apple-docs browse swiftui
apple-docs status
apple-docs storage stats
```

Built-in help is the exhaustive reference:

```bash
apple-docs --help
apple-docs <command> --help
```

## Local website

```bash
apple-docs web serve              # http://127.0.0.1:3000
apple-docs web build --out dist/web   # static site
```

`web serve` also answers agents: Markdown content negotiation on `/docs/*`
(`Accept: text/markdown`), `robots.txt` content signals, an RFC 9727 API
catalog at `/.well-known/api-catalog`, and an MCP server card at
`/.well-known/mcp/server-card.json`. Deployment notes:
`apple-docs web deploy <github-pages|cloudflare|vercel|netlify>`.

## MCP server

```bash
apple-docs mcp install            # write local MCP client config
apple-docs mcp start              # stdio server
apple-docs mcp serve --port 3031  # Streamable HTTP
```

**Tools:** `search_docs`, `read_doc`, `list_frameworks`, `browse`,
`list_taxonomy`, `search_sf_symbols`, `list_apple_fonts`, `render_sf_symbol`,
`render_font_text`.

**Resources:** `apple-docs://doc/{key}`, `apple-docs://framework/{slug}`,
`apple-docs://sf-symbol/{scope}/{name}.{format}`, `apple-docs://font/{id}`.

HTTP MCP has no built-in auth — keep it on loopback unless a reverse proxy,
tunnel, or private network handles access control. With `--allow-origin`
omitted, browser `Origin` requests are denied except loopback; native clients
(no `Origin` header) are allowed.

### Public instance

A best-effort public deployment (no uptime SLA; self-host for production):

```bash
claude mcp add -s user --transport http apple-docs https://apple-docs-mcp.everest.mt/mcp
codex mcp add apple-docs -- bunx mcp-remote https://apple-docs-mcp.everest.mt/mcp
```

## Build the corpus yourself

Instead of a snapshot, crawl Apple's docs directly:

```bash
apple-docs sync          # resumable, idempotent full refresh
apple-docs sync --full   # clean rebuild
```

Build a portable snapshot from an existing corpus with
`apple-docs snapshot build --out dist` (writes a `.tar.zst` + `.sha256` +
manifest). Install it with `apple-docs setup --archive <path> --force`.

## Corpus sources

| Source type | Coverage |
| --- | --- |
| `apple-docc` | Apple Developer Documentation: frameworks, APIs, technologies, release notes |
| `hig` | Human Interface Guidelines |
| `guidelines` | App Store Review Guidelines |
| `swift-evolution` | Swift Evolution proposals |
| `swift-book` | The Swift Programming Language |
| `swift-docc` | Swift documentation archives (compiler, SwiftPM, migration guides) |
| `swift-org` | Swift.org documentation and articles |
| `apple-archive` | Archived Apple developer documentation |
| `wwdc` | WWDC session catalog and transcripts |
| `sample-code` | Apple sample code catalog |
| `packages` | Swift package catalog, enriched with repository README content |

### Optional: enrich from Xcode's offline documentation

Xcode 26+ ships the documentation corpus as a MobileAsset
(`com.apple.MobileAsset.AppleDeveloperDocumentation`). It backfills two
things the crawl can't see: each symbol's **USR** (`documents.usr`, stable
across releases and shared by the Swift/Obj-C variants) and several thousand
member/symbol pages the crawl missed. The merge is keyed,
NULL-guarded, and idempotent: it never duplicates or overwrites crawled
data. The asset is auto-resolved — a local Xcode install is used when
present, otherwise it is downloaded (~650 MB, SHA-1-verified) from Apple's
CDN, so it works on machines without Xcode.

```bash
bun scripts/enrich-xcode-docs.js            # dry-run (auto-resolve the asset)
bun scripts/enrich-xcode-docs.js --apply    # write the merge
bun scripts/enrich-xcode-docs.js --fetch --apply   # force the CDN download
```

The weekly snapshot build runs this automatically (always downloading, since
CI has no Xcode), so published snapshots already carry the USRs and the
extra pages.

## Documentation

- [Installing](docs/installing.md) — dev, standalone binary, or production self-host.
- [Configuration](docs/configuration.md) — storage profiles, environment variables, tuning.
- [Architecture](docs/architecture.md) — five-layer stack and projection boundary.
- [Self-hosting](docs/self-hosting.md) — deployment topology, agent discovery, DNS-AID.
- [Performance](docs/perf/index.md) · [Security policy](docs/security.md) · [Docs index](docs/README.md)

## Development

```bash
bun run ci         # lint + typecheck + tests
bun run test:web   # web suite only
bun run audit      # full audit (lint, types, unused, dup, coverage)
```

## License

See [LICENSE](LICENSE).
