/**
 * Subprocess wrapper for the ops layer. Every ops command that shells
 * out (launchctl, tar, sudo, curl-via-fetch helpers, the apple-docs
 * binary itself) goes through this single entry point so:
 *
 *  - timeouts are uniform and explicit (`deadlineMs`)
 *  - stdout + stderr capture is bounded (no OOM from a wedged child)
 *  - non-zero exits and timeouts throw the same structured error
 *  - tests inject a `spawn` fake instead of really running the command
 *
 * Distinct from `src/lib/spawn-with-deadline.js` (which we keep) because
 * the ops use-case wants tee-to-log behaviour and a slightly different
 * return shape — and we'd rather not couple ops back into `src/`.
 */

const DEFAULT_DEADLINE_MS = 60_000
const DEFAULT_STDERR_MAX_BYTES = 256 * 1024
const DEFAULT_STDOUT_MAX_BYTES = 4 * 1024 * 1024

/**
 * @typedef {Object} RunCmdOptions
 * @property {number} [deadlineMs=60000]
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 * @property {'pipe' | 'inherit' | 'ignore'} [stdout='pipe']
 * @property {'pipe' | 'inherit' | 'ignore'} [stderr='pipe']
 * @property {string} [stdin]                              fed to child stdin
 * @property {number} [stdoutMaxBytes]
 * @property {number} [stderrMaxBytes]
 * @property {{ spawn?: typeof Bun.spawn, clock?: () => number }} [deps]
 *
 * @typedef {Object} RunCmdResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {number} exitCode
 * @property {number} elapsedMs
 */

/**
 * Run a command to completion, throwing on non-zero exit or deadline.
 *
 * @param {string[]} args             [cmd, ...args]
 * @param {RunCmdOptions} [options]
 * @returns {Promise<RunCmdResult>}
 */
export async function runCmd(args, options = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new RunCmdError('runCmd: args must be a non-empty array', { args, kind: 'usage' })
  }
  const {
    deadlineMs = DEFAULT_DEADLINE_MS,
    cwd,
    env,
    stdout = 'pipe',
    stderr = 'pipe',
    stdin,
    stdoutMaxBytes = DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes = DEFAULT_STDERR_MAX_BYTES,
    deps = {},
  } = options
  const spawn = deps.spawn ?? Bun.spawn
  const clock = deps.clock ?? Date.now

  const startedAt = clock()
  const proc = spawn(args, {
    stdout,
    stderr,
    cwd,
    env,
    stdin,
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch { /* already dead */ }
  }, deadlineMs)

  const stdoutPromise = stdout === 'pipe' && proc.stdout
    ? readStreamCapped(proc.stdout, stdoutMaxBytes)
    : Promise.resolve('')
  const stderrPromise = stderr === 'pipe' && proc.stderr
    ? readStreamCapped(proc.stderr, stderrMaxBytes)
    : Promise.resolve('')

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ])
  clearTimeout(timer)

  const elapsedMs = clock() - startedAt

  if (timedOut) {
    throw new RunCmdError(
      `runCmd: ${args[0]} exceeded ${deadlineMs}ms`,
      { args, kind: 'timeout', deadlineMs, stderr: stderrText, elapsedMs },
    )
  }

  if (exitCode !== 0) {
    throw new RunCmdError(
      `runCmd: ${args[0]} exited ${exitCode}: ${stderrText.trim().slice(0, 512) || '<no stderr>'}`,
      { args, kind: 'exit', exitCode, stderr: stderrText, stdout: stdoutText, elapsedMs },
    )
  }

  return { stdout: stdoutText, stderr: stderrText, exitCode, elapsedMs }
}

/**
 * Same as runCmd, but does NOT throw on non-zero exit. Use when the
 * caller wants to branch on the exit code (e.g. `launchctl print` to
 * test whether a label is loaded — exit 113 means "not present").
 *
 * @param {string[]} args
 * @param {RunCmdOptions} [options]
 * @returns {Promise<RunCmdResult>}
 */
export async function runCmdAllowFailure(args, options = {}) {
  try {
    return await runCmd(args, options)
  } catch (err) {
    if (err instanceof RunCmdError && err.kind === 'exit') {
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        exitCode: err.exitCode,
        elapsedMs: err.elapsedMs ?? 0,
      }
    }
    throw err
  }
}

export class RunCmdError extends Error {
  constructor(message, { args, kind, exitCode, deadlineMs, stdout, stderr, elapsedMs } = {}) {
    super(message)
    this.name = 'RunCmdError'
    this.args = args
    this.kind = kind
    this.exitCode = exitCode
    this.deadlineMs = deadlineMs
    this.stdout = stdout
    this.stderr = stderr
    this.elapsedMs = elapsedMs
  }
}

async function readStreamCapped(stream, maxBytes) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let truncated = false
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (received + value.byteLength > maxBytes) {
      const room = maxBytes - received
      if (room > 0) out += decoder.decode(value.subarray(0, room), { stream: true })
      truncated = true
      try { reader.cancel() } catch {}
      break
    }
    received += value.byteLength
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  if (truncated) out += `\n…[truncated at ${maxBytes} bytes]`
  return out
}
