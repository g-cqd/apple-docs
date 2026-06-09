import { describe, test, expect } from 'bun:test'
import { chunkDocument, anchorText } from '../../../src/search/chunker.js'

const doc = (over = {}) => ({
  title: 'NavigationStack',
  abstract_text: 'A view that displays a root view and enables navigation.',
  headings: 'Overview Topics',
  ...over,
})

describe('anchorText', () => {
  test('matches the legacy embedText join + 1200-char cap', () => {
    expect(anchorText(doc())).toBe('NavigationStack. A view that displays a root view and enables navigation.. Overview Topics')
  })

  test('skips missing fields and caps length', () => {
    const long = 'x'.repeat(2000)
    expect(anchorText({ title: long }).length).toBe(1200)
    expect(anchorText({ title: 'T' })).toBe('T')
  })
})

describe('chunkDocument', () => {
  test('chunk 0 is always the anchor, even with no sections', () => {
    const chunks = chunkDocument(doc({ sections: [] }))
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe(anchorText(doc()))
  })

  test('keeps discussion/overview sections as body chunks (heading prefixed)', () => {
    const chunks = chunkDocument(doc({
      sections: [
        { sectionKind: 'discussion', heading: 'Discussion', contentText: 'Use a navigation stack to present a stack of views.' },
        { sectionKind: 'overview', heading: 'Overview', contentText: 'Push and pop destinations.' },
      ],
    }))
    expect(chunks.length).toBe(3)
    expect(chunks[1]).toContain('Discussion.')
    expect(chunks[1]).toContain('present a stack of views')
    expect(chunks[2]).toContain('Push and pop')
  })

  test('skips declaration / parameters / REST schema sections', () => {
    const chunks = chunkDocument(doc({
      sections: [
        { sectionKind: 'declaration', contentText: 'struct NavigationStack<Data, Root>' },
        { sectionKind: 'parameters', contentText: 'data: the navigation data' },
        { sectionKind: 'restEndpoint', contentText: 'GET /v1/things' },
      ],
    }))
    expect(chunks.length).toBe(1) // anchor only — all body sections skipped
  })

  test('skips the abstract section when abstract_text already feeds the anchor', () => {
    const chunks = chunkDocument(doc({
      sections: [{ sectionKind: 'abstract', contentText: 'A view that displays a root view and enables navigation.' }],
    }))
    expect(chunks.length).toBe(1)
  })

  test('long sections are split into overlapping windows', () => {
    const long = 'sentence. '.repeat(300) // ~3000 chars
    const chunks = chunkDocument(doc({ sections: [{ sectionKind: 'discussion', contentText: long }] }), {
      windowChars: 880, overlapChars: 160,
    })
    expect(chunks.length).toBeGreaterThan(2)
    // adjacent windows overlap → the tail of chunk[1] reappears at the head of chunk[2]
    const tail = chunks[1].slice(-160)
    expect(chunks[2].startsWith(tail)).toBe(true)
  })

  test('honors maxChunks cap', () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({ sectionKind: 'discussion', contentText: `topic ${i}` }))
    const chunks = chunkDocument(doc({ sections }), { maxChunks: 4 })
    expect(chunks.length).toBe(4)
  })

  test('is deterministic', () => {
    const d = doc({ sections: [{ sectionKind: 'discussion', contentText: 'abc '.repeat(500) }] })
    expect(chunkDocument(d)).toEqual(chunkDocument(d))
  })
})
