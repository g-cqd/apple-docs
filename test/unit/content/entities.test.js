import { describe, expect, test } from 'bun:test'
import { decodeEntities } from '../../../src/content/parse-html/entities.js'

/**
 * Counter-audit regression suite for the entity decoder. After the
 * CodeQL `js/double-escaping` fix, `&amp;` is decoded LAST so an input
 * like `&amp;lt;` (a literal `&lt;` string that the upstream then
 * additionally escaped) round-trips to `&lt;` rather than being
 * mistakenly collapsed to `<`.
 */
describe('decodeEntities', () => {
  test('decodes the standard named entities', () => {
    expect(decodeEntities('&lt;')).toBe('<')
    expect(decodeEntities('&gt;')).toBe('>')
    expect(decodeEntities('&quot;')).toBe('"')
    expect(decodeEntities('&amp;')).toBe('&')
    expect(decodeEntities('&#39;')).toBe("'")
    expect(decodeEntities('&#x27;')).toBe("'")
    expect(decodeEntities('&#x2F;')).toBe('/')
    expect(decodeEntities('&nbsp;')).toBe(' ')
  })

  test('preserves a literal `&lt;` inside a double-encoded payload', () => {
    // This is the regression case: the source emitted `&lt;` and the
    // transport further escaped the `&` → `&amp;lt;`. Decoding must
    // produce the original literal text `&lt;`, not `<`.
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('&amp;gt;')).toBe('&gt;')
    expect(decodeEntities('&amp;amp;')).toBe('&amp;')
  })

  test('handles decimal numeric entities', () => {
    expect(decodeEntities('&#65;')).toBe('A')
    expect(decodeEntities('&#128512;')).toBe('😀')
  })

  test('handles hex numeric entities', () => {
    expect(decodeEntities('&#x41;')).toBe('A')
    expect(decodeEntities('&#x1F600;')).toBe('😀')
  })

  test('passes unknown entities through verbatim', () => {
    expect(decodeEntities('&copy;')).toBe('&copy;')
    expect(decodeEntities('plain text')).toBe('plain text')
  })

  test('processes mixed content correctly', () => {
    expect(decodeEntities('foo &amp; bar &lt; baz')).toBe('foo & bar < baz')
    expect(decodeEntities('&amp;lt; means &quot;less than&quot;')).toBe('&lt; means "less than"')
  })
})
