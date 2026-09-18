/**
 * Locate, inside an `SF Symbols.app` bundle, everything the codepoint
 * worker (codepoint-dump.js) needs: the catalog font, the two private
 * frameworks it links (SFSymbolsShared + CoreGlyphsLib) and the system
 * metadata directory.
 *
 * Split out of codepoint-dump.js when SF Symbols 27 moved CoreGlyphsLib
 * and the resolver grew layout probing.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Catalog metadata lives in the system framework, independent of which
// SF Symbols.app the worker targets. The Resources are plain plists +
// the (encrypted) metadata.store; SFSymbolsShared.SymbolFontReader
// reads them regardless of the framework binary's origin.
export const METADATA_DIR =
  '/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata'

export const DEFAULT_APP_PATH = '/Applications/SF Symbols.app'

/** First candidate that exists on disk, else the first candidate (the
 *  legacy layout) so callers that only pretend (tests) get a stable shape. */
function firstExisting(candidates) {
  return candidates.find(p => existsSync(p)) ?? candidates[0]
}

/**
 * Build the set of paths the codepoint worker needs from a given
 * SF Symbols.app bundle.
 *
 * Two bundle layouts are supported — the worker symlinks the framework
 * BINARIES into its staging dir and puts the framework DIRECTORIES on
 * DYLD_FRAMEWORK_PATH, so both need to be resolved per layout:
 *
 *   - `nested` (SF Symbols ≤ 8.x): CoreGlyphsLib lives inside
 *     SFSymbolsShared's bundle.
 *       Contents/Frameworks/SFSymbolsShared.framework/Versions/A/SFSymbolsShared
 *       Contents/Frameworks/SFSymbolsShared.framework/Versions/A/Frameworks/
 *         CoreGlyphsLib.framework/Versions/A/CoreGlyphsLib
 *   - `sibling` (SF Symbols 27+): CoreGlyphsLib promoted next to
 *     SFSymbolsShared (both still classic versioned macOS frameworks).
 *       Contents/Frameworks/SFSymbolsShared.framework/Versions/A/SFSymbolsShared
 *       Contents/Frameworks/CoreGlyphsLib.framework/Versions/A/CoreGlyphsLib
 *
 * Binaries are probed at `Versions/A/<name>` first, then the flat
 * `<name>` (iOS-style shallow frameworks, in case a future app drops the
 * Versions tree). Probing is by existence (cheap stat calls); when
 * nothing exists the legacy `nested` paths are returned so
 * `resolveSymbolFontPath` can reject the bundle and tests can build
 * synthetic layouts.
 *
 * @param {string} appPath absolute path to SF Symbols.app
 * @returns {{ appPath: string, fontPath: string, metadataDir: string,
 *   sharedFramework: string, sharedFrameworkDir: string, sharedBinary: string,
 *   glyphsLibFrameworkDir: string, glyphsFramework: string, glyphsBinary: string,
 *   layout: 'nested'|'sibling' }}
 */
export function pathsForApp(appPath) {
  const sharedFrameworkDir = join(appPath, 'Contents', 'Frameworks')
  const sharedFramework = join(sharedFrameworkDir, 'SFSymbolsShared.framework')
  const sharedBinary = firstExisting([
    join(sharedFramework, 'Versions', 'A', 'SFSymbolsShared'),
    join(sharedFramework, 'SFSymbolsShared'),
  ])
  // Directory that CONTAINS CoreGlyphsLib.framework (goes on DYLD_FRAMEWORK_PATH).
  const glyphsLibFrameworkDir = firstExisting([
    join(sharedFramework, 'Versions', 'A', 'Frameworks'),
    join(sharedFramework, 'Frameworks'),
    sharedFrameworkDir,
  ].map(dir => join(dir, 'CoreGlyphsLib.framework'))).replace(/\/CoreGlyphsLib\.framework$/, '')
  const glyphsFramework = join(glyphsLibFrameworkDir, 'CoreGlyphsLib.framework')
  const glyphsBinary = firstExisting([
    join(glyphsFramework, 'Versions', 'A', 'CoreGlyphsLib'),
    join(glyphsFramework, 'CoreGlyphsLib'),
  ])
  const layout = glyphsLibFrameworkDir === sharedFrameworkDir ? 'sibling' : 'nested'
  const fontPath = join(appPath, 'Contents', 'Resources', 'Fonts', 'SFSymbolsFallback.otf')
  return {
    appPath,
    fontPath,
    metadataDir: METADATA_DIR,
    sharedFramework,
    sharedFrameworkDir,
    sharedBinary,
    glyphsLibFrameworkDir,
    glyphsFramework,
    glyphsBinary,
    layout,
  }
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
    // The worker symlinks these two binaries, so they (not just the
    // .framework shells) must resolve for whichever layout the app uses.
    if (!existsSync(paths.sharedBinary)) continue
    if (!existsSync(paths.glyphsBinary)) continue
    if (!existsSync(paths.metadataDir)) continue
    return paths
  }
  return null
}
