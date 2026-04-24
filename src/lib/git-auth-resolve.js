import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { detectLocalGitHubToken } from './git-auth.js'
import { setResolvedGitHubToken } from './github.js'
import { promptYesNoAlways } from '../cli/prompts.js'

/**
 * Resolve a GitHub token for `sync`/`update` from, in order:
 *   1. GITHUB_TOKEN / GH_TOKEN (handled by github.js; we only check to bail early)
 *   2. APPLE_DOCS_NO_GIT_AUTH=1 → skip detection
 *   3. `--skip-git-auth` flag → skip detection
 *   4. `--use-git-auth` flag → detect, use, do not prompt
 *   5. Persisted sidecar `~/.apple-docs/config.json` with `{ "useGitAuth": true }`
 *   6. TTY prompt ("yes" / "no" / "always")
 *   7. Non-TTY without flag → no token, warn once
 *
 * Any detected token is installed via `setResolvedGitHubToken` so subsequent
 * GitHub API calls pick it up through `github.js::getGitHubToken`.
 *
 * @param {object} options
 * @param {Record<string, any>} options.flags Parsed CLI flags.
 * @param {Record<string, string | undefined>} [options.env]
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} [options.logger]
 * @param {typeof detectLocalGitHubToken} [options.detect]
 * @param {typeof promptYesNoAlways} [options.promptFn]
 * @param {() => boolean} [options.isTTY]
 * @param {string} [options.sidecarPath]
 * @returns {Promise<{ token: string | null, source: string | null }>}
 */
export async function resolveGitHubAuth({
  flags,
  env = process.env,
  logger,
  detect = detectLocalGitHubToken,
  promptFn = promptYesNoAlways,
  isTTY = () => Boolean(process.stdin.isTTY),
  sidecarPath = defaultSidecarPath(),
} = {}) {
  // 1. Env vars win; nothing to do.
  if (env.GITHUB_TOKEN || env.GH_TOKEN) {
    return { token: null, source: 'env' }
  }

  // 2. Explicit env opt-out.
  if (env.APPLE_DOCS_NO_GIT_AUTH === '1' || env.APPLE_DOCS_NO_GIT_AUTH === 'true') {
    return { token: null, source: null }
  }

  // 3. Explicit per-invocation opt-out.
  if (flags['skip-git-auth']) {
    return { token: null, source: null }
  }

  const useFlag = Boolean(flags['use-git-auth'])
  const persisted = readSidecar(sidecarPath)
  const persistedYes = persisted?.useGitAuth === true
  const persistedNo = persisted?.useGitAuth === false

  // Persisted "no" wins unless the caller opts in via flag this run.
  if (persistedNo && !useFlag) {
    return { token: null, source: null }
  }

  // 4 & 5. Flag or persisted yes → detect without prompting.
  if (useFlag || persistedYes) {
    const detected = await detect()
    if (detected) {
      setResolvedGitHubToken(detected.token)
      logger?.info?.(`Using local GitHub credentials from ${detected.source}`)
      return { token: detected.token, source: detected.source }
    }
    logger?.warn?.('--use-git-auth requested but no local GitHub credentials were found')
    return { token: null, source: null }
  }

  // 6. TTY prompt.
  if (isTTY()) {
    const detected = await detect()
    if (!detected) {
      return { token: null, source: null }
    }
    let answer = 'no'
    try {
      answer = await promptFn(
        `Use local GitHub credentials from ${detected.source} to authenticate requests? [y/N/always]`,
      )
    } catch {
      answer = 'no'
    }
    if (answer === 'yes' || answer === 'always') {
      setResolvedGitHubToken(detected.token)
      if (answer === 'always') {
        writeSidecar(sidecarPath, { ...(persisted ?? {}), useGitAuth: true })
      }
      logger?.info?.(`Using local GitHub credentials from ${detected.source}`)
      return { token: detected.token, source: detected.source }
    }
    return { token: null, source: null }
  }

  // 7. Non-TTY, no flag, no persisted preference.
  logger?.debug?.('No GitHub token available; proceeding unauthenticated')
  return { token: null, source: null }
}

/**
 * Default sidecar config path. Lives outside `APPLE_DOCS_HOME` / `dataDir`
 * because `apple-docs setup` wipes that directory.
 *
 * @returns {string}
 */
function defaultSidecarPath() {
  return join(homedir(), '.apple-docs', 'config.json')
}

/**
 * Read the sidecar JSON, returning `null` on any I/O or parse error.
 *
 * @param {string} path
 * @returns {Record<string, any> | null}
 */
export function readSidecar(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Atomically write the sidecar JSON with 0600 permissions. Silently ignores
 * write failures so a read-only home doesn't crash sync/update.
 *
 * @param {string} path
 * @param {Record<string, any>} data
 */
export function writeSidecar(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, path)
  } catch {
    // Ignored — not being able to persist the preference is non-fatal.
  }
}
