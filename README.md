# apple-docs

`apple-docs` builds a local Apple developer documentation corpus and exposes it three ways:

- a CLI for search, lookup, sync, maintenance, and snapshot management
- an MCP server for AI assistants
- a static documentation website generator

It runs on [Bun](https://bun.sh). The only runtime dependency is the official MCP SDK.

## What It Covers

The corpus is multi-source. Today the in-tree source adapters are:

| Source type | Coverage |
| --- | --- |
| `apple-docc` | Apple's DocC corpus from `developer.apple.com/tutorials/data`, including frameworks, technologies, API references, release notes, and related documentation roots |
| `hig` | Human Interface Guidelines content under the `design` root |
| `guidelines` | App Store Review Guidelines |
| `swift-evolution` | Swift Evolution proposals |
| `swift-book` | The Swift Programming Language |
| `swift-org` | Swift.org articles and reference material |
| `apple-archive` | Archived Apple documentation imported through the archive adapter |
| `wwdc` | WWDC session catalog and metadata |
| `sample-code` | Apple sample code catalog |
| `packages` | Swift package catalog entries enriched with GitHub repository metadata and README content |

## Install

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
bun link
```

After `bun link`, these commands are available globally:

- `apple-docs`
- `apple-docs-mcp`

If you do not want a global link, run the CLI locally with `bun run cli.js <command>`.

## Quick Start

### Fastest Path: Install a Snapshot

```bash
apple-docs setup --tier standard
apple-docs search "NavigationStack"
apple-docs read swiftui/view
```

`standard` is the best default for most users. It includes full `read` output and supports rebuilding the deep-search index.

### Build Your Own Corpus

```bash
apple-docs sync --roots swiftui,combine,foundation --rate 50 --concurrency 20
apple-docs index
apple-docs search "Publisher"
```

To crawl broadly:

```bash
apple-docs sync --full --parallel 10 --concurrency 50 --rate 100
```

### Generate MCP Config

```bash
apple-docs mcp install
```

That prints ready-to-paste MCP configuration using your current data directory.

### Build a Static Site

```bash
apple-docs web build --out dist/web
apple-docs web serve
```

## Global CLI Shape

```bash
apple-docs <command> [options]
```

Global flags supported by most command handlers:

| Flag | Description |
| --- | --- |
| `--home <path>` | Override the data directory. Default: `~/.apple-docs` |
| `--json` | Emit raw JSON instead of formatted terminal output |
| `--verbose` | Enable verbose CLI logging |
| `--help` | Show help |

## Command Map

| Command | Purpose |
| --- | --- |
| `search <query>` | Search the corpus with fuzzy, substring, and deep-body search |
| `read <path-or-symbol>` | Read a page by canonical path or symbol name |
| `frameworks` | List indexed roots |
| `browse <framework>` | Browse a framework or subtree |
| `sync` | Discover, fetch, convert, and index content |
| `update` | Pull incremental changes |
| `index` | Build or rebuild search indexes |
| `doctor` | Diagnose and repair corpus issues |
| `status` | Show corpus health, capabilities, freshness, and progress |
| `setup` | Install a prebuilt snapshot from the latest release |
| `snapshot build` | Build a snapshot archive from the current corpus |
| `mcp start` | Start the MCP stdio server |
| `mcp install` | Print MCP client configuration snippets |
| `web build` | Build a static documentation website |
| `web serve` | Preview the static site locally |
| `web deploy [platform]` | Print deployment instructions for supported static hosts |
| `storage stats` | Show storage usage |
| `storage gc` | Drop cached materializations and clean orphaned data |
| `storage materialize <format>` | Pre-render markdown or HTML for all or selected roots |
| `storage profile` | Inspect or change the storage policy |

## Search and Read

### `search`

Ranking is tiered: `exact > prefix > contains > match > substring > fuzzy > body`.

Examples:

```bash
apple-docs search "NavigationStack"
apple-docs search "Publsher"
apple-docs search "dismiss a sheet" --no-eager
apple-docs search "View" --framework swiftui
apple-docs search "Swift Testing" --source wwdc --year 2024
apple-docs search "Accessibility" --source wwdc --track accessibility
apple-docs search "StoreKit" --platform ios
apple-docs search "Observation" --min-ios 17.0
apple-docs search "privacy" --framework app-store-review --read
apple-docs search "Publisher" --json
```

| Option | Description |
| --- | --- |
| `--framework <slug>` | Filter to one framework or root slug |
| `--source <slug[,slug]>` | Filter by one or more source types |
| `--kind <role>` | Filter by role such as `symbol`, `article`, or `collection` |
| `--language <swift\|objc>` | Filter by language metadata |
| `--platform <ios\|macos\|watchos\|tvos\|visionos>` | Require availability on that platform |
| `--min-ios <ver>` | Require iOS availability at or above a version |
| `--min-macos <ver>` | Require macOS availability at or above a version |
| `--min-watchos <ver>` | Require watchOS availability at or above a version |
| `--min-tvos <ver>` | Require tvOS availability at or above a version |
| `--min-visionos <ver>` | Require visionOS availability at or above a version |
| `--year <n>` | Filter WWDC sessions by year |
| `--track <name>` | Filter WWDC sessions by track |
| `--limit <n>` | Cap results. Default: `100` |
| `--no-fuzzy` | Disable typo-tolerant title matching |
| `--no-deep` | Disable body search entirely |
| `--no-eager` | Wait for body search to finish instead of returning early |
| `--read` | Resolve the top hit and return its content immediately |

Notes:

- `--platform ios` means "available on iOS at all". Use `--min-ios 17.0` when you need a version threshold.
- `--year` and `--track` are mainly useful with `--source wwdc`.
- `--source` accepts a comma-separated list.

### `read`

Examples:

```bash
apple-docs read swiftui/view
apple-docs read combine/publisher
apple-docs read design/human-interface-guidelines/accessibility
apple-docs read app-store-review/3.1
apple-docs read View --framework swiftui
apple-docs read swiftui/view --section Overview
```

Options:

| Option | Description |
| --- | --- |
| `--framework <slug>` | Disambiguate a symbol lookup |
| `--section <heading-or-file>` | Return one section instead of the full document |
| `--json` | Return the lookup payload as JSON |

On a `lite` snapshot, `read` may return metadata plus a tier-upgrade hint instead of full rendered content.

### `frameworks`

Examples:

```bash
apple-docs frameworks
apple-docs frameworks --kind framework
apple-docs frameworks --json
```

Use `--json` when you need the canonical slugs instead of the grouped human-readable list.

### `browse`

Examples:

```bash
apple-docs browse swiftui
apple-docs browse swiftui --limit 25
apple-docs browse swiftui --path swiftui/view
apple-docs browse app-store-review
apple-docs browse swiftui --json
```

Options:

| Option | Description |
| --- | --- |
| `--path <page-path>` | Browse one page's children instead of the whole root |
| `--limit <n>` | Limit the returned page list |
| `--json` | Return the full browse payload as JSON |

The pretty terminal formatter previews the first 50 entries when browsing an entire root. Use `--json` for the full list.

## Build and Maintain the Corpus

### `sync`

Examples:

```bash
apple-docs sync --roots swiftui,uikit,foundation
apple-docs sync --roots app-store-review
apple-docs sync --sources wwdc,sample-code
apple-docs sync --sources packages
apple-docs sync --retry-failed
apple-docs sync --full --parallel 10 --concurrency 50 --rate 100 --index
```

| Option | Description |
| --- | --- |
| `--roots <a,b,c>` | Restrict sync to specific root slugs |
| `--sources <a,b,c>` | Restrict sync to source adapters |
| `--full` | Crawl all discovered roots |
| `--parallel <n>` | Crawl up to `n` roots simultaneously |
| `--concurrency <n>` | Max in-flight fetches across all work |
| `--rate <n>` | Max requests per second |
| `--retry-failed` | Retry pages that previously failed |
| `--index` | Build or refresh the deep-search index after sync |
| `--json` | Return the sync summary as JSON |

Current source adapter names:

`apple-docc`, `hig`, `guidelines`, `swift-evolution`, `swift-book`, `swift-org`, `apple-archive`, `wwdc`, `sample-code`, `packages`

Packages note:

- A full `packages` sync requires `GITHUB_TOKEN` or `GH_TOKEN`.
- For a small unauthenticated sample, set `APPLE_DOCS_PACKAGES_LIMIT=<n>`.

### `update`

Examples:

```bash
apple-docs update
apple-docs update --roots swiftui,combine --index
apple-docs update --sources packages
apple-docs update --concurrency 50 --rate 100 --parallel 5
```

`update` reuses the existing corpus and only fetches changed or new items. It supports the same `--roots`, `--sources`, `--parallel`, `--concurrency`, `--rate`, `--index`, and `--json` controls as `sync`.

### `index`

Examples:

```bash
apple-docs index
apple-docs index --full
apple-docs index rebuild-trigram
apple-docs index rebuild-body
```

Subcommands:

| Command | Purpose |
| --- | --- |
| `apple-docs index` | Build or incrementally update the body index |
| `apple-docs index --full` | Rebuild the entire body index |
| `apple-docs index rebuild-trigram` | Rebuild the title trigram index used for fast substring and fuzzy lookups |
| `apple-docs index rebuild-body` | Rebuild the body index from `document_sections` |

Notes:

- `rebuild-trigram` works on any tier because it only needs document titles.
- `rebuild-body` requires `document_sections`, so it works on `standard`, `full`, or a locally synced corpus with sections.

### `doctor`

Examples:

```bash
apple-docs doctor
apple-docs doctor --dry-run
apple-docs doctor --minify
apple-docs doctor --index
apple-docs doctor --verify
```

`doctor` upgrades schema state, cleans invalid crawl entries, retries resolvable failures, can minify raw JSON, and can run integrity checks. `--verify` is especially useful after installing a snapshot.

### `status`

```bash
apple-docs status
apple-docs status --json
```

`status` reports:

- current snapshot tier
- search and read capabilities
- database, raw JSON, and markdown sizes
- root counts and page counts
- active or interrupted crawl activity
- per-root progress
- freshness and stale roots
- latest-release availability when the corpus was installed from a snapshot

## Snapshots

### `setup`

`setup` downloads the latest published snapshot from GitHub Releases instead of crawling locally.

Examples:

```bash
apple-docs setup --tier lite
apple-docs setup --tier standard
apple-docs setup --tier full
apple-docs setup --tier standard --force
apple-docs setup --tier lite --force --downgrade
```

| Tier | Includes | Best for |
| --- | --- | --- |
| `lite` | Metadata, title/declaration search, browse, MCP metadata access | Quick install, smallest footprint |
| `standard` | `lite` plus normalized document sections and full `read` output | Best default |
| `full` | `standard` plus raw payloads and materialization-friendly on-disk content | Offline power use, snapshot publishing, heavy web/storage workflows |

Rules:

- Use `--force` to reinstall or upgrade an existing corpus.
- Downgrading from a higher tier to a lower tier requires `--downgrade`.
- `setup` talks to GitHub Releases and optionally uses `GITHUB_TOKEN` or `GH_TOKEN` to avoid API limits.

### `snapshot build`

Build a release-style archive from the corpus you already have.

Examples:

```bash
apple-docs snapshot build --tier lite --out dist
apple-docs snapshot build --tier standard --tag snapshot-20260413
apple-docs snapshot build --tier full --out dist/releases
```

Output:

- `apple-docs-<tier>-<tag>.tar.gz`
- `apple-docs-<tier>-<tag>.sha256`
- `apple-docs-<tier>-<tag>.manifest.json`

Tier behavior:

- `lite` strips section and search-body tables
- `standard` ships the database plus manifest
- `full` additionally bundles `raw-json/` and `markdown/`

## Static Site

Examples:

```bash
apple-docs web build
apple-docs web build --out dist/web --base-url /apple-docs --site-name "Apple Docs Mirror"
apple-docs web serve
apple-docs web serve --port 8080 --base-url /apple-docs
apple-docs web deploy github-pages
apple-docs web deploy cloudflare
apple-docs web deploy vercel
apple-docs web deploy netlify
```

`web build` creates a fully static site, including:

- landing page
- framework index pages
- one page per document
- static client-side search assets
- a `manifest.json` for the generated site

Supported `web` options:

| Command | Options |
| --- | --- |
| `web build` | `--out <dir>`, `--base-url <url>`, `--site-name <name>` |
| `web serve` | `--port <n>`, `--base-url <url>` |
| `web deploy [platform]` | `github-pages`, `cloudflare`, `vercel`, `netlify` |

## Storage Management

Examples:

```bash
apple-docs storage profile
apple-docs storage profile set raw-only
apple-docs storage profile list
apple-docs storage stats
apple-docs storage gc --drop markdown,html
apple-docs storage gc --older-than 30 --no-vacuum
apple-docs storage materialize markdown
apple-docs storage materialize html --roots swiftui,combine
```

Storage profiles:

| Profile | Behavior |
| --- | --- |
| `raw-only` | Minimal disk use. Render on demand only |
| `balanced` | Default. Cache markdown on first read with eviction |
| `prebuilt` | Persist markdown and HTML aggressively |

Subcommands:

| Command | Purpose |
| --- | --- |
| `storage profile` | Show the current profile |
| `storage profile set <name>` | Switch profile |
| `storage profile list` | List all profiles |
| `storage stats` | Show disk and table usage |
| `storage gc` | Drop cached markdown/HTML and clean orphaned data |
| `storage materialize <markdown\|html>` | Render all documents to disk, optionally limited with `--roots` |

Notes:

- `storage gc --drop markdown,html` recreates empty cache directories after deletion.
- `storage gc --older-than <days>` prunes old activity records before cleanup.
- `storage materialize` requires `document_sections`, so `lite` snapshots will not produce useful rendered output.

## MCP Server

The MCP server is read-only. It expects an existing corpus on disk.

Fastest setup:

```bash
apple-docs mcp install
```

That prints config for both:

- `apple-docs mcp start`
- `apple-docs-mcp` (backward-compatible standalone binary)

Recommended manual config:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "apple-docs",
      "args": ["mcp", "start"],
      "env": {
        "APPLE_DOCS_HOME": "/Users/you/.apple-docs"
      }
    }
  }
}
```

Legacy-compatible alternative:

```json
{
  "mcpServers": {
    "apple-docs": {
      "command": "apple-docs-mcp",
      "env": {
        "APPLE_DOCS_HOME": "/Users/you/.apple-docs"
      }
    }
  }
}
```

The MCP server exposes these tools:

| Tool | Purpose |
| --- | --- |
| `search_docs` | Search the corpus with the same ranking and filters as the CLI |
| `read_doc` | Fetch a page by path or symbol |
| `list_frameworks` | List indexed roots |
| `browse` | Explore a framework tree or subtree |
| `status` | Return corpus health and capability information |

It also exposes these resources:

| Resource | Purpose |
| --- | --- |
| `apple-docs://doc/{key}` | Read a document as markdown |
| `apple-docs://framework/{slug}` | Browse a framework tree as JSON |

Operational notes:

- `APPLE_DOCS_HOME` is required for MCP server processes.
- `apple-docs-mcp` uses `APPLE_DOCS_LOG_LEVEL` for logging control.
- When you start the server through `apple-docs mcp start`, use `--verbose` on the CLI for debug logging.

## Data Layout

Typical data directory layout:

```text
~/.apple-docs/
  apple-docs.db
  apple-docs.db-wal
  apple-docs.db-shm
  manifest.json
  raw-json/
  markdown/
  html/
```

Not every installation has every directory:

- `raw-json/` and `markdown/` are guaranteed on `full` snapshots and common in locally synced corpora
- `html/` exists when HTML has been materialized or generated for caching workflows
- `manifest.json` exists for snapshot installs and generated snapshots

## Configuration

CLI flags override environment variables when both are supplied.

Core settings:

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | CLI, MCP | Data directory |
| `APPLE_DOCS_RATE` | `5` | CLI sync/update | Default request rate if `--rate` is omitted |
| `APPLE_DOCS_BURST` | `2` | CLI sync/update | Rate-limiter burst size |
| `APPLE_DOCS_CONCURRENCY` | `5` | CLI sync/update | Default fetch concurrency if flags are omitted |
| `APPLE_DOCS_TIMEOUT` | `30000` | HTTP clients | General request timeout in ms |
| `APPLE_DOCS_GITHUB_TIMEOUT` | `45000` or `APPLE_DOCS_TIMEOUT` | GitHub-backed sources | GitHub-specific timeout override |
| `APPLE_DOCS_API_BASE` | Apple tutorial data URL | Apple DocC adapter | Advanced override for the Apple API base URL |

GitHub-backed workflows:

| Variable | Used by | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | `setup`, `status`, `packages`, GitHub fetches | Preferred GitHub token |
| `GH_TOKEN` | Same as above | Fallback token name |
| `APPLE_DOCS_PACKAGES_LIMIT` | `packages` source | Limit package discovery for unauthenticated sampling |

Logging:

| Setting | Applies to | Notes |
| --- | --- | --- |
| `--verbose` | `apple-docs` CLI | Enables debug-level CLI logging |
| `APPLE_DOCS_LOG_LEVEL` | `apple-docs-mcp` | Used by the standalone MCP binary |

## Repository Verification

If you are working on the repo itself:

```bash
bun run lint
bun run typecheck
bun test
```

Or run the standard combined check:

```bash
bun run ci
```

## Requirements

- Bun 1.0+

## License

MIT
