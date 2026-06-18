import { describe, expect, test } from 'bun:test'
import {
  buildScopeGroups,
  groupSampleCodeByFramework,
  groupSwiftEvolutionByStatus,
  groupWwdcByYear,
  swiftEvolutionStatusLabel,
} from '../../../src/web/templates/framework-groups.js'
import { renderFrameworkPage } from '../../../src/web/templates.js'

const siteConfig = {
  baseUrl: '',
  siteName: 'Apple Docs',
  buildDate: '2026-04-13',
}

// ---------------------------------------------------------------------------
// groupWwdcByYear
// ---------------------------------------------------------------------------

describe('groupWwdcByYear', () => {
  const sessions = [
    { path: 'wwdc/wwdc2023-10042', title: 'Zebra session' },
    { path: 'wwdc/wwdc2024-10195', title: 'Bring expression to your app' },
    { path: 'wwdc/wwdc2024-10134', title: 'Add personality with genmoji' },
    { path: 'wwdc/wwdc1997-805', title: 'Steve Jobs closing keynote' },
  ]

  test('groups by year descending with counts', () => {
    const groups = groupWwdcByYear(sessions)
    expect(groups.map((g) => g.label)).toEqual(['2024', '2023', '1997'])
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1])
    expect(groups[0].id).toBe('year-2024')
  })

  test('sorts sessions by title within a year', () => {
    const groups = groupWwdcByYear(sessions)
    expect(groups[0].docs.map((d) => d.title)).toEqual(['Add personality with genmoji', 'Bring expression to your app'])
  })

  test('collects pages without a year in the path into a trailing Other group', () => {
    const groups = groupWwdcByYear([...sessions, { path: 'wwdc/about', title: 'About' }])
    const last = groups[groups.length - 1]
    expect(last.label).toBe('Other')
    expect(last.id).toBe('year-other')
    expect(last.docs).toHaveLength(1)
  })

  test('accepts docs keyed by `key` instead of `path`', () => {
    const groups = groupWwdcByYear([{ key: 'wwdc/wwdc2020-10001', title: 'A' }])
    expect(groups[0].label).toBe('2020')
  })

  test('handles empty and null input', () => {
    expect(groupWwdcByYear([])).toEqual([])
    expect(groupWwdcByYear(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// swiftEvolutionStatusLabel + groupSwiftEvolutionByStatus
// ---------------------------------------------------------------------------

describe('swiftEvolutionStatusLabel', () => {
  test('normalizes status variants to their family', () => {
    expect(swiftEvolutionStatusLabel('Implemented (Swift 3.0)')).toBe('Implemented')
    expect(swiftEvolutionStatusLabel('Implemented with Modifications (Swift 5.1)')).toBe('Implemented')
    expect(swiftEvolutionStatusLabel('Partially implemented (Swift 5.3)')).toBe('Partially Implemented')
    expect(swiftEvolutionStatusLabel('Accepted with modifications')).toBe('Accepted')
    expect(swiftEvolutionStatusLabel('Active review (June 1...June 15, 2026)')).toBe('Active Review')
    expect(swiftEvolutionStatusLabel('Returned for revision')).toBe('Returned for Revision')
    expect(swiftEvolutionStatusLabel('Rejected ([Rationale](https://example))')).toBe('Rejected')
    expect(swiftEvolutionStatusLabel('Withdrawn')).toBe('Withdrawn')
  })

  test('falls back to Other for unknown or missing status', () => {
    expect(swiftEvolutionStatusLabel('')).toBe('Other')
    expect(swiftEvolutionStatusLabel(null)).toBe('Other')
    expect(swiftEvolutionStatusLabel('Some novel state')).toBe('Other')
  })
})

describe('groupSwiftEvolutionByStatus', () => {
  const proposals = [
    {
      path: 'swift-evolution/0099-conditionclauses',
      title: 'Restructuring Condition Clauses',
      source_metadata: '{"seNumber":"SE-0099","status":"Implemented (Swift 3.0)","swiftVersion":"3.0"}',
    },
    {
      path: 'swift-evolution/0413-typed-throws',
      title: 'Typed throws',
      source_metadata: '{"seNumber":"SE-0413","status":"Implemented (Swift 6.0)","swiftVersion":"6.0"}',
    },
    {
      path: 'swift-evolution/0243-codepoint',
      title: 'Integer-convertible character literals',
      source_metadata: '{"seNumber":"SE-0243","status":"Rejected"}',
    },
    {
      path: 'swift-evolution/9999-mystery',
      title: 'Mystery proposal',
      source_metadata: null,
    },
  ]

  test('groups by status family in canonical order with Other last', () => {
    const groups = groupSwiftEvolutionByStatus(proposals)
    expect(groups.map((g) => g.label)).toEqual(['Implemented', 'Rejected', 'Other'])
    expect(groups[0].count).toBe(2)
  })

  test('sorts proposals by SE number descending within a group', () => {
    const groups = groupSwiftEvolutionByStatus(proposals)
    expect(groups[0].docs.map((d) => d.title)).toEqual(['Typed throws', 'Restructuring Condition Clauses'])
  })

  test('attaches an SE number + Swift version meta line', () => {
    const groups = groupSwiftEvolutionByStatus(proposals)
    expect(groups[0].docs[0].meta).toBe('SE-0413 · Swift 6.0')
    expect(groups[1].docs[0].meta).toBe('SE-0243')
  })

  test('tolerates malformed metadata JSON', () => {
    const groups = groupSwiftEvolutionByStatus([{ path: 'swift-evolution/0001-broken', title: 'Broken', source_metadata: '{nope' }])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Other')
    expect(groups[0].docs[0].meta).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// groupSampleCodeByFramework
// ---------------------------------------------------------------------------

describe('groupSampleCodeByFramework', () => {
  const samples = [
    { path: 'sample-code/visionos/world', title: 'World', source_metadata: '{"sampleProject":true,"frameworks":["visionos"]}' },
    { path: 'sample-code/metal/fishtank', title: 'Fishtank', source_metadata: '{"sampleProject":true,"frameworks":["metal","metalkit"]}' },
    { path: 'sample-code/metal/argbuffers', title: 'Argument buffers', source_metadata: '{"sampleProject":true,"frameworks":["metal"]}' },
    { path: 'sample-code/misc/no-frameworks', title: 'Unfiled', source_metadata: '{"sampleProject":true,"frameworks":[]}' },
  ]

  test('groups by first framework entry, alphabetical with Other last', () => {
    const groups = groupSampleCodeByFramework(samples)
    expect(groups.map((g) => g.label)).toEqual(['metal', 'visionos', 'Other'])
    expect(groups[0].count).toBe(2)
    expect(groups[0].id).toBe('fw-metal')
  })

  test('sorts samples by title within a group', () => {
    const groups = groupSampleCodeByFramework(samples)
    expect(groups[0].docs.map((d) => d.title)).toEqual(['Argument buffers', 'Fishtank'])
  })

  test('missing metadata falls back to Other', () => {
    const groups = groupSampleCodeByFramework([{ path: 'sample-code/x', title: 'X' }])
    expect(groups).toEqual([{ id: 'fw-other', label: 'Other', count: 1, docs: [{ path: 'sample-code/x', title: 'X' }] }])
  })
})

// ---------------------------------------------------------------------------
// buildScopeGroups + renderFrameworkPage integration
// ---------------------------------------------------------------------------

describe('buildScopeGroups', () => {
  test('detects scope from source_type or slug', () => {
    const docs = [{ path: 'wwdc/wwdc2024-10195', title: 'Session' }]
    expect(buildScopeGroups({ slug: 'wwdc', source_type: 'wwdc' }, docs)?.scope).toBe('wwdc')
    expect(buildScopeGroups({ slug: 'wwdc' }, docs)?.scope).toBe('wwdc')
    expect(buildScopeGroups({ slug: 'swift-evolution', source_type: 'swift-evolution' }, docs)?.scope).toBe('swift-evolution')
    expect(buildScopeGroups({ slug: 'sample-code', source_type: 'sample-code' }, docs)?.scope).toBe('sample-code')
  })

  test('returns null for ordinary frameworks and empty corpora', () => {
    const docs = [{ path: 'swiftui/view', title: 'View' }]
    expect(buildScopeGroups({ slug: 'swiftui', source_type: 'apple-docc' }, docs)).toBeNull()
    expect(buildScopeGroups(null, docs)).toBeNull()
    expect(buildScopeGroups({ slug: 'wwdc', source_type: 'wwdc' }, [])).toBeNull()
  })

  test('only the wwdc scope exposes a jump nav', () => {
    const wwdc = buildScopeGroups({ slug: 'wwdc' }, [{ path: 'wwdc/wwdc2024-10195', title: 'S' }])
    expect(wwdc.nav).toEqual([{ href: '#year-2024', label: '2024', count: 1 }])
    const se = buildScopeGroups({ slug: 'swift-evolution' }, [{ path: 'swift-evolution/0001-a', title: 'A' }])
    expect(se.nav).toBeUndefined()
  })
})

describe('renderFrameworkPage scope-aware sections', () => {
  const wwdcRoot = { slug: 'wwdc', display_name: 'WWDC Session Transcripts', kind: 'collection', source_type: 'wwdc' }
  const wwdcDocs = [
    { path: 'wwdc/wwdc2024-10195', title: 'Bring expression to your app', role: 'article' },
    { path: 'wwdc/wwdc2023-10042', title: 'Older session', role: 'article' },
  ]

  test('wwdc root renders year sections with counts and a jump nav', () => {
    const page = renderFrameworkPage(wwdcRoot, wwdcDocs, siteConfig).toString()
    expect(page).toContain('class="scope-jump-nav"')
    expect(page).toContain('href="#year-2024"')
    expect(page).toMatch(/<section id="year-2024" class="role-group" data-filter-kind="2024">/)
    expect(page).toContain('<span class="group-count">(1)</span>')
    const idx2024 = page.indexOf('id="year-2024"')
    const idx2023 = page.indexOf('id="year-2023"')
    expect(idx2024).toBeGreaterThan(-1)
    expect(idx2023).toBeGreaterThan(idx2024)
  })

  test('swift-evolution root renders status sections with SE meta', () => {
    const root = { slug: 'swift-evolution', display_name: 'Swift Evolution Proposals', source_type: 'swift-evolution' }
    const docs = [
      {
        path: 'swift-evolution/0413-typed-throws',
        title: 'Typed throws',
        role: 'article',
        source_metadata: '{"seNumber":"SE-0413","status":"Implemented (Swift 6.0)","swiftVersion":"6.0"}',
      },
    ]
    const page = renderFrameworkPage(root, docs, siteConfig).toString()
    expect(page).toMatch(/<section id="status-implemented"[^>]*data-filter-kind="Implemented">/)
    expect(page).toContain('SE-0413 · Swift 6.0')
  })

  test('sample-code root renders framework sections', () => {
    const root = { slug: 'sample-code', display_name: 'Apple Sample Code', source_type: 'sample-code' }
    const docs = [
      {
        path: 'sample-code/metal/fishtank',
        title: 'Fishtank',
        role: 'sampleCode',
        source_metadata: '{"sampleProject":true,"frameworks":["metal"]}',
      },
    ]
    const page = renderFrameworkPage(root, docs, siteConfig).toString()
    expect(page).toMatch(/<section id="fw-metal"[^>]*data-filter-kind="metal">/)
  })

  test('ordinary frameworks keep role-based grouping and no jump nav', () => {
    const root = { slug: 'swiftui', name: 'SwiftUI', kind: 'framework' }
    const docs = [
      { title: 'View', key: 'documentation/swiftui/view', role: 'symbol', role_heading: 'Protocol' },
      { title: 'Getting Started', key: 'documentation/swiftui/getting-started', role: 'article' },
    ]
    const page = renderFrameworkPage(root, docs, siteConfig).toString()
    expect(page).toMatch(/section[^>]*class="role-group" data-filter-kind="Symbols"/)
    expect(page).not.toContain('scope-jump-nav')
    expect(page).not.toContain('group-count')
  })
})
