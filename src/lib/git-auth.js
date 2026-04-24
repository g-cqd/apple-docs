/**
 * Detect a GitHub token from the local environment via `gh` or the git
 * credential helper. Never throws; returns `null` on any failure.
 *
 * The function spawns short-lived child processes. `spawn` and `which` are
 * injectable so tests can fake them without touching the real system.
 */

/**
 * Minimal env allowlist for spawned children.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
function safeEnv(env) {
  const out = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL']) {
    if (env[key]) out[key] = env[key]
  }
  out.GIT_TERMINAL_PROMPT = '0'
  return out
}

/**
 * Read the entire stream as a UTF-8 string, bounded in time.
 *
 * @param {ReadableStream<Uint8Array> | null} stream
 * @returns {Promise<string>}
 */
async function streamToString(stream) {
  if (!stream) return ''
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

/**
 * Run a child process with a hard timeout. Resolves with `{ code, stdout,
 * stderr }` or `null` on spawn failure / timeout.
 *
 * @param {(cmd: string[], opts: object) => any} spawn
 * @param {string[]} cmd
 * @param {{ timeoutMs: number, stdin?: string, env: Record<string, string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string } | null>}
 */
async function runChild(spawn, cmd, { timeoutMs, stdin, env }) {
  let proc
  try {
    proc = spawn(cmd, {
      stdin: stdin === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
  } catch {
    return null
  }

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { proc.kill() } catch {}
      resolve('timeout')
    }, timeoutMs)
  })

  try {
    if (stdin !== undefined) {
      try {
        const writer = proc.stdin?.getWriter?.()
        if (writer) {
          await writer.write(new TextEncoder().encode(stdin))
          await writer.close()
        } else if (typeof proc.stdin?.write === 'function') {
          proc.stdin.write(stdin)
          proc.stdin.end?.()
        }
      } catch {
        // Ignore write errors; the child may have exited early.
      }
    }

    const exitedPromise = proc.exited.then((code) => ({ code }))
    const result = await Promise.race([exitedPromise, timeout])
    if (result === 'timeout') return null

    const [stdout, stderr] = await Promise.all([
      streamToString(proc.stdout),
      streamToString(proc.stderr),
    ])
    return { code: typeof result.code === 'number' ? result.code : 0, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse a `git credential fill` output blob and return the password/token.
 *
 * @param {string} text
 * @returns {string|null}
 */
function parseGitCredentialOutput(text) {
  if (!text) return null
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx)
    if (key === 'password') {
      const value = line.slice(idx + 1).trim()
      return value.length > 0 ? value : null
    }
  }
  return null
}

/**
 * Detect a GitHub token from `gh auth token` or `git credential fill`. Tries
 * `gh` first, then falls back to `git`. Env vars are never read here — the
 * caller handles precedence.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Per-child timeout. Default 3000ms.
 * @param {(cmd: string[], opts: object) => any} [options.spawn] Defaults to Bun.spawn.
 * @param {(name: string) => string | null | undefined} [options.which] Defaults to Bun.which.
 * @param {Record<string, string | undefined>} [options.env] Defaults to process.env.
 * @returns {Promise<{ token: string, source: 'gh' | 'git-credential' } | null>}
 */
export async function detectLocalGitHubToken({
  timeoutMs = 3000,
  spawn = Bun.spawn,
  which = Bun.which,
  env = process.env,
} = {}) {
  const childEnv = safeEnv(env)

  // 1. gh auth token --hostname github.com
  try {
    if (which('gh')) {
      const res = await runChild(
        spawn,
        ['gh', 'auth', 'token', '--hostname', 'github.com'],
        { timeoutMs, env: childEnv },
      )
      if (res && res.code === 0) {
        const token = res.stdout.trim()
        if (token.length > 0) {
          return { token, source: 'gh' }
        }
      }
    }
  } catch {
    // Fall through to git credential.
  }

  // 2. git credential fill
  try {
    if (which('git')) {
      const payload = 'protocol=https\nhost=github.com\n\n'
      const res = await runChild(
        spawn,
        ['git', 'credential', 'fill'],
        { timeoutMs, stdin: payload, env: childEnv },
      )
      if (res && res.code === 0) {
        const token = parseGitCredentialOutput(res.stdout)
        if (token) {
          return { token, source: 'git-credential' }
        }
      }
    }
  } catch {
    // Ignored.
  }

  return null
}

// Exported for unit tests.
export const _test = { safeEnv, parseGitCredentialOutput, runChild, streamToString }
