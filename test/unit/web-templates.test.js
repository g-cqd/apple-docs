import { describe, test, expect } from 'bun:test'
import {
  renderDocumentPage,
  renderIndexPage,
  renderFrameworkPage,
  renderSearchPage,
  renderNotFoundPage,
  buildBreadcrumbs,
} from '../../src/web/templates.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const siteConfig = {
  baseUrl: '',
  siteName: 'Apple Docs',
  buildDate: '2026-04-13',
}

const mockDoc = {
  title: 'View',
  key: 'swiftui/view',
  framework: 'swiftui',
  role_heading: 'Protocol',
  source_type: 'apple-docc',
  abstract_text: 'A type that represents part of your app UI',
}

const mockSections = [
  {
    sectionKind: 'abstract',
    contentText: 'A type that represents part of your app UI',
    sortOrder: 0,
  },
]

// ---------------------------------------------------------------------------
// buildBreadcrumbs
// ---------------------------------------------------------------------------

describe('buildBreadcrumbs', () => {
  test('multi-segment key produces linked ancestors and plain last segment', () => {
    const html = buildBreadcrumbs('swiftui/view/body')
    expect(html).toContain('<a href="/docs/swiftui/">swiftui</a>')
    expect(html).toContain('<a href="/docs/swiftui/view/">view</a>')
    // Last segment is not a link
    expect(html).toContain('<span aria-current="page">body</span>')
    expect(html).not.toMatch(/<a [^>]*>body<\/a>/)
  })

  test('single-segment key returns plain text with no link', () => {
    const html = buildBreadcrumbs('swiftui')
    expect(html).toContain('swiftui')
    expect(html).not.toContain('<a ')
  })

  test('two-segment key links the first and makes the second plain', () => {
    const html = buildBreadcrumbs('swiftui/view')
    expect(html).toContain('<a href="/docs/swiftui/">swiftui</a>')
    expect(html).toContain('<span aria-current="page">view</span>')
  })

  test('uses the framework display name for the first segment', () => {
    const html = buildBreadcrumbs('swiftui/view', { title: 'View', framework: 'SwiftUI' })
    expect(html).toContain('<a href="/docs/swiftui/">SwiftUI</a>')
    expect(html).not.toContain('>swiftui</a>')
  })

  test('uses ancestor titles for intermediate segments', () => {
    const ancestors = new Map([['cryptokit/kemprivatekey', 'KEMPrivateKey']])
    const html = buildBreadcrumbs('cryptokit/kemprivatekey/publickey', {
      title: 'PublicKey',
      framework: 'Apple CryptoKit',
      ancestorTitles: ancestors,
    })
    expect(html).toContain('<a href="/docs/cryptokit/">Apple CryptoKit</a>')
    expect(html).toContain('<a href="/docs/cryptokit/kemprivatekey/">KEMPrivateKey</a>')
    expect(html).toContain('<span aria-current="page">PublicKey</span>')
  })

  test('empty string returns empty string', () => {
    expect(buildBreadcrumbs('')).toBe('')
  })

  test('null returns empty string', () => {
    expect(buildBreadcrumbs(null)).toBe('')
  })

  test('contains breadcrumbs nav element', () => {
    const html = buildBreadcrumbs('swiftui/view')
    expect(html).toContain('<nav class="breadcrumbs"')
  })

  test('renders unknown intermediate segments as plain text instead of dangling links', () => {
    // swift-book chapter keys nest under a directory (LanguageGuide) that is
    // not itself a page — its breadcrumb should be plain text, not a link.
    // The framework root (swift-book) always resolves via the framework
    // landing page so it stays a link even if not in knownKeys.
    const knownKeys = new Set([
      'swift-book/LanguageGuide/TheBasics',
    ])
    const html = buildBreadcrumbs('swift-book/LanguageGuide/TheBasics', {
      title: 'The Basics',
      framework: 'The Swift Programming Language',
      knownKeys,
    })
    expect(html).toContain('<a href="/docs/swift-book/">The Swift Programming Language</a>')
    expect(html).toContain('<span>LanguageGuide</span>')
    expect(html).not.toContain('href="/docs/swift-book/LanguageGuide/"')
    expect(html).toContain('<span aria-current="page">The Basics</span>')
  })

  test('treats every intermediate as a link when knownKeys is not provided (backward compat)', () => {
    const html = buildBreadcrumbs('swift-book/LanguageGuide/TheBasics', {
      title: 'The Basics',
      framework: 'TSPL',
    })
    expect(html).toContain('href="/docs/swift-book/LanguageGuide/"')
  })
})

describe('renderNotFoundPage', () => {
  test('contains a search form pointing to /search', () => {
    const html = renderNotFoundPage(siteConfig)
    expect(html).toContain('<form')
    expect(html).toContain('action="/search"')
    expect(html).toContain('id="not-found-q"')
    expect(html).toContain('name="q"')
  })

  test('marks the page as noindex so 404s don\'t show in sitemaps', () => {
    const html = renderNotFoundPage(siteConfig)
    expect(html).toMatch(/<meta\s+name=["']robots["'][^>]*noindex/i)
  })

  test('inlines the title-derivation script', () => {
    const html = renderNotFoundPage(siteConfig)
    expect(html).toContain('window.location')
    expect(html).toContain('not-found-q')
    // The CamelCase / kebab / .html cleanup logic must be there.
    expect(html).toContain("[a-z0-9])([A-Z]")
  })

  test('includes navigation links to the main hubs', () => {
    const html = renderNotFoundPage(siteConfig)
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/search/"')
    expect(html).toContain('href="/fonts/"')
    expect(html).toContain('href="/symbols/"')
  })
})

// ---------------------------------------------------------------------------
// renderDocumentPage
// ---------------------------------------------------------------------------

describe('renderDocumentPage', () => {
  test('returns a string starting with <!DOCTYPE html>', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toBeTypeOf('string')
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains html element with lang and data-theme', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('<html lang="en" data-theme="auto">')
  })

  test('contains <title> with doc title and site name', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('<title>View — Apple Docs</title>')
  })

  test('contains <link rel="stylesheet"> with CSS path', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('<link rel="stylesheet" href="/assets/style.css">')
  })

  test('contains theme.js deferred script in head', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('/assets/theme.js')
    expect(page).toContain('defer')
  })

  test('contains search.js deferred script at end of body', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('/assets/search.js')
  })

  test('contains meta description from doc.abstract_text', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('A type that represents part of your app UI')
    expect(page).toContain('<meta name="description"')
  })

  test('contains rendered HTML content with h1 title', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('<h1>View</h1>')
  })

  test('contains breadcrumbs', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('class="breadcrumbs"')
    expect(page).toContain('documentation')
    expect(page).toContain('swiftui')
  })

  test('contains framework badge when doc has framework', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('badge-framework')
    expect(page).toContain('swiftui')
  })

  test('contains role_heading badge when doc has role_heading', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('badge-role')
    expect(page).toContain('Protocol')
  })

  test('does not expose source_type as a visible badge', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).not.toContain('badge-source')
    expect(page).not.toContain('apple-docc')
  })

  test('contains search input', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('<input class="search-input"')
    expect(page).toContain('type="search"')
  })

  test('contains header with site name link', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('class="site-name"')
    expect(page).toContain('Apple Docs')
  })

  test('contains footer with build date', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('2026-04-13')
    expect(page).toContain('site-footer')
  })

  test('empty sections produce valid page without crash', () => {
    const page = renderDocumentPage(mockDoc, [], siteConfig)
    expect(page).toBeTypeOf('string')
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
    // Title heading still rendered (renderHtml renders h1 from doc.title)
    expect(page).toContain('<h1>View</h1>')
  })

  test('doc with no framework omits framework badge', () => {
    const docWithoutFramework = { ...mockDoc, framework: undefined }
    const page = renderDocumentPage(docWithoutFramework, mockSections, siteConfig)
    expect(page).not.toContain('badge-framework')
  })

  test('framework badge uses framework_display when available', () => {
    const docWithDisplay = { ...mockDoc, framework_display: 'SwiftUI' }
    const page = renderDocumentPage(docWithDisplay, mockSections, siteConfig)
    expect(page).toContain('badge-framework')
    expect(page).toContain('SwiftUI')
  })

  test('renders deprecated badge when is_deprecated is set', () => {
    const doc = { ...mockDoc, is_deprecated: 1 }
    const page = renderDocumentPage(doc, mockSections, siteConfig)
    expect(page).toContain('badge-deprecated')
    expect(page).toContain('Deprecated')
  })

  test('renders beta badge when is_beta is set', () => {
    const doc = { ...mockDoc, is_beta: 1 }
    const page = renderDocumentPage(doc, mockSections, siteConfig)
    expect(page).toContain('badge-beta')
    expect(page).toContain('Beta')
  })

  test('renders platform availability badges from platforms_json', () => {
    const doc = { ...mockDoc, platforms_json: '{"ios":"15.0","macos":"12.0","visionos":"1.0"}' }
    const page = renderDocumentPage(doc, mockSections, siteConfig)
    expect(page).toContain('badge-platform')
    expect(page).toContain('iOS 15.0+')
    expect(page).toContain('macOS 12.0+')
    expect(page).toContain('visionOS 1.0+')
    expect(page).toContain('doc-availability')
  })

  test('omits platform badges when platforms_json is null', () => {
    const doc = { ...mockDoc, platforms_json: null }
    const page = renderDocumentPage(doc, mockSections, siteConfig)
    expect(page).not.toContain('doc-availability')
  })

  test('baseUrl prefix is applied to asset links', () => {
    const config = { ...siteConfig, baseUrl: '/apple-docs' }
    const page = renderDocumentPage(mockDoc, mockSections, config)
    expect(page).toContain('/apple-docs/assets/style.css')
    expect(page).toContain('/apple-docs/assets/theme.js')
    expect(page).toContain('/apple-docs/assets/search.js')
  })

  test('assetVersion adds cache-busting query params to document assets', () => {
    const config = { ...siteConfig, assetVersion: 'deploy-123' }
    const page = renderDocumentPage(mockDoc, mockSections, config)
    expect(page).toContain('/assets/style.css?v=deploy-123')
    expect(page).toContain('/assets/theme.js?v=deploy-123')
    expect(page).toContain('/assets/search.js?v=deploy-123')
  })

  test('bundled mode emits core.js instead of individual scripts', () => {
    const config = { ...siteConfig, bundled: true }
    const page = renderDocumentPage(mockDoc, mockSections, config)
    expect(page).toContain('/assets/core.js')
    expect(page).not.toContain('/assets/theme.js')
    expect(page).not.toContain('/assets/search.js')
    expect(page).not.toContain('/assets/page-toc.js')
  })

  test('page with 2+ sections has TOC sidebar and section IDs', () => {
    const sections = [
      { sectionKind: 'abstract', contentText: 'Abstract text', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'func foo()', contentJson: JSON.stringify([{ tokens: [{ text: 'func foo()' }], languages: ['swift'] }]), sortOrder: 1 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'Discussion here', contentJson: JSON.stringify([{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Discussion here' }] }]), sortOrder: 3 },
    ]
    const page = renderDocumentPage(mockDoc, sections, siteConfig)
    expect(page).toContain('class="page-toc"')
    expect(page).toContain('href="#declaration"')
    expect(page).toContain('href="#overview"')
    expect(page).toContain('has-sidebar')
    expect(page).toContain('id="declaration"')
    expect(page).toContain('id="overview"')
  })

  test('page with only abstract has no TOC but has sidebar for meta', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).not.toContain('class="page-toc"')
    // Sidebar still present for doc meta badges
    expect(page).toContain('sidebar-meta')
  })

  test('mobile TOC rendered as details element', () => {
    const sections = [
      { sectionKind: 'abstract', contentText: 'text', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'code', contentJson: '[]', sortOrder: 1 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'text', contentJson: JSON.stringify([{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'x' }] }]), sortOrder: 3 },
    ]
    const page = renderDocumentPage(mockDoc, sections, siteConfig)
    expect(page).toContain('class="page-toc-mobile"')
    expect(page).toContain('<summary>Contents</summary>')
  })

  test('page includes page-toc.js but not collection-filters.js script', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('page-toc.js')
    expect(page).not.toContain('collection-filters.js')
  })

  test('relationships sidebar content appears in sidebar without TOC entry', () => {
    const sections = [
      { sectionKind: 'abstract', contentText: 'text', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'code', contentJson: JSON.stringify([{ tokens: [{ text: 'var x' }], languages: ['swift'] }]), sortOrder: 1 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'discussion text', contentJson: JSON.stringify([{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'text' }] }]), sortOrder: 5 },
      { sectionKind: 'relationships', contentText: '', contentJson: JSON.stringify([{ title: 'Conforms To', items: [{ key: 'swiftui/view', title: 'View' }] }]), sortOrder: 10 },
    ]
    const page = renderDocumentPage(mockDoc, sections, siteConfig)
    expect(page).toContain('<h2>Relationships</h2>')
    expect(page).toContain('Conforms To')
    expect(page).toContain('class="doc-sidebar"')
    // Relationships should not appear in the TOC since it's sidebar-only
    expect(page).not.toContain('href="#relationships"')
  })

  test('see also content remains rendered in the article when a sidebar exists', () => {
    const sections = [
      { sectionKind: 'abstract', contentText: 'text', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'code', contentJson: JSON.stringify([{ tokens: [{ text: 'var x' }], languages: ['swift'] }]), sortOrder: 1 },
      { sectionKind: 'see_also', contentText: '', contentJson: JSON.stringify([{ title: 'Related', items: [{ key: 'swiftui/text', title: 'Text' }] }]), sortOrder: 10 },
    ]
    const page = renderDocumentPage(mockDoc, sections, siteConfig)
    expect(page).toContain('id="see-also"')
    expect(page).toContain('<h2>See Also</h2>')
    expect(page).toContain('href="/docs/swiftui/text/"')
  })

  test('header search status uses a unique id separate from the search page status region', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('id="header-search-status"')
    expect(page).not.toContain('id="search-status" aria-live="assertive"')
  })

  test('HTML-encodes doc title in <title> to prevent injection', () => {
    const xssDoc = { ...mockDoc, title: '<script>alert(1)</script>' }
    const page = renderDocumentPage(xssDoc, mockSections, siteConfig)
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;')
  })

  test('produces well-formed closing tags', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('</html>')
    expect(page).toContain('</body>')
    expect(page).toContain('</head>')
  })

  test('sidebar splits its content into sidebar-block cards', () => {
    const sections = [
      { sectionKind: 'abstract', contentText: 'text', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'code', contentJson: JSON.stringify([{ tokens: [{ text: 'x' }], languages: ['swift'] }]), sortOrder: 1 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'x', contentJson: JSON.stringify([{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'x' }] }]), sortOrder: 2 },
    ]
    const page = renderDocumentPage(mockDoc, sections, siteConfig)
    // At least two blocks: meta + TOC
    const blockCount = (page.match(/class="sidebar-block[^"]*"/g) ?? []).length
    expect(blockCount).toBeGreaterThanOrEqual(2)
  })

  test('adds a single-line Original resource link to the upstream Apple URL', () => {
    const docWithUrl = { ...mockDoc, url: 'https://developer.apple.com/documentation/swiftui/view' }
    const page = renderDocumentPage(docWithUrl, mockSections, siteConfig)
    expect(page).toContain('class="sidebar-block sidebar-source"')
    expect(page).toContain('href="https://developer.apple.com/documentation/swiftui/view"')
    expect(page).toContain('target="_blank"')
    expect(page).toContain('rel="noopener noreferrer"')
    expect(page).toContain('Open on developer.apple.com')
    // No secondary heading or host label — the link is the only content
    expect(page).not.toContain('<h2>Original resource</h2>')
    expect(page).not.toContain('sidebar-source-host')
    expect(page).not.toContain('sidebar-source-label')
  })

  test('omits the Original resource block when the document has no url', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).not.toContain('sidebar-source')
  })
})

// ---------------------------------------------------------------------------
// renderIndexPage
// ---------------------------------------------------------------------------

describe('renderIndexPage', () => {
  const mockFrameworks = [
    { slug: 'swiftui', name: 'SwiftUI', kind: 'framework', doc_count: 842 },
    { slug: 'foundation', name: 'Foundation', kind: 'framework', doc_count: 1200 },
    { slug: 'hig', name: 'Human Interface Guidelines', kind: 'guidelines', doc_count: 94 },
  ]

  test('returns a string starting with <!DOCTYPE html>', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains the site name as page title', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('<title>Apple Docs</title>')
  })

  test('lists frameworks grouped by kind', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('framework')
    expect(page).toContain('guidelines')
    expect(page).toContain('SwiftUI')
    expect(page).toContain('Foundation')
    expect(page).toContain('Human Interface Guidelines')
  })

  test('each framework links to /docs/<slug>/', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('href="/docs/swiftui/"')
    expect(page).toContain('href="/docs/foundation/"')
    expect(page).toContain('href="/docs/hig/"')
  })

  test('shows document count per framework', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('842')
    expect(page).toContain('1200')
    expect(page).toContain('94')
  })

  test('groups framework and guidelines separately', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    // Both kind labels must appear in the page
    const frameworkIdx = page.indexOf('framework-kind')
    expect(frameworkIdx).toBeGreaterThan(-1)
    expect(page).toContain('guidelines')
  })

  test('handles empty frameworks array without crash', () => {
    const page = renderIndexPage([], siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
    expect(page).toContain('No frameworks indexed yet.')
  })

  test('handles null frameworks without crash', () => {
    const page = renderIndexPage(null, siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains search input', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('<input class="search-input"')
  })

  test('contains footer with build date', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('2026-04-13')
  })

  test('framework items have data-filter-kind attributes', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('data-filter-kind="framework"')
    expect(page).toContain('data-filter-kind="guidelines"')
  })

  test('framework groups have data-filter-kind attributes', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    // Section elements also have the attribute (may include id attribute)
    expect(page).toMatch(/section[^>]*class="framework-group" data-filter-kind="framework"/)
    expect(page).toMatch(/section[^>]*class="framework-group" data-filter-kind="guidelines"/)
  })

  test('includes collection-filters.js script', () => {
    const page = renderIndexPage(mockFrameworks, siteConfig)
    expect(page).toContain('collection-filters.js')
  })
})

// ---------------------------------------------------------------------------
// renderFrameworkPage
// ---------------------------------------------------------------------------

describe('renderFrameworkPage', () => {
  const mockFramework = { slug: 'swiftui', name: 'SwiftUI', kind: 'framework' }

  const mockDocuments = [
    { title: 'View', key: 'documentation/swiftui/view', role: 'symbol', role_heading: 'Protocol' },
    { title: 'Text', key: 'documentation/swiftui/text', role: 'symbol', role_heading: 'Structure' },
    { title: 'Getting Started', key: 'documentation/swiftui/getting-started', role: 'article' },
  ]

  test('returns a string starting with <!DOCTYPE html>', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains framework name in title', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('<title>SwiftUI — Apple Docs</title>')
  })

  test('lists documents with links to /docs/<key>/', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('href="/docs/documentation/swiftui/view/"')
    expect(page).toContain('href="/docs/documentation/swiftui/text/"')
    expect(page).toContain('href="/docs/documentation/swiftui/getting-started/"')
  })

  test('lists document titles', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('View')
    expect(page).toContain('Text')
    expect(page).toContain('Getting Started')
  })

  test('groups documents by role', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('symbol')
    expect(page).toContain('article')
  })

  test('contains breadcrumbs', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('class="breadcrumbs"')
  })

  test('handles empty documents array without crash', () => {
    const page = renderFrameworkPage(mockFramework, [], siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
    expect(page).toContain('No documents found for this framework.')
  })

  test('handles null documents without crash', () => {
    const page = renderFrameworkPage(mockFramework, null, siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains search input', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('<input class="search-input"')
  })

  test('contains footer with build date', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('2026-04-13')
  })

  test('falls back to slug when name is absent', () => {
    const fw = { slug: 'foundation' }
    const page = renderFrameworkPage(fw, mockDocuments, siteConfig)
    expect(page).toContain('foundation')
  })

  test('document items have data-filter-kind attributes', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('data-filter-kind="Protocol"')
    expect(page).toContain('data-filter-kind="Structure"')
  })

  test('role groups have data-filter-kind attributes', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toMatch(/section[^>]*class="role-group" data-filter-kind="Symbols"/)
  })

  test('includes collection-filters.js script', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    expect(page).toContain('collection-filters.js')
  })

  test('renders a tree toggle and serialized tree data when tree edges are provided', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig, {
      treeEdges: [
        { from_key: 'documentation/swiftui/view', to_key: 'documentation/swiftui/text' },
      ],
    })
    expect(page).toContain('class="view-toggle"')
    expect(page).toContain('id="tree-data"')
    expect(page).toContain('tree-view.js')
  })

  test('tree data JSON is valid and parseable (not HTML-escaped)', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig, {
      treeEdges: [
        { from_key: 'documentation/swiftui/view', to_key: 'documentation/swiftui/text' },
      ],
    })
    const match = page.match(/<script type="application\/json" id="tree-data">([\s\S]*?)<\/script>/)
    expect(match).toBeTruthy()
    const json = JSON.parse(match[1])
    expect(json.edges).toBeArray()
    expect(json.edges).toHaveLength(1)
    expect(json.docs).toBeObject()
  })

  test('defers list rendering when tree edges are provided', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig, {
      treeEdges: [
        { from_key: 'documentation/swiftui/view', to_key: 'documentation/swiftui/text' },
      ],
    })
    // List container should be empty with data-deferred attribute
    expect(page).toContain('data-deferred')
    expect(page).not.toMatch(/<div id="list-container"[^>]*>[\s]*<section/)
    // Tree data should include roleGroups for client-side list building
    const match = page.match(/<script type="application\/json" id="tree-data">([\s\S]*?)<\/script>/)
    const json = JSON.parse(match[1])
    expect(json.roleGroups).toBeArray()
    expect(json.roleGroups.length).toBeGreaterThan(0)
    expect(json.roleGroups[0].docs).toBeArray()
  })

  test('renders list HTML server-side when no tree edges are provided', () => {
    const page = renderFrameworkPage(mockFramework, mockDocuments, siteConfig)
    // No deferral — list container should have content
    expect(page).not.toContain('data-deferred')
    expect(page).toContain('class="role-group"')
    expect(page).toContain('class="doc-list"')
  })

  test('adds Original resource block for apple-docc framework', () => {
    const fw = { slug: 'swiftui', name: 'SwiftUI', kind: 'framework', source_type: 'apple-docc' }
    const page = renderFrameworkPage(fw, mockDocuments, siteConfig)
    expect(page).toContain('class="sidebar-block sidebar-source"')
    expect(page).toContain('href="https://developer.apple.com/documentation/swiftui"')
  })

  test('derives upstream URL per source type for framework listings', () => {
    const cases = [
      { fw: { slug: 'design', source_type: 'hig' }, expected: 'https://developer.apple.com/design/human-interface-guidelines' },
      { fw: { slug: 'app-store-review', source_type: 'guidelines' }, expected: 'https://developer.apple.com/app-store/review/guidelines/' },
      { fw: { slug: 'wwdc', source_type: 'wwdc' }, expected: 'https://developer.apple.com/videos/' },
      { fw: { slug: 'swift-book', source_type: 'swift-book' }, expected: 'https://docs.swift.org/swift-book/' },
      { fw: { slug: 'packages', source_type: 'packages' }, expected: 'https://swiftpackageindex.com/' },
    ]
    for (const { fw, expected } of cases) {
      const page = renderFrameworkPage(fw, mockDocuments, siteConfig)
      expect(page).toContain(`href="${expected}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// renderSearchPage
// ---------------------------------------------------------------------------

describe('renderSearchPage', () => {
  test('returns a string starting with <!DOCTYPE html>', () => {
    const page = renderSearchPage(siteConfig)
    expect(page.trimStart()).toMatch(/^<!DOCTYPE html>/)
  })

  test('contains search form with id', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('id="search-form"')
    expect(page).toContain('id="search-q"')
  })

  test('contains filter dropdowns', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('filter-framework')
    expect(page).toContain('filter-kind')
  })

  test('contains language radio buttons', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('name="language"')
    expect(page).toContain('value="swift"')
    expect(page).toContain('value="objc"')
  })

  test('contains platform checkboxes', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('value="ios"')
    expect(page).toContain('value="macos"')
    expect(page).toContain('value="visionos"')
  })

  test('contains advanced filter section', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('filter-advanced')
    expect(page).toContain('min_ios')
    expect(page).toContain('min_macos')
  })

  test('contains WWDC year and track filters', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('name="year"')
    expect(page).toContain('name="track"')
  })

  test('contains results container and load-more button', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('id="search-results"')
    expect(page).toContain('id="search-load-more"')
  })

  test('search page exposes a visible search status region and does not duplicate the header id', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('id="search-status"')
    expect(page).toContain('id="header-search-status"')
  })

  test('includes search-page.js script', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('search-page.js')
  })

  test('contains header and footer', () => {
    const page = renderSearchPage(siteConfig)
    expect(page).toContain('site-header')
    expect(page).toContain('site-footer')
    expect(page).toContain('2026-04-13')
  })

  test('applies baseUrl prefix to assets', () => {
    const config = { ...siteConfig, baseUrl: '/apple-docs' }
    const page = renderSearchPage(config)
    expect(page).toContain('/apple-docs/assets/search-page.js')
    expect(page).toContain('/apple-docs/assets/style.css')
  })

  test('applies assetVersion to search page assets', () => {
    const page = renderSearchPage({ ...siteConfig, assetVersion: 'deploy-123' })
    expect(page).toContain('/assets/search-page.js?v=deploy-123')
    expect(page).toContain('/assets/style.css?v=deploy-123')
    expect(page).toContain('/assets/theme.js?v=deploy-123')
  })
})
