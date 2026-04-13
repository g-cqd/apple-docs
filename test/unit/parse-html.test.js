import { describe, test, expect } from 'bun:test'
import {
  htmlToPlainText,
  extractMetaInfo,
  extractHtmlContent,
  parseHtmlToNormalized,
} from '../../src/content/parse-html.js'

// ---------------------------------------------------------------------------
// htmlToPlainText
// ---------------------------------------------------------------------------

describe('htmlToPlainText', () => {
  test('strips tags and decodes common named entities', () => {
    const html = '<p>Hello &amp; <em>world</em>! &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39;</p>'
    const result = htmlToPlainText(html)
    expect(result).toContain('Hello &')
    expect(result).toContain('world')
    expect(result).toContain('<tag>')
    expect(result).toContain('"quoted"')
    expect(result).toContain("'apos'")
  })

  test('decodes &nbsp; to space', () => {
    const result = htmlToPlainText('hello&nbsp;world')
    expect(result).toBe('hello world')
  })

  test('decodes &#x27; and &#x2F;', () => {
    const result = htmlToPlainText('it&#x27;s a path&#x2F;to&#x2F;something')
    expect(result).toBe("it's a path/to/something")
  })

  test('decodes decimal numeric entities', () => {
    // &#65; is 'A', &#66; is 'B'
    const result = htmlToPlainText('&#65;&#66;&#67;')
    expect(result).toBe('ABC')
  })

  test('decodes hex numeric entities', () => {
    // &#x41; is 'A', &#x42; is 'B'
    const result = htmlToPlainText('&#x41;&#x42;&#x43;')
    expect(result).toBe('ABC')
  })

  test('preserves paragraph breaks for block elements', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>'
    const result = htmlToPlainText(html)
    // Expect a blank line between paragraphs
    expect(result).toMatch(/First paragraph\.\n\nSecond paragraph\./)
  })

  test('preserves paragraph breaks for div elements', () => {
    const html = '<div>Section A</div><div>Section B</div>'
    const result = htmlToPlainText(html)
    expect(result).toMatch(/Section A\n\nSection B/)
  })

  test('preserves paragraph breaks for heading elements', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2><p>Body text.</p>'
    const result = htmlToPlainText(html)
    expect(result).toMatch(/Title/)
    expect(result).toMatch(/Subtitle/)
    expect(result).toMatch(/Body text\./)
    // Each should be on its own paragraph
    expect(result.split('\n\n').length).toBeGreaterThanOrEqual(3)
  })

  test('preserves paragraph breaks for br, li, tr', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>'
    const result = htmlToPlainText(html)
    expect(result).toContain('Item 1')
    expect(result).toContain('Item 2')
  })

  test('collapses multiple spaces within a line', () => {
    const result = htmlToPlainText('<span>hello     world</span>')
    expect(result).toBe('hello world')
  })

  test('trims the result', () => {
    const result = htmlToPlainText('   <p>  hello  </p>   ')
    expect(result).toBe('hello')
  })

  test('returns empty string for empty input', () => {
    expect(htmlToPlainText('')).toBe('')
    expect(htmlToPlainText(null)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// extractMetaInfo
// ---------------------------------------------------------------------------

describe('extractMetaInfo', () => {
  test('extracts title from <title> element', () => {
    const html = '<html><head><title>Swift Documentation</title></head><body></body></html>'
    const { title } = extractMetaInfo(html)
    expect(title).toBe('Swift Documentation')
  })

  test('strips tags from title', () => {
    const html = '<html><head><title><em>Swift</em> Docs</title></head></html>'
    const { title } = extractMetaInfo(html)
    expect(title).toBe('Swift Docs')
  })

  test('extracts meta description (content before name attribute)', () => {
    const html = `<html><head>
      <meta content="Learn Swift concurrency." name="description">
    </head></html>`
    const { description } = extractMetaInfo(html)
    expect(description).toBe('Learn Swift concurrency.')
  })

  test('extracts meta description (name before content attribute)', () => {
    const html = `<html><head>
      <meta name="description" content="Concurrency in Swift.">
    </head></html>`
    const { description } = extractMetaInfo(html)
    expect(description).toBe('Concurrency in Swift.')
  })

  test('extracts og:title', () => {
    const html = `<html><head>
      <meta property="og:title" content="Swift Generics Guide">
    </head></html>`
    const { ogTitle } = extractMetaInfo(html)
    expect(ogTitle).toBe('Swift Generics Guide')
  })

  test('extracts og:title with content first', () => {
    const html = `<html><head>
      <meta content="Swift Generics Guide" property="og:title">
    </head></html>`
    const { ogTitle } = extractMetaInfo(html)
    expect(ogTitle).toBe('Swift Generics Guide')
  })

  test('returns nulls when meta tags are absent', () => {
    const html = '<html><body>No meta here.</body></html>'
    const result = extractMetaInfo(html)
    expect(result.title).toBeNull()
    expect(result.description).toBeNull()
    expect(result.ogTitle).toBeNull()
  })

  test('returns nulls for empty input', () => {
    const result = extractMetaInfo('')
    expect(result.title).toBeNull()
    expect(result.description).toBeNull()
    expect(result.ogTitle).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// extractHtmlContent – container detection
// ---------------------------------------------------------------------------

describe('extractHtmlContent — container detection', () => {
  test('finds <main> as the default content container', () => {
    const html = `<html><body>
      <nav>Skip nav</nav>
      <main><h1>Main Title</h1><p>Main content.</p></main>
      <footer>Skip footer</footer>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Main content.')
    expect(allText).not.toContain('Skip nav')
    expect(allText).not.toContain('Skip footer')
  })

  test('falls back to <article> when no <main>', () => {
    const html = `<html><body>
      <article><p>Article content.</p></article>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Article content.')
  })

  test('falls back to .content class', () => {
    const html = `<html><body>
      <div class="content"><p>Content class text.</p></div>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Content class text.')
  })

  test('falls back to #content id', () => {
    const html = `<html><body>
      <div id="content"><p>Content id text.</p></div>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Content id text.')
  })

  test('falls back to <body> when no semantic container found', () => {
    const html = `<html><body><p>Body text only.</p></body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Body text only.')
  })

  test('respects containerSelector option', () => {
    const html = `<html><body>
      <main><p>Should be ignored.</p></main>
      <div id="custom-docs"><p>Custom container.</p></div>
    </body></html>`
    const { sections } = extractHtmlContent(html, { containerSelector: '#custom-docs' })
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).toContain('Custom container.')
    // main content should NOT be included since we targeted custom container
    expect(allText).not.toContain('Should be ignored.')
  })
})

// ---------------------------------------------------------------------------
// extractHtmlContent – strip nav/footer/script
// ---------------------------------------------------------------------------

describe('extractHtmlContent — strips navigation and chrome elements', () => {
  test('strips <nav> from container', () => {
    const html = `<html><body>
      <main>
        <nav><a href="/">Home</a></nav>
        <p>Real content here.</p>
      </main>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).not.toContain('Home')
    expect(allText).toContain('Real content here.')
  })

  test('strips <header> from container', () => {
    const html = `<html><body>
      <main>
        <header><h1>Site Header</h1></header>
        <p>Article body.</p>
      </main>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).not.toContain('Site Header')
    expect(allText).toContain('Article body.')
  })

  test('strips <footer> from container', () => {
    const html = `<html><body>
      <main>
        <p>Article text.</p>
        <footer>Copyright 2024</footer>
      </main>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).not.toContain('Copyright 2024')
    expect(allText).toContain('Article text.')
  })

  test('strips <script> content from container', () => {
    const html = `<html><body>
      <main>
        <script>var x = 'should not appear';</script>
        <p>Content after script.</p>
      </main>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).not.toContain('should not appear')
    expect(allText).toContain('Content after script.')
  })

  test('strips <style> and <noscript> content', () => {
    const html = `<html><body>
      <main>
        <style>.hidden { display: none; }</style>
        <noscript>Please enable JavaScript.</noscript>
        <p>Visible content.</p>
      </main>
    </body></html>`
    const { sections } = extractHtmlContent(html)
    const allText = sections.map(s => s.content).join(' ')
    expect(allText).not.toContain('display: none')
    expect(allText).not.toContain('Please enable JavaScript')
    expect(allText).toContain('Visible content.')
  })
})

// ---------------------------------------------------------------------------
// extractHtmlContent – section splitting by h2
// ---------------------------------------------------------------------------

describe('extractHtmlContent — splits by h2 headings', () => {
  test('splits content into sections at each h2', () => {
    const html = `<html><body><main>
      <p>Introduction paragraph.</p>
      <h2>First Section</h2>
      <p>First section content.</p>
      <h2>Second Section</h2>
      <p>Second section content.</p>
    </main></body></html>`
    const { sections } = extractHtmlContent(html)
    expect(sections.length).toBeGreaterThanOrEqual(3)

    const headings = sections.map(s => s.heading).filter(Boolean)
    expect(headings).toContain('First Section')
    expect(headings).toContain('Second Section')
  })

  test('includes heading text as section heading', () => {
    const html = `<html><body><main>
      <h2>Overview</h2>
      <p>Overview content.</p>
    </main></body></html>`
    const { sections } = extractHtmlContent(html)
    const overviewSection = sections.find(s => s.heading === 'Overview')
    expect(overviewSection).toBeDefined()
    expect(overviewSection.content).toContain('Overview content.')
  })

  test('lead content before first h2 has null heading', () => {
    const html = `<html><body><main>
      <p>Intro before any heading.</p>
      <h2>First Heading</h2>
      <p>After heading.</p>
    </main></body></html>`
    const { sections } = extractHtmlContent(html)
    const leadSection = sections.find(s => s.heading === null)
    expect(leadSection).toBeDefined()
    expect(leadSection.content).toContain('Intro before any heading.')
  })

  test('falls back to h3 splitting when no h2 present', () => {
    const html = `<html><body><main>
      <p>Intro.</p>
      <h3>Sub Section A</h3>
      <p>Sub content A.</p>
      <h3>Sub Section B</h3>
      <p>Sub content B.</p>
    </main></body></html>`
    const { sections } = extractHtmlContent(html)
    const headings = sections.map(s => s.heading).filter(Boolean)
    expect(headings).toContain('Sub Section A')
    expect(headings).toContain('Sub Section B')
  })

  test('returns title from meta or h1', () => {
    const html = `<html>
      <head><title>Page Title</title></head>
      <body><main>
        <h1>Article Title</h1>
        <p>Content.</p>
      </main></body>
    </html>`
    const { title } = extractHtmlContent(html)
    // meta title takes precedence
    expect(title).toBe('Page Title')
  })

  test('falls back to h1 for title when no meta title', () => {
    const html = `<html><body><main>
      <h1>Article Title</h1>
      <p>Content.</p>
    </main></body></html>`
    const { title } = extractHtmlContent(html)
    expect(title).toBe('Article Title')
  })

  test('description comes from meta description', () => {
    const html = `<html>
      <head><meta name="description" content="A great article."></head>
      <body><main><p>Content.</p></main></body>
    </html>`
    const { description } = extractHtmlContent(html)
    expect(description).toBe('A great article.')
  })
})

// ---------------------------------------------------------------------------
// parseHtmlToNormalized
// ---------------------------------------------------------------------------

describe('parseHtmlToNormalized', () => {
  const minimalHtml = `<html>
    <head>
      <title>Swift Generics</title>
      <meta name="description" content="An introduction to Swift generics.">
    </head>
    <body><main>
      <h1>Swift Generics</h1>
      <p>Generics let you write flexible, reusable functions and types.</p>
      <h2>Overview</h2>
      <p>Generics are one of the most powerful features of Swift.</p>
      <h2>Type Parameters</h2>
      <p>A generic function uses placeholder type names.</p>
    </main></body>
  </html>`

  test('produces a document object with required fields', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics', {
      sourceType: 'swift-org',
      framework: 'swift',
      url: 'https://swift.org/documentation/generics',
      language: 'swift',
    })

    expect(document.sourceType).toBe('swift-org')
    expect(document.key).toBe('swift/generics')
    expect(document.title).toBe('Swift Generics')
    expect(document.kind).toBe('article')
    expect(document.role).toBe('article')
    expect(document.roleHeading).toBeNull()
    expect(document.framework).toBe('swift')
    expect(document.url).toBe('https://swift.org/documentation/generics')
    expect(document.language).toBe('swift')
    expect(document.declarationText).toBeNull()
    expect(document.platformsJson).toBeNull()
    expect(document.minIos).toBeNull()
    expect(document.minMacos).toBeNull()
    expect(document.minWatchos).toBeNull()
    expect(document.minTvos).toBeNull()
    expect(document.minVisionos).toBeNull()
    expect(document.isDeprecated).toBe(false)
    expect(document.isBeta).toBe(false)
    expect(document.isReleaseNotes).toBe(false)
  })

  test('sets abstractText from meta description', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(document.abstractText).toBe('An introduction to Swift generics.')
  })

  test('sets urlDepth from key segments', () => {
    const { document: d1 } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(d1.urlDepth).toBe(1)

    const { document: d2 } = parseHtmlToNormalized(minimalHtml, 'swift/generics/type-parameters')
    expect(d2.urlDepth).toBe(2)

    const { document: d0 } = parseHtmlToNormalized(minimalHtml, 'swift')
    expect(d0.urlDepth).toBe(0)
  })

  test('collects section headings into document.headings for FTS', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(document.headings).toContain('Overview')
    expect(document.headings).toContain('Type Parameters')
  })

  test('produces sections with abstract and discussion sectionKinds', () => {
    const { sections } = parseHtmlToNormalized(minimalHtml, 'swift/generics')

    const abstractSection = sections.find(s => s.sectionKind === 'abstract')
    expect(abstractSection).toBeDefined()
    expect(abstractSection.contentText).toBe('An introduction to Swift generics.')

    const discussionSections = sections.filter(s => s.sectionKind === 'discussion')
    expect(discussionSections.length).toBeGreaterThanOrEqual(2)
    const headingTexts = discussionSections.map(s => s.heading)
    expect(headingTexts).toContain('Overview')
    expect(headingTexts).toContain('Type Parameters')
  })

  test('sections have monotonically increasing sortOrder', () => {
    const { sections } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    const orders = sections.map(s => s.sortOrder)
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1])
    }
  })

  test('relationships is always an empty array', () => {
    const { relationships } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(Array.isArray(relationships)).toBe(true)
    expect(relationships.length).toBe(0)
  })

  test('uses article as default kind', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(document.kind).toBe('article')
  })

  test('respects opts.kind override', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics', { kind: 'tutorial' })
    expect(document.kind).toBe('tutorial')
  })

  test('sourceMetadata defaults to null', () => {
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics')
    expect(document.sourceMetadata).toBeNull()
  })

  test('passes through sourceMetadata option', () => {
    const meta = { crawledAt: '2024-01-01', version: '5.9' }
    const { document } = parseHtmlToNormalized(minimalHtml, 'swift/generics', {
      sourceMetadata: meta,
    })
    expect(document.sourceMetadata).toEqual(meta)
  })

  test('handles page with no meta description (uses first paragraph as abstract)', () => {
    const html = `<html><body><main>
      <p>The first paragraph becomes the abstract.</p>
      <h2>Details</h2>
      <p>More content here.</p>
    </main></body></html>`
    const { document } = parseHtmlToNormalized(html, 'test/key')
    expect(document.abstractText).toBe('The first paragraph becomes the abstract.')
  })

  test('handles empty html gracefully', () => {
    const { document, sections, relationships } = parseHtmlToNormalized('', 'test/empty')
    expect(document.title).toBeNull()
    expect(document.abstractText).toBeNull()
    expect(Array.isArray(sections)).toBe(true)
    expect(Array.isArray(relationships)).toBe(true)
    expect(relationships.length).toBe(0)
  })
})
