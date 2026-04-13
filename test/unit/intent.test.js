import { describe, test, expect } from 'bun:test'
import { detectIntent } from '../../src/search/intent.js'

describe('detectIntent', () => {
  test('detects CamelCase as symbol intent', () => {
    expect(detectIntent('NavigationStack').type).toBe('symbol')
    expect(detectIntent('NavigationStack').confidence).toBe(0.9)
  })

  test('detects qualified names as symbol intent', () => {
    expect(detectIntent('URLSession.shared').type).toBe('symbol')
    expect(detectIntent('Swift::Array').type).toBe('symbol')
  })

  test('detects single capitalized word as symbol intent', () => {
    const result = detectIntent('View')
    expect(result.type).toBe('symbol')
    expect(result.confidence).toBe(0.7)
  })

  test('detects single capitalized word Publisher as symbol', () => {
    expect(detectIntent('Publisher').type).toBe('symbol')
  })

  test('detects howto queries', () => {
    expect(detectIntent('how to use async await').type).toBe('howto')
    expect(detectIntent('tutorial navigation').type).toBe('howto')
    expect(detectIntent('implement custom layout').type).toBe('howto')
  })

  test('CamelCase in multi-word query wins over howto/concept', () => {
    // CamelCase detection takes priority when CamelCase word present
    expect(detectIntent('build a SwiftUI app').type).toBe('symbol')
    expect(detectIntent('SwiftUI vs UIKit').type).toBe('symbol')
  })

  test('single capitalized word in phrase does not trigger symbol', () => {
    // "what is Combine" — Combine is capitalized but not CamelCase, concept wins
    expect(detectIntent('what is Combine').type).toBe('concept')
  })

  test('detects error queries', () => {
    expect(detectIntent('EXC_BAD_ACCESS crash').type).toBe('error')
    expect(detectIntent('fix memory leak').type).toBe('error')
  })

  test('error words without CamelCase', () => {
    expect(detectIntent('crash on launch').type).toBe('error')
  })

  test('detects concept queries without CamelCase', () => {
    expect(detectIntent('difference between actor and class').type).toBe('concept')
    expect(detectIntent('what is concurrency').type).toBe('concept')
  })

  test('falls back to general for unclassified queries', () => {
    expect(detectIntent('privacy').type).toBe('general')
    expect(detectIntent('networking').type).toBe('general')
    expect(detectIntent('').type).toBe('general')
  })

  test('CamelCase takes priority over howto words', () => {
    // "NavigationStack" is CamelCase — symbol wins over any embedded howto word
    expect(detectIntent('NavigationStack').type).toBe('symbol')
  })

  test('returns confidence values', () => {
    expect(detectIntent('NavigationStack').confidence).toBe(0.9)
    expect(detectIntent('how to use').confidence).toBe(0.8)
    expect(detectIntent('crash on launch').confidence).toBe(0.8)
    expect(detectIntent('what is concurrency').confidence).toBe(0.7)
    expect(detectIntent('something').confidence).toBe(0.5)
  })
})
