/**
 * `ops/cli.js service <verb> <target>` — start/stop/restart/status
 * verbs against the launchd-managed apple-docs daemons.
 *
 * Ports the matching subcommand of the bash ops/bin/apple-docs-ops
 * dispatcher. Targets accepted:
 *   proxy        Caddy front
 *   web          bun web serve
 *   mcp          bun mcp serve
 *   watchdog     dead-service watcher
 *   tunnel-web   cloudflared for web edge
 *   tunnel-mcp   cloudflared for mcp edge
 *   all          fans out across the six labels above
 *
 * Verbs:
 *   start    bootstrap-or-kickstart (idempotent)
 *   stop     bootout (no-op when already stopped)
 *   restart  alias for start (kickstart -k when loaded)
 *   status   `launchctl print system/<label>`
 *
 * For `all`, start order is dependency-aware:
 *   web → mcp → tunnel-web → tunnel-mcp → proxy → watchdog
 * Watchdog last so it doesn't observe a half-up backend; stop order
 * is reverse so the watchdog isn't trying to kick services we're
 * intentionally taking down.
 */

import { join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import {
  isLoaded,
  bootstrapOrKick,
  bootout,
  kickstart,
} from '../lib/launchctl.js'
import { runCmdAllowFailure } from '../lib/run-cmd.js'

const ORDER_START = ['web', 'mcp', 'tunnel-web', 'tunnel-mcp', 'proxy', 'watchdog']
const ORDER_STOP = [...ORDER_START].reverse()

const VERBS = new Set(['start', 'stop', 'restart', 'status'])
const TARGETS = new Set(['proxy', 'web', 'mcp', 'watchdog', 'tunnel-web', 'tunnel-mcp', 'all'])

/**
 * Resolve a target name (e.g. 'web', 'tunnel-mcp') to its
 * { label, plistPath } pair using the env's LABEL_* constants.
 *
 * @param {string} target
 * @param {{ vars: Record<string,string> }} env
 * @returns {{ label: string, plistPath: string }}
 */
export function resolveTarget(target, env) {
  const map = {
    proxy: env.vars.LABEL_PROXY,
    web: env.vars.LABEL_WEB,
    mcp: env.vars.LABEL_MCP,
    watchdog: env.vars.LABEL_WATCHDOG,
    'tunnel-web': env.vars.LABEL_TUNNEL_WEB,
    'tunnel-mcp': env.vars.LABEL_TUNNEL_MCP,
  }
  const label = map[target]
  if (!label) throw new Error(`service: unknown target "${target}"`)
  return { label, plistPath: `/Library/LaunchDaemons/${label}.plist` }
}

/**
 * Expand `target` into a sequenced list of concrete targets to act on.
 * For non-`all` targets this is just [target]; for `all` it returns
 * the start- or stop-ordered sequence.
 *
 * @param {string} target
 * @param {'start' | 'stop' | 'restart' | 'status'} verb
 */
export function expandTargets(target, verb) {
  if (target !== 'all') return [target]
  if (verb === 'stop') return [...ORDER_STOP]
  return [...ORDER_START]
}

/**
 * @param {{ args?: string[], envLoader?: () => any, logger?: any,
 *           deps?: { isLoaded?: Function, bootstrapOrKick?: Function,
 *                    bootout?: Function, kickstart?: Function,
 *                    runCmdAllowFailure?: Function } }} ctx
 */
export default async function runService(ctx = {}) {
  const args = ctx.args ?? []
  const logger = ctx.logger ?? createLogger()
  if (args.length < 2) {
    logger.error('service: usage: service <start|stop|restart|status> <target|all>')
    return 64
  }
  const [verb, target] = args
  if (!VERBS.has(verb)) {
    logger.error(`service: unknown verb "${verb}"`)
    return 64
  }
  if (!TARGETS.has(target)) {
    logger.error(`service: unknown target "${target}"`)
    return 64
  }

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const targets = expandTargets(target, verb)
  const deps = {
    isLoaded: ctx.deps?.isLoaded ?? isLoaded,
    bootstrapOrKick: ctx.deps?.bootstrapOrKick ?? bootstrapOrKick,
    bootout: ctx.deps?.bootout ?? bootout,
    kickstart: ctx.deps?.kickstart ?? kickstart,
    runCmdAllowFailure: ctx.deps?.runCmdAllowFailure ?? runCmdAllowFailure,
  }

  let failCount = 0
  for (const t of targets) {
    const { label, plistPath } = resolveTarget(t, env)
    try {
      if (verb === 'start' || verb === 'restart') {
        await doStart(t, label, plistPath, logger, deps)
      } else if (verb === 'stop') {
        await doStop(t, label, logger, deps)
      } else if (verb === 'status') {
        const ok = await doStatus(t, label, logger, deps)
        if (!ok) failCount++
      }
      if (verb !== 'status') logger.say('')
    } catch (err) {
      failCount++
      logger.error(`service ${verb} ${t}: ${err?.message ?? err}`)
    }
  }
  return failCount > 0 && verb !== 'status' ? 1 : 0
}

async function doStart(target, label, plistPath, logger, deps) {
  const loaded = await deps.isLoaded(label)
  if (loaded) {
    logger.say(`restart loaded service: ${target} (${label})`)
    await deps.kickstart(label)
  } else {
    logger.say(`bootstrap service: ${target} (${label})`)
    await deps.bootstrapOrKick(label, plistPath, { logger })
  }
}

async function doStop(target, label, logger, deps) {
  logger.say(`stop service: ${target} (${label})`)
  await deps.bootout(label)
}

async function doStatus(target, label, logger, deps) {
  const r = await deps.runCmdAllowFailure([
    '/usr/bin/sudo', '-n', '/bin/launchctl', 'print', `system/${label}`,
  ], { deadlineMs: 10_000 })
  logger.say(`${target} (${label})`)
  // Trim to a few interesting lines so a status sweep stays scannable.
  const summary = (r.stdout || r.stderr || '')
    .split('\n')
    .filter(line => /state =|pid =|last exit code =|path =/.test(line))
    .map(line => '  ' + line.trim())
    .join('\n')
  if (summary) logger.say(summary)
  else if ((r.stdout || r.stderr).trim()) logger.say('  ' + (r.stdout || r.stderr).trim().slice(0, 512))
  return r.exitCode === 0
}
