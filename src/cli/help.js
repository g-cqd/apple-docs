const GLOBAL = `
apple-docs - Apple Developer Documentation search and management

Usage: apple-docs <command> [options]

Commands:
  search <query>       Search documentation by term or symbol
  read <path>          Read a specific page or symbol
  frameworks           List known documentation roots
  browse <framework>   Browse topic tree for a framework
  sync                 Discover, download, and index documentation
  update               Check for and pull documentation updates
  index                Build full-body search index
  doctor               Diagnose and repair corpus
  status               Show corpus statistics
  setup                Download pre-built documentation snapshot

  snapshot build       Build snapshot archive from current corpus

  mcp start            Start MCP stdio server
  mcp install          Show MCP configuration instructions

  web serve            Start local dev server
  web build            Build static documentation site
  web deploy           Show deployment instructions

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

  sync: `
Usage: apple-docs sync [options]

Discover, download, and convert Apple documentation.
Resumable: if interrupted, re-run the same command to continue where you left off.

Options:
  --roots <a,b,c>      Only sync specific roots (comma-separated)
  --sources <a,b,c>    Only sync specific source types (apple-docc,hig,guidelines,...,packages)
  --full               Sync all discovered roots
  --parallel <n>       Crawl N frameworks simultaneously (default: 1)
  --concurrency <n>    Max total in-flight fetches across all roots (default: 5)
  --rate <n>           Max requests per second across all roots (default: 5)
  --retry-failed       Retry pages that previously failed (404, timeout, etc)
  --index              Build body search index after sync
  --json               Output summary as JSON

Examples:
  apple-docs sync --roots swiftui,combine                   # sync two frameworks
  apple-docs sync --sources guidelines                      # sync only App Store Review Guidelines
  apple-docs sync --roots app-store-review                  # sync App Store Review Guidelines
  apple-docs sync --sources packages                        # sync Swift package catalog (GitHub token recommended)
  apple-docs sync --full --parallel 5 --rate 10             # 5 roots at once, 10 req/s
  apple-docs sync --roots uikit --concurrency 10 --rate 10  # fast single root
  apple-docs sync --retry-failed                            # retry 404s/timeouts
`.trim(),

  update: `
Usage: apple-docs update [options]

Check for documentation updates and pull changes.

Options:
  --roots <a,b,c>      Only check specific roots
  --sources <a,b,c>    Only check specific source types (apple-docc,hig,guidelines,...,packages)
  --concurrency <n>    Max concurrent HEAD checks / fetches (default: 5)
  --rate <n>           Max requests per second (default: 5)
  --parallel <n>       Crawl N new roots simultaneously (default: 1)
  --index              Update body search index after pulling changes
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
Usage: apple-docs mcp <subcommand>

MCP (Model Context Protocol) server commands.

Subcommands:
  start                Start MCP stdio server for AI assistants
  install              Show MCP configuration for Claude, Cursor, etc.

Examples:
  apple-docs mcp start            # start server (used by MCP clients)
  apple-docs mcp install          # print configuration JSON
`.trim(),

  setup: `
Usage: apple-docs setup [options]

Download a pre-built documentation snapshot for instant access.
No crawling required — ready in under 60 seconds.

Options:
  --tier <name>    Snapshot tier: lite, standard, full (default: standard)
  --force          Overwrite existing corpus
  --downgrade      Allow replacing a higher tier with a lower tier
  --json           Output results as JSON
`.trim(),

  snapshot: `
Usage: apple-docs snapshot <subcommand> [options]

Build and manage documentation snapshots.

Subcommands:
  build            Build a snapshot archive from the current corpus

Build options:
  --tier <name>    Snapshot tier: lite, standard, full (default: standard)
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
  apple-docs web build --out dist/web
  apple-docs web deploy github-pages
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
