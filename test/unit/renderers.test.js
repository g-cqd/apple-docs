import { describe, test, expect } from 'bun:test'
import { normalize } from '../../src/content/normalize.js'
import { renderMarkdown } from '../../src/content/render-markdown.js'
import { renderHtml, slugify } from '../../src/content/render-html.js'
import { renderPlainText } from '../../src/content/render-text.js'
import { renderSnippet } from '../../src/content/render-snippet.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()
const { document, sections } = normalize(fixture, 'swiftui/view', 'apple-docc')

describe('renderMarkdown', () => {
  test('produces valid markdown with front matter', () => {
    const md = renderMarkdown(document, sections)

    expect(md).toMatch(/^---\n/)
    expect(md).toContain('title:')
    expect(md).toContain('# View')
  })

  test('includes declaration section', () => {
    const md = renderMarkdown(document, sections)
    expect(md).toContain('## Declaration')
    expect(md).toContain('```')
  })

  test('includes topics section', () => {
    const md = renderMarkdown(document, sections)
    expect(md).toContain('## Topics')
  })

  test('handles empty sections gracefully', () => {
    const md = renderMarkdown(document, [])
    expect(md).toContain('# View')
    expect(md).not.toContain('## Declaration')
  })

  test('handles minimal document', () => {
    const minDoc = { key: 'test/minimal', title: 'Minimal' }
    const md = renderMarkdown(minDoc, [])
    expect(md).toContain('# Minimal')
    expect(md).toContain('path:')
  })

  test('renders abstract as plain text', () => {
    const abstractSection = sections.find(s => s.sectionKind === 'abstract')
    if (abstractSection) {
      const md = renderMarkdown(document, [abstractSection])
      expect(md).toContain(abstractSection.contentText)
    }
  })
})

describe('renderHtml', () => {
  test('produces HTML with heading', () => {
    const html = renderHtml(document, sections)

    expect(html).toContain('<h1>')
    expect(html).toContain('View')
    expect(html).toContain('</h1>')
  })

  test('includes declaration code block', () => {
    const html = renderHtml(document, sections)
    expect(html).toContain('<pre')
    expect(html).toContain('<code')
  })

  test('handles empty sections', () => {
    const html = renderHtml({ key: 'test/empty', title: 'Empty' }, [])
    expect(html).toContain('<h1>')
    expect(html).toContain('Empty')
  })

  test('sections have id attributes for TOC anchoring', () => {
    const html = renderHtml(document, sections)
    // Declaration section should have id
    if (html.includes('<h2>Declaration</h2>')) {
      expect(html).toContain('id="declaration"')
    }
    // Topics section should have id
    if (html.includes('<h2>Topics</h2>')) {
      expect(html).toContain('id="topics"')
    }
    // Discussion/Overview section should have id
    if (html.includes('<h2>Overview</h2>')) {
      expect(html).toContain('id="overview"')
    }
  })

  test('declaration renders type links when knownKeys provided and tokens have _resolvedKey', () => {
    const declSection = {
      sectionKind: 'declaration',
      heading: 'Declaration',
      contentJson: JSON.stringify([{
        tokens: [
          { kind: 'keyword', text: 'var' },
          { kind: 'text', text: ' body: ' },
          { kind: 'typeIdentifier', text: 'View', _resolvedKey: 'swiftui/view' },
        ],
        languages: ['swift'],
      }]),
      contentText: 'var body: View',
      sortOrder: 1,
    }
    const knownKeys = new Set(['swiftui/view'])
    const html = renderHtml({ title: 'Test' }, [declSection], { knownKeys })
    expect(html).toContain('<a href="/docs/swiftui/view/"')
    expect(html).toContain('class="code-type-link"')
    expect(html).toContain('decl-type')
    expect(html).toContain('View</span></a>')
  })

  test('declaration does not link types missing from knownKeys', () => {
    const declSection = {
      sectionKind: 'declaration',
      heading: 'Declaration',
      contentJson: JSON.stringify([{
        tokens: [
          { kind: 'keyword', text: 'var' },
          { kind: 'text', text: ' body: ' },
          { kind: 'typeIdentifier', text: 'UnknownType', _resolvedKey: 'missing/unknowntype' },
        ],
        languages: ['swift'],
      }]),
      contentText: 'var body: UnknownType',
      sortOrder: 1,
    }
    const knownKeys = new Set(['swiftui/view'])
    const html = renderHtml({ title: 'Test' }, [declSection], { knownKeys })
    expect(html).not.toContain('<a ')
    expect(html).toContain('decl-type')
    expect(html).toContain('UnknownType')
  })

  test('declaration falls back to Shiki/plain when no knownKeys provided', () => {
    const declSection = {
      sectionKind: 'declaration',
      heading: 'Declaration',
      contentJson: JSON.stringify([{
        tokens: [
          { kind: 'keyword', text: 'protocol' },
          { kind: 'text', text: ' ' },
          { kind: 'identifier', text: 'View' },
        ],
        languages: ['swift'],
      }]),
      contentText: 'protocol View',
      sortOrder: 1,
    }
    const html = renderHtml({ title: 'Test' }, [declSection])
    // Without knownKeys, should not produce decl-tokens rendering
    expect(html).toContain('<pre')
    // Content should include "protocol" and "View" (possibly wrapped in Shiki spans)
    expect(html).toContain('protocol')
    expect(html).toContain('View')
    expect(html).not.toContain('decl-tokens')
  })

  test('declaration applies semantic CSS classes to token kinds', () => {
    const declSection = {
      sectionKind: 'declaration',
      heading: 'Declaration',
      contentJson: JSON.stringify([{
        tokens: [
          { kind: 'keyword', text: 'func' },
          { kind: 'text', text: ' ' },
          { kind: 'identifier', text: 'doThing' },
          { kind: 'text', text: '(' },
          { kind: 'externalParam', text: 'with' },
          { kind: 'text', text: ': ' },
          { kind: 'typeIdentifier', text: 'String', _resolvedKey: 'swift/string' },
          { kind: 'text', text: ')' },
        ],
        languages: ['swift'],
      }]),
      contentText: 'func doThing(with: String)',
      sortOrder: 1,
    }
    const knownKeys = new Set(['swift/string'])
    const html = renderHtml({ title: 'Test' }, [declSection], { knownKeys })
    expect(html).toContain('class="decl-keyword"')
    expect(html).toContain('class="decl-identifier"')
    expect(html).toContain('class="decl-param"')
    expect(html).toContain('class="code-type-link"')
  })
})

describe('renderHtml block nodes', () => {
  test('renders paragraph with inline content', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Overview',
      contentJson: JSON.stringify([
        { type: 'paragraph', inlineContent: [{ type: 'text', text: 'Hello world' }] },
      ]),
      contentText: 'Hello world',
      sortOrder: 3,
    }])
    expect(html).toContain('<p>Hello world</p>')
  })

  test('renders codeListing with language', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Example',
      contentJson: JSON.stringify([
        { type: 'codeListing', syntax: 'swift', code: ['let x = 1', 'print(x)'] },
      ]),
      contentText: 'let x = 1',
      sortOrder: 3,
    }])
    expect(html).toContain('<pre')
    // Code content present (may be wrapped in Shiki spans)
    expect(html).toContain('let')
    expect(html).toContain('print')
    expect(html).toContain('(x)')
  })

  test('renders unordered and ordered lists', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Lists',
      contentJson: JSON.stringify([
        { type: 'unorderedList', items: [
          { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'item A' }] }] },
          { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'item B' }] }] },
        ]},
        { type: 'orderedList', items: [
          { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'first' }] }] },
        ]},
      ]),
      contentText: 'item A item B first',
      sortOrder: 3,
    }])
    expect(html).toContain('<ul>')
    expect(html).toContain('<li><p>item A</p></li>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li><p>first</p></li>')
  })

  test('renders aside with style', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Notes',
      contentJson: JSON.stringify([
        { type: 'aside', style: 'Important', content: [
          { type: 'paragraph', inlineContent: [{ type: 'text', text: 'Be careful' }] },
        ]},
      ]),
      contentText: 'Be careful',
      sortOrder: 3,
    }])
    expect(html).toContain('<aside>')
    expect(html).toContain('Important:')
    expect(html).toContain('Be careful')
  })

  test('renders table with header row', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Data',
      contentJson: JSON.stringify([
        { type: 'table', header: 'row', rows: [
          [{ content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Name' }] }] }],
          [{ content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Alice' }] }] }],
        ]},
      ]),
      contentText: 'Name Alice',
      sortOrder: 3,
    }])
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<td>')
    expect(html).toContain('</table>')
  })

  test('renders termList as dl', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Terms',
      contentJson: JSON.stringify([
        { type: 'termList', items: [
          { term: { inlineContent: [{ type: 'text', text: 'Key' }] },
            definition: { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Value' }] }] } },
        ]},
      ]),
      contentText: 'Key Value',
      sortOrder: 3,
    }])
    expect(html).toContain('<dl>')
    expect(html).toContain('<dt>Key</dt>')
    expect(html).toContain('<dd><p>Value</p></dd>')
  })

  test('renders heading with anchor', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Details',
      contentJson: JSON.stringify([
        { type: 'heading', level: 3, text: 'Subsection', anchor: 'subsection' },
      ]),
      contentText: 'Subsection',
      sortOrder: 3,
    }])
    expect(html).toContain('<h3 id="subsection">Subsection</h3>')
  })
})

describe('renderHtml inline nodes', () => {
  function renderInline(nodes) {
    return renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Test',
      contentJson: JSON.stringify([{ type: 'paragraph', inlineContent: nodes }]),
      contentText: '',
      sortOrder: 3,
    }])
  }

  test('renders codeVoice as <code>', () => {
    const html = renderInline([{ type: 'codeVoice', code: 'View' }])
    expect(html).toContain('<code>View</code>')
  })

  test('renders emphasis as <em>', () => {
    const html = renderInline([{ type: 'emphasis', inlineContent: [{ type: 'text', text: 'italic' }] }])
    expect(html).toContain('<em>italic</em>')
  })

  test('renders strong as <strong>', () => {
    const html = renderInline([{ type: 'strong', inlineContent: [{ type: 'text', text: 'bold' }] }])
    expect(html).toContain('<strong>bold</strong>')
  })

  test('renders superscript and subscript', () => {
    const html = renderInline([
      { type: 'superscript', inlineContent: [{ type: 'text', text: '2' }] },
      { type: 'subscript', inlineContent: [{ type: 'text', text: 'n' }] },
    ])
    expect(html).toContain('<sup>2</sup>')
    expect(html).toContain('<sub>n</sub>')
  })

  test('renders strikethrough as <s>', () => {
    const html = renderInline([{ type: 'strikethrough', inlineContent: [{ type: 'text', text: 'old' }] }])
    expect(html).toContain('<s>old</s>')
  })

  test('renders link with destination', () => {
    const html = renderInline([{ type: 'link', destination: 'https://example.com', title: 'Example' }])
    expect(html).toContain('<a href="https://example.com">Example</a>')
  })

  test('renders image as text placeholder', () => {
    const html = renderInline([{ type: 'image', alt: 'diagram' }])
    expect(html).toContain('[diagram]')
  })
})

describe('renderHtml parameters section', () => {
  test('renders parameters from JSON', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'parameters',
      heading: null,
      contentJson: JSON.stringify([
        { name: 'content', content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'The view content' }] }] },
        { name: 'label', content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'A label' }] }] },
      ]),
      contentText: 'content: The view content\nlabel: A label',
      sortOrder: 2,
    }])
    expect(html).toContain('<section id="parameters">')
    expect(html).toContain('<strong>content</strong>')
    expect(html).toContain('<strong>label</strong>')
  })

  test('falls back to text when JSON is null', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'parameters',
      heading: null,
      contentJson: null,
      contentText: 'content: The view content\nlabel: A label',
      sortOrder: 2,
    }])
    expect(html).toContain('<section id="parameters">')
    expect(html).toContain('content: The view content')
  })
})

describe('renderHtml markdown fallback', () => {
  test('renders discussion from plain text with markdown', () => {
    const html = renderHtml({ title: 'T' }, [{
      sectionKind: 'discussion',
      heading: 'Overview',
      contentJson: null,
      contentText: '# Heading\n\nA paragraph.\n\n```swift\nlet x = 1\n```\n\n- item 1\n- item 2',
      sortOrder: 3,
    }])
    expect(html).toContain('<section id="overview">')
    expect(html).toContain('<p>A paragraph.</p>')
  })
})

describe('renderPlainText', () => {
  test('produces plain text with title and content', () => {
    const text = renderPlainText(document, sections)

    expect(text).toContain('View')
    expect(text).not.toContain('#')
    expect(text).not.toContain('```')
    expect(text).not.toContain('<h1>')
  })

  test('concatenates all sections', () => {
    const text = renderPlainText(document, sections)
    // Should contain abstract text
    if (document.abstractText) {
      expect(text).toContain(document.abstractText)
    }
  })

  test('handles empty input', () => {
    const text = renderPlainText({ title: 'X' }, [])
    expect(text).toContain('X')
  })
})

describe('renderSnippet', () => {
  test('extracts context window around query match', () => {
    const snippet = renderSnippet(document, sections, 'View', 200)

    expect(snippet).toBeTruthy()
    expect(snippet.length).toBeLessThanOrEqual(210) // some slack for word boundaries
  })

  test('falls back to abstract when no match found', () => {
    const snippet = renderSnippet(document, sections, 'xyznonexistent', 200)
    // Should still return something (abstract fallback)
    expect(snippet).toBeTruthy()
  })

  test('handles empty sections', () => {
    const snippet = renderSnippet({ title: 'Test', abstractText: 'Fallback text' }, [], 'test', 100)
    expect(snippet).toBeTruthy()
  })
})

describe('slugify', () => {
  test('converts heading text to URL-safe slug', () => {
    expect(slugify('See Also')).toBe('see-also')
    expect(slugify('Overview')).toBe('overview')
    expect(slugify('Declaration')).toBe('declaration')
  })

  test('strips non-word characters', () => {
    expect(slugify('What\'s New?')).toBe('whats-new')
  })

  test('handles empty/null input', () => {
    expect(slugify('')).toBe('')
    expect(slugify(null)).toBe('')
    expect(slugify(undefined)).toBe('')
  })

  test('collapses multiple hyphens', () => {
    expect(slugify('A   B---C')).toBe('a-b-c')
  })
})
