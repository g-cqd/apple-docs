/**
 * safeCall — uniform replacement for `try { ... } catch {}` and
 * `try { ... } catch { return defaultValue }` patterns.
 *
 * Silent-catch sites fall into one of three buckets:
 *
 *   1. Cleanup paths (resource teardown, log flushes) — failure here adds
 *      noise without value. Use `log: 'silent'`.
 *   2. Defensive parses (JSON.parse, statSync) where the fallback value
 *      is a meaningful "no data" signal. Use `log: 'warn-once'` so the
 *      first failure surfaces but a stuck malformed input doesn't spam.
 *   3. Search-quality / correctness paths where catching at all is the
 *      bug. Those should propagate; remove the try/catch entirely. Do
 *      NOT use safeCall to paper over them.
 *
 * Sync and async fns are both supported: when the wrapped function
 * returns a Promise, safeCall chains a `.catch` and returns the same
 * Promise shape; otherwise it's a plain try/catch.
 */

import { createLogger } from './logger.js'

const warnedLabels = new Set()
let defaultLogger = null

function getDefaultLogger() {
  if (!defaultLogger) defaultLogger = createLogger()
  return defaultLogger
}

function emit(log, label, err, logger) {
  if (log === 'silent') return
  const data = {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }
  const msg = label ? `safeCall: ${label}` : 'safeCall: caught'
  if (log === 'warn-once') {
    const key = label ?? msg
    if (warnedLabels.has(key)) return
    warnedLabels.add(key)
  }
  ;(logger ?? getDefaultLogger()).warn(msg, data)
}

/**
 * Run `fn` with a fallback value on throw / rejection. The default log
 * mode is 'warn' so casual usage surfaces failures; the noise-suppressing
 * modes are opt-in.
 *
 * `passThrough` lets a typed error class bubble untouched — callers
 * that need to distinguish e.g. a `DeadlineError` from a generic
 * failure can mark it as pass-through and handle it upstream. Multiple
 * classes may be passed as an array.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{
 *   default?: T,
 *   log?: 'silent' | 'warn' | 'warn-once',
 *   label?: string,
 *   logger?: { warn: (msg: string, data?: object) => void },
 *   passThrough?: Function | Function[],
 * }} [opts]
 * @returns {T | Promise<T>}
 */
export function safeCall(fn, opts = {}) {
  const { default: defaultValue, log = 'warn', label, logger, passThrough } = opts
  const passThroughs = passThrough
    ? (Array.isArray(passThrough) ? passThrough : [passThrough])
    : null
  function shouldRethrow(err) {
    if (!passThroughs) return false
    for (const ctor of passThroughs) {
      if (err instanceof ctor) return true
    }
    return false
  }
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      return result.catch((err) => {
        if (shouldRethrow(err)) throw err
        emit(log, label, err, logger)
        return defaultValue
      })
    }
    return result
  } catch (err) {
    if (shouldRethrow(err)) throw err
    emit(log, label, err, logger)
    return defaultValue
  }
}

/** Test-only: clear the warn-once dedup set between cases. */
export function _resetWarnedLabels() {
  warnedLabels.clear()
  defaultLogger = null
}
