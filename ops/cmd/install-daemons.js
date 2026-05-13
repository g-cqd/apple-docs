/**
 * Install apple-docs LaunchDaemons + sudoers drop-in. Idempotent.
 * Must be invoked as root (the bash predecessor exits 1 on non-root;
 * we mirror that).
 *
 * Flow:
 *   1. Render every *.tpl from ops/.env (delegates to render-all).
 *   2. Unload any stale user-session LaunchAgents.
 *   3. Ensure caddy is installed for the operator user.
 *   4. Bootout the existing system daemons.
 *   5. Optional cleanup of legacy labels from a prior deployment.
 *   6. `install -o root -g wheel -m 644` each plist into
 *      /Library/LaunchDaemons.
 *   7. Bootstrap (or kickstart-fallback) each app daemon.
 *   8. Bring the cloudflared tunnels up.
 *   9. Validate + install the sudoers drop-in via `visudo -cf` then
 *      `install -m 440 …`.
 *  10. Sleep 8s, then run the smoke battery.
 *  11. Optional cleanup of compatibility symlinks pointing at the
 *      ops directory.
 *
 * The "as root" steps shell out via `runCmd` because they need real
 * `sudo`/`install`/`launchctl` privileges. Tests inject `runCmd` +
 * `runCmdAllowFailure` fakes so the suite never tries to actually
 * touch /Library/LaunchDaemons.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnv } from '../lib/env.js'
import { createLogger } from '../lib/logger.js'
import { bootout, bootstrapOrKick, isLoaded, kickstart } from '../lib/launchctl.js'
import { runCmd, runCmdAllowFailure } from '../lib/run-cmd.js'
import runRenderAll from './render-all.js'
import runSmokeTest from './smoke-test.js'

const APP_LABEL_KEYS = ['LABEL_PROXY', 'LABEL_WEB', 'LABEL_MCP', 'LABEL_WATCHDOG']
const ALL_LABEL_KEYS = [...APP_LABEL_KEYS, 'LABEL_TUNNEL_WEB', 'LABEL_TUNNEL_MCP']

/**
 * @param {{ args?: string[], env?: Record<string,string>,
 *           envLoader?: () => any, logger?: any,
 *           deps?: { isRoot?: () => boolean,
 *                    runCmd?: typeof runCmd,
 *                    runCmdAllowFailure?: typeof runCmdAllowFailure,
 *                    bootout?: typeof bootout,
 *                    bootstrapOrKick?: typeof bootstrapOrKick,
 *                    isLoaded?: typeof isLoaded,
 *                    kickstart?: typeof kickstart,
 *                    exists?: (p: string) => boolean,
 *                    renderAll?: typeof runRenderAll,
 *                    smokeTest?: typeof runSmokeTest,
 *                    sleep?: (ms: number) => Promise<void> } }} ctx
 */
export default async function runInstallDaemons(ctx = {}) {
  const logger = ctx.logger ?? createLogger()
  const deps = ctx.deps ?? {}
  const isRoot = deps.isRoot ?? (() => process.getuid?.() === 0)
  if (!isRoot()) {
    logger.error('install-daemons: must be run as root (sudo).')
    return 1
  }

  const env = ctx.envLoader ? ctx.envLoader() : loadEnv()
  const runner = deps.runCmd ?? runCmd
  const runAllow = deps.runCmdAllowFailure ?? runCmdAllowFailure
  const exists = deps.exists ?? existsSync
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  const renderAll = deps.renderAll ?? runRenderAll
  const smokeTest = deps.smokeTest ?? runSmokeTest

  // 1. Render templates as the operator user. We delegate to
  // render-all.js — when in-process the loaded env is reused.
  logger.say('=== rendering templates ===')
  const rcRender = await renderAll({ args: [], envLoader: () => env, logger })
  if (rcRender !== 0) return rcRender

  // 2. Strip stale user-session LaunchAgents. These would have been
  // installed by an earlier `launchctl bootstrap gui/<uid>` path; the
  // current daemon model is system-domain only.
  logger.say('=== unloading stale user LaunchAgents ===')
  const uidLine = await runAllow(['/usr/bin/id', '-u', env.vars.USER_NAME], { deadlineMs: 5_000 })
  const uid = uidLine.stdout.trim()
  for (const key of ALL_LABEL_KEYS) {
    const label = env.vars[key]
    await runAllow([
      '/usr/bin/sudo', '-u', env.vars.USER_NAME, '/bin/launchctl', 'bootout', `gui/${uid}/${label}`,
    ], { deadlineMs: 5_000 })
    await runAllow([
      '/bin/rm', '-f', `/Users/${env.vars.USER_NAME}/Library/LaunchAgents/${label}.plist`,
    ], { deadlineMs: 5_000 })
  }

  // 3. Caddy presence — delegate to a small sudo'd run-as-user step.
  // (The bash version runs `ensure-caddy.sh` as the operator user;
  // we do the same via sudo -u.)
  logger.say('=== ensuring caddy is installed ===')
  try {
    await runner([
      '/usr/bin/sudo', '-u', env.vars.USER_NAME,
      env.bunBin, join(env.opsDir, '..', 'ops/cli.js'), 'proxy', 'validate',
    ], { deadlineMs: 60_000 })
  } catch (err) {
    // ensure-caddy in the bash flow was a soft pre-check; we warn
    // rather than fail-hard so a missing Caddyfile.tpl render slip
    // doesn't gate the whole install.
    logger.warn(`caddy validation failed: ${err?.message ?? err}`)
  }

  // 4. Bootout existing system daemons.
  logger.say('=== unloading app daemons before reinstall ===')
  const launchctl = {
    bootout: deps.bootout ?? bootout,
    bootstrapOrKick: deps.bootstrapOrKick ?? bootstrapOrKick,
    isLoaded: deps.isLoaded ?? isLoaded,
    kickstart: deps.kickstart ?? kickstart,
  }
  for (const key of APP_LABEL_KEYS) {
    await launchctl.bootout(env.vars[key], { runCmdAllowFailure: runAllow })
  }

  // 5. Legacy cleanup.
  if (env.vars.LEGACY_LAUNCHD_LABELS) {
    logger.say('=== removing legacy launchd labels ===')
    const labels = env.vars.LEGACY_LAUNCHD_LABELS.split(',').map(s => s.trim()).filter(Boolean)
    for (const label of labels) {
      logger.say(`  legacy: ${label}`)
      await launchctl.bootout(label, { runCmdAllowFailure: runAllow })
      await runAllow(['/bin/rm', '-f', `/Library/LaunchDaemons/${label}.plist`], { deadlineMs: 5_000 })
    }
  }

  // 6. Install rendered plists.
  logger.say('=== installing plists to /Library/LaunchDaemons ===')
  for (const key of ALL_LABEL_KEYS) {
    const label = env.vars[key]
    const src = join(env.opsDir, 'launchd', `${label}.plist`)
    if (!exists(src)) {
      logger.warn(`skip: ${src} missing`)
      continue
    }
    await runner([
      '/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '644',
      src, '/Library/LaunchDaemons/',
    ], { deadlineMs: 5_000 })
  }

  // 7. Bootstrap app daemons.
  logger.say('=== bootstrapping app daemons ===')
  for (const key of APP_LABEL_KEYS) {
    const label = env.vars[key]
    const plist = `/Library/LaunchDaemons/${label}.plist`
    if (!exists(plist)) continue
    await launchctl.bootstrapOrKick(label, plist, {
      runCmdAllowFailure: runAllow, runCmd: runner, logger,
    })
  }

  // 8. Cloudflared tunnels.
  logger.say('=== ensuring cloudflared daemons are loaded ===')
  for (const key of ['LABEL_TUNNEL_WEB', 'LABEL_TUNNEL_MCP']) {
    const label = env.vars[key]
    const plist = `/Library/LaunchDaemons/${label}.plist`
    if (!exists(plist)) continue
    if (await launchctl.isLoaded(label, { runCmd: runAllow })) {
      await launchctl.kickstart(label, { runCmd: runner })
    } else {
      await launchctl.bootstrapOrKick(label, plist, {
        runCmdAllowFailure: runAllow, runCmd: runner, logger,
      })
    }
  }

  // 9. Sudoers drop-in.
  logger.say('=== validating + installing sudoers drop-in ===')
  const sudoersStem = env.vars.LABEL_PREFIX.replace(/\./g, '_')
  const sudoersFile = `/etc/sudoers.d/${sudoersStem}-launchctl`
  const renderedSudoers = join(env.opsDir, 'launchd', 'sudoers.apple-docs-launchctl')
  await runner(['/usr/sbin/visudo', '-cf', renderedSudoers], { deadlineMs: 5_000 })
  await runner([
    '/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', '440',
    renderedSudoers, sudoersFile,
  ], { deadlineMs: 5_000 })

  // 10. Smoke.
  logger.say('=== waiting 8s for tunnels and services to settle ===')
  await sleep(8_000)
  logger.say('=== smoke tests ===')
  const rcSmoke = await smokeTest({ envLoader: () => env, logger })
  if (rcSmoke !== 0) logger.warn('one or more smoke tests failed')
  return 0
}
