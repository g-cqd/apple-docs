# apple-docs

`apple-docs` gives you a local, searchable copy of Apple's developer documentation.

Use it in three ways:

- **CLI** — search and read docs from the terminal
- **MCP server** — expose the corpus to Claude, Cursor, and other AI tools
- **Local website** — browse a fast offline-friendly docs site in your browser

It covers Apple's DocC documentation, HIG, App Store Review Guidelines, Swift Evolution, Swift.org content, WWDC sessions, Apple sample code, the Swift package catalog, and more.

## Why this repo exists

Apple's documentation is spread across many sources and the web experience is not always ideal when you want to:

- search quickly across everything
- work offline or on a local mirror
- feed the docs into an AI assistant
- keep a reusable local corpus instead of hitting live web pages every time

`apple-docs` solves that by building a local corpus and giving you a consistent interface on top of it.

## The fastest way to get value

### Option 1: install a snapshot

If you want something working right away:

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
bun link
apple-docs setup
```

This downloads a prebuilt corpus and is the best default for most people.

### Option 2: build your own corpus

If you want to crawl and index everything yourself:

```bash
apple-docs sync --full --index
```

The default crawl profile is intentionally aggressive: **10** roots in parallel, **500** in-flight fetches, and **500** requests/sec. Override it with `--parallel`, `--concurrency`, and `--rate` if you want to be gentler.

If the sync is interrupted, rerun it and it will resume from saved progress.

## What you can do with it

### Search from the terminal

```bash
apple-docs search "NavigationStack"
apple-docs search "Swift Testing" --source wwdc --year 2024
apple-docs search "privacy" --framework app-store-review --read
```

Search is typo-tolerant, uses tiered ranking, and can fall back to body search when a body index is available.

### Read a specific page

```bash
apple-docs read swiftui/view
apple-docs read View --framework swiftui
apple-docs read app-store-review/3.1
apple-docs read swiftui/view --section Overview
```

### Browse what is available

```bash
apple-docs frameworks
apple-docs browse swiftui
apple-docs status
```

### Keep the corpus fresh

```bash
apple-docs update --index
apple-docs doctor --verify
```

Useful maintenance commands:

- `update` pulls incremental changes
- `index` rebuilds search indexes
- `doctor` repairs crawl issues and verifies corpus integrity
- `status` shows health, freshness, and storage information
- `sync` and `update` use the same default crawl profile: `--parallel 10 --concurrency 500 --rate 500`

## Local website

Start the local docs site:

```bash
apple-docs web serve
```

By default it runs at `http://localhost:3000`.

The web UI includes:

- fast filtered search
- browser-local search reuse on the header and `/search` page
- cached search worker artifacts when the browser supports IndexedDB
- tree and list views for framework pages
- quick search, kind chips, deprecated filtering, and alpha/kind sorting on listings
- syntax highlighting
- platform, deprecated, and beta badges
- a table of contents and sidebar navigation
- on-demand fetching and caching for missing pages in the dev server

To build a static site instead:

```bash
apple-docs web build --out dist/web
```

Deployment instructions are built in:

```bash
apple-docs web deploy github-pages
apple-docs web deploy cloudflare
apple-docs web deploy vercel
apple-docs web deploy netlify
```

## MCP server

To expose the corpus to an AI assistant:

```bash
apple-docs mcp install
```

That prints ready-to-paste configuration for MCP clients.

You can also run the server directly:

```bash
apple-docs mcp start
```

The MCP server exposes:

- `search_docs`
- `read_doc`
- `list_frameworks`
- `list_taxonomy`
- `browse`

and these resources:

- `apple-docs://doc/{key}`
- `apple-docs://framework/{slug}`

### Use the public MCP instance

There's a best-effort public deployment at `https://apple-docs-mcp.everest.mt/mcp`.
It runs on a home server with no uptime SLA — fine for casual use, not for
anything load-bearing. For production or privacy-sensitive work, self-host.

Claude Code:

```bash
claude mcp add -s user --transport http apple-docs https://apple-docs-mcp.everest.mt/mcp
```

Codex CLI (via the `mcp-remote` stdio bridge, which every MCP client supports):

```bash
codex mcp add apple-docs -- bunx mcp-remote https://apple-docs-mcp.everest.mt/mcp
```

For Claude Desktop, Cursor, and other clients, the corresponding JSON is the
standard Streamable HTTP config pointing at the same URL, or an `mcp-remote`
stdio fallback. Run `apple-docs mcp install --http https://apple-docs-mcp.everest.mt/mcp`
to print ready-to-paste snippets.

### Remote MCP over HTTP

For shared or remote access, run the MCP server as a Streamable HTTP endpoint instead of stdio:

```bash
apple-docs mcp serve --port 3031 --host 127.0.0.1 \
  --allow-origin https://mcp.example.com
```

Endpoints:

| Path | Method | Purpose |
| --- | --- | --- |
| `/mcp` | `POST` | JSON-RPC requests |
| `/mcp` | `GET` | Server-initiated SSE stream |
| `/mcp` | `DELETE` | Terminate a session |
| `/healthz` | `GET` | Liveness probe |

The server has **no built-in authentication**; keep it on loopback and put
access control at the edge. For a full self-hosting guide — reverse proxy,
tunnels, launchd/systemd, tuning knobs, observability — see
[`docs/self-hosting.md`](docs/self-hosting.md).

Print a client config for a remote endpoint:

```bash
apple-docs mcp install --http https://mcp.example.com/mcp
```

That emits both the native Streamable HTTP config and an `mcp-remote` stdio fallback for clients without native HTTP support.

## What the corpus covers

| Source type | Coverage |
| --- | --- |
| `apple-docc` | Apple's official developer docs: frameworks, API references, technologies, release notes |
| `hig` | Human Interface Guidelines |
| `guidelines` | App Store Review Guidelines |
| `swift-evolution` | Swift Evolution proposals |
| `swift-book` | The Swift Programming Language |
| `swift-org` | Swift.org articles and reference material |
| `apple-archive` | Archived Apple documentation |
| `wwdc` | WWDC session catalog and metadata |
| `sample-code` | Apple sample code catalog |
| `packages` | Swift package catalog, enriched with repository READMEs |

## The commands most people need

| Command | What it does |
| --- | --- |
| `search <query>` | Search the corpus |
| `read <path-or-symbol>` | Read one page |
| `frameworks` | List documentation roots |
| `browse <framework>` | Explore a framework or subtree |
| `kinds` | List distinct kind/role/docKind/sourceType values with counts |
| `setup` | Install a snapshot |
| `sync` | Crawl/build a corpus locally (resumable; idempotent re-runs) |
| `index rebuild <kind>` | Rebuild a search index from existing data (`body` or `trigram`) |
| `consolidate` | Repair failed crawl entries and re-resolve URLs |
| `status` | Show health, progress, and storage |
| `web serve` | Run the local website |
| `web build` | Build a static site |
| `mcp install` | Print MCP client config |
| `mcp start` | Start the MCP server |
| `snapshot build` | Package your corpus into a snapshot |

## A few useful examples

### Search

```bash
apple-docs search "Publisher"
apple-docs search "Publsher"
apple-docs search "Observation" --min-ios 17.0
apple-docs search "Accessibility" --source wwdc --track accessibility
apple-docs search "dismiss sheet" --no-eager
apple-docs search "UIImagePickerController" --deprecated exclude
apple-docs kinds --field roleHeading
```

### Sync only part of the world

```bash
apple-docs sync --roots swiftui,combine
apple-docs sync --sources wwdc,sample-code
apple-docs sync --sources packages
```

### Build or repair indexes

```bash
apple-docs index rebuild body
apple-docs index rebuild trigram
```

Long body-index runs checkpoint their progress and resume automatically after interruption.

### Repair a broken corpus

```bash
apple-docs consolidate
apple-docs consolidate --dry-run
apple-docs consolidate --minify
```

The retry phase is checkpointed, so rerunning `consolidate` continues where it left off.

## Packages source notes

The `packages` source has two independent dimensions:

- **Scope** (`APPLE_DOCS_PACKAGES_SCOPE` / `--full`): `official` covers the
  curated Apple + Swift ecosystem allowlist, `full` unions the full
  SwiftPackageIndex catalog on top.
- **Fetch mode** (`APPLE_DOCS_PACKAGES_FETCH`): defaults to `raw`, which pulls
  README-only data from `raw.githubusercontent.com` — no GitHub quota at all.
  Set `APPLE_DOCS_PACKAGES_FETCH=api` (and export `GITHUB_TOKEN`/`GH_TOKEN`) to
  use the richer GitHub REST metadata (stars, forks, license, topics). The
  `api` path silently degrades to `raw` if no token is available so it never
  burns the 60/hr unauthenticated IP quota.

Useful commands:

```bash
apple-docs sync --sources packages              # curated, raw, no auth
apple-docs sync --full --sources packages       # full catalog, raw, no auth
APPLE_DOCS_PACKAGES_FETCH=api GITHUB_TOKEN=... apple-docs sync --full --sources packages  # full catalog + rich metadata
```

Useful environment variables:

- `APPLE_DOCS_PACKAGES_SCOPE=official|full`
- `APPLE_DOCS_PACKAGES_FETCH=raw|api` (default `raw`)
- `APPLE_DOCS_PACKAGES_LIMIT=<n>`
- `GITHUB_TOKEN` or `GH_TOKEN` (only required for `APPLE_DOCS_PACKAGES_FETCH=api`)

## Snapshots

You can build your own release-style snapshot from an existing corpus:

```bash
apple-docs snapshot build --out dist
apple-docs snapshot build --tag snapshot-20260413
```

Every snapshot ships the full corpus:

- normalized documents + sections + body FTS5 + trigram FTS5 indexes
- raw DocC JSON + rendered Markdown
- every Apple font Apple distributes (extracted)
- the complete pre-rendered SF Symbols matrix (every weight × scale × scope)

The lite/standard tiers were retired because their consumer experience
diverged unevenly off-macOS (lite couldn't render symbols at all, standard
shipped a partial story for raw JSON), and the audits flagged tier-aware
code paths as a maintenance tax with no proportional value.

## Configuration

CLI flags take precedence over environment variables.

Core settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | Corpus location |
| `APPLE_DOCS_RATE` | `500` for `sync` / `update`, `5` otherwise | Default request rate |
| `APPLE_DOCS_BURST` | Matches the active rate floor by default | Rate-limiter burst size |
| `APPLE_DOCS_CONCURRENCY` | `500` for `sync` / `update` | Default simultaneous requests |
| `APPLE_DOCS_TIMEOUT` | `30000` | HTTP timeout in ms |
| `APPLE_DOCS_GITHUB_TIMEOUT` | `45000` or `APPLE_DOCS_TIMEOUT` | GitHub timeout override |
| `APPLE_DOCS_API_BASE` | Apple tutorial data URL | Override Apple's DocC API base |

## Where to find the exhaustive command reference

Instead of duplicating every flag in this README, use the built-in help:

```bash
apple-docs --help
apple-docs search --help
apple-docs sync --help
apple-docs web --help
```

That is the most complete and up-to-date command reference in the project.

## Contributing

If you are working on the repo itself:

```bash
bun run ci
```

Useful extra checks:

```bash
bun run bench
bun run audit
bun run test:web
bun run test:mutate
```

## Requirements

- Bun 1.0+

## License

See [LICENSE](LICENSE).
