/**
 * Apply the latest GH-release snapshot to a running apple-docs host.
 *
 * Ports ops/bin/pull-snapshot.sh. The flow preserves the
 * post-mm18-outage reordering (services come back IMMEDIATELY after
 * setup, not after the long web build) — that's what kept the user-
 * facing /api/symbols/* down for 30 min last deploy.
 *
 *   1. GET /releases/latest, compare tag with applied-snapshot.
 *   2. (Skip everything if already current and not --force.)
 *   3. Stop watchdog → web → mcp (in that order so watchdog isn't
 *      kicking services we just took down).
 *   4. `apple-docs setup --force` (DB swap; ~10 min on a fresh
 *      release. On failure: restore services + exit 2).
 *   5. Bring web → mcp → watchdog back up. ←—————————————— UNDER 10 MIN OF DOWNTIME
 *   6. `apple-docs web build --incremental` while the daemons serve.
 *   7. cf-purge.
 *   8. smoke-test.
 *   9. Stamp <opsDir>/state/applied-snapshot.
 *
 * CLI shape: ops/cli.js pull-snapshot [--force]
 *
 * Exit codes:
 *   0 — applied a new snapshot or already current (no-op)
 *   1 — GH unreachable / refusal
 *   2 — setup failed; services restored to their pre-run state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { fetchLatest, GhReleaseError } from '../lib/gh-release.js'
import { bootout, bootstrapOrKick } from '../lib/launchctl.js'
import { runCmd, runCmdAllowFailure } from '../lib/run-cmd.js'
import runSmokeTest from './smoke-test.js'
import runCfPurge from './cf-purge.js'

const GITHUB_REPO_SLUG = 'g-cqd/apple-docs'

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any,
 *           deps?: { fetcher?: typeof fetch,
 *                    runCmd?: typeof runCmd,
 *                    runCmdAllowFailure?: typeof runCmdAllowFailure,
 *                    bootout?: typeof bootout,
 *                    bootstrapOrKick?: typeof bootstrapOrKick,
 *                    smokeTest?: typeof runSmokeTest,
 *                    cfPurge?: typeof runCfPurge,
 *                    fs?: { exists: Function, readFile: Function,
 *                           writeFile: Function, mkdirp: Function } } }} ctx
 */
export default async function runPullSnapshot(ctx = {}) {
  const argsSet = new Set(ctx.args ?? [])
  const force = argsSet.has('--force') || argsSet.has('-f') || ctx.env?.FORCE_PULL === '1'

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const logger = ctx.logger ?? createLogger({ logPath: join(env.opsDir, 'logs', 'pull-snapshot.log') })

  const deps = ctx.deps ?? {}
  const fetcher = deps.fetcher ?? fetch
  const runner = deps.runCmd ?? runCmd
  const runAllow = deps.runCmdAllowFailure ?? runCmdAllowFailure
  const launchctl = {
    bootout: deps.bootout ?? bootout,
    bootstrapOrKick: deps.bootstrapOrKick ?? bootstrapOrKick,
  }
  const smokeTest = deps.smokeTest ?? runSmokeTest
  const cfPurge = deps.cfPurge ?? runCfPurge
  const fs = deps.fs ?? defaultFs()
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))

  logger.say(`=== pull-snapshot starting (force=${force ? 1 : 0}) ===`)

  // 1. Latest release.
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`
  logger.say(`querying ${apiUrl}`)
  let release
  try {
    release = await fetchLatest(GITHUB_REPO_SLUG, { fetcher })
  } catch (err) {
    if (err instanceof GhReleaseError) logger.error(`could not fetch latest release: ${err.message}`)
    else logger.error(`could not fetch latest release: ${err?.message ?? err}`)
    return 1
  }
  logger.say(`latest release: ${release.tagName}`)

  // 2. Compare against applied tag.
  const appliedFile = join(env.opsDir, 'state', 'applied-snapshot')
  const applied = fs.exists(appliedFile) ? fs.readFile(appliedFile).trim() : ''
  logger.say(`currently applied: ${applied || '<none>'}`)
  if (applied === release.tagName && !force) {
    logger.say(`already at ${release.tagName} — nothing to do`)
    logger.say('=== pull-snapshot done (no-op) ===')
    return 0
  }

  // 3. Stop services.
  const labels = env.labels
  for (const label of [labels.watchdog, labels.web, labels.mcp]) {
    logger.say(`stopping ${label}`)
    await launchctl.bootout(label, { runCmdAllowFailure: runAllow })
  }

  // 4. setup --force.
  logger.say(`$ ${env.bunBin} run ${env.repoDir}/cli.js setup --force`)
  let setupFailed = false
  try {
    const r = await runner([env.bunBin, 'run', `${env.repoDir}/cli.js`, 'setup', '--force'], {
      deadlineMs: 60 * 60_000,
      env: { ...process.env, PATH: `${dirname(env.bunBin)}:${process.env.PATH ?? ''}` },
    })
    if (r.stdout) logger.runOutput(r.stdout)
    if (r.stderr) logger.runOutput(r.stderr)
  } catch (err) {
    setupFailed = true
    logger.error(`apple-docs setup failed: ${err?.message ?? err}`)
  }
  if (setupFailed) {
    logger.say('restoring services before exiting')
    await restartAll(launchctl, runAllow, runner, env, logger, sleep)
    return 2
  }

  // 5. Bring services back UP — before the web build, so the box is
  // live while caddy still serves the previous static tree.
  await restartAll(launchctl, runAllow, runner, env, logger, sleep)

  // 6. Web build (incremental).
  logger.say(`$ ${env.bunBin} run ${env.repoDir}/cli.js web build --incremental`)
  try {
    const r = await runner([
      env.bunBin, 'run', `${env.repoDir}/cli.js`, 'web', 'build', '--incremental',
      '--out', env.staticDir,
      '--base-url', `https://${env.vars.PUBLIC_WEB_HOST}`,
    ], {
      deadlineMs: 60 * 60_000,
      env: { ...process.env, PATH: `${dirname(env.bunBin)}:${process.env.PATH ?? ''}` },
    })
    if (r.stdout) logger.runOutput(r.stdout)
    if (r.stderr) logger.runOutput(r.stderr)
  } catch (err) {
    logger.warn(`incremental static build failed: ${err?.message ?? err} — Caddy keeps the previous tree`)
  }

  // 7. cf-purge.
  await cfPurge({ env: ctx.env, envLoader: () => env, logger })
    .catch(err => logger.warn(`cf-purge errored: ${err?.message ?? err}`))

  // 8. smoke.
  await sleep(3_000)
  const rcSmoke = await smokeTest({ envLoader: () => env, logger })
  if (rcSmoke !== 0) {
    logger.warn('smoke test reported failures — investigate before declaring success')
  }

  // 9. Stamp applied-snapshot.
  fs.mkdirp(dirname(appliedFile))
  fs.writeFile(appliedFile, `${release.tagName}\n`)
  logger.say(`stamped applied-snapshot=${release.tagName}`)
  logger.say('=== pull-snapshot done ===')
  return 0
}

async function restartAll(launchctl, runAllow, runner, env, logger, sleep) {
  // web → mcp first; watchdog last so it doesn't observe a half-up backend.
  const sequence = [
    { label: env.labels.web,      plist: `/Library/LaunchDaemons/${env.labels.web}.plist` },
    { label: env.labels.mcp,      plist: `/Library/LaunchDaemons/${env.labels.mcp}.plist` },
  ]
  for (const { label, plist } of sequence) {
    logger.say(`bootstrapping ${label}`)
    try {
      await launchctl.bootstrapOrKick(label, plist, { runCmdAllowFailure: runAllow, runCmd: runner, logger })
    } catch (err) {
      logger.warn(`bootstrap ${label} failed: ${err?.message ?? err}`)
    }
  }
  await sleep(3_000)
  try {
    logger.say(`bootstrapping ${env.labels.watchdog}`)
    await launchctl.bootstrapOrKick(env.labels.watchdog,
      `/Library/LaunchDaemons/${env.labels.watchdog}.plist`,
      { runCmdAllowFailure: runAllow, runCmd: runner, logger })
  } catch (err) {
    logger.warn(`watchdog didn't restart: ${err?.message ?? err}`)
  }
}

function defaultFs() {
  return {
    exists: existsSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, content) => writeFileSync(p, content),
    mkdirp: (p) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }) },
  }
}
