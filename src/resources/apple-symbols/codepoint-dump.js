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

// Catalog metadata lives in the system framework, independent of which
// SF Symbols.app the worker targets. The Resources are plain plists +
// the (encrypted) metadata.store; SFSymbolsShared.SymbolFontReader
// reads them regardless of the framework binary's origin.
const METADATA_DIR =
  '/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata'

const DEFAULT_APP_PATH = '/Applications/SF Symbols.app'

/**
 * Build the set of paths the codepoint worker needs from a given
 * SF Symbols.app bundle. Pure path arithmetic; no FS checks here so
 * the call is cheap and the caller can validate or pretend (for tests).
 *
 * @param {string} appPath absolute path to SF Symbols.app
 * @returns {{ fontPath: string, metadataDir: string, sharedFramework: string,
 *   sharedFrameworkDir: string, glyphsLibFrameworkDir: string }}
 */
export function pathsForApp(appPath) {
  const sharedFrameworkDir = join(appPath, 'Contents', 'Frameworks')
  const sharedFramework = join(sharedFrameworkDir, 'SFSymbolsShared.framework')
  const glyphsLibFrameworkDir = join(
    sharedFramework,
    'Versions', 'A', 'Frameworks',
  )
  const fontPath = join(appPath, 'Contents', 'Resources', 'Fonts', 'SFSymbolsFallback.otf')
  return {
    appPath,
    fontPath,
    metadataDir: METADATA_DIR,
    sharedFramework,
    sharedFrameworkDir,
    glyphsLibFrameworkDir,
  }
}

function isPrivateUseCodepoint(cp) {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  )
}

/**
 * Resolve the catalog font + metadata directory the worker needs.
 * Returns `{ appPath, fontPath, metadataDir, ... }` or `null` when no
 * usable SF Symbols.app is present at the supplied path nor at
 * /Applications/SF Symbols.app.
 *
 * @param {string} _dataDir kept for callsite compatibility (unused)
 * @param {{ appPath?: string }} [opts] explicit SF Symbols.app path
 *   (typically from `ensureSfSymbolsApp`). Falls back to /Applications.
 * @returns {ReturnType<typeof pathsForApp> | null}
 */
export function resolveSymbolFontPath(_dataDir, opts = {}) {
  const candidates = []
  if (opts.appPath) candidates.push(opts.appPath)
  candidates.push(DEFAULT_APP_PATH)
  for (const appPath of candidates) {
    const paths = pathsForApp(appPath)
    if (!existsSync(paths.fontPath)) continue
    if (!existsSync(paths.sharedFramework)) continue
    if (!existsSync(paths.glyphsLibFrameworkDir)) continue
    if (!existsSync(paths.metadataDir)) continue
    return paths
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
 * @param {{ fontPath: string, metadataDir?: string, logger?: object,
 *   spawn?: Function, wallClockMs?: number, lineTimeoutMs?: number }} opts
 */
export async function dumpSymbolCodepoints(names, opts) {
  const {
    fontPath,
    metadataDir = METADATA_DIR,
    appPath,
    logger,
    spawn = defaultSpawn,
    wallClockMs = 30_000,
    lineTimeoutMs = 5_000,
  } = opts
  if (!fontPath) throw new Error('dumpSymbolCodepoints: fontPath is required')
  if (!metadataDir) throw new Error('dumpSymbolCodepoints: metadataDir is required')

  const map = new Map()
  const proc = await spawn({ fontPath, metadataDir, appPath, logger })
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

async function defaultSpawn({ fontPath, metadataDir, appPath = DEFAULT_APP_PATH, logger }) {
  const {
    SYMBOL_CODEPOINT_WORKER_SCRIPT,
    SF_SYMBOLS_SHARED_INTERFACE,
    CORE_GLYPHS_LIB_INTERFACE,
  } = await import('../swift/symbol-codepoint-worker.js')
  const { tmpdir } = await import('node:os')
  const { rm, mkdir, symlink } = await import('node:fs/promises')

  const paths = pathsForApp(appPath)

  // Stage the worker script + handcrafted Swift modules in one temp
  // dir. The `.swiftinterface` files let `swiftc` accept `import
  // SFSymbolsShared` / `import CoreGlyphsLib` against frameworks that
  // ship without a `.swiftmodule`. The symlinked `.framework` shells
  // satisfy `-framework` at link/load time.
  const stageDir = join(
    tmpdir(),
    `apple-docs-codepoint-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )
  await mkdir(stageDir, { recursive: true })

  const sharedModuleDir = join(stageDir, 'SFSymbolsShared.swiftmodule')
  const glyphsModuleDir = join(stageDir, 'CoreGlyphsLib.swiftmodule')
  await mkdir(sharedModuleDir, { recursive: true })
  await mkdir(glyphsModuleDir, { recursive: true })

  // Per-arch swiftinterface — Apple Silicon only is fine for this
  // tool; x86_64 hosts run x86_64 Swift script mode and pick up
  // the x86_64 framework slice automatically. We name the interface
  // generically so swift picks it for both arches.
  const arch = process.arch === 'arm64' ? 'arm64-apple-macos' : 'x86_64-apple-macos'
  await Bun.write(join(sharedModuleDir, `${arch}.swiftinterface`), SF_SYMBOLS_SHARED_INTERFACE)
  await Bun.write(join(glyphsModuleDir, `${arch}.swiftinterface`), CORE_GLYPHS_LIB_INTERFACE)

  // Two-level framework search path — SFSymbolsShared lives one level
  // up, CoreGlyphsLib lives nested inside SFSymbolsShared's bundle.
  const sharedFwShellDir = join(stageDir, 'SFSymbolsShared.framework')
  const glyphsFwShellDir = join(stageDir, 'CoreGlyphsLib.framework')
  await mkdir(sharedFwShellDir, { recursive: true })
  await mkdir(glyphsFwShellDir, { recursive: true })
  await symlink(
    join(paths.sharedFramework, 'Versions', 'A', 'SFSymbolsShared'),
    join(sharedFwShellDir, 'SFSymbolsShared'),
  )
  await symlink(
    join(paths.glyphsLibFrameworkDir, 'CoreGlyphsLib.framework', 'Versions', 'A', 'CoreGlyphsLib'),
    join(glyphsFwShellDir, 'CoreGlyphsLib'),
  )

  const scriptPath = join(stageDir, 'worker.swift')
  await Bun.write(scriptPath, SYMBOL_CODEPOINT_WORKER_SCRIPT)

  logger?.debug?.(`spawning codepoint worker against ${fontPath} (app=${appPath})`)
  const proc = Bun.spawn(
    [
      'swift',
      '-I', stageDir,
      '-F', stageDir,
      '-framework', 'SFSymbolsShared',
      '-framework', 'CoreGlyphsLib',
      scriptPath,
      fontPath,
      metadataDir,
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
      env: {
        ...process.env,
        // Runtime loader needs the real framework tree so the
        // symlinks resolve at exec time (dyld follows the link, then
        // re-resolves rpath-relative @rpath/CoreGlyphsLib inside the
        // SFSymbolsShared.framework bundle).
        DYLD_FRAMEWORK_PATH: [
          paths.glyphsLibFrameworkDir,
          paths.sharedFrameworkDir,
          process.env.DYLD_FRAMEWORK_PATH,
        ].filter(Boolean).join(':'),
      },
    },
  )
  // Schedule stage cleanup once the process exits.
  void (async () => {
    try { await proc.exited } catch {}
    void rm(stageDir, { recursive: true, force: true }).catch(() => {})
  })()
  return proc
}

// Exported for tests so a fake spawn can replace the Swift step.
export const _internals = { isPrivateUseCodepoint, parseLine, PUA_RANGES }
