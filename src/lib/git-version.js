// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Short commit hash of the running checkout, for the page footer ("what code
 * is this instance serving"). Computed at web-build time.
 *
 * Source order:
 *   1. `APPLE_DOCS_COMMIT` env — set by CI and by the build worker fan-out so
 *      every worker renders the same SHA; also the only source for a non-git
 *      install (e.g. the compiled standalone binary).
 *   2. `git -C <repo> rev-parse --short HEAD` — resolved from this module's
 *      location, so it works regardless of the process cwd.
 *
 * Returns null when neither yields a plausible SHA — the footer then simply
 * omits the commit line. The value is validated before use because it lands
 * in HTML and a GitHub URL.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHA_RE = /^[0-9a-f]{7,40}$/
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached // undefined = not computed; string|null = result

/** @returns {string|null} short commit hash, or null when unavailable */
export function getCommitHash() {
  if (cached !== undefined) return cached
  const env = process.env.APPLE_DOCS_COMMIT?.trim().toLowerCase()
  if (env && SHA_RE.test(env)) {
    cached = env
    return cached
  }
  try {
    const r = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'])
    if (r.exitCode === 0) {
      const sha = new TextDecoder().decode(r.stdout).trim().toLowerCase()
      if (SHA_RE.test(sha)) {
        cached = sha
        return cached
      }
    }
  } catch {
    /* git missing or not a repo — fall through to null */
  }
  cached = null
  return cached
}

/** Test seam: drop the memoized value so a fresh env/git read is taken. */
export function _resetCommitHash() {
  cached = undefined
}
