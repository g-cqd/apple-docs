import { ValidationError } from '../../lib/errors.js'
/**
 * Drive the Swift codepoint-dump worker against the catalog of
 * synced public SF Symbols and return a `Map<name, codepoint|null>`.
 *
 * One worker process per call. Long-lived: pipe N symbol names down
 * stdin, read N JSON lines back on stdout. The worker's startup cost
 * (~200ms cold + ~100ms PUA reverse-table build) is amortised across
 * the full catalog dump (~16k symbols).
 *
 * Names are PIPELINED in chunks (default 256) rather than one lockstep
 * write→read round trip per symbol: a whole chunk is written to stdin,
 * then its responses are drained. The worker answers strictly in input
 * order, so this stays deterministic while amortising the IPC/event-loop
 * round trip (which cost ~100ms/symbol under load) across the chunk.
 * Chunk sizes are kept well under the 64KB pipe buffer on both sides so
 * neither end can deadlock on backpressure.
 *
 * Budget: the wall-clock cap scales with the requested work
 * (`max(120s, 50ms × names)`) instead of a fixed 30s, plus a 5s
 * per-line idle cap as a liveness check. Exceeding either kills the
 * worker and returns whatever was already collected so sync can
 * continue. The catalog rows that didn't receive a response stay at
 * codepoint=NULL and are retried (and only they are re-requested) on
 * the next sync.
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
function pathsForApp(appPath) {
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
 *   spawn?: Function, wallClockMs?: number, lineTimeoutMs?: number,
 *   chunkSize?: number }} opts
 */
export async function dumpSymbolCodepoints(names, opts) {
  const {
    fontPath,
    metadataDir = METADATA_DIR,
    appPath,
    logger,
    spawn = defaultSpawn,
    // How many names are written to the worker before draining their
    // responses. 256 names (~8KB) and 256 responses (~13KB) both fit
    // comfortably inside the 64KB pipe buffer, so write-then-drain can
    // never deadlock while still amortising the IPC round trip.
    chunkSize = 256,
    // Wall clock sized to the work: generous 50ms/symbol budget with a
    // 2-minute floor. The steady-state pipelined rate is far faster;
    // this is a hang guard, not a pace expectation.
    wallClockMs = Math.max(120_000, names.length * 50),
    lineTimeoutMs = 5_000,
    // The first line carries the worker's cold start (Swift compile + font
    // load), which can exceed the steady-state line idle on slower machines.
    startupTimeoutMs = 60_000,
  } = opts
  if (!fontPath) throw new ValidationError('dumpSymbolCodepoints: fontPath is required', { field: 'fontPath' })
  if (!metadataDir) throw new ValidationError('dumpSymbolCodepoints: metadataDir is required', { field: 'metadataDir' })

  const map = new Map()
  const proc = await spawn({ fontPath, metadataDir, appPath, logger })
  // Generous budget until the worker warms; reset to wallClockMs after the
  // first line so cold-start time doesn't eat into the per-symbol budget.
  let wallClockDeadline = Date.now() + startupTimeoutMs

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

  async function readLine(timeoutMs) {
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
        setTimeout(() => reject(new Error('codepoint worker line timeout')), timeoutMs),
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
  let firstLine = true
  try {
    outer:
    for (let offset = 0; offset < names.length; offset += chunkSize) {
      if (Date.now() > wallClockDeadline) {
        logger?.warn?.(
          `codepoint dump exceeded ${wallClockMs}ms wall clock; processed ${map.size} of ${names.length}`,
        )
        break
      }
      // Pipeline a whole chunk of names, then drain its responses. The
      // worker replies strictly in input order, so results stay
      // deterministic; the round trip is paid once per chunk instead of
      // once per symbol.
      const chunk = names.slice(offset, offset + chunkSize)
      proc.stdin.write(chunk.map(name => `${name}\n`).join(''))
      await proc.stdin.flush?.()
      for (const name of chunk) {
        let line
        try {
          line = await readLine(firstLine ? startupTimeoutMs : lineTimeoutMs)
        } catch (error) {
          logger?.warn?.(`codepoint dump aborted at ${name}: ${error.message}`)
          break outer
        }
        if (line == null) break outer
        if (firstLine) {
          // Worker is warm — start the steady-state wall-clock budget.
          firstLine = false
          wallClockDeadline = Date.now() + wallClockMs
        }
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

/**
 * Read the SF Symbols.app major version (CFBundleShortVersionString → first
 * dotted segment). Drives which MetadataReadingOptions ABI the worker targets.
 * Falls back to the latest known major when unreadable, since we always
 * provision the newest app.
 */
async function appMajorVersion(appPath, logger) {
  try {
    const proc = Bun.spawn(
      ['defaults', 'read', join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    const major = Number.parseInt(out.split('.')[0], 10)
    if (Number.isInteger(major) && major > 0) return major
  } catch { /* fall through */ }
  logger?.debug?.(`SF Symbols app version unreadable at ${appPath}; assuming latest major (8)`)
  return 8
}

async function defaultSpawn({ fontPath, metadataDir, appPath = DEFAULT_APP_PATH, logger }) {
  const {
    symbolCodepointWorkerScript,
    sfSymbolsSharedInterface,
    CORE_GLYPHS_LIB_INTERFACE,
  } = await import('../swift/symbol-codepoint-worker.js')
  const { tmpdir } = await import('node:os')
  const { mkdtemp, rm, mkdir, symlink } = await import('node:fs/promises')

  const paths = pathsForApp(appPath)
  // The MetadataReadingOptions ABI changed in SF Symbols 8; pick the matching
  // interface + init call so the worker links against whatever app we point at.
  const major = await appMajorVersion(appPath, logger)

  // Stage the worker script + handcrafted Swift modules in one
  // mkdtemp-allocated dir. The `.swiftinterface` files let `swiftc`
  // accept `import SFSymbolsShared` / `import CoreGlyphsLib` against
  // frameworks that ship without a `.swiftmodule`. The symlinked
  // `.framework` shells satisfy `-framework` at link/load time. The
  // kernel-randomised mkdtemp suffix closes the symlink-race window
  // that the previous `${pid}-${Math.random()}` path left open.
  const stageDir = await mkdtemp(join(tmpdir(), 'apple-docs-codepoint-worker-'))

  const sharedModuleDir = join(stageDir, 'SFSymbolsShared.swiftmodule')
  const glyphsModuleDir = join(stageDir, 'CoreGlyphsLib.swiftmodule')
  await mkdir(sharedModuleDir, { recursive: true })
  await mkdir(glyphsModuleDir, { recursive: true })

  // Per-arch swiftinterface — Apple Silicon only is fine for this
  // tool; x86_64 hosts run x86_64 Swift script mode and pick up
  // the x86_64 framework slice automatically. We name the interface
  // generically so swift picks it for both arches.
  const arch = process.arch === 'arm64' ? 'arm64-apple-macos' : 'x86_64-apple-macos'
  await Bun.write(join(sharedModuleDir, `${arch}.swiftinterface`), sfSymbolsSharedInterface(major))
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
  await Bun.write(scriptPath, symbolCodepointWorkerScript(major))

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
