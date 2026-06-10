import { describe, test, expect } from 'bun:test'
import {
  groupArchiveByCategory,
  groupGuidelinesBySection,
  groupHigByCategory,
  groupPackagesByOwner,
  groupReleaseNotesByVersion,
  groupSwiftBookByPart,
  sortTechnotes,
} from '../../../src/web/templates/scope-groups-extra.js'
import { buildScopeGroups } from '../../../src/web/templates/framework-groups.js'

describe('groupGuidelinesBySection', () => {
  const docs = [
    { path: 'app-store-review/2.1', title: '2.1 App Completeness' },
    { path: 'app-store-review/1', title: '1. Safety' },
    { path: 'app-store-review/1.10', title: '1.10 Late Rule' },
    { path: 'app-store-review/1.2', title: '1.2 User-Generated Content' },
    { path: 'app-store-review/2', title: '2. Performance' },
    { path: 'app-store-review', title: 'App Store Review Guidelines' },
  ]

  test('sections per top-level number, labelled by the section page', () => {
    const sections = groupGuidelinesBySection(docs)
    expect(sections.map(s => s.label)).toEqual(['1. Safety', '2. Performance', 'Other'])
  })

  test('numeric rule order with the section page first (1.2 before 1.10)', () => {
    const one = groupGuidelinesBySection(docs)[0]
    expect(one.docs.map(d => d.path)).toEqual([
      'app-store-review/1',
      'app-store-review/1.2',
      'app-store-review/1.10',
    ])
  })
})

describe('groupReleaseNotesByVersion', () => {
  const docs = [
    { path: 'rn/ios-17', title: 'iOS 17 Release Notes' },
    { path: 'rn/ios-18_2', title: 'iOS 18.2 Release Notes' },
    { path: 'rn/ios-18', title: 'iOS 18 Release Notes' },
    { path: 'rn/foundation', title: 'Foundation Release Notes' },
  ]

  test('majors newest first, versions newest first within, versionless last', () => {
    const sections = groupReleaseNotesByVersion(docs)
    expect(sections.map(s => s.label)).toEqual(['iOS 18', 'iOS 17', 'Other'])
    expect(sections[0].docs.map(d => d.title)).toEqual(['iOS 18.2 Release Notes', 'iOS 18 Release Notes'])
  })
})

describe('groupSwiftBookByPart', () => {
  test('parts in reading order', () => {
    const sections = groupSwiftBookByPart([
      { path: 'swift-book/ReferenceManual/Types', title: 'Types' },
      { path: 'swift-book/GuidedTour/AboutSwift', title: 'About Swift' },
      { path: 'swift-book/LanguageGuide/Closures', title: 'Closures' },
    ])
    expect(sections.map(s => s.label)).toEqual(['A Swift Tour', 'Language Guide', 'Language Reference'])
  })
})

describe('groupPackagesByOwner', () => {
  test('owners by catalog size, repos alphabetical', () => {
    const sections = groupPackagesByOwner([
      { path: 'packages/vapor/vapor', title: 'vapor' },
      { path: 'packages/apple/swift-nio', title: 'swift-nio' },
      { path: 'packages/apple/swift-argument-parser', title: 'swift-argument-parser' },
    ])
    expect(sections.map(s => s.label)).toEqual(['apple', 'vapor'])
    expect(sections[0].docs.map(d => d.title)).toEqual(['swift-argument-parser', 'swift-nio'])
  })
})

describe('sortTechnotes', () => {
  test('single section, newest TN first, non-TN pages last', () => {
    const [section] = sortTechnotes([
      { path: 'technotes', title: 'Technotes' },
      { path: 'technotes/tn3102', title: 'TN3102: HTTP/3 in your app' },
      { path: 'technotes/tn3105', title: 'TN3105: Status bar style' },
    ])
    expect(section.docs.map(d => d.title)).toEqual([
      'TN3105: Status bar style',
      'TN3102: HTTP/3 in your app',
      'Technotes',
    ])
  })
})

describe('groupArchiveByCategory', () => {
  test('legacy categories by size with readable labels', () => {
    const sections = groupArchiveByCategory([
      { path: 'apple-archive/a', title: 'A', framework: 'cocoa' },
      { path: 'apple-archive/b', title: 'B', framework: 'cocoa' },
      { path: 'apple-archive/c', title: 'C', framework: 'networkinginternet' },
      { path: 'apple-archive/d', title: 'D', framework: null },
    ])
    expect(sections.map(s => s.label)).toEqual(['Cocoa', 'Networking & Internet', 'Other'])
  })
})

describe('groupHigByCategory', () => {
  const higGroups = new Map([
    ['design/human-interface-guidelines/alerts', { label: 'Patterns', parentPath: 'design/human-interface-guidelines/patterns', order: 1 }],
    ['design/human-interface-guidelines/color', { label: 'Foundations', parentPath: 'design/human-interface-guidelines/foundations', order: 0 }],
  ])
  const docs = [
    { path: 'design/human-interface-guidelines/alerts', title: 'Alerts' },
    { path: 'design/human-interface-guidelines/color', title: 'Color' },
    { path: 'design/human-interface-guidelines/patterns', title: 'Patterns' },
    { path: 'design/human-interface-guidelines/unmapped', title: 'Unmapped' },
  ]

  test('categories in landing-page order, category page heads its section', () => {
    const sections = groupHigByCategory(docs, higGroups)
    expect(sections.map(s => s.label)).toEqual(['Foundations', 'Patterns', 'Other'])
    expect(sections[1].docs.map(d => d.title)).toEqual(['Patterns', 'Alerts'])
  })

  test('returns null without a membership map (caller falls back to roles)', () => {
    expect(groupHigByCategory(docs, undefined)).toBeNull()
    expect(groupHigByCategory(docs, new Map())).toBeNull()
  })
})

describe('buildScopeGroups dispatch (new scopes)', () => {
  test('release-notes kind routes to version grouping', () => {
    const scope = buildScopeGroups(
      { slug: 'xcode-release-notes', kind: 'release-notes', source_type: 'apple-docc' },
      [{ path: 'xcode-release-notes/xcode-16', title: 'Xcode 16 Release Notes' }],
    )
    expect(scope?.scope).toBe('release-notes')
    expect(scope.sections[0].label).toBe('Xcode 16')
  })

  test('hig without extras falls back to null', () => {
    const scope = buildScopeGroups(
      { slug: 'design', kind: 'design', source_type: 'hig' },
      [{ path: 'design/human-interface-guidelines/alerts', title: 'Alerts' }],
    )
    expect(scope).toBeNull()
  })

  test('archive root gets a category nav', () => {
    const scope = buildScopeGroups(
      { slug: 'apple-archive', kind: 'collection', source_type: 'apple-archive' },
      [{ path: 'apple-archive/a', title: 'A', framework: 'carbon' }],
    )
    expect(scope?.nav?.[0]?.label).toBe('Carbon')
  })
})
