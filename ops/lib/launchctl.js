/**
 * launchctl wrapper for the ops layer. Every privileged
 * load/unload/kick call on macOS goes through here so:
 *
 *  - the sudo-passwordless allowlist in /etc/sudoers.d/ only needs to
 *    cover one binary path (/bin/launchctl) plus the standard verbs.
 *  - tests inject a `runCmd` fake instead of really shelling out.
 *  - argv shape stays consistent across every command. A drift here
 *    would break the sudoers Cmnd_Alias match and require operators
 *    to type a password on every deploy.
 *
 * The bash scripts had three idioms repeated everywhere:
 *
 *   stop_one)   sudo -n launchctl print system/$label    → if loaded, bootout
 *   start_one)  sudo -n launchctl bootstrap system $plist → if EEXIST, kickstart -k
 *   kick)       sudo -n launchctl kickstart -k system/$label
 *
 * Each is exposed as its own function below, with the
 * "fallback to kickstart" semantics built in (matching what
 * pull-snapshot.sh + deploy-update.sh did).
 */

import { runCmd, runCmdAllowFailure } from './run-cmd.js'

const LAUNCHCTL = '/bin/launchctl'
const SUDO = '/usr/bin/sudo'

/**
 * `launchctl print system/<label>` exits 0 when the service is loaded,
 * 113 (or similar) when it isn't. We branch on exit code rather than
 * parse stdout — `print` is verbose and its grammar isn't stable.
 *
 * @param {string} label  e.g. 'mt.everest.apple-docs.web'
 * @param {{ runCmd?: typeof runCmdAllowFailure }} [deps]
 * @returns {Promise<boolean>}
 */
export async function isLoaded(label, deps = {}) {
  const run = deps.runCmd ?? runCmdAllowFailure
  const r = await run([SUDO, '-n', LAUNCHCTL, 'print', `system/${label}`], {
    stdout: 'ignore',
    stderr: 'pipe',
    deadlineMs: 10_000,
  })
  return r.exitCode === 0
}

/**
 * `launchctl bootstrap` loads a plist into the system domain. If the
 * label is already loaded, `bootstrap` errors with EEXIST — in that
 * case fall back to `kickstart -k` which SIGKILLs the running process
 * and lets launchd re-exec it from the same plist already on disk.
 *
 * @param {string} label
 * @param {string} plistPath  absolute path to /Library/LaunchDaemons/<label>.plist
 * @param {{ runCmd?: typeof runCmd, runCmdAllowFailure?: typeof runCmdAllowFailure }} [deps]
 */
export async function bootstrapOrKick(label, plistPath, deps = {}) {
  const runAllow = deps.runCmdAllowFailure ?? runCmdAllowFailure
  const r = await runAllow([SUDO, '-n', LAUNCHCTL, 'bootstrap', 'system', plistPath], {
    deadlineMs: 15_000,
  })
  if (r.exitCode === 0) return { kind: 'bootstrapped' }
  await kickstart(label, deps)
  return { kind: 'kickstarted' }
}

/**
 * `launchctl bootout` removes a label from the system domain. Returns
 * silently if the label was never loaded (bootout exits non-zero in
 * that case but it's not an operator error — same idea as `rm -f`).
 *
 * @param {string} label
 * @param {{ runCmdAllowFailure?: typeof runCmdAllowFailure }} [deps]
 */
export async function bootout(label, deps = {}) {
  const run = deps.runCmdAllowFailure ?? runCmdAllowFailure
  return run([SUDO, '-n', LAUNCHCTL, 'bootout', `system/${label}`], {
    deadlineMs: 15_000,
  })
}

/**
 * `launchctl kickstart -k` SIGKILLs the running process for a label
 * and lets launchd restart it. The `-k` (kill) form is the one we
 * want every place we'd otherwise reach for `bootout` + `bootstrap` —
 * preserves the plist and is markedly faster.
 *
 * @param {string} label
 * @param {{ runCmd?: typeof runCmd }} [deps]
 */
export async function kickstart(label, deps = {}) {
  const run = deps.runCmd ?? runCmd
  return run([SUDO, '-n', LAUNCHCTL, 'kickstart', '-k', `system/${label}`], {
    deadlineMs: 15_000,
  })
}

/**
 * Stop a label if loaded; no-op when already absent. Logs through the
 * passed logger so the caller's audit trail is preserved.
 *
 * @param {string} label
 * @param {{ logger?: any, runCmd?: typeof runCmd, runCmdAllowFailure?: typeof runCmdAllowFailure }} [deps]
 */
export async function stopOne(label, deps = {}) {
  const log = deps.logger
  if (!(await isLoaded(label, deps))) {
    log?.say?.(`${label} not loaded — skipping bootout`)
    return { kind: 'already-stopped' }
  }
  log?.say?.(`stopping ${label}`)
  await bootout(label, deps)
  return { kind: 'stopped' }
}

/**
 * Start a label, picking the right verb. If the plist file is missing
 * we throw — that's an install bug the operator must fix, not a
 * "service didn't restart" warning to bury in the log.
 *
 * @param {string} label
 * @param {string} plistPath
 * @param {{ logger?: any, fs?: { exists: (p: string) => boolean },
 *           runCmd?: typeof runCmd, runCmdAllowFailure?: typeof runCmdAllowFailure }} [deps]
 */
export async function startOne(label, plistPath, deps = {}) {
  const log = deps.logger
  const fs = deps.fs ?? { exists: defaultExists }
  if (!fs.exists(plistPath)) {
    throw new Error(`launchctl: ${plistPath} missing — cannot start ${label}`)
  }
  log?.say?.(`bootstrapping ${label}`)
  const result = await bootstrapOrKick(label, plistPath, deps)
  return result
}

function defaultExists(p) {
  try {
    // Inline require to avoid pulling node:fs into a fresh module on
    // every test that doesn't touch the filesystem.
    const { existsSync } = require('node:fs')
    return existsSync(p)
  } catch {
    return false
  }
}
