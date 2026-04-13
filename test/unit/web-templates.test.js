import { describe, test, expect } from 'bun:test'
import {
  renderDocumentPage,
  renderIndexPage,
  renderFrameworkPage,
  renderSearchPage,
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
  key: 'documentation/swiftui/view',
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
    const html = buildBreadcrumbs('documentation/swiftui/view')
    expect(html).toContain('<a href="/docs/documentation/">documentation</a>')
    expect(html).toContain('<a href="/docs/documentation/swiftui/">swiftui</a>')
    // Last segment is not a link
    expect(html).toContain('<span aria-current="page">view</span>')
    expect(html).not.toMatch(/<a [^>]*>view<\/a>/)
  })

  test('single-segment key returns plain text with no link', () => {
    const html = buildBreadcrumbs('swiftui')
    expect(html).toContain('swiftui')
    expect(html).not.toContain('<a ')
  })

  test('two-segment key links the first and makes the second plain', () => {
    const html = buildBreadcrumbs('documentation/swiftui')
    expect(html).toContain('<a href="/docs/documentation/">documentation</a>')
    expect(html).toContain('<span aria-current="page">swiftui</span>')
  })

  test('empty string returns empty string', () => {
    expect(buildBreadcrumbs('')).toBe('')
  })

  test('null returns empty string', () => {
    expect(buildBreadcrumbs(null)).toBe('')
  })

  test('contains breadcrumbs nav element', () => {
    const html = buildBreadcrumbs('documentation/swiftui/view')
    expect(html).toContain('<nav class="breadcrumbs"')
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

  test('contains source_type badge when doc has source_type', () => {
    const page = renderDocumentPage(mockDoc, mockSections, siteConfig)
    expect(page).toContain('badge-source')
    expect(page).toContain('apple-docc')
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

  test('baseUrl prefix is applied to asset links', () => {
    const config = { ...siteConfig, baseUrl: '/apple-docs' }
    const page = renderDocumentPage(mockDoc, mockSections, config)
    expect(page).toContain('/apple-docs/assets/style.css')
    expect(page).toContain('/apple-docs/assets/theme.js')
    expect(page).toContain('/apple-docs/assets/search.js')
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
    expect(page).toContain('filter-source')
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
})
