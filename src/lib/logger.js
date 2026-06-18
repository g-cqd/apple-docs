// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Keys whose values get replaced with the literal string "<redacted>"
 * before serialization. Writing `headers`, `cookies`, or a captured
 * request body straight to disk would leak the caller's secret material
 * on a retry or error path.
 */
const REDACT_KEY_RE = /token|secret|authorization|cookie|password|api[_-]?key|bearer/i

/**
 * Cap object depth at 8 — bounds work for adversarial deeply-nested
 * objects landing in `data` (rare in practice; defense in depth).
 */
const REDACT_MAX_DEPTH = 8

export function createLogger(level = process.env.APPLE_DOCS_LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info

  function buildEntry(lvl, msg, data, requestId) {
    const entry = { ts: new Date().toISOString(), level: lvl, msg }
    if (requestId) entry.requestId = requestId
    if (data !== undefined) entry.data = redact(data, 0)
    return entry
  }

  function emit(lvl, msg, data, requestId) {
    if (LEVELS[lvl] < threshold) return
    process.stderr.write(`${JSON.stringify(buildEntry(lvl, msg, data, requestId))}\n`)
  }

  function makeLogger(requestId) {
    return {
      debug: (msg, data) => emit('debug', msg, data, requestId),
      info: (msg, data) => emit('info', msg, data, requestId),
      warn: (msg, data) => emit('warn', msg, data, requestId),
      error: (msg, data) => emit('error', msg, data, requestId),
      /**
       * Returns a child logger that stamps every log line with `requestId`.
       * The base logger is reused; only the closed-over id changes.
       */
      withRequestId(id) {
        return makeLogger(id)
      },
    }
  }

  return makeLogger(null)
}

/**
 * Walk `value` and return a clone with sensitive keys replaced. Stops at
 * REDACT_MAX_DEPTH to bound work; structures deeper than that come back as
 * the literal "<deep>" so the log line is still useful.
 *
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (depth > REDACT_MAX_DEPTH) return '<deep>'
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1))
  }
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEY_RE.test(k)) {
      out[k] = '<redacted>'
    } else {
      out[k] = redact(v, depth + 1)
    }
  }
  return out
}
