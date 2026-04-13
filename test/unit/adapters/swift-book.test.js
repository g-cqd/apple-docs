import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Mock GitHub helpers before importing adapter
const mockFetchGitHubTree = mock(() => Promise.resolve([]))
const mockFetchRawGitHub = mock(() => Promise.resolve({ text: '', etag: null, lastModified: null }))
const mockCheckRawGitHub = mock(() => Promise.resolve({ status: 'unchanged', etag: null }))

mock.module('../../../src/lib/github.js', () => ({
  fetchGitHubTree: mockFetchGitHubTree,
  fetchRawGitHub: mockFetchRawGitHub,
  checkRawGitHub: mockCheckRawGitHub,
}))

const { SwiftBookAdapter } = await import('../../../src/sources/swift-book.js')

const SAMPLE_CHAPTER = `# The Basics

Swift is a programming language for iOS, macOS, watchOS, and tvOS app development.

## Constants and Variables

Constants and variables associate a name with a value of a particular type.

You declare constants with the \`let\` keyword and variables with the \`var\` keyword.

## Type Annotations

You can provide a type annotation when you declare a constant or variable.

## Comments

Use comments to include nonexecutable text in your code.
`

function makeCtx() {
  return {
    db: {
      getRootBySlug: mock(() => ({ id: 1, slug: 'swift-book', source_type: 'swift-book' })),
      upsertRoot: mock(() => {}),
    },
    rateLimiter: { acquire: mock(() => Promise.resolve()) },
    logger: { info: mock(), warn: mock(), error: mock() },
  }
}

describe('SwiftBookAdapter', () => {
  let adapter

  beforeEach(() => {
    adapter = new SwiftBookAdapter()
    mockFetchGitHubTree.mockReset()
    mockFetchRawGitHub.mockReset()
    mockCheckRawGitHub.mockReset()
  })

  test('has correct static properties', () => {
    expect(SwiftBookAdapter.type).toBe('swift-book')
    expect(SwiftBookAdapter.displayName).toBe('The Swift Programming Language')
    expect(SwiftBookAdapter.syncMode).toBe('flat')
  })

  test('discover filters TSPL.docc markdown files', async () => {
    mockFetchGitHubTree.mockResolvedValue([
      { path: 'TSPL.docc/TheBasics.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/StringsAndCharacters.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/Types.md', type: 'blob' },
      { path: 'TSPL.docc/TSPL.md', type: 'blob' }, // excluded — root file
      { path: 'TSPL.docc/Snippets/TheBasics.swift', type: 'blob' }, // excluded — Snippets dir
      { path: 'README.md', type: 'blob' }, // excluded — not under TSPL.docc/
      { path: 'TSPL.docc/', type: 'tree' }, // excluded — not blob
    ])

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('swift-book/TheBasics')
    expect(result.keys).toContain('swift-book/LanguageGuide/StringsAndCharacters')
    expect(result.keys).toContain('swift-book/ReferenceManual/Types')
    expect(result.keys).not.toContain('swift-book/TSPL')
    expect(result.keys.some(k => k.includes('Snippets'))).toBe(false)
    expect(result.keys.some(k => k === 'swift-book/README')).toBe(false)
  })

  test('fetch returns raw markdown', async () => {
    mockFetchRawGitHub.mockResolvedValue({
      text: SAMPLE_CHAPTER,
      etag: '"abc"',
      lastModified: '2024-06-01',
    })

    const ctx = makeCtx()
    const result = await adapter.fetch('swift-book/TheBasics', ctx)

    expect(result.key).toBe('swift-book/TheBasics')
    expect(result.payload).toBe(SAMPLE_CHAPTER)
    expect(result.etag).toBe('"abc"')

    // Verify correct GitHub path was constructed
    expect(mockFetchRawGitHub).toHaveBeenCalledWith(
      'swiftlang', 'swift-book', 'main',
      'TSPL.docc/TheBasics.md',
      expect.anything(),
    )
  })

  test('check delegates to checkRawGitHub', async () => {
    mockCheckRawGitHub.mockResolvedValue({ status: 'modified', etag: '"new"' })

    const ctx = makeCtx()
    const result = await adapter.check('swift-book/TheBasics', { etag: '"old"' }, ctx)

    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
  })

  test('normalize produces valid book chapter document', () => {
    const result = adapter.normalize('swift-book/TheBasics', SAMPLE_CHAPTER)

    expect(result.document.key).toBe('swift-book/TheBasics')
    expect(result.document.title).toBe('The Basics')
    expect(result.document.kind).toBe('book-chapter')
    expect(result.document.framework).toBe('swift-book')
    expect(result.document.sourceType).toBe('swift-book')
    expect(result.document.url).toContain('docs.swift.org/swift-book')
  })

  test('normalize creates sections from headings', () => {
    const result = adapter.normalize('swift-book/TheBasics', SAMPLE_CHAPTER)

    expect(result.sections.length).toBeGreaterThan(0)
    expect(result.relationships).toEqual([])

    const discussions = result.sections.filter(s => s.sectionKind === 'discussion')
    const headings = discussions.map(s => s.heading)
    expect(headings).toContain('Constants and Variables')
    expect(headings).toContain('Type Annotations')
    expect(headings).toContain('Comments')
  })

  test('normalize derives title from filename when missing in markdown', () => {
    const noTitle = 'Some content without a heading.\n'
    const result = adapter.normalize('swift-book/StringsAndCharacters', noTitle)

    expect(result.document.title).toBe('Strings And Characters')
  })
})
