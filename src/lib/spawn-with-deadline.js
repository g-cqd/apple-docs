/**
 * One-shot Bun.spawn wrapper with a hard deadline + bounded stderr capture.
 *
 * Every native spawn (Swift renderer, hdiutil, pkgutil, tar, sips,
 * rsvg-convert, sw_vers) needs a timeout — `proc.exited` alone would
 * let a wedged child hold a request handler indefinitely, and unbounded
 * stderr could blow up memory on a worker that streams thousands of
 * "deprecated API" warnings.
 *
 * Usage:
 *   const { stdout, stderr, exitCode } = await spawnWithDeadline(
 *     ['swift', scriptPath, ...args],
 *     { deadlineMs: 10_000, stderrMaxBytes: 64 * 1024 },
 *   )
 *
 * On deadline expiry: SIGKILLs the process, awaits its exit, and throws
 * SpawnTimeoutError with the captured stderr prefix (still useful for
 * diagnostics).
 *
 * On non-zero exit: returns the result; the caller decides how to handle
 * the exit code. (Throwing here would force every caller to wrap, which
 * we don't gain much from given the existing patterns.)
 */

import { SpawnTimeoutError } from './errors.js'

const DEFAULT_DEADLINE_MS = 10_000
const DEFAULT_STDERR_MAX_BYTES = 64 * 1024

/**
 * @param {string[]} args - Command + args, exactly as Bun.spawn expects.
 * @param {object} [opts]
 * @param {number} [opts.deadlineMs=10000]    Wall-clock kill deadline.
 * @param {number} [opts.stderrMaxBytes=65536] Cap on captured stderr; excess truncated.
 * @param {'pipe'|'inherit'|'ignore'} [opts.stdout='pipe']
 * @param {'pipe'|'inherit'|'ignore'} [opts.stderr='pipe']
 * @param {string|undefined} [opts.cwd]
 * @param {Record<string,string>|undefined} [opts.env]
 * @param {ReadableStream|string|undefined} [opts.stdin] Forwarded to Bun.spawn.
 * @returns {Promise<{ stdout: ArrayBuffer, stderr: string, exitCode: number }>}
 */
export async function spawnWithDeadline(args, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const stderrMaxBytes = opts.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES

  const proc = Bun.spawn(args, {
    stdout: opts.stdout ?? 'pipe',
    stderr: opts.stderr ?? 'pipe',
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch { /* already exited */ }
  }, deadlineMs)

  // Read stdout fully; read stderr through a capped sink so a pathological
  // child can't OOM us.
  const stdoutPromise = proc.stdout
    ? new Response(proc.stdout).arrayBuffer()
    : Promise.resolve(new ArrayBuffer(0))
  const stderrPromise = proc.stderr
    ? readStreamCapped(proc.stderr, stderrMaxBytes)
    : Promise.resolve('')

  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited,
  ])
  clearTimeout(timer)

  if (timedOut) {
    throw new SpawnTimeoutError(args, deadlineMs, { stderr })
  }

  return { stdout, stderr, exitCode }
}

async function readStreamCapped(stream, maxBytes) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let out = ''
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (truncated) continue
      total += value.length
      if (total <= maxBytes) {
        out += decoder.decode(value, { stream: true })
      } else {
        const remaining = Math.max(0, maxBytes - (total - value.length))
        if (remaining > 0) {
          out += decoder.decode(value.subarray(0, remaining), { stream: true })
        }
        out += `\n…[truncated; ${total - maxBytes} bytes dropped]`
        truncated = true
      }
    }
    out += decoder.decode()
  } finally {
    try { reader.releaseLock?.() } catch { /* ignore */ }
  }
  return out
}
