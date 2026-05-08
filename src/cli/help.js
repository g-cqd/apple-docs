const GLOBAL = `
apple-docs - Apple Developer Documentation search and management

Usage: apple-docs <command> [options]

Commands:
  search <query>       Search documentation by term or symbol
  read <path>          Read a specific page or symbol
  frameworks           List known documentation roots
  browse <framework>   Browse topic tree for a framework
  kinds                List distinct kind/role/docKind/sourceType values with counts
  sync                 Discover, download, and index documentation
  update               Check for and pull documentation updates
  index                Build full-body search index
  doctor               Diagnose and repair corpus
  status               Show corpus statistics
  setup                Download pre-built documentation snapshot

  snapshot build       Build snapshot archive from current corpus

  mcp start            Start MCP stdio server
  mcp serve            Start MCP Streamable HTTP server
  mcp install          Show MCP configuration instructions

  web serve            Start local dev server
  web build            Build static documentation site
  web deploy           Show deployment instructions

  fonts sync           Index Apple font families and files (--download to fetch DMGs)
  fonts list           List indexed Apple fonts
  symbols sync         Index public and private SF Symbols
  symbols search       Search indexed SF Symbols

  links audit          Audit cross-references across the rendered static site
  links consolidate    Internalize external-resolvable links in stored sections

  storage stats        Show disk usage breakdown
  storage gc           Garbage collect cached files
  storage materialize  Force-render markdown or HTML
  storage profile      Show or change storage profile

Global options:
  --json               Output raw JSON (for scripting)
  --home <path>        Override data directory (default: ~/.apple-docs)
  --verbose            Verbose logging
  --help               Show help
`.trim()

const COMMANDS = {
  search: `
Usage: apple-docs search <query> [options]

Search Apple documentation with typo tolerance and tiered ranking.
Results are ranked: exact > prefix > contains > match > substring > fuzzy > body.

Keep queries short and keyword-shaped. Use symbol names or API terms rather
than natural-language questions, and apply filters (--framework, --source,
--platform, ...) to narrow results instead of stuffing them into the query.

Body search runs in background by default when the index exists. Fast tiers get
a 200ms head start; if they fill the limit, body results are skipped (eager mode).

Options:
  --framework <name>   Filter by framework (e.g. swiftui, design, app-store-review)
  --source <name>      Filter by source type(s), comma-separated (e.g. apple-docc, wwdc, sample-code)
  --kind <kind>        Filter by role or displayed kind (e.g. symbol, article, Article, Session)
  --language <lang>    Filter by language: swift, objc
  --platform <name>    Filter by platform availability: ios, macos, watchos, tvos, visionos
  --min-ios <ver>      Only show docs available on iOS >= version (e.g. 17.0)
  --min-macos <ver>    Only show docs available on macOS >= version
  --min-watchos <ver>  Only show docs available on watchOS >= version
  --min-tvos <ver>     Only show docs available on tvOS >= version
  --min-visionos <ver> Only show docs available on visionOS >= version
  --year <n>           Filter WWDC sessions by year (e.g. 2024)
  --track <name>       Filter WWDC sessions by track (e.g. SwiftUI, Accessibility)
  --deprecated <mode>  Deprecated filter: include (default), exclude, only
  --limit <n>          Max results (default: 100)
  --no-fuzzy           Disable typo-tolerant matching
  --no-deep            Disable full-body search entirely
  --no-eager           Wait for body search to finish (exhaustive results)
  --read               Read the full content of the best match
  --max-chars <n>      Paginate output to fit within N characters (use with --read)
  --page <n>           Page number to display (default: 1, requires --max-chars)
  --json               Output raw JSON

Examples:
  apple-docs search "NavigationStack"         # exact + CamelCase expansion
  apple-docs search "Publsher"                # fuzzy: finds Publisher (d=1)
  apple-docs search "navig"                   # substring match on titles
  apple-docs search "async patterns" --no-eager  # wait for body results
  apple-docs search "in-app purchase" --framework app-store-review
  apple-docs search "Observation" --source wwdc
  apple-docs search "Swift Testing" --source wwdc --year 2024
  apple-docs search "privacy" --framework guidelines --read  # search + read best match
  apple-docs search "View" --read --max-chars 4000            # paginated read
`.trim(),

  read: `
Usage: apple-docs read <path-or-symbol> [options]

Read a specific documentation page and print its Markdown content.

Options:
  --framework <name>   Disambiguate symbol by framework
  --section <name>     Extract a specific section by heading or file path
  --max-chars <n>      Paginate output to fit within N characters
  --page <n>           Page number to display (default: 1, requires --max-chars)
  --json               Output metadata as JSON instead of Markdown
`.trim(),

  frameworks: `
Usage: apple-docs frameworks [options]

List all known documentation roots (frameworks, technologies, etc).

Options:
  --kind <type>        Filter by kind (framework, technology, tooling, etc)
  --json               Output raw JSON
`.trim(),

  browse: `
Usage: apple-docs browse <framework> [options]

Browse the documentation tree for a framework.

Options:
  --path <path>        Show children of a specific page
  --limit <n>          Max pages to return (default: all)
  --json               Output raw JSON
`.trim(),

  kinds: `
Usage: apple-docs kinds [options]

List distinct taxonomy values found across the corpus with counts.
Useful for discovering valid --kind values for search, and seeing the shape
of the indexed documentation at a glance.

Options:
  --field <name>       Limit output to one field: kind, role, docKind,
                       roleHeading, sourceType (default: all)
  --json               Output raw JSON
`.trim(),

  sync: `
Usage: apple-docs sync [options]

Discover, download, and convert Apple documentation.
Resumable: if interrupted, re-run the same command to continue where you left off.

Options:
  --roots <a,b,c>      Only sync specific roots (comma-separated)
  --sources <a,b,c>    Only sync specific source types (apple-docc,hig,guidelines,...,packages)
  --full               Sync all discovered roots and expand sources to their full catalog
  --parallel <n>       Crawl N frameworks simultaneously (default: 10)
  --concurrency <n>    Max total in-flight fetches across all roots (default: 500)
  --rate <n>           Max requests per second across all roots (default: 500)
  --retry-failed       Retry pages that previously failed (404, timeout, etc)
  --index              Build body search index after sync
  --skip-fonts         Skip Apple typography indexing (default: indexed)
  --skip-symbols       Skip SF Symbols indexing (default: indexed; macOS only)
  --download-fonts     Download SF Pro/Compact/Mono/etc DMGs from Apple CDN
                       and extract them. Off by default — large files (~500MB)
                       and only needed if the host doesn't already have them
                       installed in ~/Library/Fonts or /Library/Fonts.
  --render-symbols     Pre-render every SF Symbol to SVG. Off by default —
                       takes several minutes; rendering happens lazily on
                       first request otherwise. Implies --skip-symbols=false.
  --use-git-auth       Reuse a GitHub token from the local gh CLI or git
                       credential helper. No prompt. Env vars still take
                       precedence.
  --skip-git-auth      Skip all local-credential detection for this run.
  --json               Output summary as JSON

Resource sync (fonts + SF Symbols) runs by default unless the caller passes
--roots or --sources, in which case the run is treated as a targeted sync
of those sources only. Use --skip-fonts / --skip-symbols on a full sync
to opt out, or --download-fonts / --render-symbols to enable the heavier
steps.

On a TTY with no GITHUB_TOKEN set, sync prompts before using local credentials
and can remember the choice with "always". Persisted preference lives at
~/.apple-docs/config.json. Set APPLE_DOCS_NO_GIT_AUTH=1 to disable detection
globally (recommended for CI).

Examples:
  apple-docs sync                                           # sync everything (docs + fonts + symbols)
  apple-docs sync --roots swiftui,combine                   # sync two frameworks (no fonts/symbols)
  apple-docs sync --sources guidelines                      # sync only App Store Review Guidelines
  apple-docs sync --roots app-store-review                  # sync App Store Review Guidelines
  apple-docs sync --sources packages                        # sync curated apple/swiftlang packages
  apple-docs sync --full --sources packages                 # full package catalog via raw.githubusercontent.com (no auth)
  APPLE_DOCS_PACKAGES_FETCH=api GITHUB_TOKEN=... apple-docs sync --full --sources packages  # rich GitHub REST metadata (stars, license, …)
  apple-docs sync --full --parallel 10 --rate 500             # aggressive full crawl
  apple-docs sync --roots uikit --concurrency 100 --rate 100  # tuned single-root crawl
  apple-docs sync --retry-failed                            # retry 404s/timeouts
  apple-docs sync --download-fonts --render-symbols         # also pull DMG fonts and prerender symbol SVGs
`.trim(),

  update: `
Usage: apple-docs update [options]

Check for documentation updates and pull changes.

Options:
  --roots <a,b,c>      Only check specific roots
  --sources <a,b,c>    Only check specific source types (apple-docc,hig,guidelines,...,packages)
  --concurrency <n>    Max concurrent HEAD checks / fetches (default: 500)
  --rate <n>           Max requests per second (default: 500)
  --parallel <n>       Crawl N new roots simultaneously (default: 10)
  --index              Update body search index after pulling changes
  --use-git-auth       Reuse a GitHub token from the local gh CLI or git
                       credential helper (same behavior as sync).
  --skip-git-auth      Skip local-credential detection for this run.
  --json               Output summary as JSON

Examples:
  apple-docs update --concurrency 50 --rate 100    # fast update check
  apple-docs update --roots swiftui,combine         # check specific roots
  apple-docs update --sources guidelines            # check only App Store Review Guidelines
  apple-docs update --sources packages              # refresh package catalog entries
`.trim(),

  index: `
Usage: apple-docs index [subcommand] [options]

Build or update search indexes.

Subcommands:
  (none)               Build or update the full-body search index
  rebuild-trigram      Rebuild trigram index from document titles (fuzzy search)
  rebuild-body         Rebuild body index from document sections (deep search)

Options:
  --full               Rebuild the entire index from scratch
  --json               Output results as JSON

The rebuild subcommands are useful for lower-tier snapshots that ship without
certain indexes. rebuild-trigram works on any tier (uses titles).
rebuild-body requires document_sections (standard tier or above).

Examples:
  apple-docs index                    # build/update body index
  apple-docs index --full             # full rebuild
  apple-docs index rebuild-trigram    # add fuzzy search to a lite snapshot
  apple-docs index rebuild-body      # add deep search (requires standard tier)
`.trim(),

  doctor: `
Usage: apple-docs doctor [options]

Diagnose and repair the documentation corpus:
  - Upgrades the database to the latest schema version
  - Cleans up invalid crawl entries (fragments, dot-operators)
  - Re-resolves failures by checking parent pages for correct URLs
  - Retries re-resolved paths
  - Optionally minifies raw JSON files to save disk space
  - Optionally rebuilds the body search index

Options:
  --dry-run            Show what would be fixed without changing anything
  --minify             Minify all existing JSON files (sorted keys, no whitespace)
  --index              Rebuild the full-body search index
  --verify             Verify snapshot integrity (if installed from snapshot)
  --json               Output results as JSON
`.trim(),

  status: `
Usage: apple-docs status [options]

Show corpus statistics and health.

Options:
  --json               Output raw JSON
`.trim(),

  mcp: `
Usage: apple-docs mcp <subcommand> [options]

MCP (Model Context Protocol) server commands.

Subcommands:
  start                Start MCP stdio server for AI assistants
  serve                Start MCP Streamable HTTP server (for remote access)
  install              Show MCP configuration for Claude, Cursor, etc.

Serve options:
  --port <n>           Port number (default: 3031)
  --host <addr>        Bind address (default: 127.0.0.1)
  --allow-origin <url> Allowed browser Origin header(s); comma-separated.
                       Omit to allow all origins (defaults open — intended
                       to run behind a private network boundary).
  --concurrency <n>    Max in-flight heavy tool calls (default: 4, also
                       APPLE_DOCS_MCP_CONCURRENCY). Caps search_docs /
                       read_doc / browse / list_frameworks / list_taxonomy so
                       initialize/ping/tools/list stay responsive.
  --queue <n>          Max queued heavy calls beyond --concurrency before
                       rejecting with HTTP 503 (default: 32, also
                       APPLE_DOCS_MCP_QUEUE). 0 means reject immediately once
                       permits are exhausted.

Install options:
  --http <url>         Print configuration for a remote Streamable HTTP
                       endpoint instead of the default local stdio config.

Examples:
  apple-docs mcp start
  apple-docs mcp serve                                    # 127.0.0.1:3031/mcp
  apple-docs mcp serve --port 3031 --allow-origin https://apple-docs-mcp.example.com
  apple-docs mcp install
  apple-docs mcp install --http https://apple-docs-mcp.example.com/mcp
`.trim(),

  setup: `
Usage: apple-docs setup [options]

Download a pre-built documentation snapshot for instant access.
No crawling required — ready in under 60 seconds.

Options:
  --tier <name>    Snapshot tier: lite, standard, full (default: full)
  --force          Overwrite existing corpus
  --downgrade      Allow replacing a higher tier with a lower tier
  --use-git-auth   Reuse a GitHub token from the local gh CLI or git
                   credential helper to authenticate release downloads.
  --skip-git-auth  Skip local-credential detection for this run.
  --json           Output results as JSON
`.trim(),

  fonts: `
Usage: apple-docs fonts <subcommand> [options]

Manage Apple typography (SF Pro, SF Mono, New York, …).

Subcommands:
  sync                 Index Apple font families and font files
  list                 List indexed Apple font families (default)

Sync options:
  --download           Download Apple font DMGs before indexing local files

Examples:
  apple-docs fonts sync --download
  apple-docs fonts list
`.trim(),

  symbols: `
Usage: apple-docs symbols <subcommand> [options]

Manage SF Symbols (public and private).

Subcommands:
  sync                 Index public and private SF Symbols from local CoreGlyphs bundles
  render               Pre-render every indexed symbol to SVG on disk (uses Apple's vector PDF pipeline + pdftocairo)
  search [query]       Search indexed SF Symbols (default)

Sync options:
  --exclude-private    Skip the private CoreGlyphs bundle
  --render             Pre-render SVGs after indexing (chains symbols sync + symbols render)
  --concurrency <n>    Parallel Swift workers (default: 4)
  --reset-cache        Delete the existing SVG cache before rendering

Render options:
  --scope <scope>      Render only public or private (default: both)
  --concurrency <n>    Parallel Swift workers (default: 4)
  --reset-cache        Delete the existing SVG cache before rendering

Search options:
  --scope <scope>      public or private
  --limit <n>          Max results (default: 100)

Examples:
  apple-docs symbols sync --render --concurrency 8
  apple-docs symbols render --scope public
  apple-docs symbols search "pencil sparkles" --scope private
`.trim(),

  snapshot: `
Usage: apple-docs snapshot <subcommand> [options]

Build and manage documentation snapshots.

Subcommands:
  build            Build a snapshot archive from the current corpus

Build options:
  --tier <name>    Snapshot tier: lite, standard, full (default: full)
  --out <dir>      Output directory (default: dist)
  --tag <name>     Version tag for the archive filename
  --json           Output results as JSON

Examples:
  apple-docs snapshot build --tier lite --out dist/
  apple-docs snapshot build --tier full --tag snapshot-20260413
`.trim(),

  web: `
Usage: apple-docs web <subcommand> [options]

Static documentation website commands.

Subcommands:
  serve                Start local dev server
  build                Build static site to dist/web/
  deploy [platform]    Show deployment instructions

Build options:
  --out <dir>          Output directory (default: dist/web)
  --base-url <url>     Base URL prefix for links
  --site-name <name>   Site title
  --incremental        Skip docs whose render fingerprint matches the last build (writes in place; resumable)
  --full               Force a full rebuild (clears the per-doc render index, rewrites via staging dir)
  --frameworks <a,b>   Restrict the build to these framework slugs (escape hatch for memory pressure on giant frameworks)
  --concurrency <n>    Per-process render concurrency (default: ncpu - 2). Sync-CPU rendering doesn't benefit much above 2-4 within one Bun process; for real parallelism see --workers.
  --workers <n>        Fan out across N child Bun subprocesses, each rendering a partition of the framework list (default: 1 = inline). Use ncpu (e.g. 6) for the first full build to scale near-linearly with cores.
  --skip-docs          Build only the site essentials (homepage, search page, public files, sitemap-index, search artifacts, manifest, framework metadata) and skip every per-document and per-framework HTML page. Caddy falls through to Bun for /docs/*, where the on-demand renderer + Cache-Control headers let Cloudflare cache each doc after first visit. The fastest path to a working deploy.

Serve options:
  --port <n>           Port number (default: 3000)
  --base-url <url>     Base URL prefix for links

Deploy platforms:
  github-pages         GitHub Pages (default)
  cloudflare           Cloudflare Pages
  vercel               Vercel
  netlify              Netlify

Examples:
  apple-docs web serve
  apple-docs web build --out dist/web                                 # full build via staging
  apple-docs web build --incremental --out dist/web                   # skip unchanged pages, write in place
  apple-docs web build --workers 6 --incremental --out dist/web       # fan out across 6 cores; one Bun subprocess each
  apple-docs web build --skip-docs --out dist/web                     # essentials only; let Bun + Cloudflare handle /docs/* on demand
  apple-docs web build --frameworks kernel,matter,swift --concurrency 2  # one big framework at a time
  apple-docs web deploy github-pages
`.trim(),

  links: `
Usage: apple-docs links <subcommand> [options]

Audit and consolidate cross-references across the corpus.

Subcommands:
  audit               Walk dist/web/docs/**/*.html, classify every <a href>
                      and report counts + top broken patterns
  consolidate         Re-apply the cross-source link resolver to stored
                      document_sections.content_json, populating
                      _resolvedKey on reference/link nodes whose URL maps
                      to a corpus key. Idempotent. Run after sync.

Options (audit):
  --out <dir>         Built static site directory (default: dist/web)
  --json              Output raw stats as JSON for downstream analysis

Options (consolidate):
  --dry-run           Show counts without writing to the DB

Categories reported by audit:
  internal_ok         /docs/<key>/ where the key resolves
  internal_broken     /docs/<key>/ where the key is not in the corpus
  external_resolvable Absolute URL with a known internal equivalent
                      (run \`apple-docs links consolidate\` to internalize)
  external            Absolute URL with no internal equivalent
  fragment            #anchor — page-local
  relative_broken     Relative path that doesn't resolve

Examples:
  apple-docs links audit                          # full audit
  apple-docs links audit --json > /tmp/links.json # JSON for analysis
  apple-docs links consolidate --dry-run          # preview rewrites
  apple-docs links consolidate                    # apply rewrites in DB
`.trim(),

  storage: `
Usage: apple-docs storage <subcommand> [options]

Manage on-disk storage: profiles, materialization, and garbage collection.

Subcommands:
  profile [set <name>]    Show or change the active storage profile
  profile list            List all available profiles
  stats                   Show disk usage breakdown by category
  materialize <format>    Force-render markdown or HTML for all documents
  gc                      Garbage collect cached materializations

Profile subcommand:
  apple-docs storage profile                    Show current profile
  apple-docs storage profile set raw-only       Switch to minimal disk usage
  apple-docs storage profile set balanced       Switch to cache-on-read (default)
  apple-docs storage profile set prebuilt       Switch to full materialization
  apple-docs storage profile list               List all profiles with descriptions

GC options:
  --drop <types>       Categories to drop: markdown, html (comma-separated)
  --older-than <days>  Remove activity records older than this many days before cleanup
  --no-vacuum          Skip database VACUUM after cleanup

Materialize options:
  --roots <a,b,c>      Only materialize specific frameworks

Examples:
  apple-docs storage stats
  apple-docs storage gc --drop markdown,html
  apple-docs storage gc --older-than 30 --no-vacuum
  apple-docs storage materialize markdown --roots swiftui
  apple-docs storage profile set raw-only
`.trim(),
}

export function showHelp(command) {
  if (command && COMMANDS[command]) {
    console.log(COMMANDS[command])
  } else {
    console.log(GLOBAL)
  }
}
