// Top-level `apple-docs` usage text, split out of help.js to keep that file
// under the 400-line ceiling. Per-command help lives inline in help.js.
export const GLOBAL = `
apple-docs - Apple Developer Documentation search and management

Usage: apple-docs <command> [options]

Query:
  search <query>       Search documentation by term or symbol
  read <path>          Read a specific page or symbol
  browse <framework>   Browse topic tree for a framework
  frameworks           List known documentation roots
  kinds                List taxonomy values for filters
  status               Show corpus statistics
  version              Show tool version, commit, and corpus provenance

Setup & Sync:
  setup                Download a pre-built documentation snapshot
  sync                 Refresh the entire corpus end-to-end
  consolidate          Repair failed crawl entries and re-resolve URLs

Hosting:
  mcp start            Start MCP stdio server
  mcp serve            Start MCP Streamable HTTP server
  mcp install          Show MCP client configuration
  web serve            Start local dev web server
  web build            Build static documentation site
  web deploy           Show deployment instructions

Maintenance & Build:
  snapshot build       Build a release snapshot archive (lean by default)
  storage stats        Show disk usage breakdown
  storage gc           Garbage collect cached files
  storage profile      Get or set the storage profile (on-demand vs prebuilt)
  storage materialize  Render markdown/HTML/raw-json to disk on demand
  storage compact      Shrink an install (zstd sections, contentless FTS, drop raw; --keep-raw)
  index <subcommand>   rebuild <body|trigram> | embeddings (semantic vectors)
  prune                Trim the corpus to <data-dir>/scope.json (see: prune --help)

Global options:
  --json               Output raw JSON (for scripting)
  --home <path>        Override data directory (default: ~/.apple-docs)
  --verbose            Verbose logging
  --version, -V        Show version (same as the version command)
  --help               Show help

Environment:
  APPLE_DOCS_DEBUG=1   Bypass public-output projection (raw envelopes)
`.trim()
