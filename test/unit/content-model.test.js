import { describe, expect, test } from 'bun:test'
import { normalize } from '../../src/content/normalize.js'
import { renderMarkdown } from '../../src/content/render-markdown.js'
import { renderHtml } from '../../src/content/render-html.js'
import { renderPlainText } from '../../src/content/render-text.js'
import { renderSnippet } from '../../src/content/render-snippet.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

describe('normalized content model', () => {
  test('normalizes a DocC payload into document, sections, and relationships', () => {
    const normalized = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(normalized.document.title).toBe('View')
    expect(normalized.document.kind).toBe('protocol')
    expect(normalized.sections.length).toBeGreaterThan(3)
    expect(normalized.relationships.length).toBeGreaterThan(5)
  })

  test('renders markdown from normalized content', () => {
    const normalized = normalize(fixture, 'swiftui/view', 'apple-docc')
    const markdown = renderMarkdown(normalized.document, normalized.sections)

    expect(markdown).toContain('title: View')
    expect(markdown).toContain('# View')
    expect(markdown).toContain('## Declaration')
    expect(markdown).toContain('## Topics')
  })

  test('renders html and plain text from normalized content', () => {
    const normalized = normalize(fixture, 'swiftui/view', 'apple-docc')
    const html = renderHtml(normalized.document, normalized.sections)
    const text = renderPlainText(normalized.document, normalized.sections)

    expect(html).toContain('<h1>View</h1>')
    expect(html).toContain('<h2>Declaration</h2>')
    expect(text).toContain('View')
    expect(text).toContain('user interface')
  })

  test('renders a query-focused snippet', () => {
    const normalized = normalize(fixture, 'swiftui/view', 'apple-docc')
    const snippet = renderSnippet(normalized.document, normalized.sections, 'user interface', 140)

    expect(snippet.length).toBeLessThanOrEqual(146)
    expect(snippet.toLowerCase()).toContain('user interface')
  })
})
