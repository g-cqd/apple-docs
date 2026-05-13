/**
 * Caddy proxy verbs: run / validate / reload / status. Folds four
 * separate bash scripts (run-proxy, proxy-validate, proxy-reload,
 * proxy-status) into one subcommand.
 *
 * CLI shape:
 *   ops/cli.js proxy run         caddy run --config Caddyfile
 *   ops/cli.js proxy validate    caddy validate --config Caddyfile
 *   ops/cli.js proxy reload      caddy reload --config Caddyfile --address <admin>
 *   ops/cli.js proxy status      curl http://<admin>/reverse_proxy/upstreams
 *
 * All verbs read Caddyfile from <opsDir>/caddy/Caddyfile, refuse to
 * proceed when it doesn't exist (render-all must run first), and use
 * the CADDY_ADMIN_ADDR env var for admin-API verbs.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { probe } from '../lib/http-probe.js'
import { runCmd } from '../lib/run-cmd.js'

const PATH_WITH_BREW =
  '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

const VERBS = new Set(['run', 'validate', 'reload', 'status'])

/**
 * @param {{ args?: string[], envLoader?: () => any, logger?: any,
 *           deps?: { runCmd?: Function, fetcher?: typeof fetch,
 *                    which?: (bin: string) => string | null,
 *                    exists?: (p: string) => boolean } }} ctx
 */
export default async function runProxy(ctx = {}) {
  const args = ctx.args ?? []
  const logger = ctx.logger ?? createLogger()
  if (args.length < 1 || !VERBS.has(args[0])) {
    logger.error(`proxy: usage: proxy <run|validate|reload|status>`)
    return 64
  }
  const verb = args[0]
  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const configPath = join(env.opsDir, 'caddy', 'Caddyfile')
  const adminAddr = env.vars.CADDY_ADMIN_ADDRESS || env.vars.CADDY_ADMIN_ADDR

  const exists = ctx.deps?.exists ?? defaultExists
  const which = ctx.deps?.which ?? defaultWhich
  const runner = ctx.deps?.runCmd ?? runCmd
  const fetcher = ctx.deps?.fetcher ?? fetch

  if (verb !== 'status' && !exists(configPath)) {
    logger.error(`proxy: ${configPath} not found. Run \`ops/cli.js render-all\` first.`)
    return 66
  }

  let caddyBin
  if (verb !== 'status') {
    caddyBin = which('caddy', PATH_WITH_BREW)
    if (!caddyBin) {
      logger.error('proxy: `caddy` not found in PATH')
      return 127
    }
  }

  const childEnv = { ...process.env, PATH: PATH_WITH_BREW }

  if (verb === 'validate') {
    return await runCaddy(runner, logger, [caddyBin, 'validate', '--config', configPath, '--adapter', 'caddyfile'], { env: childEnv })
  }
  if (verb === 'run') {
    return await superviseCaddy(
      [caddyBin, 'run', '--config', configPath, '--adapter', 'caddyfile'],
      { env: childEnv, logger, spawn: ctx.deps?.spawn ?? Bun.spawn },
    )
  }
  if (verb === 'reload') {
    // Validate first so we don't try to apply a broken config — the
    // bash version did this too.
    const v = await runCaddy(runner, logger, [caddyBin, 'validate', '--config', configPath, '--adapter', 'caddyfile'], { env: childEnv })
    if (v !== 0) return v
    return await runCaddy(
      runner, logger,
      [caddyBin, 'reload', '--config', configPath, '--adapter', 'caddyfile', '--address', adminAddr],
      { env: childEnv },
    )
  }
  // status
  logger.say('== Caddy upstream status ==')
  const r = await probe(`http://${adminAddr}/reverse_proxy/upstreams`, {
    deadlineMs: 5_000,
    deps: { fetcher },
  })
  if (!r.ok) {
    logger.error(`proxy: could not query Caddy admin API at ${adminAddr} (${r.outcome} ${r.status ?? ''})`)
    return 1
  }
  logger.say(r.body || '<empty body>')
  return 0
}

async function runCaddy(runner, logger, args, opts) {
  logger.say(`$ ${args.join(' ')}`)
  try {
    const r = await runner(args, opts)
    if (r.stdout) logger.say(r.stdout.trimEnd())
    if (r.stderr) logger.say(r.stderr.trimEnd())
    return r.exitCode === 0 ? 0 : 1
  } catch (err) {
    logger.error(err?.message ?? String(err))
    return 1
  }
}

/**
 * Long-running caddy supervision. Bypasses runCmd because runCmd's
 * default 60s deadline would SIGKILL caddy after the timer fires — for
 * the `run` verb we want bun to wait on caddy indefinitely and let
 * launchd manage restarts. Forwards SIGTERM/SIGINT/SIGHUP so launchd's
 * "stop the daemon" path (or `service stop proxy`) drains caddy
 * cleanly rather than killing it via parent death.
 */
async function superviseCaddy(args, { env, logger, spawn }) {
  logger.say(`$ ${args.join(' ')}`)
  const proc = spawn(args, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env })
  const forward = (sig) => { try { proc.kill(sig) } catch { /* already gone */ } }
  const sigs = ['SIGTERM', 'SIGINT', 'SIGHUP']
  for (const s of sigs) process.on(s, () => forward(s))
  try {
    const code = await proc.exited
    return typeof code === 'number' ? code : 0
  } finally {
    for (const s of sigs) process.removeAllListeners(s)
  }
}

function defaultExists(p) { return existsSync(p) }

function defaultWhich(bin, pathWithBrew) {
  const candidates = pathWithBrew.split(':')
  for (const dir of candidates) {
    const candidate = join(dir, bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}
