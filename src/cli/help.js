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
  --kind <role>        Filter by role (e.g. symbol, article)
  --limit <n>          Max results (default: 100)
  --no-fuzzy           Disable typo-tolerant matching
  --no-deep            Disable full-body search entirely
  --no-eager           Wait for body search to finish (exhaustive results)
  --json               Output raw JSON

Examples:
  apple-docs search "NavigationStack"         # exact + CamelCase expansion
  apple-docs search "Publsher"                # fuzzy: finds Publisher (d=1)
  apple-docs search "navig"                   # substring match on titles
  apple-docs search "async patterns" --no-eager  # wait for body results
  apple-docs search "in-app purchase" --framework app-store-review
`.trim(),

  read: `
Usage: apple-docs read <path-or-symbol> [options]

Read a specific documentation page and print its Markdown content.

Options:
  --framework <name>   Disambiguate symbol by framework
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
  --full               Sync all discovered roots
  --parallel <n>       Crawl N frameworks simultaneously (default: 1)
  --concurrency <n>    Max total in-flight fetches across all roots (default: 5)
  --rate <n>           Max requests per second across all roots (default: 5)
  --retry-failed       Retry pages that previously failed (404, timeout, etc)
  --index              Build body search index after sync
  --json               Output summary as JSON

Examples:
  apple-docs sync --roots swiftui,combine                   # sync two frameworks
  apple-docs sync --roots app-store-review                  # sync App Store Review Guidelines
  apple-docs sync --full --parallel 5 --rate 10             # 5 roots at once, 10 req/s
  apple-docs sync --roots uikit --concurrency 10 --rate 10  # fast single root
  apple-docs sync --retry-failed                            # retry 404s/timeouts
`.trim(),

  update: `
Usage: apple-docs update [options]

Check for documentation updates and pull changes.

Options:
  --roots <a,b,c>      Only check specific roots
  --concurrency <n>    Max concurrent HEAD checks / fetches (default: 5)
  --rate <n>           Max requests per second (default: 5)
  --parallel <n>       Crawl N new roots simultaneously (default: 1)
  --index              Update body search index after pulling changes
  --json               Output summary as JSON

Examples:
  apple-docs update --concurrency 50 --rate 100    # fast update check
  apple-docs update --roots swiftui,combine         # check specific roots
`.trim(),

  index: `
Usage: apple-docs index [options]

Build or update the full-body search index. This indexes the complete Markdown
content of every page, enabling deep search across discussions, code examples,
and parameter descriptions.

Options:
  --full               Rebuild the entire index from scratch
  --json               Output results as JSON

Run this once after syncing, then incrementally after updates.
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
  --json               Output results as JSON
`.trim(),

  status: `
Usage: apple-docs status [options]

Show corpus statistics and health.

Options:
  --json               Output raw JSON
`.trim(),
}

export function showHelp(command) {
  if (command && COMMANDS[command]) {
    console.log(COMMANDS[command])
  } else {
    console.log(GLOBAL)
  }
}
