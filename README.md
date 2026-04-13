# apple-docs

Search, browse, and query Apple Developer Documentation locally. Provides both a CLI for humans and an MCP server for AI assistants.

Zero npm dependencies. Runs on [Bun](https://bun.sh).

## Features

- Full-text search across all Apple documentation with BM25 ranking
- Symbol lookup with complete Markdown content (declarations, parameters, discussion, relationships)
- Browse framework topic trees
- Discover and index all Apple documentation roots (frameworks, technologies, HIG, release notes, App Store Review Guidelines)
- Incremental updates via ETag-based change detection
- Resumable sync -- stop and restart without losing progress
- MCP server for Claude and other AI assistants
- SQLite FTS5 index for instant queries across 300K+ pages

## Quick Start

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Clone and link (installs `apple-docs` CLI + `apple-docs-mcp` server globally)
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun link

# Sync a few frameworks
apple-docs sync --roots swiftui,combine,foundation --rate 50 --concurrency 20

# Search
apple-docs search "NavigationStack"

# Read a symbol
apple-docs read swiftui/view

# Sync everything (takes a few hours)
apple-docs sync --full --parallel 10 --concurrency 50 --rate 100
```

## CLI

```
apple-docs <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `search <query>` | Search with typo tolerance and tiered ranking |
| `read <path-or-symbol>` | Read a page, print Markdown |
| `frameworks` | List documentation roots |
| `browse <framework>` | Browse topic tree |
| `sync` | Discover, download, and index |
| `update` | Check for and pull changes |
| `index` | Build full-body search index |
| `doctor` | Diagnose and repair corpus |
| `status` | Show corpus statistics |

### search

Search with tiered ranking: exact > prefix > contains > match > substring > fuzzy > body.
Typo tolerance is enabled by default. Body search runs in background when the index exists.

```bash
apple-docs search "NavigationStack"                # exact + CamelCase expansion
apple-docs search "Publsher"                       # fuzzy: finds Publisher (d=1)
apple-docs search "navig"                          # substring match on titles
apple-docs search "dismiss a sheet" --no-eager     # wait for body search results
apple-docs search "View" --framework swiftui       # filter by framework
apple-docs search "in-app purchase" --framework app-store-review  # search guidelines
apple-docs search "privacy" --framework guidelines --read  # search + read best match
apple-docs search "Publisher" --json               # machine-readable output
```

| Option | Default | Description |
|--------|---------|-------------|
| `--framework <slug>` | | Filter by framework |
| `--kind <role>` | | Filter by role (symbol, article, collection) |
| `--limit <n>` | 100 | Max results |
| `--no-fuzzy` | | Disable typo-tolerant matching |
| `--no-deep` | | Disable full-body search entirely |
| `--no-eager` | | Wait for body search to finish (exhaustive) |
| `--read` | | Read the full content of the best match |
| `--json` | | Output raw JSON |

### read

```bash
apple-docs read swiftui/view
apple-docs read combine/publisher
apple-docs read design/human-interface-guidelines/accessibility
apple-docs read app-store-review/3.1                               # App Store Review Guidelines

# By symbol name (fuzzy)
apple-docs read View --framework swiftui
```

Prints full Markdown to stdout. Pipe to `less`, `bat`, or redirect to a file.

Options: `--framework <slug>`, `--json`

### sync

```bash
# Sync specific frameworks
apple-docs sync --roots swiftui,uikit,foundation

# Sync App Store Review Guidelines
apple-docs sync --roots app-store-review

# Sync everything with maximum speed
apple-docs sync --full --parallel 10 --concurrency 50 --rate 100

# Resume after interruption (just run the same command)
apple-docs sync --roots swiftui

# Retry pages that previously failed
apple-docs sync --retry-failed
```

| Flag | Default | Description |
|------|---------|-------------|
| `--roots <a,b,c>` | all | Only sync specific roots |
| `--full` | | Sync all discovered roots |
| `--parallel` | 1 | Frameworks crawled simultaneously |
| `--concurrency` | 5 | Max in-flight fetches across all roots |
| `--rate` | 5 | Max requests per second |
| `--retry-failed` | | Retry pages that previously failed |
| `--index` | | Build body search index after sync |

### update

```bash
apple-docs update --concurrency 50 --rate 100
apple-docs update --roots swiftui,combine --index
```

Options: `--roots`, `--concurrency`, `--rate`, `--parallel`, `--index`, `--json`

### index

Build the full-body search index. This indexes the complete Markdown content of every page,
enabling deep search across discussions, code examples, and parameter descriptions.

```bash
apple-docs index              # incremental (only new pages)
apple-docs index --full       # rebuild from scratch
```

The index is ~150 MB for 330K pages and takes 5-15 minutes to build. Once built, body search
runs automatically in background during `search`.

### doctor

Diagnose and repair the corpus. Upgrades the database schema, cleans up invalid entries,
re-resolves failed paths, and optionally minifies JSON files or rebuilds the search index.

```bash
apple-docs doctor             # analyze and fix
apple-docs doctor --minify    # also minify raw JSON (~40% disk savings)
apple-docs doctor --index     # also rebuild body index
apple-docs doctor --dry-run   # show what would be fixed
```

### Global options

| Flag | Description |
|------|-------------|
| `--home <path>` | Data directory (default: `~/.apple-docs`) |
| `--json` | Output JSON instead of formatted text |
| `--verbose` | Verbose logging to stderr |
| `--help` | Show help |

## MCP Server

The MCP server exposes read-only query tools to AI assistants. Sync the corpus via CLI first, then configure the server.

### Setup

```bash
# 1. Install and link
bun link

# 2. Sync documentation
apple-docs sync --roots swiftui,combine,foundation --rate 50 --concurrency 20

# 3. Add to your MCP client config (see below)
```

After `bun link`, two commands are available globally:
- `apple-docs` — the CLI
- `apple-docs-mcp` — the MCP server (stdio)

`APPLE_DOCS_HOME` is required for the MCP server and must point to an existing synced data directory.

#### Claude Code

In `~/.claude.json`, add to the `mcpServers` object:

```json
{
  "apple-docs": {
    "command": "apple-docs-mcp",
    "args": [],
    "env": {
      "APPLE_DOCS_HOME": "/Users/you/.apple-docs"
    }
  }
}
```

#### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.apple-docs]
command = "apple-docs-mcp"
args = []

[mcp_servers.apple-docs.env]
APPLE_DOCS_HOME = "/Users/you/.apple-docs"
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `search` | Full-text search with fuzzy matching and tiered ranking |
| `read` | Fetch page by path or symbol name, returns Markdown |
| `list_frameworks` | List all indexed documentation roots |
| `browse` | Explore the documentation topic tree |
| `status` | Corpus health and statistics |

## How It Works

1. **Discovery**: Fetches Apple's technology index to enumerate all documentation roots (frameworks, technologies, HIG, etc.)
2. **Crawl**: BFS traversal of each root's documentation tree via Apple's JSON API at `developer.apple.com/tutorials/data/documentation/{path}.json`
3. **Guidelines**: Fetches and parses the App Store Review Guidelines HTML page into searchable sections using Bun's built-in `HTMLRewriter`
4. **Storage**: Raw JSON/HTML saved to disk, metadata and FTS5 index in SQLite
5. **Conversion**: Apple's DocC JSON (and guidelines HTML) converted to Markdown with YAML front matter and cross-reference links
6. **Query**: SQLite FTS5 with BM25 ranking for search; exact path lookup for symbol pages

### Data Layout

```
~/.apple-docs/
  apple-docs.db          SQLite database (FTS5 index + metadata)
  raw-json/              Raw Apple JSON responses
    swiftui/view.json
    combine/publisher.json
    ...
  markdown/              Converted Markdown
    swiftui/view.md
    combine/publisher.md
    app-store-review/3.1.md
    ...
```

### Coverage

A full sync discovers ~370 documentation roots and indexes ~330,000 pages including:
- All Apple frameworks (SwiftUI, UIKit, Foundation, AppKit, etc.)
- Swift standard library
- Apple REST APIs (App Store Server API, Apple Music API, etc.)
- Human Interface Guidelines (via the `design` root)
- App Store Review Guidelines (57 sections, parsed from HTML)
- Release notes, tech notes, technology overviews

## Configuration

All configuration via environment variables or CLI flags:

| Variable | Default | Description |
|----------|---------|-------------|
| `APPLE_DOCS_HOME` | `~/.apple-docs` | Data directory |
| `APPLE_DOCS_RATE` | `5` | Requests per second |
| `APPLE_DOCS_CONCURRENCY` | `5` | Max concurrent fetches |
| `APPLE_DOCS_TIMEOUT` | `30000` | HTTP timeout (ms) |
| `APPLE_DOCS_LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |

## Requirements

- [Bun](https://bun.sh) 1.0+
- No other dependencies

## License

MIT
