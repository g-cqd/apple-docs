/**
 * First-boot helper: wait for an in-progress `apple-docs sync` to
 * complete, then bootstrap the web + mcp daemons against the fresh
 * corpus and smoke-test. Ports ops/bin/watch-sync-and-start-web.sh.
 *
 * Inputs:
 *   SYNC_PID env var — pid of the sync process to wait on (required).
 *
 * Flow:
 *   1. Poll `kill -0 <SYNC_PID>` until the process exits (every 15 s).
 *   2. Bootstrap web (idempotent), kickstart web (rebuild caches),
 *      kickstart mcp (drop LRU).
 *   3. Wait up to 20 s for local web /healthz.
 *   4. Run the smoke-test battery (informational; doesn't gate).
 *
 * Logs go to <opsDir>/logs/watch-sync-and-start-web.log (matches the
 * filename the bash version wrote so existing log tailers still pick
 * it up).
 */

import { join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { bootstrapOrKick, kickstart } from '../lib/launchctl.js'
import { probe } from '../lib/http-probe.js'
import runSmokeTest from './smoke-test.js'

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any,
 *           deps?: { kill?: (pid: number, sig: number) => void,
 *                    sleep?: (ms: number) => Promise<void>,
 *                    bootstrap?: typeof bootstrapOrKick,
 *                    kickstart?: typeof kickstart,
 *                    fetcher?: typeof fetch,
 *                    smokeTest?: typeof runSmokeTest } }} ctx
 */
export default async function runWatchSync(ctx = {}) {
  const procEnv = ctx.env ?? process.env
  const pidStr = procEnv.SYNC_PID
  const pid = Number.parseInt(pidStr ?? '', 10)
  if (!Number.isFinite(pid) || pid <= 0) {
    const log = ctx.logger ?? createLogger()
    log.error('watch-sync: set SYNC_PID=<pid of apple-docs sync> before invoking')
    return 64
  }

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const logPath = join(env.opsDir, 'logs', 'watch-sync-and-start-web.log')
  const logger = ctx.logger ?? createLogger({ logPath })

  const deps = {
    kill: ctx.deps?.kill ?? defaultKill,
    sleep: ctx.deps?.sleep ?? defaultSleep,
    bootstrap: ctx.deps?.bootstrap ?? bootstrapOrKick,
    kickstart: ctx.deps?.kickstart ?? kickstart,
    fetcher: ctx.deps?.fetcher ?? fetch,
    smokeTest: ctx.deps?.smokeTest ?? runSmokeTest,
  }

  logger.say(`watcher started, waiting for PID ${pid}`)
  // Poll signal 0 to detect process exit. We don't `wait()` because
  // the sync was launched detached (it's not our child).
  let alive = true
  while (alive) {
    alive = deps.kill(pid, 0)
    if (alive) await deps.sleep(15_000)
  }
  logger.say('sync process exited')

  // Bootstrap web (or noop) then kickstart to ensure the fresh corpus
  // is picked up. We kickstart even if bootstrap reported success
  // because the bash version did — start order was "bootstrap, then
  // kickstart to force a fresh cache" and the cache rebuild was the
  // whole point of this helper.
  const labels = env.labels
  const plistFor = (label) => `/Library/LaunchDaemons/${label}.plist`

  try {
    await deps.bootstrap(labels.web, plistFor(labels.web), { logger })
  } catch (err) {
    logger.say(`(bootstrap web failed: ${err?.message ?? err} — will kickstart anyway)`)
  }
  logger.say('kickstarting web daemon to rebuild caches from completed corpus')
  try {
    await deps.kickstart(labels.web)
  } catch (err) {
    logger.error(`could not kickstart web daemon: ${err?.message ?? err}`)
    return 1
  }

  logger.say('kickstarting MCP daemon to drop stale LRU entries post-corpus-refresh')
  try {
    await deps.kickstart(labels.mcp)
  } catch (err) {
    logger.warn(`could not kickstart mcp daemon: ${err?.message ?? err}`)
  }

  // Wait up to 20 s for the new web process to come online.
  for (let attempt = 1; attempt <= 10; attempt++) {
    await deps.sleep(2_000)
    const r = await probe(`http://127.0.0.1:${env.vars.WEB_PORT}/`, {
      deadlineMs: 3_000,
      deps: { fetcher: deps.fetcher },
    })
    if (r.status === 200) {
      logger.say(`local web responding 200 (attempt ${attempt})`)
      break
    }
    logger.say(`waiting for web daemon (attempt ${attempt}, got ${r.status ?? r.outcome})...`)
  }

  logger.say('running smoke-test')
  try {
    await deps.smokeTest({ envLoader: () => env, logger, deps: { fetcher: deps.fetcher } })
  } catch {
    // smoke-test is informational; don't fail the watcher on it
  }
  logger.say('watcher done')
  return 0
}

function defaultKill(pid, sig) {
  try { process.kill(pid, sig); return true } catch { return false }
}

function defaultSleep(ms) { return new Promise(r => setTimeout(r, ms)) }
