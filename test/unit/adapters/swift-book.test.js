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

const { SwiftBookAdapter, parseBookTopics } = await import('../../../src/sources/swift-book.js')

const SAMPLE_ROOT_TOC = `# The Swift Programming Language (6.3 beta)

@Metadata {
  @TechnologyRoot
}

## Topics

### Welcome to Swift

- <doc:AboutSwift>
- <doc:Compatibility>
- <doc:GuidedTour>

### Language Guide

- <doc:TheBasics>
- <doc:StringsAndCharacters>

### Language Reference

- <doc:LexicalStructure>
- <doc:Types>

### Revision History

- <doc:RevisionHistory>
`

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
      { path: 'TSPL.docc/The-Swift-Programming-Language.md', type: 'blob' }, // included — root TOC
      { path: 'TSPL.docc/LanguageGuide/TheBasics.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/StringsAndCharacters.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/Types.md', type: 'blob' },
      { path: 'TSPL.docc/Snippets/TheBasics.swift', type: 'blob' }, // excluded — Snippets dir
      { path: 'README.md', type: 'blob' }, // excluded — not under TSPL.docc/
      { path: 'TSPL.docc/', type: 'tree' }, // excluded — not blob
    ])

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('swift-book/The-Swift-Programming-Language')
    expect(result.keys).toContain('swift-book/LanguageGuide/TheBasics')
    expect(result.keys).toContain('swift-book/LanguageGuide/StringsAndCharacters')
    expect(result.keys).toContain('swift-book/ReferenceManual/Types')
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

  test('normalize tags chapters with their book section group', () => {
    const result = adapter.normalize('swift-book/LanguageGuide/TheBasics', SAMPLE_CHAPTER)
    const meta = JSON.parse(result.document.sourceMetadata ?? '{}')
    expect(meta.bookSection).toBe('Language Guide')
    expect(meta.bookSectionDir).toBe('LanguageGuide')
  })

  test('normalize on root TOC emits a topics section grouped by ### headings', async () => {
    mockFetchGitHubTree.mockResolvedValue([
      { path: 'TSPL.docc/The-Swift-Programming-Language.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/AboutSwift.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/Compatibility.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/GuidedTour.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/TheBasics.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/StringsAndCharacters.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/LexicalStructure.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/Types.md', type: 'blob' },
      { path: 'TSPL.docc/RevisionHistory/RevisionHistory.md', type: 'blob' },
    ])
    await adapter.discover(makeCtx())

    const result = adapter.normalize('swift-book/The-Swift-Programming-Language', SAMPLE_ROOT_TOC)
    const topics = result.sections.find(s => s.sectionKind === 'topics')
    expect(topics).toBeDefined()
    const linkSections = JSON.parse(topics.contentJson)
    expect(linkSections.map(s => s.title)).toEqual([
      'Welcome to Swift',
      'Language Guide',
      'Language Reference',
      'Revision History',
    ])
    const guideItems = linkSections.find(s => s.title === 'Language Guide').items
    expect(guideItems.find(i => i.title === 'The Basics').key).toBe('swift-book/LanguageGuide/TheBasics')
  })

  test('normalize on root TOC emits child relationships in TOC order', async () => {
    mockFetchGitHubTree.mockResolvedValue([
      { path: 'TSPL.docc/The-Swift-Programming-Language.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/AboutSwift.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/Compatibility.md', type: 'blob' },
      { path: 'TSPL.docc/GuidedTour/GuidedTour.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/TheBasics.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/StringsAndCharacters.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/LexicalStructure.md', type: 'blob' },
      { path: 'TSPL.docc/ReferenceManual/Types.md', type: 'blob' },
      { path: 'TSPL.docc/RevisionHistory/RevisionHistory.md', type: 'blob' },
    ])
    await adapter.discover(makeCtx())

    const result = adapter.normalize('swift-book/The-Swift-Programming-Language', SAMPLE_ROOT_TOC)
    const childKeys = result.relationships.filter(r => r.relationType === 'child').map(r => r.toKey)
    expect(childKeys[0]).toBe('swift-book/GuidedTour/AboutSwift')
    expect(childKeys).toContain('swift-book/LanguageGuide/TheBasics')
    expect(childKeys).toContain('swift-book/ReferenceManual/Types')
    expect(childKeys).toContain('swift-book/RevisionHistory/RevisionHistory')
  })

  test('normalize on root TOC kind is collection', async () => {
    mockFetchGitHubTree.mockResolvedValue([
      { path: 'TSPL.docc/The-Swift-Programming-Language.md', type: 'blob' },
      { path: 'TSPL.docc/LanguageGuide/TheBasics.md', type: 'blob' },
    ])
    await adapter.discover(makeCtx())
    const result = adapter.normalize('swift-book/The-Swift-Programming-Language', SAMPLE_ROOT_TOC)
    expect(result.document.kind).toBe('collection')
    expect(result.document.url).toBe('https://docs.swift.org/swift-book/documentation/the-swift-programming-language/')
  })
})

describe('parseBookTopics', () => {
  test('returns empty array when no Topics section is present', () => {
    expect(parseBookTopics('# Title\n\nIntro paragraph.\n')).toEqual([])
  })

  test('parses grouped <doc:> references under ### subheadings', () => {
    const md = `## Topics\n\n### A\n\n- <doc:Foo>\n- <doc:Bar>\n\n### B\n\n- <doc:Baz>\n`
    expect(parseBookTopics(md)).toEqual([
      { title: 'A', items: ['Foo', 'Bar'] },
      { title: 'B', items: ['Baz'] },
    ])
  })

  test('does not bleed into sibling ## sections', () => {
    const md = `## Topics\n\n### A\n\n- <doc:Foo>\n\n## Other\n\n### Z\n\n- <doc:Nope>\n`
    const groups = parseBookTopics(md)
    expect(groups).toEqual([{ title: 'A', items: ['Foo'] }])
  })
})
