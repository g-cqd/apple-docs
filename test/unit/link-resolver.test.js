import { describe, expect, test } from 'bun:test'
import {
  classifyLink,
  createLinkResolver,
  mapUrlToKey,
} from '../../src/lib/link-resolver.js'

describe('mapUrlToKey', () => {
  test('developer.apple.com/documentation → framework key', () => {
    expect(mapUrlToKey('https://developer.apple.com/documentation/swiftui/view'))
      .toBe('swiftui/view')
    expect(mapUrlToKey('https://developer.apple.com/documentation/SwiftUI/View'))
      .toBe('swiftui/view')
    expect(mapUrlToKey('https://developer.apple.com/documentation/foundation/'))
      .toBe('foundation')
  })

  test('developer.apple.com/design → design/ key', () => {
    expect(mapUrlToKey('https://developer.apple.com/design/human-interface-guidelines/foundations'))
      .toBe('design/human-interface-guidelines/foundations')
  })

  test('developer.apple.com/library/archive → apple-archive key', () => {
    // Terminal `Foo.html` whose parent is also `Foo` collapses (matches catalog).
    expect(mapUrlToKey('https://developer.apple.com/library/archive/documentation/Aperture/Conceptual/AppleApp_Aperture_3.4/Overview/Overview.html'))
      .toBe('apple-archive/documentation/Aperture/Conceptual/AppleApp_Aperture_3.4/Overview')
    // `index.html` collapses too.
    expect(mapUrlToKey('https://developer.apple.com/library/archive/documentation/Foo/Bar/index.html'))
      .toBe('apple-archive/documentation/Foo/Bar')
    // Distinct sibling stays terminal.
    expect(mapUrlToKey('https://developer.apple.com/library/archive/documentation/Foo/Bar/Sibling.html'))
      .toBe('apple-archive/documentation/Foo/Bar/Sibling.html')
  })

  test('developer.apple.com/videos/play/wwdcYYYY/ID → wwdc/wwdcYYYY-ID', () => {
    expect(mapUrlToKey('https://developer.apple.com/videos/play/wwdc2024/10001/'))
      .toBe('wwdc/wwdc2024-10001')
    expect(mapUrlToKey('https://developer.apple.com/videos/play/wwdc2025/281'))
      .toBe('wwdc/wwdc2025-281')
  })

  test('docs.swift.org/{compiler,swiftpm,swift-book} → corpus slug', () => {
    expect(mapUrlToKey('https://docs.swift.org/compiler/documentation/diagnostics/diagnostic-groups'))
      .toBe('swift-compiler/documentation/diagnostics/diagnostic-groups')
    expect(mapUrlToKey('https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/usage'))
      .toBe('swift-package-manager/documentation/packagemanagerdocs/usage')
    expect(mapUrlToKey('https://docs.swift.org/swift-book/documentation/the-swift-programming-language/thebasics/'))
      .toBe('swift-book/documentation/the-swift-programming-language/thebasics')
  })

  test('swift.org redirect paths map to their archive home', () => {
    expect(mapUrlToKey('https://swift.org/documentation/concurrency'))
      .toBe('swift-migration-guide/documentation/migrationguide')
    expect(mapUrlToKey('https://swift.org/documentation/package-manager/'))
      .toBe('swift-package-manager/documentation/packagemanagerdocs')
    expect(mapUrlToKey('https://www.swift.org/documentation/tspl'))
      .toBe('swift-book/The-Swift-Programming-Language')
  })

  test('swift.org/migration/* → swift-migration-guide/*', () => {
    expect(mapUrlToKey('https://swift.org/migration/documentation/swift-6-concurrency-migration-guide/dataracesafety'))
      .toBe('swift-migration-guide/documentation/swift-6-concurrency-migration-guide/dataracesafety')
  })

  test('swift.org/swift-evolution/proposals → swift-evolution key', () => {
    expect(mapUrlToKey('https://swift.org/swift-evolution/proposals/0179-swift-run-command.html'))
      .toBe('swift-evolution/0179-swift-run-command')
    expect(mapUrlToKey('https://github.com/apple/swift-evolution/blob/main/proposals/0253-callable.md'))
      .toBe('swift-evolution/0253-callable')
  })

  test('swift.org generic paths are NOT auto-mapped (curated-only via createLinkResolver)', () => {
    // mapUrlToKey only recognizes structured patterns. Generic swift.org
    // paths like /getting-started/cli-swiftpm need the swift-org adapter's
    // CURATED_PATHS to opt in via createLinkResolver({ swiftOrgPaths }).
    expect(mapUrlToKey('https://swift.org/getting-started/cli-swiftpm')).toBeNull()
    expect(mapUrlToKey('https://www.swift.org/about/')).toBeNull()
  })

  test('returns null for unrecognized URLs', () => {
    expect(mapUrlToKey('https://forums.swift.org/t/some-thread/1234')).toBeNull()
    expect(mapUrlToKey('https://github.com/apple/swift')).toBeNull()
    expect(mapUrlToKey('https://example.com/foo')).toBeNull()
    expect(mapUrlToKey('not a url')).toBeNull()
    expect(mapUrlToKey('')).toBeNull()
    expect(mapUrlToKey(null)).toBeNull()
  })
})

describe('createLinkResolver', () => {
  test('rewrites internalizable URLs to /docs/<key>/', () => {
    const knownKeys = new Set(['swift-compiler/documentation/diagnostics'])
    const resolve = createLinkResolver({ knownKeys })
    expect(resolve('https://docs.swift.org/compiler/documentation/diagnostics/'))
      .toBe('/docs/swift-compiler/documentation/diagnostics/')
  })

  test('preserves URL fragments on internalized rewrites', () => {
    const swiftOrgPaths = new Set(['contributing'])
    const resolve = createLinkResolver({ swiftOrgPaths, sourceUrl: 'https://swift.org/about/' })
    expect(resolve('/contributing/#reporting-bugs'))
      .toBe('/docs/swift-org/contributing/#reporting-bugs')
  })

  test('absolutizes relative URLs against sourceUrl when no internal match', () => {
    const resolve = createLinkResolver({ sourceUrl: 'https://swift.org/about/' })
    // /LICENSE.txt isn't a curated path → absolutize.
    expect(resolve('/LICENSE.txt')).toBe('https://swift.org/LICENSE.txt')
  })

  test('swiftOrgPaths gates the swift.org generic catchall', () => {
    const swiftOrgPaths = new Set(['install', 'getting-started/cli-swiftpm'])
    const resolve = createLinkResolver({ swiftOrgPaths, sourceUrl: 'https://swift.org/about/' })
    expect(resolve('/install')).toBe('/docs/swift-org/install/')
    expect(resolve('/getting-started/cli-swiftpm')).toBe('/docs/swift-org/getting-started/cli-swiftpm/')
    // /blog isn't curated → external
    expect(resolve('/blog/something')).toBe('https://swift.org/blog/something')
  })

  test('swiftOrgPaths handles .html-suffixed curated entries', () => {
    const swiftOrgPaths = new Set(['documentation/server/guides/passkeys.html'])
    const resolve = createLinkResolver({ swiftOrgPaths, sourceUrl: 'https://swift.org/' })
    expect(resolve('/documentation/server/guides/passkeys'))
      .toBe('/docs/swift-org/documentation/server/guides/passkeys.html/')
  })

  test('leaves true external URLs untouched', () => {
    const knownKeys = new Set()
    const resolve = createLinkResolver({ knownKeys })
    expect(resolve('https://forums.swift.org/t/123')).toBe('https://forums.swift.org/t/123')
  })

  test('does not rewrite already-internal /docs/* URLs', () => {
    const knownKeys = new Set(['swiftui/view'])
    const resolve = createLinkResolver({ knownKeys })
    expect(resolve('/docs/swiftui/view/')).toBe('/docs/swiftui/view/')
  })

  test('passes through non-http schemes (mailto:, tel:, fragments)', () => {
    const resolve = createLinkResolver({ knownKeys: new Set() })
    expect(resolve('mailto:swift@apple.com')).toBe('mailto:swift@apple.com')
    expect(resolve('#section')).toBe('#section')
  })

  test('rewrites swift.org redirect paths to their archive', () => {
    const knownKeys = new Set([
      'swift-package-manager/documentation/packagemanagerdocs',
      'swift-migration-guide/documentation/migrationguide',
    ])
    const resolve = createLinkResolver({ knownKeys, sourceUrl: 'https://swift.org/' })
    expect(resolve('/documentation/package-manager/'))
      .toBe('/docs/swift-package-manager/documentation/packagemanagerdocs/')
    expect(resolve('/documentation/concurrency'))
      .toBe('/docs/swift-migration-guide/documentation/migrationguide/')
  })

  test('rewrites apple.com developer URLs when key is in corpus', () => {
    const knownKeys = new Set(['swiftui/view'])
    const resolve = createLinkResolver({ knownKeys })
    expect(resolve('https://developer.apple.com/documentation/swiftui/view'))
      .toBe('/docs/swiftui/view/')
  })

  test('leaves apple.com URL external when key is NOT in corpus', () => {
    const knownKeys = new Set()
    const resolve = createLinkResolver({ knownKeys })
    expect(resolve('https://developer.apple.com/documentation/missing/page'))
      .toBe('https://developer.apple.com/documentation/missing/page')
  })

  test('without knownKeys, every pattern match is internalized (trust mode)', () => {
    const resolve = createLinkResolver({}) // no knownKeys
    expect(resolve('https://developer.apple.com/documentation/swiftui/view'))
      .toBe('/docs/swiftui/view/')
    expect(resolve('https://docs.swift.org/compiler/documentation/diagnostics/'))
      .toBe('/docs/swift-compiler/documentation/diagnostics/')
  })
})

describe('classifyLink', () => {
  const knownKeys = new Set([
    'swiftui/view',
    'swift-org/about',
    'swift-compiler/documentation/diagnostics',
  ])

  test('fragment-only', () => {
    expect(classifyLink('#anchor', { knownKeys }).category).toBe('fragment')
  })

  test('internal_ok when key resolves', () => {
    expect(classifyLink('/docs/swiftui/view/', { knownKeys }).category).toBe('internal_ok')
  })

  test('internal_broken when key does not resolve', () => {
    const r = classifyLink('/docs/swift-book/LanguageGuide/', { knownKeys })
    expect(r.category).toBe('internal_broken')
    expect(r.internalKey).toBe('swift-book/LanguageGuide')
  })

  test('external_resolvable when external URL has corpus equivalent', () => {
    const r = classifyLink('https://developer.apple.com/documentation/swiftui/view', { knownKeys })
    expect(r.category).toBe('external_resolvable')
    expect(r.internalKey).toBe('swiftui/view')
  })

  test('external for true external URL', () => {
    const r = classifyLink('https://forums.swift.org/t/123', { knownKeys })
    expect(r.category).toBe('external')
  })

  test('relative_broken for non-/docs relative paths', () => {
    const r = classifyLink('/install', { knownKeys })
    expect(r.category).toBe('relative_broken')
  })

  test('strips fragment + querystring from internal key check', () => {
    const r = classifyLink('/docs/swiftui/view/?foo=1#section', { knownKeys })
    expect(r.category).toBe('internal_ok')
    expect(r.internalKey).toBe('swiftui/view')
  })
})
