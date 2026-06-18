import { describe, expect, test } from 'bun:test'
import {
  projectBrowse,
  projectFrameworks,
  projectListAppleFonts,
  projectReadDoc,
  projectRenderFontText,
  projectRenderSfSymbol,
  projectSearchHit,
  projectSearchResult,
  projectSearchSfSymbols,
  projectStatus,
  projectTaxonomy,
} from '../../../src/output/projection.js'

// --- search ----------------------------------------------------------------

describe('projectSearchResult', () => {
  test('drops every infrastructural top-level field', () => {
    const out = projectSearchResult({
      query: 'View',
      total: 1,
      results: [{ title: 'View', matchQuality: 'exact' }],
      intent: { kind: 'api' },
      trigramAvailable: true,
      bodyIndexAvailable: true,
      tier: 'full',
      relaxed: false,
      relaxationTier: null,
      partial: false,
      partialReasons: [],
      pageInfo: { page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false, strategy: 'items', totalItems: 1, pageItems: 1, maxChars: 4096 },
    })
    expect(out.intent).toBeUndefined()
    expect(out.trigramAvailable).toBeUndefined()
    expect(out.bodyIndexAvailable).toBeUndefined()
    expect(out.tier).toBeUndefined()
    expect(out.relaxed).toBeUndefined()
    expect(out.relaxationTier).toBeUndefined()
    expect(out.partial).toBeUndefined()
    expect(out.partialReasons).toBeUndefined()
    expect(out.pageInfo.strategy).toBeUndefined()
    expect(out.pageInfo.totalSections).toBeUndefined()
    expect(out.pageInfo.pageSections).toBeUndefined()
    expect(out.pageInfo.maxChars).toBeUndefined()
    expect(out.pageInfo.page).toBe(1)
    expect(out.pageInfo.totalItems).toBe(1)
  })

  test('emits top-level approximate: true when any hit is approximate', () => {
    const out = projectSearchResult({
      query: 'foo',
      total: 2,
      results: [
        { title: 'Exact', matchQuality: 'exact' },
        { title: 'Loose', matchQuality: 'fuzzy' },
      ],
    })
    expect(out.approximate).toBe(true)
  })

  test('omits approximate top-level when all hits are partial/exact', () => {
    const out = projectSearchResult({
      query: 'foo',
      total: 2,
      results: [
        { title: 'Exact', matchQuality: 'exact' },
        { title: 'Partial', matchQuality: 'body' },
      ],
    })
    expect(out.approximate).toBeUndefined()
  })

  test('promotes partial:true to truncated:true', () => {
    const out = projectSearchResult({
      query: 'foo',
      total: 0,
      results: [],
      partial: true,
      partialReasons: ['body'],
    })
    expect(out.truncated).toBe(true)
    expect(out.partial).toBeUndefined()
    expect(out.partialReasons).toBeUndefined()
  })

  test('dispatches to projectReadDoc when result is doc-shaped', () => {
    const out = projectSearchResult({
      found: true,
      metadata: { title: 'View', tier: 'full' },
      content: 'body',
      sections: [],
    })
    expect(out.found).toBe(true)
    expect(out.metadata.title).toBe('View')
    expect(out.metadata.tier).toBeUndefined()
  })

  test('shape stays empty when results are empty', () => {
    const out = projectSearchResult({ query: 'q', total: 0, results: [] })
    expect(out).toEqual({ query: 'q', total: 0, results: [] })
  })
})

describe('projectSearchHit', () => {
  test('drops urlDepth, score, sourceMetadata, isReleaseNotes:false, distance', () => {
    const out = projectSearchHit({
      title: 'View',
      path: 'swiftui/view',
      urlDepth: 2,
      isReleaseNotes: false,
      score: 0.8,
      sourceMetadata: { foo: 'bar' },
      distance: 3,
      matchQuality: 'exact',
    })
    expect(out.urlDepth).toBeUndefined()
    expect(out.isReleaseNotes).toBeUndefined()
    expect(out.score).toBeUndefined()
    expect(out.sourceMetadata).toBeUndefined()
    expect(out.distance).toBeUndefined()
    expect(out.confidence).toBe('exact')
  })

  test('preserves isDeprecated, isBeta, isReleaseNotes true-only', () => {
    const out = projectSearchHit({
      title: 'X',
      matchQuality: 'match',
      isDeprecated: true,
      isBeta: true,
      isReleaseNotes: true,
    })
    expect(out.isDeprecated).toBe(true)
    expect(out.isBeta).toBe(true)
    expect(out.isReleaseNotes).toBe(true)
  })

  test('passes non-objects through', () => {
    expect(projectSearchHit(null)).toBeNull()
    expect(projectSearchHit(42)).toBe(42)
  })

  test('webPath is emitted only with webPaths:true and only for overlong keys', () => {
    const longHit = {
      title: 'X',
      matchQuality: 'exact',
      path: `swiftui/view/init(${'parameterlabel:'.repeat(20)})`,
    }
    // Default (MCP / CLI): no webPath, raw corpus key untouched.
    expect(projectSearchHit(longHit).webPath).toBeUndefined()
    expect(projectSearchHit(longHit).path).toBe(longHit.path)
    // Web: hashed webPath alongside the raw path.
    const web = projectSearchHit(longHit, { webPaths: true })
    expect(web.webPath).toMatch(/~[0-9a-f]{12}$/)
    expect(web.path).toBe(longHit.path)
    // Short keys never carry webPath, even on the web surface.
    const short = projectSearchHit({ title: 'V', matchQuality: 'exact', path: 'swiftui/view' }, { webPaths: true })
    expect(short.webPath).toBeUndefined()
  })
})

// --- read_doc --------------------------------------------------------------

describe('projectReadDoc', () => {
  test('collapses found:false to { found: false, note }', () => {
    expect(projectReadDoc({ found: false, note: 'missing', content: '...' })).toEqual({
      found: false,
      note: 'missing',
    })
  })

  test('collapses found:false without note to just { found: false }', () => {
    expect(projectReadDoc({ found: false })).toEqual({ found: false })
  })

  test('skeleton mode returns [{ heading, chars }] and drops DB column names', () => {
    const out = projectReadDoc({
      found: true,
      sections: [
        { heading: 'Overview', contentText: 'abcdef', sectionKind: 'body', sortOrder: 1 },
        { heading: 'Details', contentText: '12345', sectionKind: 'body', sortOrder: 2 },
      ],
    })
    expect(out.sections).toEqual([
      { heading: 'Overview', chars: 6 },
      { heading: 'Details', chars: 5 },
    ])
  })

  test('full mode keeps contentText but strips sectionKind/sortOrder', () => {
    const out = projectReadDoc(
      {
        found: true,
        sections: [{ heading: 'Overview', contentText: 'abc', sectionKind: 'body', sortOrder: 1 }],
      },
      { full: true },
    )
    expect(out.sections[0]).toEqual({ heading: 'Overview', contentText: 'abc' })
  })

  test('drops urlDepth, sourceMetadata, tier from metadata', () => {
    const out = projectReadDoc({
      found: true,
      metadata: {
        title: 'View',
        path: 'swiftui/view',
        urlDepth: 2,
        sourceMetadata: { foo: 'bar' },
        tier: 'full',
      },
    })
    expect(out.metadata.urlDepth).toBeUndefined()
    expect(out.metadata.sourceMetadata).toBeUndefined()
    expect(out.metadata.tier).toBeUndefined()
    expect(out.metadata.title).toBe('View')
  })

  test('keeps relationships counts on metadata', () => {
    const out = projectReadDoc({
      found: true,
      metadata: {
        title: 'View',
        relationships: { inheritsFrom: 1, conformsTo: 3, seeAlso: 6, children: 12 },
      },
    })
    expect(out.metadata.relationships).toEqual({ inheritsFrom: 1, conformsTo: 3, seeAlso: 6, children: 12 })
  })

  test('projects bestMatch through projectSearchHit (drops urlDepth, score)', () => {
    const out = projectReadDoc({
      found: true,
      bestMatch: { title: 'X', urlDepth: 3, score: 0.5, matchQuality: 'fuzzy', distance: 1 },
    })
    expect(out.bestMatch.urlDepth).toBeUndefined()
    expect(out.bestMatch.score).toBeUndefined()
    expect(out.bestMatch.distance).toBeUndefined()
    expect(out.bestMatch.confidence).toBe('approximate')
  })
})

// --- list_frameworks --------------------------------------------------------

describe('projectFrameworks', () => {
  test('drops lastSeen, status, displayName, sourceType from each root', () => {
    const out = projectFrameworks({
      roots: [
        {
          slug: 'swiftui',
          name: 'SwiftUI',
          kind: 'framework',
          status: 'active',
          lastSeen: '2026-01-01',
          displayName: 'SwiftUI',
          sourceType: 'apple-docc',
          pageCount: 100,
        },
      ],
      total: 1,
    })
    expect(out.roots[0]).toEqual({ slug: 'swiftui', name: 'SwiftUI', kind: 'framework', pageCount: 100 })
    expect(out.total).toBe(1)
  })

  test('preserves total and pageInfo (slim)', () => {
    const out = projectFrameworks({
      roots: [],
      total: 0,
      pageInfo: { page: 1, totalPages: 1, hasNextPage: false, hasPreviousPage: false, strategy: 'items', totalItems: 0 },
    })
    expect(out.pageInfo.strategy).toBeUndefined()
    expect(out.pageInfo.page).toBe(1)
  })
})

// --- browse -----------------------------------------------------------------

describe('projectBrowse', () => {
  test('drops slug and kind at top level', () => {
    const out = projectBrowse({
      framework: 'SwiftUI',
      slug: 'swiftui',
      kind: 'framework',
      pages: [],
      total: 0,
    })
    expect(out.slug).toBeUndefined()
    expect(out.framework).toBe('SwiftUI')
  })

  test('drops abstract... wait: keep abstract in pages', () => {
    const out = projectBrowse({
      framework: 'SwiftUI',
      pages: [{ path: 'a', title: 'A', kind: 'symbol', abstract: 'abs' }],
    })
    expect(out.pages[0].abstract).toBe('abs')
  })

  test('preserves children section labels', () => {
    const out = projectBrowse({
      framework: 'SwiftUI',
      path: 'swiftui/view',
      title: 'View',
      children: [{ path: 'swiftui/view/body', title: 'body', kind: 'symbol', section: 'Topics' }],
    })
    expect(out.children[0].section).toBe('Topics')
  })
})

// --- list_taxonomy ----------------------------------------------------------

describe('projectTaxonomy', () => {
  test('uniform shape across both targeted and broad input', () => {
    const single = projectTaxonomy({ field: 'kind', values: [{ value: 'symbol', count: 100 }] })
    expect(single).toEqual({ kind: [{ value: 'symbol', count: 100 }] })

    const broad = projectTaxonomy({
      kind: [{ value: 'symbol', count: 100 }],
      role: [{ value: 'article', count: 10 }],
    })
    expect(broad).toEqual({
      kind: [{ value: 'symbol', count: 100 }],
      role: [{ value: 'article', count: 10 }],
    })
  })

  test('ignores unknown taxonomy fields', () => {
    const out = projectTaxonomy({
      kind: [{ value: 'a', count: 1 }],
      internalCacheState: 'leak',
    })
    expect(out.internalCacheState).toBeUndefined()
  })
})

// --- assets -----------------------------------------------------------------

describe('projectSearchSfSymbols', () => {
  test('keeps only name + scope', () => {
    const out = projectSearchSfSymbols({ results: [{ name: 'a', scope: 'public', internalRank: 0.5 }] })
    expect(out.results[0]).toEqual({ name: 'a', scope: 'public' })
  })
})

describe('projectListAppleFonts', () => {
  test('drops file_path from every file entry', () => {
    const out = projectListAppleFonts({
      families: [
        {
          id: 'sf-pro',
          name: 'SF Pro',
          files: [{ id: 'f1', file_name: 'SFPro.ttf', file_path: '/var/cache/SFPro.ttf' }],
        },
      ],
    })
    expect(out.families[0].files[0]).toEqual({ id: 'f1', file_name: 'SFPro.ttf' })
  })
})

describe('projectRenderSfSymbol', () => {
  test('drops file_path', () => {
    const out = projectRenderSfSymbol({
      name: 'pencil',
      scope: 'public',
      format: 'svg',
      file_path: '/var/cache/pencil.svg',
      resourceUri: 'apple-docs://...',
      svg: '<svg/>',
    })
    expect(out.file_path).toBeUndefined()
    expect(out.resourceUri).toBe('apple-docs://...')
    expect(out.svg).toBe('<svg/>')
  })
})

describe('projectRenderFontText', () => {
  test('drops format and font internals', () => {
    const out = projectRenderFontText({
      text: 'hello',
      mimeType: 'image/svg+xml',
      content: '<svg/>',
      format: 'svg-1',
      font: { internal: 'state' },
    })
    expect(out.format).toBeUndefined()
    expect(out.font).toBeUndefined()
    expect(out.content).toBe('<svg/>')
  })
})

// --- status -----------------------------------------------------------------

describe('projectStatus', () => {
  test('drops tier, capabilities, crawl internals by default', () => {
    const out = projectStatus({
      dataDir: '/x',
      tier: 'full',
      capabilities: { search: true, searchTrigram: true, searchBody: true, readContent: true },
      databaseSize: 100,
      rawJson: { size: 200, files: 5 },
      markdown: { size: 300, files: 6 },
      roots: { total: 7, byKind: { framework: 5 } },
      pages: { active: 50, deleted: 1 },
      activity: { action: 'sync', status: 'running', startedAt: 't', pid: 12345, alive: true, roots: ['x'] },
      crawlProgress: { total: 100, processed: 50, pending: 50, failed: 0 },
      crawlByRoot: [{ root_slug: 'x', processed: 5, pending: 5, failed: 0 }],
      lastSync: 'when',
      lastAction: 'sync',
    })
    expect(out.tier).toBeUndefined()
    expect(out.capabilities).toBeUndefined()
    expect(out.crawlProgress).toBeUndefined()
    expect(out.crawlByRoot).toBeUndefined()
    expect(out.activity.pid).toBeUndefined()
    expect(out.activity.alive).toBeUndefined()
    expect(out.dataDir).toBe('/x')
    expect(out.lastSync).toBe('when')
  })

  test('--advanced passes raw envelope through', () => {
    const raw = { tier: 'full', databaseSize: 1, secret: 'value' }
    expect(projectStatus(raw, { advanced: true })).toBe(raw)
  })
})
