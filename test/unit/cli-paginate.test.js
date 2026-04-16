import { describe, test, expect } from 'bun:test'
import { paginateCliContent } from '../../src/cli/paginate.js'
import { formatLookup, formatSearchRead } from '../../src/cli/formatter.js'

describe('paginateCliContent', () => {
  const makeResult = (content) => ({ found: true, content, metadata: { title: 'Test' } })

  const longContent = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} with enough text to fill space.`).join('\n\n')

  test('returns result unchanged when content fits', () => {
    const result = makeResult('short text')
    const out = paginateCliContent(result, 1000)
    expect(out.content).toBe('short text')
    expect(out.pageInfo).toBeUndefined()
  })

  test('splits at paragraph boundaries', () => {
    const content = longContent(20)
    const result = makeResult(content)
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo.page).toBe(1)
    expect(out.pageInfo.totalPages).toBeGreaterThan(1)
    expect(out.pageInfo.hasNextPage).toBe(true)
    expect(out.content.length).toBeLessThanOrEqual(200)
  })

  test('returns correct page when pageNum specified', () => {
    const content = longContent(20)
    const result = makeResult(content)
    const p1 = paginateCliContent(result, 200, 1)
    const p2 = paginateCliContent(result, 200, 2)
    expect(p1.content).not.toBe(p2.content)
    expect(p2.pageInfo.page).toBe(2)
    expect(p2.pageInfo.hasPreviousPage).toBe(true)
  })

  test('clamps page number to valid range', () => {
    const content = longContent(20)
    const result = makeResult(content)
    const out = paginateCliContent(result, 200, 999)
    expect(out.pageInfo.page).toBe(out.pageInfo.totalPages)
    expect(out.pageInfo.hasNextPage).toBe(false)
  })

  test('rejects maxChars below minimum', () => {
    const result = makeResult('some content here that is long enough')
    const out = paginateCliContent(result, 50)
    expect(out.content).toContain('Error')
  })

  test('falls back to line breaks when no paragraph break fits', () => {
    // Each line ~20 chars, no double newlines, maxChars=200 forces multiple pages
    const lines = Array.from({ length: 50 }, (_, i) => `Line number ${i + 1} here`)
    const content = lines.join('\n')
    const result = makeResult(content)
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo.totalPages).toBeGreaterThan(1)
  })

  test('hard-cuts when no break point exists', () => {
    const content = 'a'.repeat(500)
    const result = makeResult(content)
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo.totalPages).toBe(3)
    expect(out.content.length).toBe(200)
  })

  test('preserves metadata through pagination', () => {
    const content = longContent(20)
    const result = makeResult(content)
    const out = paginateCliContent(result, 200, 1)
    expect(out.metadata.title).toBe('Test')
    expect(out.found).toBe(true)
  })

  test('strategy is text-window', () => {
    const content = longContent(20)
    const result = makeResult(content)
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo.strategy).toBe('text-window')
  })
})

// ---------------------------------------------------------------------------
// splitPages edge cases (tested via paginateCliContent)
// ---------------------------------------------------------------------------
describe('splitPages edge cases', () => {
  const makeResult = (content) => ({ found: true, content, metadata: {} })

  test('empty string content returns result unchanged (no pagination)', () => {
    // empty string is falsy — paginateCliContent short-circuits before splitPages
    const out = paginateCliContent(makeResult(''), 200)
    expect(out.pageInfo).toBeUndefined()
    expect(out.content).toBe('')
  })

  test('content exactly equal to maxChars returns result unchanged', () => {
    const content = 'x'.repeat(200)
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo).toBeUndefined()
    expect(out.content).toBe(content)
  })

  test('content one char over maxChars triggers pagination into 2 pages', () => {
    // 201 'a' chars with no break point → hard cut at 200 + 1 remaining
    const content = 'a'.repeat(201)
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo).toBeDefined()
    expect(out.pageInfo.totalPages).toBe(2)
    expect(out.content.length).toBe(200)
  })

  test('maxChars exactly at MIN_MAX_CHARS (200) is accepted', () => {
    const content = 'x'.repeat(400)
    const out = paginateCliContent(makeResult(content), 200)
    // should paginate, not error
    expect(out.content).not.toContain('Error')
    expect(out.pageInfo).toBeDefined()
  })

  test('trailing newlines in content do not cause extra empty pages', () => {
    // Content that fills slightly over one page with trailing newlines
    const base = 'a'.repeat(190)
    const content = base + '\n\n\n\n'
    const out = paginateCliContent(makeResult(content), 200)
    // Content with trailing newlines is <= 200 chars (194 chars total)
    // so no pagination needed
    expect(out.pageInfo).toBeUndefined()
  })

  test('trailing whitespace in content that is over limit does not produce empty final page', () => {
    // 210 chars: 200 'a' + 10 spaces — splitPages hard-cuts at 200, leaving '          '
    const content = 'a'.repeat(200) + '          '
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo.totalPages).toBe(2)
    // page 2 should be the trailing spaces, non-empty
    const p2 = paginateCliContent(makeResult(content), 200, 2)
    expect(p2.content.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// paginateCliContent boundary conditions
// ---------------------------------------------------------------------------
describe('paginateCliContent boundary conditions', () => {
  const longContent = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} with enough text to fill space.`).join('\n\n')
  const makeResult = (content) => ({ found: true, content, metadata: {} })

  test('pageNum = 0 clamps to page 1', () => {
    const content = longContent(20)
    const out = paginateCliContent(makeResult(content), 200, 0)
    expect(out.pageInfo.page).toBe(1)
    expect(out.pageInfo.hasPreviousPage).toBe(false)
  })

  test('pageNum = -1 clamps to page 1', () => {
    const content = longContent(20)
    const out = paginateCliContent(makeResult(content), 200, -1)
    expect(out.pageInfo.page).toBe(1)
    expect(out.pageInfo.hasPreviousPage).toBe(false)
  })

  test('null content in result returns result unchanged', () => {
    const result = { found: true, content: null, metadata: {} }
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo).toBeUndefined()
    expect(out.content).toBeNull()
  })

  test('undefined content in result returns result unchanged', () => {
    const result = { found: true, content: undefined, metadata: {} }
    const out = paginateCliContent(result, 200)
    expect(out.pageInfo).toBeUndefined()
    expect(out.content).toBeUndefined()
  })

  test('result.found = false passes through unchanged', () => {
    const result = { found: false, path: '/some/path' }
    const out = paginateCliContent(result, 200)
    expect(out.found).toBe(false)
    expect(out.pageInfo).toBeUndefined()
    expect(out.path).toBe('/some/path')
  })

  test('maxChars = 199 returns error result', () => {
    const content = 'x'.repeat(400)
    const out = paginateCliContent(makeResult(content), 199)
    expect(out.content).toContain('Error')
    expect(out.content).toContain('200')
    expect(out.pageInfo).toBeNull()
  })

  test('maxChars = 200 does not return error', () => {
    const content = 'x'.repeat(400)
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.content).not.toContain('Error')
    expect(out.pageInfo).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Content splitting quality
// ---------------------------------------------------------------------------
describe('content splitting quality', () => {
  const makeResult = (content) => ({ found: true, content, metadata: {} })

  test('markdown headers are not split mid-line', () => {
    // Build content where a header line falls near a page boundary
    // Use content that will push headers to be around the split point
    const prefix = 'x'.repeat(150) + '\n\n'
    const header = '# Important Title\n\n'
    const body = 'Some body text here.\n\n'
    const content = prefix + header + body + 'x'.repeat(400)
    const out = paginateCliContent(makeResult(content), 200)
    // The header should not appear partially — it starts at char ~152
    // so it lands in a later page fully intact
    const allPages = []
    for (let i = 1; i <= out.pageInfo.totalPages; i++) {
      allPages.push(paginateCliContent(makeResult(content), 200, i).content)
    }
    // No page should start in the middle of the header text
    const headerSplit = allPages.some(p => p.startsWith('mportant Title') || p.startsWith('portant Title'))
    expect(headerSplit).toBe(false)
  })

  test('content with code fences splits without breaking mid-fence-line', () => {
    // Build a long page with a code block; splitting should fall at \n boundaries
    const intro = 'Introduction text here.\n\n'
    const codeFence = '```javascript\n' + 'const x = 1;\n'.repeat(15) + '```\n\n'
    const outro = 'x'.repeat(300)
    const content = intro + codeFence + outro
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo.totalPages).toBeGreaterThan(1)
    // Each page should not contain half of ``` on two different pages merged
    // Verify the fence opener appears only as a whole line
    for (let i = 1; i <= out.pageInfo.totalPages; i++) {
      const page = paginateCliContent(makeResult(content), 200, i).content
      // No page should start with just `` (truncated fence)
      expect(page.startsWith('``\n') || page.startsWith('` ')).toBe(false)
    }
  })

  test('mixed paragraph and line-break content splits at paragraph boundary first', () => {
    // Content with both \n\n and \n — paragraph break should be preferred
    const para1 = 'First paragraph that is somewhat long.\n\n'
    const para2 = 'Second paragraph that is also fairly long.\n\n'
    const lines = Array.from({ length: 5 }, (_, i) => `Line ${i + 1}`).join('\n')
    const content = para1 + para2 + 'x'.repeat(300)
    const out = paginateCliContent(makeResult(content), 200)
    // The split should occur after a paragraph (content ends with \n\n or after a \n\n)
    // Page 1 content length should be <= 200
    expect(out.content.length).toBeLessThanOrEqual(200)
    expect(out.pageInfo.totalPages).toBeGreaterThan(1)
    // Confirm page 1 ends with a paragraph break (the '\n\n' is included in the cut)
    expect(out.content.endsWith('\n\n')).toBe(true)
  })

  test('content with only single newlines falls back to line-break splitting', () => {
    // 20 lines each ~25 chars, no double newlines
    const lines = Array.from({ length: 20 }, (_, i) => `Line number ${String(i + 1).padStart(2, '0')} text`)
    const content = lines.join('\n')
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo.totalPages).toBeGreaterThan(1)
    // Each page should end with a newline (line-break split includes the \n)
    expect(out.content.endsWith('\n')).toBe(true)
  })

  test('very long single line forces hard cut at maxChars', () => {
    const content = 'z'.repeat(1000)
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.content.length).toBe(200)
    expect(out.pageInfo.totalPages).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Page navigation consistency
// ---------------------------------------------------------------------------
describe('page navigation consistency', () => {
  const makeResult = (content) => ({ found: true, content, metadata: {} })
  const longContent = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} with enough text to fill space.`).join('\n\n')

  test('all pages concatenated equal original content', () => {
    const original = longContent(20)
    const first = paginateCliContent(makeResult(original), 200, 1)
    const totalPages = first.pageInfo.totalPages

    let reconstructed = ''
    for (let i = 1; i <= totalPages; i++) {
      reconstructed += paginateCliContent(makeResult(original), 200, i).content
    }

    expect(reconstructed).toBe(original)
  })

  test('last page has hasNextPage=false and hasPreviousPage=true', () => {
    const content = longContent(20)
    const first = paginateCliContent(makeResult(content), 200, 1)
    const lastPage = first.pageInfo.totalPages
    const last = paginateCliContent(makeResult(content), 200, lastPage)
    expect(last.pageInfo.hasNextPage).toBe(false)
    expect(last.pageInfo.hasPreviousPage).toBe(true)
  })

  test('first page has hasNextPage=true and hasPreviousPage=false', () => {
    const content = longContent(20)
    const first = paginateCliContent(makeResult(content), 200, 1)
    expect(first.pageInfo.hasNextPage).toBe(true)
    expect(first.pageInfo.hasPreviousPage).toBe(false)
  })

  test('single-page result when content is at or below limit has no pageInfo', () => {
    // content exactly equal to maxChars → no pagination
    const content = 'x'.repeat(200)
    const out = paginateCliContent(makeResult(content), 200)
    expect(out.pageInfo).toBeUndefined()
  })

  test('two-page result: page 1 hasNextPage=true, page 2 hasNextPage=false', () => {
    // 201 chars with no break → 2 pages exactly
    const content = 'a'.repeat(201)
    const p1 = paginateCliContent(makeResult(content), 200, 1)
    const p2 = paginateCliContent(makeResult(content), 200, 2)
    expect(p1.pageInfo.totalPages).toBe(2)
    expect(p1.pageInfo.hasNextPage).toBe(true)
    expect(p1.pageInfo.hasPreviousPage).toBe(false)
    expect(p2.pageInfo.hasNextPage).toBe(false)
    expect(p2.pageInfo.hasPreviousPage).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Formatter integration
// ---------------------------------------------------------------------------
describe('formatLookup formatter integration', () => {
  const makePageInfo = (overrides = {}) => ({
    page: 1,
    totalPages: 3,
    hasNextPage: true,
    hasPreviousPage: false,
    strategy: 'text-window',
    ...overrides,
  })

  test('formatLookup with pageInfo includes page footer', () => {
    const result = {
      found: true,
      content: 'Some documentation content.',
      pageInfo: makePageInfo(),
    }
    const output = formatLookup(result)
    expect(output).toContain('Page 1/3')
    expect(output).toContain('text-window')
  })

  test('formatLookup with pageInfo includes next-page hint when hasNextPage=true', () => {
    const result = {
      found: true,
      content: 'Content here.',
      pageInfo: makePageInfo({ page: 2, hasNextPage: true }),
    }
    const output = formatLookup(result)
    expect(output).toContain('--page 3')
  })

  test('formatLookup without pageInfo has no page footer', () => {
    const result = {
      found: true,
      content: 'Short content with no pagination.',
    }
    const output = formatLookup(result)
    expect(output).not.toContain('Page ')
    expect(output).not.toContain('text-window')
    expect(output).not.toContain('--page')
  })

  test('formatLookup with pageInfo.hasNextPage=false omits next-page hint', () => {
    const result = {
      found: true,
      content: 'Final page content.',
      pageInfo: makePageInfo({ page: 3, hasNextPage: false, hasPreviousPage: true }),
    }
    const output = formatLookup(result)
    expect(output).toContain('Page 3/3')
    expect(output).not.toContain('--page')
  })

  test('formatLookup with found=false returns not-found message', () => {
    const result = { found: false, path: '/documentation/swift/array' }
    const output = formatLookup(result)
    expect(output).toContain('Not found')
    expect(output).toContain('/documentation/swift/array')
  })
})

describe('formatSearchRead formatter integration', () => {
  const makeHit = (overrides = {}) => ({
    title: 'Array',
    framework: 'Swift',
    sourceType: 'apple-docs',
    matchQuality: 'match',
    path: '/documentation/swift/array',
    ...overrides,
  })

  const makePageInfo = (overrides = {}) => ({
    page: 1,
    totalPages: 2,
    hasNextPage: true,
    hasPreviousPage: false,
    strategy: 'text-window',
    ...overrides,
  })

  test('formatSearchRead with pageInfo includes page footer', () => {
    const result = {
      hit: makeHit(),
      page: {
        found: true,
        content: 'Documentation content for Array.',
        pageInfo: makePageInfo(),
      },
    }
    const output = formatSearchRead(result)
    expect(output).toContain('Page 1/2')
    expect(output).toContain('text-window')
  })

  test('formatSearchRead with pageInfo.hasNextPage=true shows next-page hint', () => {
    const result = {
      hit: makeHit(),
      page: {
        found: true,
        content: 'Content.',
        pageInfo: makePageInfo({ page: 1, hasNextPage: true }),
      },
    }
    const output = formatSearchRead(result)
    expect(output).toContain('--page 2')
  })

  test('formatSearchRead with pageInfo.hasNextPage=false does not show next-page hint', () => {
    const result = {
      hit: makeHit(),
      page: {
        found: true,
        content: 'Final page.',
        pageInfo: makePageInfo({ page: 2, hasNextPage: false, hasPreviousPage: true }),
      },
    }
    const output = formatSearchRead(result)
    expect(output).toContain('Page 2/2')
    expect(output).not.toContain('--page')
  })

  test('formatSearchRead without pageInfo has no page footer', () => {
    const result = {
      hit: makeHit(),
      page: {
        found: true,
        content: 'Short content.',
      },
    }
    const output = formatSearchRead(result)
    expect(output).not.toContain('Page ')
    expect(output).not.toContain('text-window')
  })

  test('formatSearchRead includes hit metadata in header', () => {
    const result = {
      hit: makeHit({ title: 'Dictionary', framework: 'Swift' }),
      page: {
        found: true,
        content: 'Dictionary docs.',
      },
    }
    const output = formatSearchRead(result)
    expect(output).toContain('Dictionary')
    expect(output).toContain('Swift')
  })

  test('formatSearchRead when page not found shows fallback message', () => {
    const result = {
      hit: makeHit(),
      page: {
        found: false,
        note: 'Markdown not available.',
      },
    }
    const output = formatSearchRead(result)
    expect(output).toContain('Markdown not available')
  })
})
