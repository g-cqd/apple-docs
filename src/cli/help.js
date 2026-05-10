const GLOBAL = `
apple-docs - Apple Developer Documentation search and management

Usage: apple-docs <command> [options]

Read / query:
  search <query>       Search documentation by term or symbol
  read <path>          Read a specific page or symbol
  frameworks           List known documentation roots
  browse <framework>   Browse topic tree for a framework
  status               Show corpus statistics

Operator:
  sync                 Refresh the entire corpus end-to-end
                       (HEAD-check existing pages, crawl new pages, convert,
                       index, sync fonts + SF Symbols, pre-render symbols,
                       run schema migrations / minify / cleanup)
  setup                Download a pre-built documentation snapshot

Build / serve:
  web build            Build static documentation site
  web serve            Start local dev server
  web deploy           Show deployment instructions
  mcp start            Start MCP stdio server
  mcp serve            Start MCP Streamable HTTP server
  mcp install          Show MCP configuration instructions

Storage:
  storage stats        Show disk usage breakdown
  storage gc           Garbage collect cached files

Maintenance:
  snapshot build       Build a release snapshot archive (lite/standard/full)
  consolidate          Repair failed crawl entries and re-resolve URLs
  index rebuild <kind> Rebuild a search index from existing data (body|trigram)

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

  sync: `
Usage: apple-docs sync [options]

Refresh the entire Apple documentation corpus end-to-end. Single command,
full coverage — no scope flags, no skip flags. Resumable: if interrupted,
re-run the same command to continue where you left off.

Stages, in order:
  1. HEAD-check every existing page across every source for upstream changes
  2. Discover roots and adapter pages (catalog + flat sources)
  3. Crawl new pages, retrying any previously-failed entries
  4. Download missing raw payloads, convert to Markdown
  5. Build / refresh the body search index
  6. Sync Apple typography (downloads SF Pro / Compact / Mono / etc DMGs)
  7. Sync SF Symbols (public + private) and pre-render every variant to SVG
  8. Run schema migrations, clean invalid entries, re-resolve failures,
     minify raw JSON

Options:
  --full               Force a clean rebuild: rebuild the body index from
                       scratch and treat every page as if it were new. Use
                       after a major schema change or to recover from a
                       corrupted incremental state.
  --rate <n>           Max requests per second across all roots (default: 500)
  --json               Output the full pipeline report as JSON

GitHub auth:
  --use-git-auth       Reuse a GitHub token from the local gh CLI or git
                       credential helper. No prompt. Env vars still take
                       precedence.
  --skip-git-auth      Skip all local-credential detection for this run.

On a TTY with no GITHUB_TOKEN set, sync prompts before using local credentials
and can remember the choice with "always". Persisted preference lives at
~/.apple-docs/config.json. Set APPLE_DOCS_NO_GIT_AUTH=1 to disable detection
globally (recommended for CI).

Examples:
  apple-docs sync                # full refresh, idempotent
  apple-docs sync --full         # clean rebuild from scratch
  apple-docs sync --json         # pipeline report as JSON
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
  --metrics-port <n>   When set, expose a Prometheus /metrics scrape endpoint
                       on a separate listener. Absent → disabled (zero cost).
                       Bound to 127.0.0.1 by default; not gated by main
                       server middleware (scrapers handle their own auth).
  --metrics-host <addr> Bind address for --metrics-port (default: 127.0.0.1).

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
  --force          Overwrite existing corpus
  --skip-resources Skip the post-extract font + symbols re-index step
  --use-git-auth   Reuse a GitHub token from the local gh CLI or git
                   credential helper to authenticate release downloads.
  --skip-git-auth  Skip local-credential detection for this run.
  --json           Output results as JSON
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
  --json               Emit the build summary plus the full link-audit report as JSON

After every build, the link auditor walks the rendered HTML tree and prints a
one-line summary (e.g. "links: 12345 ok, 3 broken, 27 external_unresolvable").
Pass --json for the full breakdown.

Serve options:
  --port <n>           Port number (default: 3000)
  --host <addr>        Bind address (default: 127.0.0.1; pass 0.0.0.0 for LAN
                       reach). Also: APPLE_DOCS_WEB_HOST=<addr>.
  --rate-limit         Enable per-client-IP token-bucket gate (off by default).
                       Tune via APPLE_DOCS_WEB_RATE / APPLE_DOCS_WEB_BURST,
                       or set APPLE_DOCS_WEB_RATE_LIMIT=1.
  --base-url <url>     Base URL prefix for links
  --metrics-port <n>   When set, expose a Prometheus /metrics scrape endpoint
                       on a separate listener. Absent → disabled (zero cost).
                       Bound to 127.0.0.1 by default.
  --metrics-host <addr> Bind address for --metrics-port (default: 127.0.0.1).

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

  storage: `
Usage: apple-docs storage <subcommand> [options]

Disk usage inspection and cache cleanup.

Subcommands:
  stats                   Show disk usage breakdown by category
  gc                      Garbage collect cached materializations
  check-orphans           Report foreign-key violations and semantic orphans

GC options:
  --drop <types>       Categories to drop: markdown, html (comma-separated)
  --older-than <days>  Remove activity records older than this many days before cleanup
  --no-vacuum          Skip database VACUUM after cleanup

Examples:
  apple-docs storage stats
  apple-docs storage gc --drop markdown,html
  apple-docs storage gc --older-than 30 --no-vacuum
  apple-docs storage check-orphans      # read-only; surfaces FK violations
`.trim(),

  snapshot: `
Usage: apple-docs snapshot <subcommand> [options]

Build a release snapshot archive of the corpus.

Subcommands:
  build                Materialize the corpus to a tarball + .sha256 + manifest

Build options:
  --out <dir>                  Output directory (default: dist)
  --tag <tag>                  Archive tag (default: snapshot-YYYYMMDD)
  --allow-incomplete-symbols   Skip the SF Symbols matrix-completeness gate
                               (only when building on a host that can't run
                               the live renderer; consumers will see 404s
                               for the missing variants).

The build runs VACUUM INTO on the live database, writes the tarball under
<out>/<tag>/, and emits both a SHA-256 sidecar and a JSON manifest. Used
by the release pipeline (scripts/build-snapshot.js) and the operator
who wants a portable copy.

Lite/standard tiers were retired in G.1; every snapshot ships the full
corpus (raw-json + markdown + extracted fonts + the complete pre-
rendered SF Symbols matrix).

Examples:
  apple-docs snapshot build --out dist
  apple-docs snapshot build --tag snapshot-2026-05-09
`.trim(),

  consolidate: `
Usage: apple-docs consolidate [options]

Repair failed crawl entries and re-resolve URLs that became reachable after
the original failure (e.g. typos fixed, fragments rewritten, redirects).

Steps:
  1. Drop entries the normalizer now rejects (fragments, dot-ops, etc).
  2. Inspect parents of remaining failures to find correct URLs.
  3. Retry resolved paths, persisting checkpoints between batches.

Options:
  --dry-run            Report what would change without persisting.
  --minify             Trim raw-JSON payloads in place after consolidation.
  --json               Output raw JSON.

Resumable: re-run after interruption to continue from the last checkpoint.
`.trim(),

  index: `
Usage: apple-docs index <subcommand> [target] [options]

Rebuild a search index from existing data. Useful after recovering from
a corrupted FTS5 / trigram table.

Subcommands:
  rebuild body         Rebuild the full-body FTS5 index from documents.
  rebuild trigram      Rebuild the trigram FTS5 index from document titles.

Examples:
  apple-docs index rebuild body
  apple-docs index rebuild trigram
`.trim(),
}

export function showHelp(command) {
  if (command && COMMANDS[command]) {
    console.log(COMMANDS[command])
  } else {
    console.log(GLOBAL)
  }
}
