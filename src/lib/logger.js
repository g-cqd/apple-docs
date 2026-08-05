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

/**
 * Everything goes to stderr by DEFAULT, and that default is load-bearing:
 * `apple-docs mcp start` speaks JSON-RPC over stdout, so a stray log line
 * there corrupts the protocol stream.
 *
 * The cost is that a long-lived HTTP daemon writes its entire request log to
 * the "error" file. On the reference deployment that produced a 199 MB
 * apple-docs-mcp.err.log consisting almost entirely of `info` request lines,
 * with an empty .log beside it — real failures were invisible in the noise.
 *
 * `APPLE_DOCS_LOG_STDOUT=1` opts into the conventional split: debug/info to
 * stdout, warn/error to stderr. Set it only where stdout is not a protocol
 * channel — the ops launchd templates set it for the web and MCP *HTTP*
 * daemons, never for the stdio server.
 *
 * @param {string} [level]
 * @param {{ splitStreams?: boolean }} [opts]
 */
export function createLogger(level = process.env.APPLE_DOCS_LOG_LEVEL || 'info', opts = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const splitStreams = opts.splitStreams ?? process.env.APPLE_DOCS_LOG_STDOUT === '1'

  function buildEntry(lvl, msg, data, requestId) {
    const entry = { ts: new Date().toISOString(), level: lvl, msg }
    if (requestId) entry.requestId = requestId
    if (data !== undefined) entry.data = redact(data, 0)
    return entry
  }

  function emit(lvl, msg, data, requestId) {
    if (LEVELS[lvl] < threshold) return
    const line = `${JSON.stringify(buildEntry(lvl, msg, data, requestId))}\n`
    const stream = splitStreams && LEVELS[lvl] < LEVELS.warn ? process.stdout : process.stderr
    stream.write(line)
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
