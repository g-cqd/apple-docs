#!/usr/bin/env bun
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from './src/cli/parser.js'
import { showHelp } from './src/cli/help.js'
import { formatSearchResults, formatSearchRead, formatLookup, formatFrameworks, formatBrowse, formatStatus, formatSync, formatUpdate, formatConsolidate, formatIndex, formatSnapshot, formatSetup, formatStorageStats, formatStorageGc, formatStorageMaterialize, formatStorageProfile, formatWebBuild, formatWebDeploy, formatTaxonomy } from './src/cli/formatter.js'
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

const { command, subcommand, positional, flags } = parseArgs(process.argv)

/**
 * Throttled TTY progress reporter for `web build`. Emits at most once per
 * second and replaces the line with a carriage return; computes a smoothed
 * rate from a sliding window so a paused-but-resumable build doesn't quote
 * a bogus 0/s instantaneous rate.
 */
function makeProgressReporter() {
  const startTs = Date.now()
  let lastFlush = 0
  const window = []
  const WINDOW_MS = 5_000

  const fmt = (n) => n.toLocaleString('en-US')
  const fmtBytes = (b) => {
    if (b > 1e9) return `${(b / 1e9).toFixed(1)}G`
    if (b > 1e6) return `${(b / 1e6).toFixed(0)}M`
    return `${(b / 1e3).toFixed(0)}K`
  }
  const fmtDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`
    const s = Math.round(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    return `${m}m${String(s % 60).padStart(2, '0')}s`
  }

  function reporter(p) {
    const now = Date.now()
    window.push({ t: now, n: p.total })
    while (window.length > 1 && now - window[0].t > WINDOW_MS) window.shift()

    if (now - lastFlush < 1000) return
    lastFlush = now

    const oldest = window[0]
    const elapsedSec = Math.max(1e-3, (now - oldest.t) / 1000)
    const rate = (p.total - oldest.n) / elapsedSec
    const elapsedTotal = now - startTs
    const line = (
      `[${fmtDuration(elapsedTotal)}] ` +
      `${fmt(p.built)} built, ${fmt(p.skipped)} skipped, ${fmt(p.failed)} failed ` +
      `· ${rate.toFixed(0)}/s ` +
      `· RSS=${fmtBytes(p.rss)}`
    )
    process.stdout.write(`\r${line.padEnd(process.stdout.columns ?? 80, ' ').slice(0, (process.stdout.columns ?? 80) - 1)}`)
  }
  reporter.done = () => {
    if (lastFlush > 0) process.stdout.write('\n')
  }
  return reporter
}


if (flags.help || !command) {
  showHelp(command)
  process.exit(flags.help ? 0 : (command ? 0 : 1))
}

const dataDir = flags.home ?? process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const logLevel = flags.verbose ? 'debug' : 'info'
const logger = createLogger(logLevel)
const isCrawlCommand = command === 'sync' || command === 'update'
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

// Graceful shutdown
const cleanup = () => { try { db.close() } catch {} }
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// Commands that hit the GitHub API benefit from local credentials.
if (command === 'sync' || command === 'update' || command === 'setup') {
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
      const roots = flags.roots ? flags.roots.split(',').map(s => s.trim()) : undefined
      const sources = flags.sources ? flags.sources.split(',').map(s => s.trim()) : undefined
      const concurrency = flags.concurrency ? Number.parseInt(flags.concurrency, 10) : undefined
      const parallel = flags.parallel ? Number.parseInt(flags.parallel, 10) : undefined
      result = await sync({ roots, sources, full: !!flags.full, retryFailed: !!flags['retry-failed'], concurrency, parallel, indexBody: !!flags.index }, ctx)
      formatter = formatSync
      break
    }

    case 'update': {
      const { update } = await import('./src/commands/update.js')
      const roots = flags.roots ? flags.roots.split(',').map(s => s.trim()) : undefined
      const sources = flags.sources ? flags.sources.split(',').map(s => s.trim()) : undefined
      const concurrency = flags.concurrency ? Number.parseInt(flags.concurrency, 10) : undefined
      const parallel = flags.parallel ? Number.parseInt(flags.parallel, 10) : undefined
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
      if (subcommand === 'rebuild-trigram') {
        const { rebuildTrigram } = await import('./src/commands/index-rebuild.js')
        result = await rebuildTrigram({}, ctx)
        formatter = formatIndex
      } else if (subcommand === 'rebuild-body') {
        const { rebuildBody } = await import('./src/commands/index-rebuild.js')
        result = await rebuildBody({ full: !!flags.full }, ctx)
        formatter = formatIndex
      } else {
        const { index: indexCmd } = await import('./src/commands/index.js')
        result = await indexCmd({ full: !!flags.full }, ctx)
        formatter = formatIndex
      }
      break
    }

    case 'doctor': {
      const { consolidate } = await import('./src/commands/consolidate.js')
      result = await consolidate({ dryRun: !!flags['dry-run'], minify: !!flags.minify, indexBody: !!flags.index, verify: !!flags.verify }, ctx)
      formatter = formatConsolidate
      break
    }

    case 'mcp': {
      switch (subcommand) {
        case 'start': {
          const { startServer } = await import('./src/mcp/server.js')
          const handle = await startServer(ctx)
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
          const heavyConcurrency = flags.concurrency != null
            ? Number.parseInt(flags.concurrency, 10) || undefined
            : undefined
          const heavyQueue = flags.queue != null
            ? Number.parseInt(flags.queue, 10)
            : undefined
          const handle = await startHttpServer(
            { port, host, allowedOrigins },
            ctx,
            {
              ...(heavyConcurrency != null ? { heavyConcurrency } : {}),
              ...(heavyQueue != null && Number.isFinite(heavyQueue) ? { heavyQueue } : {}),
            },
          )
          console.log(`MCP HTTP server running at ${handle.url}`)
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

    case 'snapshot': {
      switch (subcommand) {
        case 'build': {
          const { snapshotBuild } = await import('./src/commands/snapshot.js')
          result = await snapshotBuild({
            tier: flags.tier ?? 'full',
            out: flags.out ?? 'dist',
            tag: flags.tag,
          }, ctx)
          formatter = formatSnapshot
          break
        }
        default:
          showHelp('snapshot')
          process.exit(subcommand ? 1 : 0)
      }
      break
    }

    case 'setup': {
      const { setup: setupCmd } = await import('./src/commands/setup.js')
      result = await setupCmd({
        tier: flags.tier ?? 'full',
        force: !!flags.force,
        downgrade: !!flags.downgrade,
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
          const onProgress = process.stdout.isTTY ? makeProgressReporter() : null
          result = await buildStaticSite({
            out: flags.out,
            baseUrl: flags['base-url'],
            siteName: flags['site-name'],
            incremental: !!flags.incremental,
            full: !!flags.full,
            frameworks,
            concurrency,
            onProgress,
          }, ctx)
          if (onProgress) onProgress.done()
          formatter = formatWebBuild
          break
        }
        case 'serve': {
          const { startDevServer } = await import('./src/web/serve.js')
          const info = await startDevServer({ port: flags.port ? Number.parseInt(flags.port) : 3000, baseUrl: flags['base-url'] }, ctx)
          console.log(`Dev server running at ${info.url}`)
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

    case 'storage': {
      switch (subcommand) {
        case 'stats': {
          const { storageStats } = await import('./src/commands/storage.js')
          result = await storageStats({}, ctx)
          formatter = formatStorageStats
          break
        }
        case 'gc': {
          const { storageGc } = await import('./src/commands/storage.js')
          const drop = flags.drop ? flags.drop.split(',').map(s => s.trim()) : []
          const olderThan = flags['older-than'] ? Number.parseInt(flags['older-than'], 10) : undefined
          result = await storageGc({ drop, olderThan, vacuum: !flags['no-vacuum'] }, ctx)
          formatter = formatStorageGc
          break
        }
        case 'materialize': {
          const { storageMaterialize } = await import('./src/commands/storage.js')
          const format = positional[0] || 'markdown'
          const roots = flags.roots ? flags.roots.split(',').map(s => s.trim()) : undefined
          result = await storageMaterialize({ format, roots }, ctx)
          formatter = formatStorageMaterialize
          break
        }
        case 'profile': {
          const { getProfile, setProfile, getProfileConfig, listProfiles } = await import('./src/storage/profiles.js')
          if (positional[0] === 'set' && positional[1]) {
            setProfile(db, positional[1])
            result = { action: 'set', name: positional[1], config: getProfileConfig(positional[1]) }
          } else if (positional[0] === 'list') {
            result = { action: 'list', profiles: listProfiles() }
          } else {
            const name = getProfile(db)
            result = { action: 'get', name, config: getProfileConfig(name) }
          }
          formatter = formatStorageProfile
          break
        }
        default:
          showHelp('storage')
          process.exit(subcommand ? 1 : 0)
      }
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
