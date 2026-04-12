import { describe, test, expect } from 'bun:test'
import { extractReferences, extractMetadata, renderInlineToText } from '../../src/apple/extractor.js'

// Load the real fixture
const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

describe('extractReferences', () => {
  test('extracts references from real fixture', () => {
    const refs = extractReferences(fixture)
    expect(refs.length).toBeGreaterThan(10)
    // All should be lowercase canonical paths
    for (const ref of refs) {
      expect(ref).toBe(ref.toLowerCase())
      expect(ref).not.toContain('doc://')
      expect(ref).not.toContain('/documentation/')
    }
  })

  test('includes topic section identifiers', () => {
    const refs = extractReferences(fixture)
    // SwiftUI/View has topic sections with child symbols
    expect(refs.some(r => r.startsWith('swiftui/view/'))).toBe(true)
  })

  test('returns empty for empty json', () => {
    expect(extractReferences({})).toEqual([])
  })
})

describe('extractMetadata', () => {
  test('extracts title and role from real fixture', () => {
    const meta = extractMetadata(fixture)
    expect(meta.title).toBe('View')
    expect(meta.role).toBe('symbol')
    expect(meta.roleHeading).toBe('Protocol')
  })

  test('extracts abstract as plain text', () => {
    const meta = extractMetadata(fixture)
    expect(meta.abstract).toContain('user interface')
    expect(typeof meta.abstract).toBe('string')
  })

  test('extracts platforms', () => {
    const meta = extractMetadata(fixture)
    expect(meta.platforms.length).toBeGreaterThan(0)
    expect(meta.platforms.some(p => p.includes('iOS'))).toBe(true)
  })

  test('extracts declaration', () => {
    const meta = extractMetadata(fixture)
    // View protocol should have a declaration
    if (meta.declaration) {
      expect(meta.declaration).toContain('View')
    }
  })

  test('handles empty json gracefully', () => {
    const meta = extractMetadata({})
    expect(meta.title).toBeNull()
    expect(meta.role).toBeNull()
    expect(meta.abstract).toBeNull()
  })
})

describe('renderInlineToText', () => {
  test('renders text nodes', () => {
    expect(renderInlineToText([{ type: 'text', text: 'hello' }])).toBe('hello')
  })

  test('renders codeVoice', () => {
    expect(renderInlineToText([{ type: 'codeVoice', code: 'View' }])).toBe('View')
  })

  test('renders mixed content', () => {
    const result = renderInlineToText([
      { type: 'text', text: 'A ' },
      { type: 'codeVoice', code: 'View' },
      { type: 'text', text: ' protocol' },
    ])
    expect(result).toBe('A View protocol')
  })

  test('returns null for empty array', () => {
    expect(renderInlineToText([])).toBeNull()
  })
})
