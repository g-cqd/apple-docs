import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findAppInTree,
  findAppInVolumes,
  findPkgInVolumes,
  isSfSymbolsAppName,
  parseHdiutilMountPoints,
} from '../../../src/resources/sf-symbols-app/dmg-helpers.js'

describe('parseHdiutilMountPoints', () => {
  // Apple's SF Symbols .dmg is SLA-wrapped: `hdiutil attach -plist` returns
  // a whole-disk entity (no mount-point) plus the mounted app volume. The
  // parser must skip the former and return only real mount points.
  test('returns only entities that carry a mount-point', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>system-entities</key>
  <array>
    <dict>
      <key>content-hint</key><string>GUID_partition_scheme</string>
      <key>dev-entry</key><string>/dev/disk4</string>
    </dict>
    <dict>
      <key>content-hint</key><string>Apple_HFS</string>
      <key>dev-entry</key><string>/dev/disk4s1</string>
      <key>mount-point</key><string>/Volumes/SFSymbols</string>
    </dict>
  </array>
</dict></plist>`
    expect(parseHdiutilMountPoints(plist)).toEqual(['/Volumes/SFSymbols'])
  })

  test('captures multiple mounted volumes in order', () => {
    const plist = `
      <key>mount-point</key><string>/Volumes/A</string>
      <key>dev-entry</key><string>/dev/disk9</string>
      <key>mount-point</key>
      <string>/Volumes/B</string>`
    expect(parseHdiutilMountPoints(plist)).toEqual(['/Volumes/A', '/Volumes/B'])
  })

  test('decodes XML entities in volume names', () => {
    const plist = '<key>mount-point</key><string>/Volumes/Tom &amp; Jerry</string>'
    expect(parseHdiutilMountPoints(plist)).toEqual(['/Volumes/Tom & Jerry'])
  })

  test('returns [] when nothing is mounted', () => {
    expect(parseHdiutilMountPoints('<key>dev-entry</key><string>/dev/disk4</string>')).toEqual([])
    expect(parseHdiutilMountPoints('')).toEqual([])
  })
})

describe('volume / package discovery', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'apple-docs-dmg-helpers-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('findAppInVolumes finds a loose SF Symbols.app at a volume root', () => {
    const vol = join(root, 'vol-app')
    mkdirSync(join(vol, 'SF Symbols.app', 'Contents'), { recursive: true })
    const other = join(root, 'vol-empty')
    mkdirSync(other, { recursive: true })
    expect(findAppInVolumes([other, vol])).toBe(join(vol, 'SF Symbols.app'))
    expect(findAppInVolumes([other])).toBeNull()
  })

  test('findAppInVolumes accepts the beta-channel bundle name', () => {
    const vol = join(root, 'vol-beta')
    mkdirSync(join(vol, 'SF Symbols Beta.app', 'Contents'), { recursive: true })
    expect(findAppInVolumes([vol])).toBe(join(vol, 'SF Symbols Beta.app'))
  })

  test('findPkgInVolumes finds the installer package (case-insensitive)', () => {
    const vol = join(root, 'vol-pkg')
    mkdirSync(vol, { recursive: true })
    writeFileSync(join(vol, '.background.png'), '')
    writeFileSync(join(vol, 'SF Symbols.PKG'), '')
    expect(findPkgInVolumes([vol])).toBe(join(vol, 'SF Symbols.PKG'))
    expect(findPkgInVolumes([join(root, 'vol-empty')])).toBeNull()
  })

  test('findAppInTree locates the app inside an expanded pkg Payload', () => {
    // Mirrors `pkgutil --expand-full` output: <dest>/Payload/<dst>/SF Symbols.app
    const appDir = join(root, 'expanded', 'Payload', 'Applications', 'SF Symbols.app', 'Contents')
    mkdirSync(appDir, { recursive: true })
    expect(findAppInTree(join(root, 'expanded'))).toBe(join(root, 'expanded', 'Payload', 'Applications', 'SF Symbols.app'))
  })

  test('findAppInTree returns null when absent and respects maxDepth', () => {
    mkdirSync(join(root, 'a', 'b', 'c', 'SF Symbols.app'), { recursive: true })
    expect(findAppInTree(join(root, 'empty'))).toBeNull()
    // The app is 3 levels below root; a maxDepth of 1 must not reach it.
    expect(findAppInTree(root, 1)).toBeNull()
    expect(findAppInTree(root, 8)).toBe(join(root, 'a', 'b', 'c', 'SF Symbols.app'))
  })

  test('findAppInTree locates the SF Symbols 8 beta bundle in a real pkg layout', () => {
    // Exactly what `pkgutil --expand-full` produced for SF-Symbols-8.dmg:
    // <dest>/SFSymbols.pkg/Payload/Applications/SF Symbols Beta.app
    const betaApp = join(root, 'expanded', 'SFSymbols.pkg', 'Payload', 'Applications', 'SF Symbols Beta.app')
    mkdirSync(join(betaApp, 'Contents'), { recursive: true })
    expect(findAppInTree(join(root, 'expanded'))).toBe(betaApp)
  })

  test('findAppInTree prefers an SF Symbols bundle but falls back to any .app', () => {
    // An unrelated installer app shallower than the SF Symbols bundle must
    // not win when the branded bundle exists.
    mkdirSync(join(root, 'pref', 'Helper.app'), { recursive: true })
    mkdirSync(join(root, 'pref', 'Payload', 'SF Symbols Beta.app'), { recursive: true })
    expect(findAppInTree(join(root, 'pref'))).toBe(join(root, 'pref', 'Payload', 'SF Symbols Beta.app'))

    // With no branded bundle, the shallowest plain .app is the fallback.
    mkdirSync(join(root, 'fb', 'Some Installer.app'), { recursive: true })
    expect(findAppInTree(join(root, 'fb'))).toBe(join(root, 'fb', 'Some Installer.app'))
  })
})

describe('isSfSymbolsAppName', () => {
  test('matches stable and beta channel bundle names', () => {
    expect(isSfSymbolsAppName('SF Symbols.app')).toBe(true)
    expect(isSfSymbolsAppName('SF Symbols Beta.app')).toBe(true)
    expect(isSfSymbolsAppName('SF Symbols 9.app')).toBe(true)
  })

  test('rejects unrelated or malformed names', () => {
    expect(isSfSymbolsAppName('Xcode.app')).toBe(false)
    expect(isSfSymbolsAppName('SF SymbolsX.app')).toBe(false) // no word boundary
    expect(isSfSymbolsAppName('SF Symbols')).toBe(false) // not a bundle
    expect(isSfSymbolsAppName(null)).toBe(false)
  })
})
