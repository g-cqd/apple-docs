/**
 * Pull-and-redeploy workflow for apple-docs. Ports ops/bin/deploy-update.sh.
 *
 * 1. Keep web/mcp serving while we pull + render + sync (the bash
 *    KEEP_SERVING_DURING_REFRESH=1 default; we honour the env override).
 * 2. git fetch + fast-forward pull (rejects diverged working trees,
 *    auto-resets working-tree noise that matches origin).
 * 3. bun install if package.json or bun.lock changed.
 * 4. render-all; compute Caddyfile hash before+after, reload caddy on
 *    drift. Warn loudly on plist drift.
 * 5. Refresh corpus: auto-detects USE_SNAPSHOT vs USE_CRAWL by comparing
 *    GH /releases/latest tag with the applied-snapshot file.
 * 6. Rebuild static site (--incremental by default; REBUILD_STATIC_FULL=1
 *    forces a full rebuild).
 * 7. cf-purge.
 * 8. Cutover: kickstart web → mcp → watchdog (the same ordering the
 *    bash version uses, with a 3s pause before watchdog so it sees fresh
 *    backends not the killed ones).
 * 9. Smoke test.
 *
 * CLI shape: ops/cli.js deploy [--full]
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CryptoHasher } from 'bun'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { fetchLatest } from '../lib/gh-release.js'
import { bootstrapOrKick, kickstart, isLoaded } from '../lib/launchctl.js'
import { runCmd, runCmdAllowFailure } from '../lib/run-cmd.js'
import runRenderAll from './render-all.js'
import runProxy from './proxy.js'
import runCfPurge from './cf-purge.js'
import runSmokeTest from './smoke-test.js'
import runPullSnapshot from './pull-snapshot.js'

const GITHUB_REPO_SLUG = 'g-cqd/apple-docs'

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any,
 *           deps?: object }} ctx
 */
export default async function runDeployUpdate(ctx = {}) {
  const argsSet = new Set(ctx.args ?? [])
  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const logger = ctx.logger ?? createLogger({ logPath: join(env.opsDir, 'logs', 'deploy-update.log') })

  const deps = ctx.deps ?? {}
  const runner = deps.runCmd ?? runCmd
  const runAllow = deps.runCmdAllowFailure ?? runCmdAllowFailure
  const fetcher = deps.fetcher ?? fetch
  const fs = deps.fs ?? defaultFs()
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  const renderAll = deps.renderAll ?? runRenderAll
  const proxyCmd = deps.proxy ?? runProxy
  const cfPurge = deps.cfPurge ?? runCfPurge
  const smokeTest = deps.smokeTest ?? runSmokeTest
  const pullSnapshot = deps.pullSnapshot ?? runPullSnapshot

  const procEnv = ctx.env ?? process.env
  const repoDir = procEnv.APPLE_DOCS_REPO ?? env.repoDir
  const keepServing = (procEnv.KEEP_SERVING_DURING_REFRESH ?? '1') === '1'
  const fullRebuild = argsSet.has('--full') || procEnv.REBUILD_STATIC_FULL === '1'

  logger.say('=== deploy-update starting ===')

  if (!fs.exists(repoDir)) {
    logger.error(`repo directory ${repoDir} does not exist`)
    return 1
  }

  // 1. Optional pre-down: bash default keeps services up, we mirror that.
  if (!keepServing) {
    for (const label of [env.labels.web, env.labels.mcp]) {
      logger.say(`stopping ${label}`)
      await runAllow([
        '/usr/bin/sudo', '-n', '/bin/launchctl', 'bootout', `system/${label}`,
      ], { deadlineMs: 15_000 })
    }
  } else {
    logger.say('keeping web + mcp online during refresh; cutover restart happens at the end')
  }

  // 2. Repo state + git pull.
  logger.say(`current HEAD: ${await git(repoDir, ['rev-parse', '--short', 'HEAD'], runAllow)}`)
  const dirty = await isDirty(repoDir, runAllow)
  if (dirty) {
    logger.say('working tree dirty — checking if changes are already on origin')
    await git(repoDir, ['fetch', 'origin', '--quiet'], runner)
    const diff = await runAllow(['/usr/bin/git', '-C', repoDir, 'diff', 'origin/main', '--'], { deadlineMs: 30_000 })
    if ((diff.stdout || '').trim().length === 0) {
      logger.say('local tree matches origin/main — resetting to drop local noise')
      await git(repoDir, ['reset', '--hard', 'HEAD'], runner)
      await git(repoDir, ['clean', '-fd', '--', 'src', 'test', 'cli.js'], runner)
    } else {
      logger.error(`local changes diverge from origin. Aborting deploy-update. Resolve: cd ${repoDir} && git status`)
      return 2
    }
  }

  await git(repoDir, ['fetch', 'origin', '--quiet'], runner)
  const preLock = await git(repoDir, ['rev-parse', 'HEAD:bun.lock'], runAllow)
  const prePkg = await git(repoDir, ['rev-parse', 'HEAD:package.json'], runAllow)
  try {
    await git(repoDir, ['pull', '--ff-only', 'origin', 'main'], runner)
  } catch (err) {
    logger.error(`git pull failed: ${err?.message ?? err}`)
    return 3
  }
  logger.say(`new HEAD: ${await git(repoDir, ['rev-parse', '--short', 'HEAD'], runAllow)}`)

  // 3. Install deps if needed.
  const postLock = await git(repoDir, ['rev-parse', 'HEAD:bun.lock'], runAllow)
  const postPkg = await git(repoDir, ['rev-parse', 'HEAD:package.json'], runAllow)
  if (preLock !== postLock || prePkg !== postPkg) {
    logger.say('package.json / bun.lock changed — running bun install')
    try {
      await runner([env.bunBin, 'install', '--frozen-lockfile'], { cwd: repoDir, deadlineMs: 5 * 60_000 })
    } catch {
      await runner([env.bunBin, 'install'], { cwd: repoDir, deadlineMs: 5 * 60_000 })
    }
  } else {
    logger.say('deps unchanged — skipping bun install')
  }

  // 4. Re-render templates, reload caddy on Caddyfile drift, warn on plist drift.
  const caddyfile = join(env.opsDir, 'caddy', 'Caddyfile')
  const preHash = sha256OfFile(fs, caddyfile)
  const rcRender = await renderAll({ args: [], envLoader: () => env, logger })
  if (rcRender !== 0) {
    logger.warn('render-all failed; continuing with stale rendered config')
  } else {
    const postHash = sha256OfFile(fs, caddyfile)
    if (preHash !== postHash) {
      logger.say('Caddyfile changed — reloading caddy')
      const rcReload = await proxyCmd({ args: ['reload'], envLoader: () => env, logger })
      if (rcReload !== 0) logger.warn('caddy reload failed')
    } else {
      logger.say('Caddyfile unchanged — skipping caddy reload')
    }
    warnOnPlistDrift(env, fs, logger)
  }

  // 5. Auto-detect snapshot vs crawl.
  const useSnapshot = await chooseRefreshMode(procEnv, env, fs, fetcher, logger)
  if (useSnapshot) {
    const rcSnap = await pullSnapshot({ env: procEnv, envLoader: () => env, logger, deps: { fetcher, runCmd: runner, runCmdAllowFailure: runAllow, sleep } })
      .catch(err => { logger.error(`pull-snapshot threw: ${err?.message ?? err}`); return 1 })
    if (rcSnap !== 0) {
      logger.warn('pull-snapshot failed; falling back to crawl-on-host refresh')
      await runner([env.bunBin, 'run', `${repoDir}/cli.js`, 'sync'], { cwd: repoDir, deadlineMs: 4 * 60 * 60_000 })
        .catch(err => logger.warn(`sync exited: ${err?.message ?? err}`))
    }
  } else {
    await runner([env.bunBin, 'run', `${repoDir}/cli.js`, 'sync'], { cwd: repoDir, deadlineMs: 4 * 60 * 60_000 })
      .catch(err => logger.warn(`sync exited: ${err?.message ?? err}`))
  }

  // 6. Rebuild static site.
  const buildArgs = [env.bunBin, 'run', `${repoDir}/cli.js`, 'web', 'build',
    fullRebuild ? '--full' : '--incremental',
    '--out', env.staticDir,
    '--base-url', `https://${env.vars.PUBLIC_WEB_HOST}`]
  try {
    await runner(buildArgs, { cwd: repoDir, deadlineMs: 60 * 60_000 })
  } catch (err) {
    if (fullRebuild) {
      logger.error(`full static build failed: ${err?.message ?? err} — keeping existing ${env.staticDir}`)
      return 4
    }
    logger.warn(`incremental static build failed: ${err?.message ?? err} — Caddy keeps the previous tree`)
  }

  // 7. cf-purge.
  await cfPurge({ env: procEnv, envLoader: () => env, logger })
    .catch(err => logger.warn(`cf-purge: ${err?.message ?? err}`))

  // 8. Cutover.
  for (const label of [env.labels.web, env.labels.mcp]) {
    await cutoverOne(label, runner, runAllow, logger)
  }
  await sleep(3_000)
  await cutoverOne(env.labels.watchdog, runner, runAllow, logger)

  // 9. Smoke.
  await sleep(3_000)
  logger.say('=== smoke tests ===')
  const rcSmoke = await smokeTest({ envLoader: () => env, logger })
  if (rcSmoke !== 0) logger.warn('one or more smoke tests failed')
  logger.say('=== deploy-update done ===')
  return 0
}

async function cutoverOne(label, runner, runAllow, logger) {
  const loaded = await isLoaded(label, { runCmd: runAllow })
  if (loaded) {
    logger.say(`kickstarting ${label} for cutover`)
    await kickstart(label, { runCmd: runner }).catch(err => logger.error(`kickstart ${label} failed: ${err?.message ?? err}`))
  } else {
    logger.say(`bootstrapping ${label}`)
    await bootstrapOrKick(label, `/Library/LaunchDaemons/${label}.plist`, {
      runCmd: runner, runCmdAllowFailure: runAllow, logger,
    }).catch(err => logger.error(`bootstrap ${label} failed: ${err?.message ?? err}`))
  }
}

async function chooseRefreshMode(procEnv, env, fs, fetcher, logger) {
  const forced = procEnv.USE_SNAPSHOT
  if (forced === '1' || forced === '0') {
    logger.say(`USE_SNAPSHOT=${forced} forced by env`)
    return forced === '1'
  }
  const appliedFile = join(env.opsDir, 'state', 'applied-snapshot')
  const applied = fs.exists(appliedFile) ? fs.readFile(appliedFile).trim() : ''
  try {
    const release = await fetchLatest(GITHUB_REPO_SLUG, { fetcher })
    if (release.tagName && release.tagName !== applied) {
      logger.say(`auto-detected new GH snapshot ${release.tagName} (was ${applied || '<none>'}) — using snapshot mode`)
      return true
    }
    logger.say('no newer GH snapshot found — using crawl-on-host mode')
    return false
  } catch (err) {
    logger.warn(`could not query GH releases (${err?.message ?? err}) — defaulting to crawl-on-host`)
    return false
  }
}

function warnOnPlistDrift(env, fs, logger) {
  const labels = [
    env.vars.LABEL_PROXY, env.vars.LABEL_WEB, env.vars.LABEL_MCP,
    env.vars.LABEL_WATCHDOG, env.vars.LABEL_TUNNEL_WEB, env.vars.LABEL_TUNNEL_MCP,
  ]
  let drift = false
  for (const label of labels) {
    const rendered = join(env.opsDir, 'launchd', `${label}.plist`)
    const installed = `/Library/LaunchDaemons/${label}.plist`
    if (!fs.exists(rendered)) continue
    if (!fs.exists(installed)) {
      logger.warn(`${installed} not yet installed — run \`apple-docs-ops install\``)
      drift = true
      continue
    }
    if (sha256OfFile(fs, rendered) !== sha256OfFile(fs, installed)) {
      logger.warn(`plist drift for ${label} — rendered ${rendered} differs from installed copy`)
      drift = true
    }
  }
  if (drift) {
    logger.warn('one or more plists changed; kickstart will NOT pick them up. Run `apple-docs-ops install`')
  }
}

function sha256OfFile(fs, p) {
  if (!fs.exists(p)) return ''
  const text = fs.readFile(p)
  return new CryptoHasher('sha256').update(text).digest('hex')
}

async function git(repoDir, args, runner) {
  const r = await runner(['/usr/bin/git', '-C', repoDir, ...args], { deadlineMs: 60_000 })
  return (r.stdout ?? '').trim()
}

async function isDirty(repoDir, runAllow) {
  const a = await runAllow(['/usr/bin/git', '-C', repoDir, 'diff', '--quiet'], { deadlineMs: 30_000 })
  const b = await runAllow(['/usr/bin/git', '-C', repoDir, 'diff', '--cached', '--quiet'], { deadlineMs: 30_000 })
  return a.exitCode !== 0 || b.exitCode !== 0
}

function defaultFs() {
  return {
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    mkdirp: (p) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }) },
  }
}
