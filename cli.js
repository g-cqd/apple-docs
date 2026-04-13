#!/usr/bin/env bun
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from './src/cli/parser.js'
import { showHelp } from './src/cli/help.js'
import { formatSearchResults, formatSearchRead, formatLookup, formatFrameworks, formatBrowse, formatStatus, formatSync, formatUpdate, formatConsolidate, formatIndex } from './src/cli/formatter.js'
import { DocsDatabase } from './src/storage/database.js'
import { createLogger } from './src/lib/logger.js'
import { RateLimiter } from './src/lib/rate-limiter.js'

import { search } from './src/commands/search.js'
import { lookup } from './src/commands/lookup.js'
import { frameworks } from './src/commands/frameworks.js'
import { browse } from './src/commands/browse.js'
import { sync } from './src/commands/sync.js'
import { status } from './src/commands/status.js'

const { command, subcommand, positional, flags } = parseArgs(process.argv)

if (flags.help || !command) {
  showHelp(command)
  process.exit(command ? 0 : 1)
}

const dataDir = flags.home ?? process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const logLevel = flags.verbose ? 'debug' : 'info'
const logger = createLogger(logLevel)
const rate = parseInt(flags.rate ?? process.env.APPLE_DOCS_RATE ?? '5', 10)
const burst = Math.max(rate, parseInt(process.env.APPLE_DOCS_BURST ?? '2', 10))
const rateLimiter = new RateLimiter(rate, burst)

const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
const ctx = { db, dataDir, rateLimiter, logger }

// Graceful shutdown
const cleanup = () => { try { db.close() } catch {} }
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

try {
  let result
  let formatter

  switch (command) {
    case 'search': {
      const query = positional.join(' ')
      result = await search({
        query,
        framework: flags.framework,
        source: flags.source,
        kind: flags.kind,
        limit: flags.limit ? parseInt(flags.limit) : undefined,
        fuzzy: !flags['no-fuzzy'],
        noDeep: !!flags['no-deep'],
        noEager: !!flags['no-eager'],
      }, ctx)
      if (flags.read) {
        if (result.results.length === 0) {
          formatter = formatSearchResults
        } else {
          const hit = result.results[0]
          const page = await lookup({ path: hit.path }, ctx)
          result = { hit, page }
          formatter = formatSearchRead
        }
      } else {
        formatter = formatSearchResults
      }
      break
    }

    case 'read': {
      const target = positional[0]
      if (!target) { showHelp('read'); process.exit(1) }
      // If it contains '/', treat as path; otherwise as symbol name
      const opts = target.includes('/') ? { path: target } : { symbol: target, framework: flags.framework }
      result = await lookup(opts, ctx)
      formatter = formatLookup
      break
    }

    case 'frameworks': {
      result = await frameworks({ kind: flags.kind }, ctx)
      formatter = formatFrameworks
      break
    }

    case 'browse': {
      const fw = positional[0]
      if (!fw) { showHelp('browse'); process.exit(1) }
      result = await browse({ framework: fw, path: flags.path, limit: flags.limit ? parseInt(flags.limit) : undefined }, ctx)
      formatter = formatBrowse
      break
    }

    case 'sync': {
      const roots = flags.roots ? flags.roots.split(',').map(s => s.trim()) : undefined
      const sources = flags.sources ? flags.sources.split(',').map(s => s.trim()) : undefined
      const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : undefined
      const parallel = flags.parallel ? parseInt(flags.parallel, 10) : undefined
      result = await sync({ roots, sources, full: !!flags.full, retryFailed: !!flags['retry-failed'], concurrency, parallel, indexBody: !!flags.index }, ctx)
      formatter = formatSync
      break
    }

    case 'update': {
      const { update } = await import('./src/commands/update.js')
      const roots = flags.roots ? flags.roots.split(',').map(s => s.trim()) : undefined
      const sources = flags.sources ? flags.sources.split(',').map(s => s.trim()) : undefined
      const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : undefined
      const parallel = flags.parallel ? parseInt(flags.parallel, 10) : undefined
      result = await update({ roots, sources, concurrency, parallel, indexBody: !!flags.index }, ctx)
      formatter = formatUpdate
      break
    }

    case 'status': {
      result = await status({}, ctx)
      formatter = formatStatus
      break
    }

    case 'index': {
      const { index: indexCmd } = await import('./src/commands/index.js')
      result = await indexCmd({ full: !!flags.full }, ctx)
      formatter = formatIndex
      break
    }

    case 'doctor': {
      const { consolidate } = await import('./src/commands/consolidate.js')
      result = await consolidate({ dryRun: !!flags['dry-run'], minify: !!flags.minify, indexBody: !!flags.index }, ctx)
      formatter = formatConsolidate
      break
    }

    case 'mcp': {
      switch (subcommand) {
        case 'start': {
          const { startServer } = await import('./src/mcp/server.js')
          await startServer(ctx)
          process.exit(0)
          break
        }
        case 'install': {
          console.log(`MCP server configuration for apple-docs:\n`)
          console.log(JSON.stringify({
            mcpServers: {
              'apple-docs': {
                command: 'apple-docs',
                args: ['mcp', 'start'],
                env: { APPLE_DOCS_HOME: dataDir },
              },
            },
          }, null, 2))
          console.log(`\nAlternatively, use the backward-compatible binary:`)
          console.log(JSON.stringify({
            mcpServers: {
              'apple-docs': {
                command: 'apple-docs-mcp',
                env: { APPLE_DOCS_HOME: dataDir },
              },
            },
          }, null, 2))
          process.exit(0)
          break
        }
        default:
          showHelp('mcp')
          process.exit(subcommand ? 1 : 0)
      }
      break
    }

    case 'web': {
      console.log('Web commands are coming in a future release.')
      console.log('Planned: apple-docs web serve | build | deploy')
      process.exit(0)
      break
    }

    case 'storage': {
      console.log('Storage commands are coming in a future release.')
      console.log('Planned: apple-docs storage profile | stats | gc')
      process.exit(0)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }

  if (formatter && result !== undefined) {
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatter(result))
    }
  }
} catch (e) {
  logger.error(e.message, { stack: e.stack })
  if (flags.verbose) console.error(e)
  else console.error(`Error: ${e.message}`)
  process.exit(1)
} finally {
  cleanup()
}
