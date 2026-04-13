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
    expect(html).toContain('<pre>')
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
