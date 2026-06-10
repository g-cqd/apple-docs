import { GLOBAL } from './help-global.js'

const COMMANDS = {
  search: `
Usage: apple-docs search <query> [options]

Search Apple documentation with typo tolerance, tiered ranking, and a local
semantic index — both exact symbol names ("NavigationStack") and plain
questions ("how do I record audio in the background") work.

Prefer filters (--framework, --source, --platform, ...) over stuffing
constraints into the query.

Options:
  --framework <name>   Filter by framework (e.g. swiftui, design, app-store-review)
  --source <name>      Filter by source type(s), comma-separated (apple-docc, wwdc, sample-code)
  --kind <kind>        Filter by role or displayed kind (Article, Session, symbol, ...)
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
  --read               Read the full content of the best match
  --max-chars <n>      Paginate output to fit within N characters (use with --read)
  --page <n>           Page number to display (default: 1, requires --max-chars)
  --json               Output raw JSON (projected — internals hidden)

Advanced (search-tuning, diagnostic):
  --no-fuzzy           Disable typo-tolerant matching
  --no-deep            Disable full-body search entirely
  --no-eager           Wait for body search to finish (exhaustive results)

Examples:
  apple-docs search "NavigationStack"
  apple-docs search "Publsher"                # fuzzy: finds Publisher (d=1)
  apple-docs search "Swift Testing" --source wwdc --year 2024
  apple-docs search "privacy" --framework guidelines --read
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

Browse the documentation tree for a framework or collection root.

The wwdc root is year-aware: \`browse wwdc\` lists years with session
counts, \`browse wwdc --year 2024\` lists that year's sessions.

Options:
  --path <path>        Show children of a specific page
  --year <yyyy>        WWDC only: list one year's sessions
  --limit <n>          Max pages to return (default: all)
  --json               Output raw JSON

Examples:
  apple-docs browse swiftui
  apple-docs browse swiftui --path swiftui/view
  apple-docs browse wwdc --year 2025
`.trim(),

  kinds: `
Usage: apple-docs kinds [options]

List distinct taxonomy values with counts. Use this to discover valid
--kind, --source, and related filter values for search.

Options:
  --field <name>       Return one field only: kind, role, docKind,
                       roleHeading, or sourceType
  --all                Return every distinct value (default: top 20 per field)
  --json               Output raw JSON
`.trim(),

  status: `
Usage: apple-docs status [options]

Show corpus statistics and freshness.

Options:
  --json               Output raw JSON

Advanced (operator diagnostics):
  --advanced           Include snapshot tier, search-index availability,
                       and per-root crawl progress
`.trim(),

  sync: `
Usage: apple-docs sync [options]

Refresh the entire Apple documentation corpus end-to-end. Single command,
full coverage. Resumable: re-run after interruption to continue.

Stages: HEAD-check → discover → crawl → download → convert → Xcode-docs
enrich → body index → fonts → SF Symbols → migrations + cleanup + minify.

The enrich stage merges Xcode's offline documentation asset (symbol USRs +
pages the public crawl can't see) when a local Xcode install provides one;
set APPLE_DOCS_ENRICH_FETCH=1 to allow the ~650 MB CDN download instead.

Options:
  --full               Force a clean rebuild from scratch
  --rate <n>           Max requests per second across roots (default: 500)
  --json               Output the full pipeline report as JSON

Advanced (performance / auth tuning):
  --aggressive         Use the legacy 500 in-flight fetch profile. Default
                       caps at 100 in-flight unless APPLE_DOCS_CONCURRENCY
                       is set explicitly.
  --use-git-auth       Reuse a GitHub token from local gh CLI or git
                       credential helper. No prompt.
  --skip-git-auth      Skip all local-credential detection for this run.

On a TTY without GITHUB_TOKEN, sync prompts before using local credentials
and can remember the choice. Set APPLE_DOCS_NO_GIT_AUTH=1 to disable
detection globally (recommended for CI).

Examples:
  apple-docs sync                # full refresh, idempotent
  apple-docs sync --full         # clean rebuild
  apple-docs sync --json         # pipeline report as JSON
`.trim(),

  setup: `
Usage: apple-docs setup [options]

Download a pre-built documentation snapshot (~1.5 GB). No
crawling required — ready in a few minutes, mostly the download. After
extraction, setup builds the semantic search index locally (snapshots ship
the embedding model but no vectors); --compact and --prebuilt do extra
one-time work after that (see below).

Profiles pick disk-vs-speed and finish in one step (no follow-up command):
  --compact          Smallest disk. Compacts the install now: compresses
                     sections, makes the body index contentless, drops the
                     embedded raw payloads, VACUUMs (DB ~4.3 → ~1.9 GiB).
                     Renders on demand.
  --prebuilt         Fastest. Materializes Markdown + HTML now (largest disk).
  (default)          balanced — snapshot as-is; caches Markdown on first read.

Options:
  --force            Overwrite existing corpus
  --beta             Beta channel: also consider prerelease snapshots (built
                     on newer/beta macOS, with SF Symbols stable CI lacks).
                     Updates only to newer betas, or stables built on at
                     least the same macOS — never one that sheds symbols.
  --profile <name>   compact | balanced | prebuilt (explicit; overrides the
                     --compact / --prebuilt shorthands). Prompts on a TTY;
                     otherwise balanced.
  --yes              Accept the default profile without prompting
  --skip-resources   Skip the post-extract font + symbols re-index step
  --skip-semantic    Skip the post-extract semantic index build (lexical-only
                     search; run \`apple-docs index embeddings --full\` later)
  --archive <path>   Install from a local snapshot tarball (under $HOME/cwd);
                     verifies a sibling .sha256 sidecar when present.
  --json             Output results as JSON

Advanced (auth tuning):
  --use-git-auth     Reuse a GitHub token from the local gh CLI or git
                     credential helper to authenticate release downloads.
  --skip-git-auth    Skip local-credential detection for this run.

Examples:
  apple-docs setup                 # balanced (default), prompts on a TTY
  apple-docs setup --compact       # smallest install, one step
  apple-docs setup --prebuilt      # fastest install, one step
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
                       Omit to deny browser origins except loopback. Native
                       clients without an Origin header are allowed.

Serve options (advanced — capacity / observability):
  --concurrency <n>    Max in-flight heavy tool calls (default: 8, also
                       APPLE_DOCS_MCP_CONCURRENCY). Caps search_docs /
                       read_doc / browse / render tools so initialize/ping /
                       tools/list stay responsive.
  --queue <n>          Max queued heavy calls beyond --concurrency before
                       rejecting with HTTP 503 (default: 64, also
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
  --concurrency <n>    Per-process render concurrency (default: ncpu - 2). For real parallelism see --workers.
  --workers <n>        Fan out across N child Bun subprocesses, each rendering a partition of the framework list (default: 1 = inline).
  --skip-docs          Build only the site essentials and skip every per-document HTML page.
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

Serve options (advanced — observability):
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
  apple-docs web build --workers 6 --incremental --out dist/web       # fan out across 6 cores
  apple-docs web build --skip-docs --out dist/web                     # essentials only
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

GC options (advanced):
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

Build options (advanced):
  --allow-incomplete-symbols   Skip the SF Symbols matrix gate (for build
                               hosts without the live renderer; expect 404s).

The build writes a single .tar.zst + .sha256 + manifest under <out>/: the DB
(document_sections + zstd-compressed raw payloads), SF Symbols, fonts, and the
model2vec embedding model. Markdown/HTML are regenerated on device
(\`storage materialize\`). Semantic vectors are NOT shipped — \`setup\`
rebuilds them locally from the shipped sections + model.

Examples:
  apple-docs snapshot build --out dist
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
  --json               Output raw JSON.

Options (advanced — pipeline tuning):
  --dry-run            Report what would change without persisting.
  --minify             Trim raw-JSON payloads in place after consolidation.

Resumable: re-run after interruption to continue from the last checkpoint.
`.trim(),

  index: `
Usage: apple-docs index <subcommand> [target] [options]

Rebuild a search index from existing data. Useful after recovering from a
corrupted FTS5 / trigram table, or to (re)build the optional semantic tier.

Subcommands:
  rebuild body         Rebuild the full-body FTS5 index from documents.
  rebuild trigram      Rebuild the trigram FTS5 index from document titles.
  embeddings           Build the semantic index (document_chunks: per-chunk
                       binary + int8 codes, plus the document_vectors anchor)
                       with the model2vec embedder. Runs automatically at
                       setup; needs the optional @huggingface/transformers
                       dep + the local model, otherwise lexical-only.

Options:
  --full               (embeddings) Re-chunk + re-embed every document.
                       Without it, only documents with no chunks yet are
                       processed.

Examples:
  apple-docs index rebuild body
  apple-docs index rebuild trigram
  apple-docs index embeddings --full
`.trim(),
}

export function showHelp(command) {
  if (command && COMMANDS[command]) {
    console.log(COMMANDS[command])
  } else {
    console.log(GLOBAL)
  }
}
