/**
 * Resolve the Swift driver used to run our `.swift` helper scripts.
 *
 * These scripts run in interpreter/JIT mode and link AppKit at runtime
 * (NSImage, NSColor, NSFontWeight*, NSImageSymbolConfiguration, and the
 * private CoreGlyphs bundles). Only the toolchain that ships with the
 * selected Xcode / Command Line Tools can materialize those symbols.
 *
 * A bare `swift` picks whatever is first on PATH, which on machines with a
 * toolchain manager (swiftly, a downloaded swift.org snapshot, TOOLCHAINS
 * overrides) is an open-source build with no macOS SDK stubs. It fails at
 * JIT link time with:
 *
 *     JIT session error: Symbols not found: [ _OBJC_CLASS_$_NSImage, … ]
 *
 * and the worker dies before writing a frame — surfacing as a flood of
 * "worker exited" pre-render failures. CI never saw it because the runner
 * images have exactly one Swift on PATH: Xcode's.
 *
 * Resolution order: `xcrun -f swift` (honours xcode-select and
 * DEVELOPER_DIR) → `/usr/bin/swift` (the same shim, if xcrun is unusable)
 * → `swift` (non-macOS or unusual layouts; let PATH decide).
 */

import { existsSync } from 'node:fs'

let cached = null

/**
 * Absolute path to the Swift driver, memoized for the process.
 * @returns {string}
 */
export function resolveSwiftBinary() {
  if (cached) return cached
  cached = detectSwiftBinary()
  return cached
}

/** Reset the memo. Test seam. */
export function resetSwiftBinaryCache() {
  cached = null
}

function detectSwiftBinary() {
  if (process.platform !== 'darwin') return 'swift'
  try {
    const proc = Bun.spawnSync(['/usr/bin/xcrun', '-f', 'swift'], { stdout: 'pipe', stderr: 'pipe' })
    if (proc.exitCode === 0) {
      const path = new TextDecoder().decode(proc.stdout).trim()
      if (path && existsSync(path)) return path
    }
  } catch {
    // xcrun missing or not executable — fall through.
  }
  if (existsSync('/usr/bin/swift')) return '/usr/bin/swift'
  return 'swift'
}
