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
apple-docs setup --tier standard
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
- `status`

and these resources:

- `apple-docs://doc/{key}`
- `apple-docs://framework/{slug}`

### Remote MCP over HTTP

For shared or remote access, run the MCP server as a Streamable HTTP endpoint instead of stdio:

```bash
apple-docs mcp serve --port 3031 --host 127.0.0.1 \
  --allow-origin https://mcp.example.com
```

- `--port` defaults to `3031`
- `--host` defaults to `127.0.0.1` — keep it bound to loopback and expose it via a reverse proxy or tunnel (Cloudflare, Tailscale, WireGuard) rather than binding to `0.0.0.0`
- `--allow-origin` restricts the browser `Origin` header (comma-separated list); omit to allow all origins

The server has **no built-in authentication**. Put access control at the edge (e.g. Cloudflare Access, Tailscale ACLs) or keep the endpoint private.

It speaks the Streamable HTTP transport from the 2025-03-26 MCP protocol revision. Endpoints:

| Path | Method | Purpose |
| --- | --- | --- |
| `/mcp` | `POST` | JSON-RPC requests |
| `/mcp` | `GET` | Server-initiated SSE stream |
| `/mcp` | `DELETE` | Terminate a session |
| `/healthz` | `GET` | Liveness probe |

Print a client config for a remote endpoint:

```bash
apple-docs mcp install --http https://mcp.example.com/mcp
```

That emits both the native Streamable HTTP config and an `mcp-remote` stdio fallback for clients without native HTTP support.

Example Claude Desktop / Cursor config:

```json
{
  "mcpServers": {
    "apple-docs": {
      "transport": {
        "type": "streamable-http",
        "url": "https://mcp.example.com/mcp"
      }
    }
  }
}
```

Fallback via `mcp-remote` for older clients:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.example.com/mcp"]
    }
  }
}
```

Codex CLI (`~/.codex/config.toml`) — use the `mcp-remote` bridge, since the current `rmcp` HTTP client does not interoperate cleanly with every Streamable HTTP origin:

```toml
[mcp_servers.apple-docs]
command = "npx"
args = ["mcp-remote", "https://mcp.example.com/mcp"]
```

For a local stdio setup (no tunnel), Codex can call the binary directly:

```toml
[mcp_servers.apple-docs]
command = "apple-docs"
args = ["mcp", "start"]
```

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
| `sync` | Crawl/build a corpus locally |
| `update` | Pull incremental changes |
| `index` | Build or rebuild search indexes |
| `doctor` | Repair and verify the corpus |
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
apple-docs index
apple-docs index --full
apple-docs index rebuild-trigram
apple-docs index rebuild-body
```

Long body-index runs checkpoint their progress and resume automatically after interruption.

### Repair a broken corpus

```bash
apple-docs doctor
apple-docs doctor --dry-run
apple-docs doctor --minify
apple-docs doctor --verify
```

The retry phase is checkpointed too, so rerunning `doctor` continues where it left off.

## Packages source notes

The `packages` source has two modes:

- **default / official**: curated Apple and Swift ecosystem packages, no auth required
- **full catalog**: the full SwiftPackageIndex catalog

Useful commands:

```bash
apple-docs sync --sources packages
apple-docs sync --full
APPLE_DOCS_PACKAGES_SCOPE=full GITHUB_TOKEN=... apple-docs sync --sources packages
```

Useful environment variables:

- `APPLE_DOCS_PACKAGES_SCOPE=official|full`
- `APPLE_DOCS_PACKAGES_LIMIT=<n>`
- `GITHUB_TOKEN` or `GH_TOKEN`

Without a GitHub token, full package sync still works, but it falls back to public README-focused data.

## Snapshots

You can build your own release-style snapshot from an existing corpus:

```bash
apple-docs snapshot build --tier lite --out dist
apple-docs snapshot build --tier standard --tag snapshot-20260413
apple-docs snapshot build --tier full --out dist/releases
```

Snapshot tiers:

| Tier | Includes | Best for |
| --- | --- | --- |
| `lite` | Titles, declarations, browse, metadata | Fastest install, smallest footprint |
| `standard` | `lite` plus full page content for `read` | Recommended default |
| `full` | `standard` plus raw JSON and pre-rendered files on disk | Offline-heavy use, publishing, site builds |

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
