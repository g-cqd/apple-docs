#!/usr/bin/env bun
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from './src/cli/parser.js'
import { showHelp } from './src/cli/help.js'
import { formatSearchResults, formatSearchRead, formatLookup, formatFrameworks, formatBrowse, formatStatus, formatSync, formatSetup, formatWebBuild, formatWebDeploy, formatTaxonomy } from './src/cli/formatter.js'
import { DocsDatabase } from './src/storage/database.js'
import { createLogger } from './src/lib/logger.js'
import { createHostBucketedLimiter } from './src/lib/per-host-rate-limiter.js'

import { search } from './src/commands/search.js'
import { lookup } from './src/commands/lookup.js'
import { frameworks } from './src/commands/frameworks.js'
import { browse } from './src/commands/browse.js'
import { sync } from './src/commands/sync.js'
import { status } from './src/commands/status.js'
import { taxonomy } from './src/commands/taxonomy.js'
import { paginateCliContent } from './src/cli/paginate.js'
import { dispatchMaintenance, MAINTENANCE_COMMANDS } from './src/cli/maintenance.js'
import { makeProgressReporter } from './src/cli/progress-reporter.js'
import { installCrashHandlers, lifecycle } from './src/lib/lifecycle.js'

const { command, subcommand, positional, flags } = parseArgs(process.argv)

function parseOptionalInt(value) {
  if (value == null) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : undefined
}

// D.2: metrics-port/host on `mcp serve` + `web serve`. Spread into opts.
function metricsOpts(flags) {
  const p = parseOptionalInt(flags['metrics-port'])
  return { ...(p != null && { metricsPort: p }), ...(flags['metrics-host'] && { metricsHost: flags['metrics-host'] }) }
}

if (flags.help || !command) {
  showHelp(command)
  process.exit(flags.help ? 0 : (command ? 0 : 1))
}

const dataDir = flags.home ?? process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const logLevel = flags.verbose ? 'debug' : 'info'
const logger = createLogger(logLevel)
const isCrawlCommand = command === 'sync'
const defaultRate = isCrawlCommand ? '500' : '5'
const defaultBurst = isCrawlCommand ? '500' : '2'
const rate = Number.parseInt(flags.rate ?? process.env.APPLE_DOCS_RATE ?? defaultRate, 10)
const burst = Math.max(rate, Number.parseInt(process.env.APPLE_DOCS_BURST ?? defaultBurst, 10))
const rateLimiter = createHostBucketedLimiter({
  defaults: { rate, burst },
  primary: { rate, burst },
})

const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
const ctx = { db, dataDir, rateLimiter, logger }

// P1.3: signal-driven graceful drain. Each long-running server registers its
// own stop() with the lifecycle; the DB is the last thing torn down so any
// drain step that touches it (WAL checkpoint, etc.) runs first.
installCrashHandlers({ logger })
lifecycle.register({ name: 'db', stop: () => db.close() })
const cleanup = () => { try { db.close() } catch {} }

// Commands that hit the GitHub API benefit from local credentials.
if (command === 'sync' || command === 'setup') {
  const { resolveGitHubAuth } = await import('./src/lib/git-auth-resolve.js')
  await resolveGitHubAuth({ flags, env: process.env, logger })
}

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
        limit: flags.limit ? Number.parseInt(flags.limit) : undefined,
        fuzzy: !flags['no-fuzzy'],
        noDeep: !!flags['no-deep'],
        noEager: !!flags['no-eager'],
        language: flags.language,
        platform: flags.platform,
        minIos: flags['min-ios'],
        minMacos: flags['min-macos'],
        minWatchos: flags['min-watchos'],
        minTvos: flags['min-tvos'],
        minVisionos: flags['min-visionos'],
        year: flags.year ? Number.parseInt(flags.year) : undefined,
        track: flags.track,
        deprecated: flags.deprecated,
      }, ctx)
      if (flags.read) {
        if (result.results.length === 0) {
          formatter = formatSearchResults
        } else {
          const hit = result.results[0]
          const maxChars = flags['max-chars'] ? Number.parseInt(flags['max-chars'], 10) : null
          const pageNum = flags.page ? Number.parseInt(flags.page, 10) : 1
          const readPage = await lookup({ path: hit.path }, ctx)
          if (maxChars != null && readPage.found && readPage.content) {
            result = { hit, page: paginateCliContent(readPage, maxChars, pageNum) }
          } else {
            result = { hit, page: readPage }
          }
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
      if (flags.section) opts.section = flags.section
      const maxChars = flags['max-chars'] ? Number.parseInt(flags['max-chars'], 10) : null
      const pageNum = flags.page ? Number.parseInt(flags.page, 10) : 1
      result = await lookup(opts, ctx)
      if (maxChars != null && result.found && result.content) {
        result = paginateCliContent(result, maxChars, pageNum)
      }
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
      result = await browse({ framework: fw, path: flags.path, limit: flags.limit ? Number.parseInt(flags.limit) : undefined }, ctx)
      formatter = formatBrowse
      break
    }

    case 'kinds': {
      result = await taxonomy({ field: flags.field }, ctx)
      formatter = formatTaxonomy
      break
    }

    case 'sync': {
      // A25: --aggressive opts back into the legacy 500-in-flight default.
      // Without it, sync caps at 100 concurrent fetches (Apple's per-IP
      // limit absorbs that comfortably; 500 was an unfriendly default).
      result = await sync({ full: !!flags.full, aggressive: !!flags.aggressive }, ctx)
      formatter = formatSync
      break
    }

    case 'status': {
      result = await status({}, ctx)
      formatter = formatStatus
      break
    }

    case 'mcp': {
      switch (subcommand) {
        case 'start': {
          const { startServer } = await import('./src/mcp/server.js')
          const handle = await startServer(ctx)
          lifecycle.register({ name: 'mcp-stdio', stop: (deadlineMs) => handle.close(deadlineMs) })
          await handle.closed
          break
        }
        case 'serve': {
          const { startHttpServer } = await import('./src/mcp/http-server.js')
          const port = flags.port ? Number.parseInt(flags.port, 10) : 3031
          const host = flags.host ?? '127.0.0.1'
          const allowedOrigins = flags['allow-origin']
            ? String(flags['allow-origin']).split(',').map(s => s.trim()).filter(Boolean)
            : []
          const heavyConcurrency = parseOptionalInt(flags.concurrency) || undefined
          const heavyQueue = parseOptionalInt(flags.queue)
          const handle = await startHttpServer(
            { port, host, allowedOrigins, ...metricsOpts(flags) },
            ctx,
            {
              ...(heavyConcurrency != null ? { heavyConcurrency } : {}),
              ...(heavyQueue != null ? { heavyQueue } : {}),
            },
          )
          lifecycle.register({ name: 'mcp-http', stop: (deadlineMs) => handle.close(deadlineMs) })
          console.log(`MCP HTTP server running at ${handle.url}`)
          if (handle.metricsUrl) console.log(`Metrics endpoint at ${handle.metricsUrl}`)
          console.log('Press Ctrl+C to stop')
          // Keep process alive — process signal handlers at the top of this file
          // close the DB; Bun releases sockets on exit.
          await new Promise(() => {})
          break
        }
        case 'install': {
          if (flags.http) {
            const endpoint = typeof flags.http === 'string'
              ? flags.http
              : 'https://apple-docs-mcp.example.com/mcp'
            console.log('MCP (Streamable HTTP) client configuration for apple-docs:\n')
            console.log(JSON.stringify({
              mcpServers: {
                'apple-docs': {
                  transport: { type: 'streamable-http', url: endpoint },
                },
              },
            }, null, 2))
            console.log('\nFallback for clients without native Streamable HTTP support (via mcp-remote):')
            console.log(JSON.stringify({
              mcpServers: {
                'apple-docs': {
                  command: 'npx',
                  args: ['mcp-remote', endpoint],
                },
              },
            }, null, 2))
            process.exit(0)
            break
          }
          console.log("MCP server configuration for apple-docs:\n")
          console.log(JSON.stringify({
            mcpServers: {
              'apple-docs': {
                command: 'apple-docs',
                args: ['mcp', 'start'],
                env: { APPLE_DOCS_HOME: dataDir },
              },
            },
          }, null, 2))
          console.log("\nAlternatively, use the backward-compatible binary:")
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

    case 'setup': {
      // Lite/standard tiers were removed in G.1; the only snapshot
      // shape is `full`. Reject the obsolete flags loudly so legacy
      // automation gets a clear error pointing to the simplification.
      if (flags.tier && flags.tier !== 'full') {
        console.error(`apple-docs setup: --tier ${flags.tier} is no longer supported (G.1). Every snapshot now ships the full corpus; drop the --tier flag.`)
        process.exit(2)
      }
      if (flags.downgrade) {
        console.error('apple-docs setup: --downgrade is no longer meaningful — there is only one snapshot shape (G.1).')
        process.exit(2)
      }
      const { setup: setupCmd } = await import('./src/commands/setup.js')
      result = await setupCmd({
        force: !!flags.force,
        skipResources: !!flags['skip-resources'],
      }, ctx)
      formatter = formatSetup
      break
    }

    case 'web': {
      switch (subcommand) {
        case 'build': {
          const { buildStaticSite } = await import('./src/web/build.js')
          const frameworks = typeof flags.frameworks === 'string' && flags.frameworks.length > 0
            ? flags.frameworks.split(',').map(s => s.trim()).filter(Boolean)
            : undefined
          const concurrency = flags.concurrency ? Math.max(1, Number.parseInt(flags.concurrency, 10) || 0) : undefined
          const workers = flags.workers ? Math.max(1, Number.parseInt(flags.workers, 10) || 0) : undefined
          // Suppress the per-doc TTY rotor when this Bun is itself a build
          // worker — its stdout is inherited by the orchestrator and the
          // rotor lines from N workers would otherwise overwrite each other.
          const isWorker = process.env.APPLE_DOCS_BUILD_WORKER === '1'
          const onProgress = (process.stdout.isTTY && !isWorker) ? makeProgressReporter() : null
          result = await buildStaticSite({
            out: flags.out,
            baseUrl: flags['base-url'],
            siteName: flags['site-name'],
            incremental: !!flags.incremental,
            full: !!flags.full,
            skipDocs: !!flags['skip-docs'],
            frameworks,
            concurrency,
            workers,
            onProgress,
            json: !!flags.json,
          }, ctx)
          if (onProgress) onProgress.done()
          formatter = formatWebBuild
          break
        }
        case 'serve': {
          const { startDevServer } = await import('./src/web/serve.js')
          const info = await startDevServer({
            port: flags.port ? Number.parseInt(flags.port) : 3000,
            baseUrl: flags['base-url'],
            ...metricsOpts(flags),
          }, ctx)
          lifecycle.register({ name: 'web', stop: (deadlineMs) => info.close(deadlineMs) })
          console.log(`Dev server running at ${info.url}`)
          if (info.metricsUrl) console.log(`Metrics endpoint at ${info.metricsUrl}`)
          console.log('Press Ctrl+C to stop')
          // Keep process alive
          await new Promise(() => {})
          break
        }
        case 'deploy': {
          const { webDeploy } = await import('./src/commands/web-deploy.js')
          result = webDeploy({ platform: positional[0] ?? 'github-pages' })
          formatter = formatWebDeploy
          break
        }
        default:
          showHelp('web')
          process.exit(subcommand ? 1 : 0)
      }
      break
    }

    default:
      if (MAINTENANCE_COMMANDS.includes(command)) {
        const dispatched = await dispatchMaintenance(command, subcommand, positional, flags, ctx)
        if (dispatched) ({ result, formatter } = dispatched)
        break
      }
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
