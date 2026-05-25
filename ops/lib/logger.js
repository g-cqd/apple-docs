/**
 * Operator-facing logger for ops/cli.js. Mirrors the `say()` / `run()`
 * idiom every bash script in ops/bin used:
 *
 *   say "stopping mt.everest.apple-docs.web"
 *     → [2026-05-13T02:31:02+02:00] stopping mt.everest.apple-docs.web
 *   run launchctl bootout system/foo
 *     → [2026-05-13T02:31:02+02:00] $ launchctl bootout system/foo
 *       <command's stdout/stderr>
 *
 * Output goes to two destinations: a per-script log file under
 * ops/logs/ (operator audit trail) and a process stream (stderr by
 * default — operators tail it while a deploy runs). Both are
 * injectable for tests.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Redact common credential shapes from arbitrary text before it
 * lands on disk. This is `ops/`'s analog of the `redact()` helper in
 * `src/lib/logger.js`, adapted for free-form text instead of structured
 * payloads — `runOutput()` forwards raw subprocess stdout, which on
 * `ops/cmd/cf-purge` and `ops/cmd/pull-snapshot` can include HTTP
 * Authorization headers or response bodies from Cloudflare / GitHub.
 *
 * Patterns covered:
 *   - HTTP headers: `Authorization:`, `Cookie:`, `X-API-Key:`,
 *     `X-Auth-Token:` (case-insensitive)
 *   - JSON property values for `token`, `secret`, `authorization`,
 *     `cookie`, `password`, `api[_-]?key`, `bearer` (case-insensitive)
 *   - URL query strings: `?token=…`, `&api_key=…`, etc.
 *
 * Each match is replaced with `<redacted>`. Resolves CodeQL
 * `js/http-to-file-access` on the ops logger by ensuring that a
 * subprocess's HTTP-bearing output cannot leak unredacted to disk.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    // HTTP-style headers. The header name must be preceded by start-of-line
    // or a non-letter punctuation (typical of curl `> ` / `< ` verbose
    // output prefixes). Terminator is CR/LF.
    .replace(/((?:^|[^A-Za-z])(?:authorization|cookie|x-api-key|x-auth-token|x-cloudflare-token|x-amz-security-token)\s*:\s*)[^\r\n]+/gi,
      (_m, prefix) => `${prefix}<redacted>`)
    // JSON-ish "key": "value" pairs. Greedy until the closing quote.
    .replace(/(["'](?:token|secret|authorization|cookie|password|api[_-]?key|bearer)["']\s*:\s*["'])[^"'\\]+(["'])/gi,
      (_m, prefix, suffix) => `${prefix}<redacted>${suffix}`)
    // URL query-string fragments.
    .replace(/([?&](?:token|secret|api[_-]?key|access[_-]?token|auth)=)[^&\s]+/gi,
      (_m, prefix) => `${prefix}<redacted>`)
}

/**
 * @typedef {Object} LoggerOptions
 * @property {string} [logPath]                      File to append to; defaults to no-file logging
 * @property {{ write: (s: string) => void }} [stream]  Defaults to a stderr wrapper
 * @property {() => Date} [clock]                    Defaults to () => new Date()
 *
 * @typedef {Object} Logger
 * @property {(msg: string) => void} say                Timestamp + message
 * @property {(msg: string) => void} warn               Timestamp + WARN: prefix
 * @property {(msg: string) => void} error              Timestamp + ERROR: prefix
 * @property {(cmd: string, args?: string[]) => void} runStart   Logs `$ cmd args…`
 * @property {(text: string) => void} runOutput          Mirrors a command's stdout/stderr chunk
 * @property {() => string | undefined} logPath          Currently-bound log file
 */

/**
 * @param {LoggerOptions} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const stream = opts.stream ?? { write: (s) => process.stderr.write(s) }
  const clock = opts.clock ?? (() => new Date())
  const logPath = opts.logPath

  if (logPath) {
    const dir = dirname(logPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  function write(line) {
    const safe = redactSensitive(line)
    stream.write(safe)
    if (logPath) appendFileSync(logPath, safe)
  }

  function format(prefix, msg) {
    return `[${isoOffset(clock())}] ${prefix}${msg}\n`
  }

  return {
    say(msg) { write(format('', msg)) },
    warn(msg) { write(format('WARN: ', msg)) },
    error(msg) { write(format('ERROR: ', msg)) },
    runStart(cmd, args = []) {
      const formatted = [cmd, ...args].join(' ')
      write(format('$ ', formatted))
    },
    runOutput(text) {
      if (!text) return
      // Subcommand output is already line-terminated; don't add another
      // newline. If the chunk doesn't end with one we still pass it
      // through verbatim — the operator-side tail behaves the same.
      // All output passes through redactSensitive() inside write() so
      // bearer tokens and HTTP auth headers don't land in the ops log.
      write(text)
    },
    logPath() { return logPath },
  }
}

/**
 * Format a Date as `2026-05-13T02:31:02+02:00` to match the bash
 * `date -Iseconds` output the existing log scrapers expect. Exposed
 * for tests.
 */
export function isoOffset(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const tz = -date.getTimezoneOffset() // minutes east of UTC
  const sign = tz >= 0 ? '+' : '-'
  const abs = Math.abs(tz)
  const tzH = pad(Math.floor(abs / 60))
  const tzM = pad(abs % 60)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${tzH}:${tzM}`
  )
}
