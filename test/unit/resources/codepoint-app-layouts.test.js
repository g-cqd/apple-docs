import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  resolveSymbolFontPath,
} from '../../../src/resources/apple-symbols/codepoint-dump.js'

// SF Symbols.app bundle layouts the codepoint worker must locate:
//   nested  (≤ 8.x) — CoreGlyphsLib.framework inside
//                     SFSymbolsShared.framework/Versions/A/Frameworks/
//   sibling (27+)   — CoreGlyphsLib.framework next to SFSymbolsShared.framework
// Both are classic versioned macOS frameworks; a shallow (`<name>` directly in
// the .framework) binary is accepted too. SF Symbols 27 shipped the sibling
// layout and the previous nested-only resolver returned null → sync skipped
// codepoint stamping for the whole catalog.

const { pathsForApp } = _internals
const tmps = []
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }) })

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'sfsymbols-layout-'))
  tmps.push(dir)
  return dir
}

function touch(path) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

/** Versioned framework: Versions/A/<name> + the conventional top-level symlink. */
function versionedFramework(dir, name) {
  const fw = join(dir, `${name}.framework`)
  touch(join(fw, 'Versions', 'A', name))
  symlinkSync(join('Versions', 'A'), join(fw, 'Versions', 'Current'))
  symlinkSync(join('Versions', 'Current', name), join(fw, name))
  return fw
}

function makeApp(root, layout) {
  const app = join(root, 'SF Symbols.app')
  touch(join(app, 'Contents', 'Resources', 'Fonts', 'SFSymbolsFallback.otf'))
  const frameworks = join(app, 'Contents', 'Frameworks')
  const shared = versionedFramework(frameworks, 'SFSymbolsShared')
  if (layout === 'nested') {
    versionedFramework(join(shared, 'Versions', 'A', 'Frameworks'), 'CoreGlyphsLib')
  } else if (layout === 'sibling') {
    versionedFramework(frameworks, 'CoreGlyphsLib')
  } else if (layout === 'shallow') {
    // iOS-style frameworks: no Versions tree at all.
    rmSync(shared, { recursive: true, force: true })
    touch(join(frameworks, 'SFSymbolsShared.framework', 'SFSymbolsShared'))
    touch(join(frameworks, 'CoreGlyphsLib.framework', 'CoreGlyphsLib'))
  }
  return app
}

describe('pathsForApp — SF Symbols.app bundle layouts', () => {
  test('nested (≤ 8.x): CoreGlyphsLib inside SFSymbolsShared/Versions/A/Frameworks', () => {
    const app = makeApp(scratch(), 'nested')
    const p = pathsForApp(app)
    expect(p.layout).toBe('nested')
    expect(p.sharedBinary).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/Versions/A/SFSymbolsShared'))
    expect(p.glyphsLibFrameworkDir).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/Versions/A/Frameworks'))
    expect(p.glyphsBinary).toBe(join(p.glyphsLibFrameworkDir, 'CoreGlyphsLib.framework/Versions/A/CoreGlyphsLib'))
    expect(existsSync(p.sharedBinary)).toBe(true)
    expect(existsSync(p.glyphsBinary)).toBe(true)
  })

  test('sibling (27+): CoreGlyphsLib promoted next to SFSymbolsShared', () => {
    const app = makeApp(scratch(), 'sibling')
    const p = pathsForApp(app)
    expect(p.layout).toBe('sibling')
    expect(p.sharedBinary).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/Versions/A/SFSymbolsShared'))
    expect(p.glyphsLibFrameworkDir).toBe(join(app, 'Contents/Frameworks'))
    expect(p.glyphsBinary).toBe(join(app, 'Contents/Frameworks/CoreGlyphsLib.framework/Versions/A/CoreGlyphsLib'))
    expect(existsSync(p.sharedBinary)).toBe(true)
    expect(existsSync(p.glyphsBinary)).toBe(true)
  })

  test('shallow frameworks (no Versions tree) resolve the bare binaries', () => {
    const app = makeApp(scratch(), 'shallow')
    const p = pathsForApp(app)
    expect(p.layout).toBe('sibling')
    expect(p.sharedBinary).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/SFSymbolsShared'))
    expect(p.glyphsBinary).toBe(join(app, 'Contents/Frameworks/CoreGlyphsLib.framework/CoreGlyphsLib'))
    expect(existsSync(p.sharedBinary)).toBe(true)
    expect(existsSync(p.glyphsBinary)).toBe(true)
  })

  test('a missing bundle falls back to the legacy nested shape (never throws)', () => {
    const app = join(scratch(), 'nope', 'SF Symbols.app')
    const p = pathsForApp(app)
    expect(p.layout).toBe('nested')
    expect(p.sharedBinary).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/Versions/A/SFSymbolsShared'))
    expect(p.glyphsBinary).toBe(join(app, 'Contents/Frameworks/SFSymbolsShared.framework/Versions/A/Frameworks/CoreGlyphsLib.framework/Versions/A/CoreGlyphsLib'))
    expect(p.fontPath).toBe(join(app, 'Contents/Resources/Fonts/SFSymbolsFallback.otf'))
    expect(p.metadataDir).toMatch(/SFSymbols\.framework\/Resources\/metadata$/)
  })

  test('framework shells alone (no binaries) do not count as a usable bundle', () => {
    // The pre-27 resolver only stat'd the .framework directories, which is
    // exactly what let a sibling-layout app slip through as "present" while
    // the symlink step later pointed at a non-existent Versions/A binary.
    const app = join(scratch(), 'SF Symbols.app')
    touch(join(app, 'Contents', 'Resources', 'Fonts', 'SFSymbolsFallback.otf'))
    mkdirSync(join(app, 'Contents', 'Frameworks', 'SFSymbolsShared.framework', 'Versions', 'A', 'Frameworks', 'CoreGlyphsLib.framework'), { recursive: true })
    const p = pathsForApp(app)
    expect(existsSync(p.sharedFramework)).toBe(true)
    expect(existsSync(p.sharedBinary)).toBe(false)
    expect(existsSync(p.glyphsBinary)).toBe(false)
  })
})

describe('resolveSymbolFontPath — layout-independent acceptance', () => {
  // The system metadata dir only exists on macOS; elsewhere every bundle is
  // rejected on that check, so the acceptance assertions are macOS-only while
  // the rejection assertions run everywhere.
  const hasSystemMetadata = existsSync('/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata')

  test.skipIf(!hasSystemMetadata)('accepts nested, sibling and shallow bundles', () => {
    for (const layout of ['nested', 'sibling', 'shallow']) {
      const app = makeApp(scratch(), layout)
      const resolved = resolveSymbolFontPath(null, { appPath: app })
      expect(resolved, `layout=${layout}`).not.toBeNull()
      expect(resolved.appPath).toBe(app)
      expect(resolved.fontPath.endsWith('SFSymbolsFallback.otf')).toBe(true)
    }
  })

  test('rejects a bundle whose CoreGlyphsLib binary is missing', () => {
    const app = makeApp(scratch(), 'sibling')
    rmSync(join(app, 'Contents', 'Frameworks', 'CoreGlyphsLib.framework'), { recursive: true, force: true })
    // Falls through to /Applications/SF Symbols.app — accept either a null or
    // a result that is NOT our synthetic app.
    const resolved = resolveSymbolFontPath(null, { appPath: app })
    if (resolved != null) expect(resolved.appPath).not.toBe(app)
  })

  test('rejects a bundle without the fallback font', () => {
    const app = makeApp(scratch(), 'nested')
    rmSync(join(app, 'Contents', 'Resources'), { recursive: true, force: true })
    const resolved = resolveSymbolFontPath(null, { appPath: app })
    if (resolved != null) expect(resolved.appPath).not.toBe(app)
  })
})
