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

const { SwiftEvolutionAdapter } = await import('../../../src/sources/swift-evolution.js')

const SAMPLE_PROPOSAL = `# Async/Await

* Proposal: [SE-0296](0296-async-await.md)
* Authors: [John McCall](https://github.com/rjmccall), [Doug Gregor](https://github.com/DougGregor)
* Review Manager: [Ben Cohen](https://github.com/airspeedswift)
* Status: **Implemented (Swift 5.5)**
* Implementation: [apple/swift#33147](https://github.com/apple/swift/pull/33147)

## Introduction

Modern Swift development involves a lot of asynchronous programming.

## Motivation

Asynchronous programming is common in modern development.

## Proposed solution

We propose adding async/await to Swift.
`

function makeCtx() {
  return {
    db: {
      getRootBySlug: mock(() => ({ id: 1, slug: 'swift-evolution', source_type: 'swift-evolution' })),
      upsertRoot: mock(() => {}),
    },
    rateLimiter: { acquire: mock(() => Promise.resolve()) },
    logger: { info: mock(), warn: mock(), error: mock() },
  }
}

describe('SwiftEvolutionAdapter', () => {
  let adapter

  beforeEach(() => {
    adapter = new SwiftEvolutionAdapter()
    mockFetchGitHubTree.mockReset()
    mockFetchRawGitHub.mockReset()
    mockCheckRawGitHub.mockReset()
  })

  test('has correct static properties', () => {
    expect(SwiftEvolutionAdapter.type).toBe('swift-evolution')
    expect(SwiftEvolutionAdapter.displayName).toBe('Swift Evolution Proposals')
    expect(SwiftEvolutionAdapter.syncMode).toBe('flat')
  })

  test('discover returns keys from GitHub tree', async () => {
    mockFetchGitHubTree.mockResolvedValue([
      { path: 'proposals/0001-keywords-as-argument-labels.md', type: 'blob' },
      { path: 'proposals/0296-async-await.md', type: 'blob' },
      { path: 'proposals/README.md', type: 'blob' }, // should be excluded? No, it ends with .md and starts with proposals/
      { path: 'Sources/some-file.swift', type: 'blob' }, // should be excluded
      { path: 'proposals/', type: 'tree' }, // should be excluded (not blob)
    ])

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('swift-evolution/0001-keywords-as-argument-labels')
    expect(result.keys).toContain('swift-evolution/0296-async-await')
    expect(result.keys).not.toContain('swift-evolution/Sources/some-file')
    expect(result.roots).toBeDefined()
  })

  test('discover registers root if not present', async () => {
    mockFetchGitHubTree.mockResolvedValue([])
    const ctx = makeCtx()
    ctx.db.getRootBySlug.mockReturnValue(null)

    await adapter.discover(ctx)
    expect(ctx.db.upsertRoot).toHaveBeenCalled()
  })

  test('fetch returns raw markdown content', async () => {
    mockFetchRawGitHub.mockResolvedValue({
      text: SAMPLE_PROPOSAL,
      etag: '"abc123"',
      lastModified: '2024-01-01',
    })

    const ctx = makeCtx()
    const result = await adapter.fetch('swift-evolution/0296-async-await', ctx)

    expect(result.key).toBe('swift-evolution/0296-async-await')
    expect(result.payload).toBe(SAMPLE_PROPOSAL)
    expect(result.etag).toBe('"abc123"')
  })

  test('check delegates to checkRawGitHub', async () => {
    mockCheckRawGitHub.mockResolvedValue({ status: 'modified', etag: '"new"' })

    const ctx = makeCtx()
    const result = await adapter.check(
      'swift-evolution/0296-async-await',
      { etag: '"old"' },
      ctx,
    )

    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
  })

  test('check returns unchanged for 304', async () => {
    mockCheckRawGitHub.mockResolvedValue({ status: 'unchanged', etag: '"same"' })

    const ctx = makeCtx()
    const result = await adapter.check(
      'swift-evolution/0296-async-await',
      { etag: '"same"' },
      ctx,
    )

    expect(result.status).toBe('unchanged')
    expect(result.changed).toBe(false)
  })

  test('normalize parses SE proposal header fields', () => {
    const result = adapter.normalize('swift-evolution/0296-async-await', SAMPLE_PROPOSAL)

    expect(result.document.key).toBe('swift-evolution/0296-async-await')
    expect(result.document.kind).toBe('proposal')
    expect(result.document.framework).toBe('swift-evolution')
    expect(result.document.sourceType).toBe('swift-evolution')
    expect(result.document.title).toContain('SE-0296')
    expect(result.document.title).toContain('Async/Await')

    const meta = JSON.parse(result.document.sourceMetadata)
    expect(meta.seNumber).toBe('SE-0296')
    expect(meta.status).toContain('Implemented')
    expect(meta.swiftVersion).toBe('5.5')
    expect(meta.authors).toContain('John McCall')
    expect(meta.authors).toContain('Doug Gregor')
    expect(meta.reviewManager).toBe('Ben Cohen')
  })

  test('normalize produces valid sections', () => {
    const result = adapter.normalize('swift-evolution/0296-async-await', SAMPLE_PROPOSAL)

    expect(result.sections.length).toBeGreaterThan(0)
    expect(result.relationships).toEqual([])

    const abstract = result.sections.find(s => s.sectionKind === 'abstract')
    expect(abstract).toBeDefined()

    const discussions = result.sections.filter(s => s.sectionKind === 'discussion')
    expect(discussions.length).toBeGreaterThanOrEqual(2) // Introduction, Motivation, Proposed solution

    const headings = discussions.map(s => s.heading)
    expect(headings).toContain('Introduction')
    expect(headings).toContain('Motivation')
    expect(headings).toContain('Proposed solution')
  })

  test('normalize sets correct URL', () => {
    const result = adapter.normalize('swift-evolution/0296-async-await', SAMPLE_PROPOSAL)
    expect(result.document.url).toContain('github.com/swiftlang/swift-evolution')
    expect(result.document.url).toContain('0296-async-await')
  })

  test('normalize handles minimal proposal', () => {
    const minimal = '# Simple Feature\n\nA basic proposal.\n'
    const result = adapter.normalize('swift-evolution/9999-simple', minimal)

    expect(result.document.key).toBe('swift-evolution/9999-simple')
    expect(result.document.title).toContain('Simple Feature')
    expect(result.document.kind).toBe('proposal')
  })
})
