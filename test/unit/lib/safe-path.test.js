import { describe, expect, test } from 'bun:test'
import { ValidationError } from '../../../src/lib/errors.js'
import {
  keyPath,
  safeFilename,
  safeWebDocKey,
  safeWebSegment,
  validateStorageKey,
  WEB_SEGMENT_MAX_BYTES,
  webKeyNeedsMapping,
} from '../../../src/lib/safe-path.js'

describe('safeFilename', () => {
  test('returns the input verbatim when the result fits the temp-suffix budget', () => {
    expect(safeFilename('view', '.json')).toBe('view.json')
    expect(safeFilename('init(animationtool:colorprimaries:configuration)', '.json')).toBe('init(animationtool:colorprimaries:configuration).json')
  })

  test('shortens basenames that overflow the per-component byte limit', () => {
    // Construct a basename close to the 255-byte cap. Adding `.json` plus the
    // 32-byte temp-suffix budget should push it over and trigger the hash.
    const longBase = 'init(' + 'param:'.repeat(40) + ')'
    expect(longBase.length).toBeGreaterThan(220)

    const result = safeFilename(longBase, '.json')

    // Total length must accommodate the full atomic-write temp suffix.
    expect(result.length).toBeLessThanOrEqual(255 - 32)
    // Must end in the requested extension and contain a `~hex12` marker.
    expect(result.endsWith('.json')).toBe(true)
    expect(result).toMatch(/~[0-9a-f]{12}\.json$/)
    // Must preserve the readable prefix.
    expect(result.startsWith('init(')).toBe(true)
  })

  test('different long basenames hash to different on-disk filenames', () => {
    const base = 'init(' + 'param:'.repeat(40)
    const a = safeFilename(`${base}aaaa)`, '.json')
    const b = safeFilename(`${base}bbbb)`, '.json')

    expect(a).not.toBe(b)
    // Same length budget, different hash suffix.
    expect(a.length).toBe(b.length)
  })

  test('identical inputs map to identical filenames (deterministic)', () => {
    const long = 'init(' + 'param:'.repeat(40) + ')'
    expect(safeFilename(long, '.json')).toBe(safeFilename(long, '.json'))
  })

  test('repeats the same shortening for the matching real-world Apple identifier', () => {
    // Pulled verbatim from the snapshot CI failure log on 2026-05-08.
    const realWorld =
      'init(animationtool:colorprimaries:colortransferfunction:colorycbcrmatrix:customvideocompositorclass:frameduration:instructions:outputbufferdescription:perframehdrdisplaymetadatapolicy:renderscale:rendersize:sourcesampledatatrackids:sourcetr-2lwnx'
    const result = safeFilename(realWorld, '.json')

    expect(result.length).toBeLessThanOrEqual(255 - 32)
    expect(result).toMatch(/~[0-9a-f]{12}\.json$/)
  })
})

describe('keyPath', () => {
  test('threads slash-separated keys into platform path components', () => {
    const result = keyPath('/data', 'raw-json', 'swiftui/view', '.json')
    expect(result).toBe('/data/raw-json/swiftui/view.json')
  })

  test('only the leaf segment gets shortened', () => {
    const longLeaf = 'init(' + 'param:'.repeat(40) + ')'
    const key = `avfoundation/avvideocomposition/configuration/${longLeaf}`
    const result = keyPath('/data', 'raw-json', key, '.json')

    // Intermediate segments are passed through verbatim.
    expect(result).toContain('/avfoundation/avvideocomposition/configuration/')
    // Leaf is hash-tagged.
    expect(result).toMatch(/~[0-9a-f]{12}\.json$/)
  })

  test('rejects keys that resolve outside dataDir even after validation', () => {
    // Belt-and-braces: validateStorageKey already catches `..` segments,
    // but the post-resolve invariant is the second line of defense.
    expect(() => keyPath('/data', 'raw-json', '../escape', '.json')).toThrow(ValidationError)
  })
})

describe('safeWebSegment / safeWebDocKey / webKeyNeedsMapping', () => {
  const longLeaf = `init(${'param:'.repeat(50)})`

  test('segments at or under the threshold pass through unchanged', () => {
    expect(safeWebSegment('view')).toBe('view')
    const exactly = 'a'.repeat(WEB_SEGMENT_MAX_BYTES)
    expect(safeWebSegment(exactly)).toBe(exactly)
  })

  test('oversized segments truncate and gain a ~hex12 tag within the byte budget', () => {
    expect(Buffer.byteLength(longLeaf)).toBeGreaterThan(WEB_SEGMENT_MAX_BYTES)
    const out = safeWebSegment(longLeaf)
    expect(out).toMatch(/~[0-9a-f]{12}$/)
    expect(out.startsWith('init(')).toBe(true)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(WEB_SEGMENT_MAX_BYTES)
  })

  test('deterministic: same input always maps to the same segment', () => {
    expect(safeWebSegment(longLeaf)).toBe(safeWebSegment(longLeaf))
    const key = `cloudkit/cksubscription/${longLeaf}`
    expect(safeWebDocKey(key)).toBe(safeWebDocKey(key))
  })

  test('two distinct long segments sharing a 180-byte prefix do not collide', () => {
    const base = 'init(' + 'param:'.repeat(45)
    const a = safeWebSegment(`${base}alertbody:)`)
    const b = safeWebSegment(`${base}collapseidkey:)`)
    expect(a).not.toBe(b)
  })

  test('multi-byte UTF-8 segments truncate on a character boundary', () => {
    const seg = 'é'.repeat(150) // 300 bytes
    const out = safeWebSegment(seg)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(WEB_SEGMENT_MAX_BYTES)
    const prefix = out.slice(0, out.indexOf('~'))
    expect([...prefix].every((ch) => ch === 'é')).toBe(true)
    expect(Buffer.from(out).toString('utf8')).toBe(out)
  })

  test('safeWebDocKey fast path returns the identical string for safe keys', () => {
    const key = 'swiftui/view/init(alertbody:title:)'
    expect(safeWebDocKey(key)).toBe(key)
    // A long key made of short segments needs no mapping either.
    const deep = Array.from({ length: 30 }, (_, i) => `segment-${i}`).join('/')
    expect(Buffer.byteLength(deep)).toBeGreaterThan(WEB_SEGMENT_MAX_BYTES)
    expect(safeWebDocKey(deep)).toBe(deep)
  })

  test('only oversized segments are rewritten; the rest pass through', () => {
    const key = `cloudkit/cksubscription/notificationinfo-swift.class/${longLeaf}`
    const out = safeWebDocKey(key)
    expect(out.startsWith('cloudkit/cksubscription/notificationinfo-swift.class/')).toBe(true)
    expect(out).toMatch(/~[0-9a-f]{12}$/)
    expect(out).not.toBe(key)
    expect(safeWebDocKey(out)).toBe(out)
  })

  test('webKeyNeedsMapping matches safeWebDocKey behavior', () => {
    expect(webKeyNeedsMapping('swiftui/view')).toBe(false)
    expect(webKeyNeedsMapping(`metal/mtlindirectrendercommand/${longLeaf}`)).toBe(true)
    const deep = Array.from({ length: 30 }, (_, i) => `segment-${i}`).join('/')
    expect(webKeyNeedsMapping(deep)).toBe(false)
    expect(webKeyNeedsMapping(null)).toBe(false)
  })
})

describe('validateStorageKey — A4 traversal vectors', () => {
  const traversal = [
    ['empty string', ''],
    ['single dot', '.'],
    ['double dot', '..'],
    ['leading slash (POSIX absolute)', '/etc/passwd'],
    ['tilde (home)', '~/escape'],
    ['Windows drive', 'C:\\Windows\\System32'],
    ['Windows drive with forward slash', 'C:/Windows/System32'],
    ['embedded ..', 'a/../b'],
    ['traversal at end', 'a/b/..'],
    ['traversal at start', '../escape'],
    ['empty segment from leading slash variant', 'a//b'],
    ['trailing slash', 'a/'],
    ['embedded backslash', 'a\\b'],
    ['NUL byte', 'a\0b'],
  ]
  for (const [label, key] of traversal) {
    test(`rejects ${label}: ${JSON.stringify(key)}`, () => {
      expect(() => validateStorageKey(key)).toThrow(ValidationError)
    })
  }

  test('non-string input throws', () => {
    expect(() => validateStorageKey(null)).toThrow(ValidationError)
    expect(() => validateStorageKey(undefined)).toThrow(ValidationError)
    expect(() => validateStorageKey(42)).toThrow(ValidationError)
  })

  test('accepts well-formed keys and returns them unchanged', () => {
    expect(validateStorageKey('swiftui/view')).toBe('swiftui/view')
    expect(validateStorageKey('a')).toBe('a')
    expect(validateStorageKey('a/b/c/d')).toBe('a/b/c/d')
    expect(validateStorageKey('init(foo:bar:)')).toBe('init(foo:bar:)')
  })
})
