# Command Namespace Redesign

## Resolving the `serve` semantic conflict between MCP and static website

---

## 1. Problem

We want two distinct server modes:
1. **MCP server** -- JSON-RPC over stdio for AI assistants (Claude, Codex, Cursor)
2. **Web server** -- HTTP server for the static documentation website

Both could naturally use `serve` as their verb, creating a conflict. We need a clear, intuitive namespace that avoids ambiguity.

---

## 2. Current State

| Entry Point | What It Does | How It's Invoked |
|---|---|---|
| `cli.js` | CLI commands (search, sync, etc.) | `apple-docs <command>` |
| `index.js` | MCP stdio server | `apple-docs-mcp` binary, or `bun run index.js` |

The MCP server is started either:
- Directly as the `apple-docs-mcp` binary (for MCP client configuration)
- Via `bun run index.js` / `bun run start`

There is no `serve` command currently.

---

## 3. Design Principles

1. **`serve` should mean HTTP.** Developers universally associate `serve` with "start an HTTP server." `next serve`, `hugo serve`, `jekyll serve`, `vite serve`.
2. **MCP should be a subcommand namespace.** `apple-docs mcp start` is clearer than a bare `serve` for a protocol that most developers haven't encountered.
3. **Backward compatibility.** The `apple-docs-mcp` binary must continue to work (existing MCP client configurations reference it).
4. **Default behavior without arguments.** Running `apple-docs` with no command should show help, not start a server. This is the current behavior and should be preserved.

---

## 4. Proposed Namespace

### Primary Commands

```
apple-docs                              # Show help
apple-docs setup                        # Download pre-built databases
apple-docs sync [options]               # Sync documentation sources
apple-docs update [options]             # Incremental update (ETag check)
apple-docs search <query> [options]     # Search documentation
apple-docs read <path|symbol> [options] # Read a specific document
apple-docs browse <framework> [options] # Browse topic tree
apple-docs frameworks [options]         # List documentation roots
apple-docs index [options]              # Build full-body search index
apple-docs doctor [options]             # Health check and repair
apple-docs status [options]             # Corpus statistics
```

### MCP Subcommands

```
apple-docs mcp start                    # Start MCP stdio server
apple-docs mcp install                  # Print setup instructions for AI clients
apple-docs mcp config                   # Show current MCP configuration
```

### Web Subcommands

```
apple-docs serve                        # Start HTTP dev server (localhost:3000)
apple-docs serve --port 8080            # Custom port
apple-docs serve --build                # Build static site
apple-docs serve --build --out ./site   # Custom output directory
```

### Export / Storage Management

```
apple-docs export --format markdown     # Generate markdown files from JSON
apple-docs export --format json-only    # Remove markdown, keep JSON
apple-docs export --format markdown-only # Generate markdown, remove JSON
apple-docs cleanup [--raw-json] [--markdown] [--all]  # Disk space cleanup
```

---

## 5. Implementation

### 5.1 CLI Router Update

```javascript
// cli.js (updated switch)
switch (command) {
  case 'search':    /* ... existing ... */ break
  case 'read':      /* ... existing ... */ break
  case 'frameworks':/* ... existing ... */ break
  case 'browse':    /* ... existing ... */ break
  case 'sync':      /* ... existing ... */ break
  case 'update':    /* ... existing ... */ break
  case 'status':    /* ... existing ... */ break
  case 'index':     /* ... existing ... */ break
  case 'doctor':    /* ... existing ... */ break

  // NEW commands
  case 'setup':     /* ... download pre-built DB ... */ break
  case 'export':    /* ... format conversion ... */ break
  case 'cleanup':   /* ... disk space management ... */ break

  // MCP subcommand
  case 'mcp': {
    const subcommand = positional[0]
    switch (subcommand) {
      case 'start':
        // Start MCP server (delegates to index.js logic)
        const { startServer } = await import('./src/mcp/server.js')
        await startServer(ctx)
        break
      case 'install':
        // Print setup instructions
        printMcpSetupInstructions()
        break
      case 'config':
        // Show MCP config
        showMcpConfig(ctx)
        break
      default:
        // Bare 'apple-docs mcp' with no subcommand also starts the server
        // (backward compatible: some configs may use 'apple-docs mcp')
        const { startServer: start } = await import('./src/mcp/server.js')
        await start(ctx)
    }
    break
  }

  // Web server
  case 'serve': {
    if (flags.build) {
      const { buildStaticSite } = await import('./src/web/build.js')
      await buildStaticSite(ctx, flags.out || join(ctx.dataDir, 'site'))
    } else {
      const { startWebServer } = await import('./src/web/server.js')
      const server = startWebServer(ctx, { port: flags.port ? parseInt(flags.port) : 3000 })
      console.log(`Documentation server running at http://localhost:${server.port}`)
    }
    break
  }
}
```

### 5.2 MCP Entry Point (Backward Compatible)

The `apple-docs-mcp` binary must keep working:

```javascript
// mcp-entry.js (NEW - replaces index.js as MCP entry point)
#!/usr/bin/env bun
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DocsDatabase } from './src/storage/database.js'
import { createLogger } from './src/lib/logger.js'
import { startServer } from './src/mcp/server.js'

const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const logger = createLogger(process.env.APPLE_DOCS_LOG_LEVEL ?? 'info')
const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))

const ctx = { db, dataDir, logger }

const cleanup = () => { try { db.close() } catch {} }
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

await startServer(ctx)
```

### 5.3 Package.json Bin Entries

```json
{
  "bin": {
    "apple-docs": "./cli.js",
    "apple-docs-mcp": "./mcp-entry.js"
  }
}
```

Both entries are maintained:
- `apple-docs` -- main CLI with all commands including `mcp start` and `serve`
- `apple-docs-mcp` -- direct MCP server (for MCP client configurations that need a simple binary)

### 5.4 MCP Install Instructions

```javascript
function printMcpSetupInstructions() {
  const mcpBin = 'apple-docs-mcp'  // or: 'apple-docs mcp start'
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')

  console.log(`
MCP Server Setup Instructions
==============================

For Claude Code / Claude Desktop:
  Add to your MCP settings:
  {
    "mcpServers": {
      "apple-docs": {
        "command": "${mcpBin}",
        "env": {
          "APPLE_DOCS_HOME": "${home}"
        }
      }
    }
  }

For Cursor:
  Settings > MCP Servers > Add:
    Name: apple-docs
    Command: ${mcpBin}

For Codex:
  Add to codex-config.json:
  {
    "mcpServers": {
      "apple-docs": {
        "command": "${mcpBin}"
      }
    }
  }

Verify:
  apple-docs mcp start   # Should output JSON-RPC on stdout
`)
}
```

---

## 6. Help Text Update

```
apple-docs - Apple Developer Documentation tools

Usage: apple-docs <command> [options]

Search & Browse:
  search <query>       Full-text search across all documentation sources
  read <path|symbol>   Fetch a specific document by path or symbol name
  browse <framework>   Explore a framework's topic tree
  frameworks           List all indexed documentation roots

Data Management:
  setup                Download pre-built databases for instant setup
  sync [options]       Discover, crawl, and index documentation sources
  update [options]     Check for and pull documentation updates
  index [options]      Build full-body search index
  doctor [options]     Diagnose and repair corpus issues
  status [options]     Show corpus statistics and disk usage

MCP Server:
  mcp start            Start MCP server (JSON-RPC over stdio)
  mcp install          Print MCP client setup instructions
  mcp config           Show current MCP configuration

Web Server:
  serve                Start documentation website on localhost
  serve --build        Build static site for deployment

Storage:
  export [options]     Convert between storage formats
  cleanup [options]    Reclaim disk space

Global Options:
  --home <path>        Data directory (default: ~/.apple-docs)
  --json               Output machine-readable JSON
  --verbose            Enable debug logging
  --help               Show help for a command
```

---

## 7. Migration Notes

### For existing users

- `apple-docs-mcp` binary continues to work unchanged
- All existing CLI commands work unchanged
- `apple-docs mcp start` is a new alias for the same functionality
- `apple-docs serve` is entirely new (no conflict)

### For MCP client configurations

No changes needed. Existing configurations using `apple-docs-mcp` as the command continue to work. New configurations can use either:
- `apple-docs-mcp` (simpler)
- `apple-docs mcp start` (more explicit)
