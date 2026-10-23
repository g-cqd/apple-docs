/**
 * Reports whether this process runs under the Seatbelt profile from
 * `ops/sandbox/apple-docs-serve.sb`.
 *
 * The profile denies listing the home directory (it allows only metadata
 * reads there), while an unconfined process can list it. Trying the listing
 * and reading the outcome is therefore a direct, dependency-free signal; it
 * needs no FFI into libsandbox, whose `sandbox_check` is variadic and not
 * safe to call with a fixed signature on every architecture.
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * @param {{ readdir?: (path: string) => unknown, home?: string }} [deps]
 * @returns {boolean | null} `true` when the listing is denied (confined),
 *   `false` when it succeeds (unconfined), `null` when the outcome says
 *   nothing about confinement (for example the directory does not exist).
 */
export function detectSandbox({ readdir = readdirSync, home = homedir() } = {}) {
  try {
    readdir(home)
    return false
  } catch (error) {
    const code = error?.code
    return code === 'EPERM' || code === 'EACCES' ? true : null
  }
}

let cached
/**
 * Memoized {@link detectSandbox}: confinement cannot change for the life of a
 * process, so the probe runs once.
 *
 * @returns {boolean | null}
 */
export function isSandboxed() {
  if (cached === undefined) cached = detectSandbox()
  return cached
}
