import { describe, test, expect } from 'bun:test'
import { normalizeIdentifier, extractRootSlug } from '../../src/apple/normalizer.js'

describe('normalizeIdentifier', () => {
  test('handles doc:// URI scheme', () => {
    expect(normalizeIdentifier('doc://com.apple.SwiftUI/documentation/SwiftUI/View'))
      .toBe('swiftui/view')
  })

  test('handles /documentation/ prefix', () => {
    expect(normalizeIdentifier('/documentation/SwiftUI/View'))
      .toBe('swiftui/view')
  })

  test('handles mixed-case path without prefix', () => {
    expect(normalizeIdentifier('SwiftUI/View'))
      .toBe('swiftui/view')
  })

  test('handles documentation/ prefix without leading slash', () => {
    expect(normalizeIdentifier('documentation/SwiftUI/View'))
      .toBe('swiftui/view')
  })

  test('passes through already canonical path', () => {
    expect(normalizeIdentifier('swiftui/view'))
      .toBe('swiftui/view')
  })

  test('strips trailing slashes', () => {
    expect(normalizeIdentifier('swiftui/view/'))
      .toBe('swiftui/view')
  })

  test('handles deeply nested paths', () => {
    expect(normalizeIdentifier('doc://com.apple.documentation/documentation/Foundation/NSString/Encoding'))
      .toBe('foundation/nsstring/encoding')
  })

  test('returns null for empty/null input', () => {
    expect(normalizeIdentifier('')).toBeNull()
    expect(normalizeIdentifier(null)).toBeNull()
    expect(normalizeIdentifier(undefined)).toBeNull()
  })

  test('rejects dot-prefixed operator paths (.==, .!=, ._, ..<, ...)', () => {
    expect(normalizeIdentifier('swift/simd16/.==(_:_:)-6vtbl')).toBeNull()
    expect(normalizeIdentifier('swift/simd3/.!=(_:_:)-1o5ed')).toBeNull()
    expect(normalizeIdentifier('swift/simd16/._(_:_:)-2gbn0')).toBeNull()
    expect(normalizeIdentifier('swift/never/...(_:)-45ng')).toBeNull()
    expect(normalizeIdentifier('swift/never/.._(_:)')).toBeNull()
    expect(normalizeIdentifier('swift/simd16/._=(_:_:)-25vha')).toBeNull()
  })

  test('rejects https:// URLs', () => {
    expect(normalizeIdentifier('https://example.com')).toBeNull()
    expect(normalizeIdentifier('http://developer.apple.com/foo')).toBeNull()
  })

  test('strips fragment identifiers', () => {
    expect(normalizeIdentifier('activitykit/displaying-live-data#configure'))
      .toBe('activitykit/displaying-live-data')
  })

  test('keeps valid operator paths without leading dot', () => {
    // Regular operator paths like ==(_:_:) are fine — only dot-prefixed are rejected
    expect(normalizeIdentifier('swift/int/==(_:_:)')).toBe('swift/int/==(_:_:)')
    expect(normalizeIdentifier('swift/int/+(_:_:)')).toBe('swift/int/+(_:_:)')
  })
})

describe('extractRootSlug', () => {
  test('extracts first segment', () => {
    expect(extractRootSlug('swiftui/view')).toBe('swiftui')
  })

  test('returns whole string if no slash', () => {
    expect(extractRootSlug('swiftui')).toBe('swiftui')
  })

  test('returns null for null input', () => {
    expect(extractRootSlug(null)).toBeNull()
  })
})
