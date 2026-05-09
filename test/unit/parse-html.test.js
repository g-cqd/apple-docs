import { describe, test, expect } from 'bun:test'
import {
  htmlToPlainText,
  htmlToMarkdown,
  extractMetaInfo,
  extractHtmlContent,
  parseHtmlToNormalized,
  detectRedirectStub,
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
    const html = "<html><body><p>Body text only.</p></body></html>"
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

// ---------------------------------------------------------------------------
// detectRedirectStub
// ---------------------------------------------------------------------------

describe('detectRedirectStub', () => {
  test('returns canonical URL from a Hugo-style redirect stub', () => {
    const html = `<!DOCTYPE html>
<html lang="en-US">
  <meta charset="utf-8">
  <title>Redirecting&hellip;</title>
  <link rel="canonical" href="https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/">
  <meta http-equiv="refresh" content="0; url=https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/">
  <h1>Redirecting&hellip;</h1>
</html>`
    expect(detectRedirectStub(html)).toBe('https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/')
  })

  test('falls back to meta-refresh URL when canonical is missing', () => {
    const html = '<title>Redirecting…</title><meta http-equiv="refresh" content="0; url=https://example.com/new">'
    expect(detectRedirectStub(html)).toBe('https://example.com/new')
  })

  test('returns null for normal content pages', () => {
    const html = '<title>About Swift</title><body><p>Real content here.</p></body>'
    expect(detectRedirectStub(html)).toBeNull()
  })

  test('returns null for large pages even if title contains "redirect"', () => {
    const big = 'x'.repeat(5000)
    expect(detectRedirectStub(`<title>Redirecting</title>${big}`)).toBeNull()
  })

  test('recognizes the bare "Document Has Moved" HTTP-server stub', () => {
    const html = '<HTML><HEAD><TITLE>Document Has Moved</TITLE></HEAD><BODY><A HREF="https://example.com/new">here</A></BODY></HTML>'
    expect(detectRedirectStub(html)).toBe('https://example.com/new')
  })

  test('returns null for non-string input', () => {
    expect(detectRedirectStub(null)).toBeNull()
    expect(detectRedirectStub(undefined)).toBeNull()
  })
})

describe('parseHtmlToNormalized — redirect stub handling', () => {
  test('emits a "Page Moved" notice section when fed a redirect stub', () => {
    const html = '<title>Redirecting…</title><link rel="canonical" href="https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/">'
    const { document, sections } = parseHtmlToNormalized(html, 'swift-org/documentation/package-manager', {
      sourceType: 'swift-org',
      framework: 'swift-org',
    })
    expect(document.url).toBe('https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/')
    expect(document.kind).toBe('redirect')
    expect(sections.length).toBe(1)
    expect(sections[0].heading).toBe('Page Moved')
    expect(sections[0].contentText).toContain('https://docs.swift.org/swiftpm/documentation/packagemanagerdocs/')
  })
})

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

describe('htmlToMarkdown', () => {
  test('renders inline <code> with backticks', () => {
    const md = htmlToMarkdown('<p>Use <code>foo()</code> here.</p>')
    expect(md).toContain('`foo()`')
  })

  test('renders <a href> as markdown link', () => {
    const md = htmlToMarkdown('<p>See <a href="https://example.com">site</a>.</p>')
    expect(md).toContain('[site](https://example.com)')
  })

  test('renders <strong>/<b> as bold and <em>/<i> as italic', () => {
    expect(htmlToMarkdown('<p><strong>bold</strong></p>')).toContain('**bold**')
    expect(htmlToMarkdown('<p><b>bold</b></p>')).toContain('**bold**')
    expect(htmlToMarkdown('<p><em>italic</em></p>')).toContain('*italic*')
    expect(htmlToMarkdown('<p><i>italic</i></p>')).toContain('*italic*')
  })

  test('renders <ul><li> as unordered list', () => {
    const md = htmlToMarkdown('<ul><li>one</li><li>two</li><li>three</li></ul>')
    expect(md).toContain('- one')
    expect(md).toContain('- two')
    expect(md).toContain('- three')
  })

  test('renders <ol><li> as ordered list with sequential numbers', () => {
    const md = htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')
    expect(md).toContain('1. first')
    expect(md).toContain('2. second')
  })

  test('renders h3-h6 as nested markdown headings', () => {
    const md = htmlToMarkdown('<h3>A</h3><h4>B</h4><h5>C</h5><h6>D</h6>')
    expect(md).toContain('### A')
    expect(md).toContain('#### B')
    expect(md).toContain('##### C')
    expect(md).toContain('###### D')
  })

  test('preserves <pre> code as fenced block with original indentation', () => {
    const md = htmlToMarkdown('<pre>if (x) {\n    foo();\n}</pre>')
    expect(md).toContain('```')
    expect(md).toContain('if (x) {')
    expect(md).toContain('    foo();')
  })

  test('joins apple-archive multi-row codesample tables into a single fenced block', () => {
    const html = `<div class="codesample clear"><table>
      <tr><td><pre>line one</pre></td></tr>
      <tr><td><pre>    line two indented</pre></td></tr>
      <tr><td><pre>line three</pre></td></tr>
    </table></div>`
    const md = htmlToMarkdown(html)
    const fence = md.match(/```\n([\s\S]+?)\n```/)
    expect(fence).not.toBeNull()
    expect(fence[1]).toBe('line one\n    line two indented\nline three')
  })

  test('renders <dl> with bold terms separated by em-dash', () => {
    const html = '<dl><dt>Foo</dt><dd>The foo type.</dd><dt>Bar</dt><dd>The bar type.</dd></dl>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**Foo** — The foo type.')
    expect(md).toContain('**Bar** — The bar type.')
  })

  test('apple-archive <dl class="termdef"> with embedded <h5> term names is recognized', () => {
    const html = '<dl class="termdef"><h5>ProtocolName</h5><dt></dt><dd>Defined in <code>Header.h</code>.</dd></dl>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('**ProtocolName**')
    expect(md).toContain('`Header.h`')
  })

  test('strips legacy named anchors (<a name="..." title="...">) but keeps inner content', () => {
    const md = htmlToMarkdown('<a name="anchor1" title="Anchor"><h2>Section</h2></a><p>Body.</p>')
    expect(md).not.toContain('anchor1')
    expect(md).not.toContain('<a')
  })

  test('strips script/style/nav/header/footer chrome', () => {
    const html = '<header>Site nav</header><main><p>Content.</p></main><footer>©</footer>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('Content.')
    expect(md).not.toContain('Site nav')
    expect(md).not.toContain('©')
  })

  test('handles nested inline <code> inside list items', () => {
    const html = '<ul><li>Use <code>foo</code> here.</li><li>And <code>bar</code> there.</li></ul>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('- Use `foo` here.')
    expect(md).toContain('- And `bar` there.')
  })

  test('returns empty string for empty input', () => {
    expect(htmlToMarkdown('')).toBe('')
    expect(htmlToMarkdown(null)).toBe('')
  })
})

describe('extractHtmlContent — preserveStructure option', () => {
  test('emits markdown-formatted section content when preserveStructure is true', () => {
    const html = `<html><body><main>
      <h1>Title</h1>
      <h2>Section A</h2>
      <p>Use <code>foo()</code> in this <strong>place</strong>.</p>
      <ul><li>one</li><li>two</li></ul>
    </main></body></html>`
    const { sections } = extractHtmlContent(html, { preserveStructure: true })
    const sec = sections.find(s => s.heading === 'Section A')
    expect(sec.content).toContain('`foo()`')
    expect(sec.content).toContain('**place**')
    expect(sec.content).toContain('- one')
    expect(sec.content).toContain('- two')
  })

  test('plain-text mode (default) collapses inline structure', () => {
    const html = `<html><body><main>
      <h1>Title</h1>
      <h2>Section A</h2>
      <p>Use <code>foo()</code> here.</p>
      <ul><li>one</li><li>two</li></ul>
    </main></body></html>`
    const { sections } = extractHtmlContent(html)
    const sec = sections.find(s => s.heading === 'Section A')
    expect(sec.content).not.toContain('`foo()`')
    expect(sec.content).not.toContain('- one')
  })
})

describe('stripElements — adversarial inputs (P4.9)', () => {
  // extractHtmlContent runs the input through stripElements(STRIP_ELEMENTS),
  // which is the surface we care about for adversarial parse cost. The
  // wrapping <h1> + <h2> let extractHtmlContent emit a section so we can
  // assert against its content.
  function strip(inner) {
    const html = `<html><body><h1>T</h1><h2>S</h2><div>${inner}</div></body></html>`
    const { sections } = extractHtmlContent(html)
    return (sections.find(s => s.heading === 'S')?.content ?? '').replace(/\s+/g, ' ').trim()
  }

  test('deeply nested same-tag elements strip in linear time', () => {
    // Earlier do-while regex loop did O(depth) full-string rescans → O(N×depth).
    // 5000-deep nesting on a 200 KB string took >5s before the fix.
    const depth = 5000
    const html = `<html><body><h1>T</h1><h2>S</h2><div>before${'<script>foo'.repeat(depth)}${'bar</script>'.repeat(depth)}after</div></body></html>`
    const start = performance.now()
    const { sections } = extractHtmlContent(html)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(2000)
    const content = sections.find(s => s.heading === 'S')?.content ?? ''
    expect(content).toContain('before')
    expect(content).toContain('after')
    expect(content).not.toContain('foo')
    expect(content).not.toContain('bar')
  })

  test('multiple top-level script tags are all stripped', () => {
    const result = strip('a<script>x</script>b<script>y</script>c')
    expect(result).not.toContain('x')
    expect(result).not.toContain('y')
    expect(result).toContain('a')
    expect(result).toContain('b')
    expect(result).toContain('c')
  })

  test('self-closing script tag is dropped', () => {
    const result = strip('a<script/>b')
    expect(result).toContain('a')
    expect(result).toContain('b')
    expect(result).not.toContain('script')
  })

  test('unmatched opening script tag — content remains', () => {
    // Unclosed <script> means we strip just the tag; the trailing text is
    // preserved (matches the previous regex-based behavior).
    expect(strip('a<script>b')).toContain('a')
  })
})
