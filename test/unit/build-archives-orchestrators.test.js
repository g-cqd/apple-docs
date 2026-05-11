import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSymbolsArchive } from '../../scripts/build-symbols-archive.js'
import { buildFontsArchives, FONT_FAMILIES } from '../../scripts/build-fonts-archives.js'
import { resolveSevenZipBinary } from '../../src/lib/archive-7z.js'

let dataDir
let outDir

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-arc-orch-data-'))
  outDir = mkdtempSync(join(tmpdir(), 'apple-docs-arc-orch-out-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

let hasSevenZip = true
try { resolveSevenZipBinary() } catch { hasSevenZip = false }
const describeIf = hasSevenZip ? describe : describe.skip

describeIf('buildSymbolsArchive', () => {
  test('emits one symbols-<tag>.7z plus a sidecar from a public+private fixture', async () => {
    const sym = join(dataDir, 'resources', 'symbols')
    mkdirSync(join(sym, 'public', 'regular-medium'), { recursive: true })
    writeFileSync(join(sym, 'public', 'regular-medium', 'heart.svg'), '<svg/>')
    mkdirSync(join(sym, 'private'), { recursive: true })
    writeFileSync(join(sym, 'private', 'pencil.svg'), '<svg/>')

    const result = await buildSymbolsArchive({ dataDir, outDir, tag: 'snap-test' })
    expect(result).not.toBeNull()
    expect(result.name).toBe('symbols-snap-test.7z')
    expect(existsSync(result.path)).toBe(true)
    expect(existsSync(`${result.path}.sha256`)).toBe(true)
    expect(result.size).toBeGreaterThan(0)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.fileCount).toBe(2)
  })

  test('returns null when no symbols dir exists', async () => {
    const result = await buildSymbolsArchive({ dataDir, outDir, tag: 'snap-empty' })
    expect(result).toBeNull()
  })
})

describeIf('buildFontsArchives', () => {
  test('emits per-family + fonts-all archives only for present families', async () => {
    const fontsRoot = join(dataDir, 'resources', 'fonts', 'extracted')
    mkdirSync(join(fontsRoot, 'sf-pro'), { recursive: true })
    writeFileSync(join(fontsRoot, 'sf-pro', 'SF-Pro.otf'), 'fakeotf-pro')
    mkdirSync(join(fontsRoot, 'sf-mono'), { recursive: true })
    writeFileSync(join(fontsRoot, 'sf-mono', 'SF-Mono.otf'), 'fakeotf-mono')

    const result = await buildFontsArchives({ dataDir, outDir, tag: 'snap-fonts' })
    // fonts-all + 2 family archives
    expect(result.all).not.toBeNull()
    expect(result.all.name).toBe('fonts-all-snap-fonts.7z')
    expect(existsSync(result.all.path)).toBe(true)
    expect(existsSync(`${result.all.path}.sha256`)).toBe(true)

    expect(Object.keys(result.byFamily).sort()).toEqual(['sf-mono', 'sf-pro'])
    for (const fam of ['sf-pro', 'sf-mono']) {
      const a = result.byFamily[fam]
      expect(a.name).toBe(`fonts-${fam}-snap-fonts.7z`)
      expect(existsSync(a.path)).toBe(true)
      expect(existsSync(`${a.path}.sha256`)).toBe(true)
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    }

    // No archive for families not present
    for (const fam of FONT_FAMILIES) {
      if (fam === 'sf-pro' || fam === 'sf-mono') continue
      expect(existsSync(join(outDir, `fonts-${fam}-snap-fonts.7z`))).toBe(false)
    }
  })

  test('returns empty result when no fonts dir exists', async () => {
    const result = await buildFontsArchives({ dataDir, outDir, tag: 'snap-empty-fonts' })
    expect(result.all).toBeNull()
    expect(result.byFamily).toEqual({})
  })

  test('FONT_FAMILIES exports the 8 canonical slugs', () => {
    expect(FONT_FAMILIES).toEqual([
      'sf-pro',
      'sf-compact',
      'sf-mono',
      'new-york',
      'sf-arabic',
      'sf-armenian',
      'sf-georgian',
      'sf-hebrew',
    ])
  })
})
