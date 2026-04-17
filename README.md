# apple-docs

Read, search, and share Apple's developer documentation from the command line, from your AI assistant, or from a local website — entirely offline. One install covers 10 sources, from SwiftUI references to WWDC sessions. Runs on [Bun](https://bun.sh).

## Setup

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
bun link
```

Grab everything in one pass (15 to 30 minutes depending on your machine and connection):

```bash
apple-docs sync --concurrency 500 --rate 500 --full --parallel 20 --retry-failed --index
```

Prefer not to wait? Install a prebuilt snapshot instead:

```bash
apple-docs setup --tier standard
```

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

Large responses can be paged with `maxChars` and `page`; responses report `pageInfo` with `totalPages` when paging is active.

`read_doc` and `search_docs` (in read mode) also support focused excerpts via `match`, `contextChars`, `maxMatches`, and `caseSensitive`.

## Local Website

```bash
apple-docs web serve
```

Opens a local documentation site at `http://localhost:3000` backed by your corpus. Highlights:

- Fast search with filters for framework, language, and platform
- Toggle between Swift and Objective-C declarations
- Collapsible tree view for type hierarchies
- Syntax-highlighted Swift and Objective-C code
- Light and dark themes
- Per-page table of contents and framework sidebar
- Platform availability, deprecated, and beta badges
- Missing pages are fetched from Apple on demand and cached for next time

Prefer a self-hosted site? Build a static bundle you can drop on any host:

```bash
apple-docs web build --out dist/web
```

## What It Covers

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
| `search <query>` | Search the corpus, from exact matches down to page-body text |
| `read <path-or-symbol>` | Read a page by path or symbol name |
| `frameworks` | List available frameworks |
| `browse <framework>` | Browse a framework or subtree |
| `sync` | Fetch and index content |
| `update` | Pull incremental changes |
| `index` | Build or rebuild search indexes |
| `doctor` | Diagnose and repair corpus issues |
| `status` | Show corpus health, freshness, and progress |
| `setup` | Install a prebuilt snapshot |
| `snapshot build` | Package a snapshot from the current corpus |
| `mcp start` | Start the MCP server |
| `mcp install` | Print MCP client configuration snippets |
| `web build` | Build a static documentation website |
| `web serve` | Preview the local website |
| `web deploy [platform]` | Print deployment instructions for popular hosts |
| `storage stats` | Show storage usage |
| `storage gc` | Drop cached content and clean up |
| `storage materialize <format>` | Pre-render markdown or HTML to disk |
| `storage profile` | Inspect or change the storage policy |

## Search and Read

### `search`

Results are ordered by how directly they match, starting with exact title matches and ending with deep body-text matches.

Keep queries short and keyword-shaped — symbol names, API terms, or a few related words. Natural-language questions ("how do I dismiss a sheet") match worse than a compact query ("dismiss sheet"). Let filters (`--framework`, `--source`, `--platform`) do the narrowing instead of stuffing them into the query.

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
| `--framework <slug>` | Limit to a single framework |
| `--source <slug[,slug]>` | Limit to one or more sources |
| `--kind <role>` | Limit to a kind (`symbol`, `article`, `collection`, ...) |
| `--language <swift\|objc>` | Limit to a language |
| `--platform <ios\|macos\|watchos\|tvos\|visionos>` | Require availability on that platform |
| `--min-ios <ver>` | Require iOS at or above a version |
| `--min-macos <ver>` | Require macOS at or above a version |
| `--min-watchos <ver>` | Require watchOS at or above a version |
| `--min-tvos <ver>` | Require tvOS at or above a version |
| `--min-visionos <ver>` | Require visionOS at or above a version |
| `--year <n>` | Filter WWDC sessions by year |
| `--track <name>` | Filter WWDC sessions by track |
| `--limit <n>` | Cap results. Default: `100` |
| `--no-fuzzy` | Turn off typo-tolerant matching |
| `--no-deep` | Skip searching inside page bodies |
| `--no-eager` | Wait for full results instead of showing title matches first |
| `--read` | Open the top result right away |
| `--max-chars <n>` | With `--read`, split the page into character-limited chunks |
| `--page <n>` | With `--read` and `--max-chars`, pick a chunk (1-based) |

Notes:

- `--platform ios` means "available on iOS at all". Use `--min-ios 17.0` when you need a version threshold.
- `--year` and `--track` are mainly useful with `--source wwdc`.
- `--source` accepts a comma-separated list.
- If the strict cascade returns nothing on a long natural-language query, search retries with progressive relaxation (stopword pruning → OR composition → trigram on the strongest token). Relaxed hits are tagged `[relaxed]` in the CLI and web UI, and the JSON/MCP response carries `relaxed: true` with a `relaxationTier`. Quoted phrases and short queries skip relaxation.

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
| `--framework <slug>` | Disambiguate when a symbol name is shared |
| `--section <heading-or-file>` | Return one section instead of the full page |
| `--max-chars <n>` | Split the page into character-limited chunks |
| `--page <n>` | Pick a chunk when `--max-chars` is set (1-based) |
| `--json` | Return the raw payload as JSON |

On a `lite` snapshot, `read` returns metadata with a hint to upgrade to a larger tier for the full page.

### `frameworks`

Examples:

```bash
apple-docs frameworks
apple-docs frameworks --kind framework
apple-docs frameworks --json
```

Use `--json` when you need the raw slugs instead of the grouped list.

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
| `--path <page-path>` | Browse one page's children instead of the whole framework |
| `--limit <n>` | Cap the number of entries returned |
| `--json` | Return the full listing as JSON |

Terminal output previews the first 50 entries when browsing a whole framework. Use `--json` for the full list.

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
| `--roots <a,b,c>` | Limit sync to specific frameworks |
| `--sources <a,b,c>` | Limit sync to specific sources |
| `--full` | Fetch everything the sources expose, including the full packages catalog |
| `--parallel <n>` | Work on up to `n` frameworks at once |
| `--concurrency <n>` | Cap simultaneous network requests |
| `--rate <n>` | Cap requests per second |
| `--retry-failed` | Retry pages that failed last time |
| `--index` | Refresh the deep-search index when sync finishes |
| `--json` | Return the sync summary as JSON |

Available sources:

`apple-docc`, `hig`, `guidelines`, `swift-evolution`, `swift-book`, `swift-org`, `apple-archive`, `wwdc`, `sample-code`, `packages`

For the `packages` source:

- The default `official` scope indexes a curated allowlist of apple/* and swiftlang/* repositories using raw GitHub README files only — no authentication required.
- `apple-docs sync --full` now requests the full SwiftPackageIndex catalog automatically. Without a GitHub token it still works, but package metadata falls back to public README-only data.
- Set `APPLE_DOCS_PACKAGES_SCOPE=full` with a GitHub token (`GITHUB_TOKEN` or `GH_TOKEN`) when you want the full catalog with GitHub repository metadata (stars, issues, topics, license, and so on).
- Set `APPLE_DOCS_PACKAGES_LIMIT=<n>` to cap discovery for the active scope.

### `update`

Examples:

```bash
apple-docs update
apple-docs update --roots swiftui,combine --index
apple-docs update --sources packages
apple-docs update --concurrency 50 --rate 100 --parallel 5
```

`update` keeps your existing corpus and only fetches what changed. It takes the same options as `sync` (`--roots`, `--sources`, `--parallel`, `--concurrency`, `--rate`, `--index`, `--json`).

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
| `apple-docs index` | Build or update the body-search index |
| `apple-docs index --full` | Rebuild the body-search index from scratch |
| `apple-docs index rebuild-trigram` | Rebuild the title index for substring and typo-tolerant search |
| `apple-docs index rebuild-body` | Rebuild the full-text index for page bodies |

Notes:

- `rebuild-trigram` works on any tier.
- `rebuild-body` needs a `standard` or `full` corpus.

### `doctor`

Examples:

```bash
apple-docs doctor
apple-docs doctor --dry-run
apple-docs doctor --minify
apple-docs doctor --index
apple-docs doctor --verify
```

`doctor` cleans up invalid crawl entries, retries recoverable failures, can shrink stored JSON, and can verify corpus integrity. Run it with `--verify` after installing a snapshot if anything feels off.

### `status`

```bash
apple-docs status
apple-docs status --json
```

`status` reports:

- the current snapshot tier and what it supports
- storage used by the database, raw JSON, and markdown
- how many frameworks and pages are available
- any crawl in progress or left interrupted
- per-framework progress and freshness
- whether a newer snapshot is available on GitHub Releases

## Snapshots

### `setup`

`setup` grabs the latest snapshot from GitHub Releases so you can skip the initial crawl.

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
| `lite` | Titles, declarations, browse, metadata | Fastest install, smallest footprint |
| `standard` | `lite` plus full page content for `read` | Recommended default |
| `full` | `standard` plus raw JSON and pre-rendered files on disk | Offline power use, publishing snapshots, web builds |

Tips:

- `--force` reinstalls or upgrades an existing corpus.
- Downgrading to a smaller tier requires `--downgrade`.
- Set `GITHUB_TOKEN` or `GH_TOKEN` to avoid GitHub rate limits.

### `snapshot build`

Package your existing corpus into a release-style archive.

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

What each tier ships:

- `lite` — titles and metadata only
- `standard` — the full database plus a manifest
- `full` — everything above plus raw JSON and Markdown files

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
- search index and assets
- a build manifest

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
| `raw-only` | Smallest footprint. Render pages only when asked |
| `balanced` | Default. Cache markdown as you read it |
| `prebuilt` | Keep markdown and HTML on disk for instant reads |

Subcommands:

| Command | Purpose |
| --- | --- |
| `storage profile` | Show the active profile |
| `storage profile set <name>` | Switch profile |
| `storage profile list` | List all profiles |
| `storage stats` | Show disk usage |
| `storage gc` | Drop cached markdown/HTML and clean up |
| `storage materialize <markdown\|html>` | Pre-render pages to disk (optionally `--roots <slugs>`) |

Notes:

- `storage gc --older-than <days>` also prunes old activity records.
- `storage materialize` needs a `standard` or `full` corpus.

## MCP Server Reference

See [MCP Server](#mcp-server) for quick setup. A few extra details:

- `apple-docs-mcp` is a standalone binary kept around for backward compatibility (`apple-docs mcp install` prints config for both entry points)
- `APPLE_DOCS_HOME` must be set in the MCP process environment
- `APPLE_DOCS_LOG_LEVEL` controls logging for the standalone binary
- Use `--verbose` on `apple-docs mcp start` for debug logging

| Tool | Purpose |
| --- | --- |
| `search_docs` | Search with the same ranking and filters as the CLI |
| `read_doc` | Fetch a page by path or symbol, with optional paging and focused excerpts |
| `list_frameworks` | List available frameworks, optionally paged |
| `browse` | Explore a framework tree or subtree, optionally paged |
| `status` | Report corpus health and capabilities |

| Resource | Purpose |
| --- | --- |
| `apple-docs://doc/{key}` | Read a document as markdown |
| `apple-docs://framework/{slug}` | Browse a framework tree as JSON (supports `?maxChars=<n>&page=<n>`) |

## Data Layout

Typical data directory:

```text
~/.apple-docs/
  apple-docs.db
  manifest.json
  raw-json/
  markdown/
  html/
```

Not every install has every directory:

- `raw-json/` and `markdown/` always ship with `full` snapshots and are common after a local sync
- `html/` shows up once you pre-render HTML to disk
- `manifest.json` is present for installs and packaged snapshots

## Configuration

CLI flags take precedence over environment variables.

Core settings:

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `APPLE_DOCS_HOME` | `~/.apple-docs` | CLI, MCP | Where the corpus lives |
| `APPLE_DOCS_RATE` | `5` | `sync`, `update` | Default requests per second |
| `APPLE_DOCS_BURST` | `2` | `sync`, `update` | Rate-limiter burst size |
| `APPLE_DOCS_CONCURRENCY` | `5` | `sync`, `update` | Default simultaneous requests |
| `APPLE_DOCS_TIMEOUT` | `30000` | All HTTP | Request timeout in milliseconds |
| `APPLE_DOCS_GITHUB_TIMEOUT` | `45000` or `APPLE_DOCS_TIMEOUT` | GitHub requests | Timeout override for GitHub calls |
| `APPLE_DOCS_API_BASE` | Apple tutorial data URL | DocC source | Advanced: override Apple's API base URL |

GitHub access:

| Variable | Used by | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | `setup`, `status`, `packages` | GitHub token; optional for package syncs, but enables GitHub metadata and avoids rate limits |
| `GH_TOKEN` | Same as above | Fallback token name |
| `APPLE_DOCS_PACKAGES_SCOPE` | `packages` source | `official` (default, curated apple/swiftlang list, no auth) or `full` (entire SwiftPackageIndex catalog). `sync --full` also requests the full catalog unless this variable overrides it. Without a token, full scope still works in README-only mode. |
| `APPLE_DOCS_PACKAGES_LIMIT` | `packages` source | Cap package discovery for the active scope |

Logging:

| Setting | Applies to | Notes |
| --- | --- | --- |
| `--verbose` | `apple-docs` CLI | Enables debug logging |
| `APPLE_DOCS_LOG_LEVEL` | `apple-docs-mcp` | Standalone MCP binary logging level |

## Contributing

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
