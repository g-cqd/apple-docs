# apple-docs

Local Apple developer documentation corpus with CLI search, an MCP server for AI assistants, and a static website generator. 10 sources, tiered search, offline-first. Runs on [Bun](https://bun.sh).

## Setup

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
bun link
```

Build the full corpus (about 15 minutes):

```bash
apple-docs sync --concurrency 500 --rate 500 --full --parallel 20 --retry-failed --index
```

This fetches all 10 sources, converts every page, and builds the deep-search index in one pass.

## MCP Server

Print ready-to-paste configuration for Claude Desktop, Cursor, or any MCP client:

```bash
apple-docs mcp install
```

Or add this to your MCP client config manually:

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

The server exposes 5 tools (`search_docs`, `read_doc`, `list_frameworks`, `browse`, `status`) and 2 resources (`apple-docs://doc/{key}`, `apple-docs://framework/{slug}`).

For large MCP responses, `search_docs`, `read_doc`, `list_frameworks`, and `browse` support:

- `maxChars`: cap one response page by serialized character count
- `page`: request a specific 1-based response page
- `pageInfo`: returned when `maxChars` is used, including `totalPages`

`read_doc` and `search_docs` read mode also support focused excerpt reads with:

- `match`: literal substring match
- `contextChars`: context window around each match
- `maxMatches`: maximum number of excerpts to return
- `caseSensitive`: case-sensitive matching toggle

## Local Website

```bash
apple-docs web serve
```

Opens a local documentation site at `http://localhost:3000` backed by your synced corpus. Key features:

- Full-text client-side search across all sources, with filters for framework, kind, language, and platform versions
- Swift / Objective-C declaration toggle, persisted per browser
- Tree view for type hierarchies with single-child chain compaction
- Syntax-highlighted Swift and Objective-C code via Shiki
- Auto / light / dark theme with `prefers-color-scheme` detection
- Per-page table of contents and framework sidebar navigation
- Platform availability, deprecated, and beta badges on symbols
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) and gzip compression on the dev server
- Dev server fetches missing pages from `developer.apple.com` on demand and persists them to the corpus

To generate a static build for deployment:

```bash
apple-docs web build --out dist/web
```

The static build emits self-contained HTML, assets, and a client-side search index with no server-side dependency.

## What It Covers

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
| `--max-chars <n>` | With `--read`, paginate the rendered content to fit within a character budget |
| `--page <n>` | With `--read` and `--max-chars`, select a specific page (1-based) |

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
| `--max-chars <n>` | Paginate the rendered content to fit within a character budget |
| `--page <n>` | Select a specific page when `--max-chars` is used (1-based) |
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

## MCP Server Reference

See [MCP Server](#mcp-server) at the top for quick setup. Additional notes:

- `apple-docs-mcp` is a backward-compatible standalone binary (`apple-docs mcp install` prints config for both entry points)
- `APPLE_DOCS_HOME` is required for MCP server processes
- `apple-docs-mcp` uses `APPLE_DOCS_LOG_LEVEL` for logging control
- Use `--verbose` on `apple-docs mcp start` for debug logging

| Tool | Purpose |
| --- | --- |
| `search_docs` | Search the corpus with the same ranking and filters as the CLI |
| `read_doc` | Fetch a page by path or symbol, with optional paged and match-scoped output |
| `list_frameworks` | List indexed roots, optionally paged by response size |
| `browse` | Explore a framework tree or subtree, optionally paged by response size |
| `status` | Return corpus health and capability information |

| Resource | Purpose |
| --- | --- |
| `apple-docs://doc/{key}` | Read a document as markdown |
| `apple-docs://framework/{slug}` | Browse a framework tree as JSON, with optional `?maxChars=<n>&page=<n>` paging |

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
