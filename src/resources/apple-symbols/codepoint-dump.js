/**
 * Drive the Swift codepoint-dump worker against the catalog of
 * synced public SF Symbols and return a `Map<name, codepoint|null>`.
 *
 * One worker process per call. Long-lived: pipe N symbol names down
 * stdin, read N JSON lines back on stdout. The worker's startup cost
 * (~200ms cold + ~100ms PUA reverse-table build) is amortised across
 * the full catalog dump (~16k symbols), so per-symbol overhead is just
 * the line round-trip — measured at <0.5 ms per symbol locally.
 *
 * Budget: a 30s wall-clock cap on the whole dump and a 5s line idle
 * cap. Exceeding either kills the worker and returns whatever was
 * already collected so sync can continue. The catalog rows that didn't
 * receive a response stay at codepoint=NULL until the next sync.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PUA_RANGES = Object.freeze([
  [0xe000, 0xf8ff],
  [0xf0000, 0xffffd],
  [0x100000, 0x10fffd],
])

function isPrivateUseCodepoint(cp) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  )
}

/**
 * Default font path within a snapshot. Returns null when SF-Pro.ttf
 * is not present — callers should skip the dump rather than crash.
 */
export function resolveSymbolFontPath(dataDir) {
  const candidates = [
    join(dataDir, 'resources', 'fonts', 'extracted', 'sf-pro', 'SF-Pro.ttf'),
    '/System/Library/Fonts/SFNS.ttf',
  ]
  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/**
 * Run the dump. Returns `{ map, total, resolved, skipped, fontPath }`
 * where `map` is `Map<name, number|null>`. Names absent from `map`
 * indicate the worker died before processing them and the catalog
 * row was not touched.
 *
 * @param {string[]} names — list of catalog names to query
 * @param {{ fontPath: string, logger?: object, spawn?: Function,
 *   wallClockMs?: number, lineTimeoutMs?: number }} opts
 */
export async function dumpSymbolCodepoints(names, opts) {
  const {
    fontPath,
    logger,
    spawn = defaultSpawn,
    wallClockMs = 30_000,
    lineTimeoutMs = 5_000,
  } = opts
  if (!fontPath) throw new Error('dumpSymbolCodepoints: fontPath is required')

  const map = new Map()
  const proc = await spawn({ fontPath, logger })
  const wallClockDeadline = Date.now() + wallClockMs

  // Drain stderr in the background so worker crashes are visible.
  void (async () => {
    try {
      const text = await new Response(proc.stderr).text()
      if (text.trim()) logger?.debug?.(`codepoint worker stderr: ${text.trim()}`)
    } catch {}
  })()

  // Read stdout line-by-line. Use a manual splitter rather than line
  // streams because Bun's ReadableStream<Uint8Array> doesn't expose a
  // text-line iterator and the JSON-per-line protocol is trivial to
  // chunk by hand.
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  async function readLine() {
    while (true) {
      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        return line
      }
      // Race the read against a line-level idle timeout.
      const readPromise = reader.read()
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('codepoint worker line timeout')), lineTimeoutMs),
      )
      const { value, done } = await Promise.race([readPromise, timeoutPromise])
      if (done) {
        if (buffer.length > 0) {
          const line = buffer
          buffer = ''
          return line
        }
        return null
      }
      buffer += decoder.decode(value, { stream: true })
    }
  }

  let resolved = 0
  let skipped = 0
  let killed = false
  try {
    for (const name of names) {
      if (Date.now() > wallClockDeadline) {
        logger?.warn?.(
          `codepoint dump exceeded ${wallClockMs}ms wall clock; processed ${map.size} of ${names.length}`,
        )
        break
      }
      proc.stdin.write(`${name}\n`)
      await proc.stdin.flush?.()
      let line
      try {
        line = await readLine()
      } catch (error) {
        logger?.warn?.(`codepoint dump aborted at ${name}: ${error.message}`)
        break
      }
      if (line == null) break
      const parsed = parseLine(line)
      if (!parsed) continue
      if (parsed.codepoint != null) {
        // Defensive: reject anything outside the PUA. The Swift worker
        // only walks PUA ranges, but a stale binary or font swap could
        // in principle return Latin codepoints — we want to catch that
        // here rather than store nonsense in the DB.
        if (!isPrivateUseCodepoint(parsed.codepoint)) {
          logger?.warn?.(
            `codepoint dump: rejecting non-PUA codepoint ${parsed.codepoint} for ${parsed.name}`,
          )
          map.set(parsed.name, null)
          skipped++
          continue
        }
        map.set(parsed.name, parsed.codepoint)
        resolved++
      } else {
        map.set(parsed.name, null)
        skipped++
      }
    }
  } finally {
    try { proc.stdin.end?.() } catch {}
    try { proc.kill() } catch { killed = true }
    void killed
  }
  return { map, total: names.length, resolved, skipped, fontPath }
}

function parseLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed)
    if (typeof obj?.name !== 'string') return null
    const cp = Number.isInteger(obj.codepoint) ? obj.codepoint : null
    return { name: obj.name, codepoint: cp }
  } catch {
    return null
  }
}

async function defaultSpawn({ fontPath, logger }) {
  const { SYMBOL_CODEPOINT_WORKER_SCRIPT } = await import('../swift/symbol-codepoint-worker.js')
  const { tmpdir } = await import('node:os')
  const { rm } = await import('node:fs/promises')
  const scriptPath = join(
    tmpdir(),
    `apple-docs-codepoint-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}.swift`,
  )
  await Bun.write(scriptPath, SYMBOL_CODEPOINT_WORKER_SCRIPT)
  logger?.debug?.(`spawning codepoint worker against ${fontPath}`)
  const proc = Bun.spawn(['swift', scriptPath, fontPath], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
  // Schedule script cleanup once the process exits.
  void (async () => {
    try { await proc.exited } catch {}
    void rm(scriptPath, { force: true }).catch(() => {})
  })()
  return proc
}

// Exported for tests so a fake spawn can replace the Swift step.
export const _internals = { isPrivateUseCodepoint, parseLine, PUA_RANGES }
