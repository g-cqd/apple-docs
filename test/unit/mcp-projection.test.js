import { describe, expect, test } from 'bun:test'
import {
  projectSearchResult,
  projectSearchHit,
  projectReadDoc,
  projectFrameworks,
  projectBrowse,
  projectStatus,
} from '../../src/mcp/projection.js'

describe('projectSearchResult', () => {
  test('strips MCP-only top-level fields', () => {
    const result = {
      query: 'View',
      results: [],
      intent: { kind: 'api' },
      trigramAvailable: true,
      bodyIndexAvailable: true,
      tier: 'standard',
    }
    const out = projectSearchResult(result)
    expect(out.intent).toBeUndefined()
    expect(out.trigramAvailable).toBeUndefined()
    expect(out.bodyIndexAvailable).toBeUndefined()
    expect(out.tier).toBe('standard')
  })

  test('strips noise from each hit', () => {
    const result = {
      results: [
        {
          title: 'View',
          urlDepth: 2,
          isReleaseNotes: false,
          score: 0.8,
          sourceMetadata: { foo: 'bar' },
          isDeprecated: true,
        },
      ],
    }
    const [hit] = projectSearchResult(result).results
    expect(hit.urlDepth).toBeUndefined()
    expect(hit.isReleaseNotes).toBeUndefined()
    expect(hit.score).toBeUndefined()
    expect(hit.sourceMetadata).toBeUndefined()
    expect(hit.isDeprecated).toBe(true)
  })
})

describe('projectSearchHit', () => {
  test('passes non-objects through', () => {
    expect(projectSearchHit(null)).toBeNull()
    expect(projectSearchHit(42)).toBe(42)
  })
})

describe('projectReadDoc', () => {
  test('collapses found:false to { found: false, note }', () => {
    const out = projectReadDoc({ found: false, note: 'missing', content: '...' })
    expect(out).toEqual({ found: false, note: 'missing' })
  })

  test('collapses found:false without note to just { found: false }', () => {
    expect(projectReadDoc({ found: false })).toEqual({ found: false })
  })

  test('skeleton mode returns [{ heading, chars }] and drops contentText', () => {
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

  test('full mode keeps content but strips sectionKind/sortOrder', () => {
    const out = projectReadDoc({
      found: true,
      sections: [
        { heading: 'Overview', contentText: 'abc', sectionKind: 'body', sortOrder: 1 },
      ],
    }, { full: true })
    expect(out.sections[0].heading).toBe('Overview')
    expect(out.sections[0].contentText).toBe('abc')
    expect(out.sections[0].sectionKind).toBeUndefined()
    expect(out.sections[0].sortOrder).toBeUndefined()
  })

  test('projects bestMatch embedded in search+read responses', () => {
    const out = projectReadDoc({
      found: true,
      bestMatch: { title: 'X', urlDepth: 3, score: 0.5 },
    })
    expect(out.bestMatch).toEqual({ title: 'X' })
  })
})

describe('projectFrameworks', () => {
  test('drops lastSeen from each root', () => {
    const out = projectFrameworks({
      roots: [{ slug: 'swiftui', name: 'SwiftUI', lastSeen: '2026-01-01' }],
    })
    expect(out.roots[0].lastSeen).toBeUndefined()
    expect(out.roots[0].slug).toBe('swiftui')
  })
})

describe('projectBrowse', () => {
  test('drops top-level slug', () => {
    const out = projectBrowse({ framework: 'SwiftUI', slug: 'swiftui', pages: [] })
    expect(out.slug).toBeUndefined()
    expect(out.framework).toBe('SwiftUI')
  })
})

describe('projectStatus', () => {
  test('drops dataDir', () => {
    const out = projectStatus({ dataDir: '/home/x/.apple-docs', tier: 'standard' })
    expect(out.dataDir).toBeUndefined()
    expect(out.tier).toBe('standard')
  })
})
