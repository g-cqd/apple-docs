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
    stream.write(line)
    if (logPath) appendFileSync(logPath, line)
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
