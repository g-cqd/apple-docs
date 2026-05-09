const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Keys whose values get replaced with the literal string "<redacted>"
 * before serialization. Audit A30: a logger that ships `headers`,
 * `cookies`, or a captured request body straight to disk leaks the
 * caller's secret material on a retry / error.
 */
const REDACT_KEY_RE = /token|secret|authorization|cookie|password|api[_-]?key|bearer/i

/**
 * Cap object depth at 8 — bounds work for adversarial deeply-nested
 * objects landing in `data` (rare in practice; defense in depth).
 */
const REDACT_MAX_DEPTH = 8

export function createLogger(level = process.env.APPLE_DOCS_LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info

  function log(lvl, msg, data) {
    if (LEVELS[lvl] < threshold) return
    const entry = { ts: new Date().toISOString(), level: lvl, msg }
    if (data !== undefined) entry.data = redact(data, 0)
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  }
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
