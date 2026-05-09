import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ValidationError } from '../../src/lib/errors.js'
import { assertFontPathContained } from '../../src/resources/apple-fonts/safe-font-path.js'

describe('assertFontPathContained (A6)', () => {
  const dataDir = '/tmp/apple-docs-test'

  test('accepts /Library/Fonts paths', () => {
    expect(assertFontPathContained('/Library/Fonts/Helvetica.ttf', dataDir))
      .toBe('/Library/Fonts/Helvetica.ttf')
  })

  test('accepts /System/Library/Fonts paths', () => {
    expect(assertFontPathContained('/System/Library/Fonts/SF-Pro.ttf', dataDir))
      .toBe('/System/Library/Fonts/SF-Pro.ttf')
  })

  test('accepts user-home Library/Fonts paths', () => {
    const homePath = join(homedir(), 'Library', 'Fonts', 'Custom.ttf')
    expect(assertFontPathContained(homePath, dataDir)).toBe(homePath)
  })

  test('accepts dataDir/resources/fonts/extracted/* paths', () => {
    const path = `${dataDir}/resources/fonts/extracted/sf-pro/SF-Pro.ttf`
    expect(assertFontPathContained(path, dataDir)).toBe(path)
  })

  test('rejects /etc/passwd', () => {
    expect(() => assertFontPathContained('/etc/passwd', dataDir))
      .toThrow(ValidationError)
  })

  test('rejects an arbitrary path outside approved roots', () => {
    expect(() => assertFontPathContained('/usr/local/sneaky.ttf', dataDir))
      .toThrow(ValidationError)
  })

  test('rejects traversal that resolves outside approved roots', () => {
    // /Library/Fonts/../../etc/passwd resolves to /etc/passwd
    expect(() => assertFontPathContained('/Library/Fonts/../../etc/passwd', dataDir))
      .toThrow(ValidationError)
  })

  test('rejects traversal that resolves outside dataDir resources/fonts', () => {
    // dataDir/resources/fonts/extracted/../../escape.txt resolves to dataDir/resources/escape.txt
    const path = `${dataDir}/resources/fonts/extracted/../../escape.txt`
    expect(() => assertFontPathContained(path, dataDir))
      .toThrow(ValidationError)
  })

  test('rejects empty / null / non-string', () => {
    expect(() => assertFontPathContained('', dataDir)).toThrow(ValidationError)
    expect(() => assertFontPathContained(null, dataDir)).toThrow(ValidationError)
    expect(() => assertFontPathContained(undefined, dataDir)).toThrow(ValidationError)
    expect(() => assertFontPathContained(42, dataDir)).toThrow(ValidationError)
  })
})
