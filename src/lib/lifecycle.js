/**
 * Process lifecycle helper for the apple-docs CLI / MCP / web entry points.
 *
 * Replaces the minimal SIGINT/SIGTERM handlers that simply closed the DB
 * and exited — those left no hook for unhandledRejection /
 * uncaughtException and the synchronous cleanup dropped in-flight
 * requests and killed reader-pool workers before they could drain, so
 * launchd's default 20 s ExitTimeOut hard-killed the process.
 *
 * This module provides:
 *   - `installCrashHandlers({ logger })` — wires SIGINT/SIGTERM and the
 *     two crash event handlers exactly once. Idempotent.
 *   - `lifecycle.register({ name, stop })` — adds a drain step. Returns an
 *     opaque handle whose `.unregister()` removes it again.
 *   - `gracefulShutdown(reason, deadlineMs?)` — calls every registered
 *     `stop()` in reverse order with a per-step remaining-budget timeout,
 *     then `process.exit`. Total budget defaults to 30 s, matching the
 *     launchd ExitTimeOut set in the plist templates.
 *
 * Tests don't normally call `installCrashHandlers`, so registrations made
 * during a test never trigger drains — they're just inert state on the
 * module singleton.
 */

const components = []
let handlersInstalled = false
let shuttingDown = false
let installedLogger = null
let exitImpl = (code) => process.exit(code)

const DEFAULT_DEADLINE_MS = 30_000
const CRASH_DEADLINE_MS = 5_000
const FORCE_EXIT_CODE = 2

/**
 * @typedef {object} LifecycleHandle
 * @property {() => void} unregister
 */

/**
 * Register a drain step. Components are drained in reverse registration
 * order so the most recently started one stops first (typically: HTTP
 * server → reader pool → DB).
 *
 * @param {{ name: string, stop: (deadlineMs: number) => Promise<void> | void }} entry
 * @returns {LifecycleHandle}
 */
function register(entry) {
  if (!entry || typeof entry.name !== 'string' || typeof entry.stop !== 'function') {
    throw new TypeError('lifecycle.register requires { name: string, stop: function }')
  }
  components.push(entry)
  return {
    unregister() {
      const idx = components.indexOf(entry)
      if (idx >= 0) components.splice(idx, 1)
    },
  }
}

/**
 * Drain every registered component in reverse order with a shared deadline.
 * Each component's `stop()` runs against `Promise.race([stop(), sleep(remaining)])`
 * so a wedged component cannot hold up the rest. Returns the exit code the
 * caller should pass to `process.exit`.
 *
 * @param {string} reason
 * @param {number} [deadlineMs]
 * @param {{ logger?: { info?: Function, warn?: Function, error?: Function } }} [opts]
 * @returns {Promise<number>} 0 on clean drain, 1 if the deadline was hit
 */
async function gracefulShutdown(reason, deadlineMs = DEFAULT_DEADLINE_MS, opts = {}) {
  if (shuttingDown) {
    const logger = opts.logger ?? installedLogger
    logger?.warn?.('shutdown: re-entry, forcing immediate exit', { reason })
    exitImpl(FORCE_EXIT_CODE)
    return FORCE_EXIT_CODE
  }
  shuttingDown = true
  const logger = opts.logger ?? installedLogger
  logger?.info?.(`shutdown.start reason=${reason} deadline=${deadlineMs}ms components=${components.length}`)

  const start = Date.now()
  let exitCode = 0
  while (components.length > 0) {
    const entry = components.pop()
    const remaining = Math.max(0, deadlineMs - (Date.now() - start))
    if (remaining === 0) {
      logger?.warn?.(`shutdown: deadline reached before stopping ${entry.name}`)
      exitCode = 1
      break
    }
    try {
      await Promise.race([
        Promise.resolve(entry.stop(remaining)),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ])
    } catch (err) {
      logger?.error?.(`shutdown: ${entry.name} stop() threw`, { error: err?.message, stack: err?.stack })
      exitCode = 1
    }
  }

  const elapsed = Date.now() - start
  if (elapsed >= deadlineMs && exitCode === 0) exitCode = 1
  logger?.info?.(`shutdown.done reason=${reason} elapsed=${elapsed}ms exit=${exitCode}`)
  return exitCode
}

/**
 * Install the four process-level handlers exactly once. Subsequent calls
 * update the logger reference but don't re-attach handlers.
 */
function installCrashHandlers({ logger } = {}) {
  installedLogger = logger ?? installedLogger
  if (handlersInstalled) return
  handlersInstalled = true

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT').then((code) => exitImpl(code))
  })
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM').then((code) => exitImpl(code))
  })
  process.on('unhandledRejection', (reason) => {
    installedLogger?.error?.('unhandledRejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    })
    void gracefulShutdown('unhandledRejection', CRASH_DEADLINE_MS).then(() => exitImpl(1))
  })
  process.on('uncaughtException', (err) => {
    installedLogger?.error?.('uncaughtException', { error: err?.message, stack: err?.stack })
    void gracefulShutdown('uncaughtException', CRASH_DEADLINE_MS).then(() => exitImpl(1))
  })
}

/** Test-only: reset module state between cases. */
function _reset({ exit } = {}) {
  components.length = 0
  handlersInstalled = false
  shuttingDown = false
  installedLogger = null
  exitImpl = exit ?? ((code) => process.exit(code))
}

export const lifecycle = { register, gracefulShutdown, _reset }
export { installCrashHandlers, gracefulShutdown }
