import { describe, test, expect } from 'bun:test'
import { normalize, renderContentNodesToText } from '../../src/content/normalize.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

describe('normalize — Apple DocC', () => {
  test('extracts document metadata from DocC JSON', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(document.sourceType).toBe('apple-docc')
    expect(document.key).toBe('swiftui/view')
    expect(document.title).toBe('View')
    expect(document.role).toBe('symbol')
    expect(document.roleHeading).toBe('Protocol')
    expect(document.framework).toBe('swiftui')
    expect(document.url).toContain('developer.apple.com/documentation/swiftui/view')
    expect(document.language).toBe('swift')
    expect(document.abstractText).toBeTruthy()
    expect(document.declarationText).toContain('View')
    expect(document.isReleaseNotes).toBe(false)
    expect(document.urlDepth).toBe(1)
  })

  test('extracts platform versions', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')

    if (document.platformsJson) {
      const platforms = JSON.parse(document.platformsJson)
      expect(typeof platforms).toBe('object')
    }
  })

  test('produces sections in correct order', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(sections.length).toBeGreaterThan(0)

    // Should be sorted by sortOrder
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].sortOrder).toBeGreaterThanOrEqual(sections[i - 1].sortOrder)
    }

    // First section should be abstract or have sortOrder 0
    const sectionKinds = sections.map(s => s.sectionKind)
    expect(sectionKinds).toContain('abstract')
  })

  test('extracts abstract section with contentText and contentJson', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const abstract = sections.find(s => s.sectionKind === 'abstract')

    expect(abstract).toBeTruthy()
    expect(abstract.contentText).toBeTruthy()
    expect(abstract.contentJson).toBeTruthy()
    expect(abstract.heading).toBeNull()
  })

  test('extracts declaration section', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const decl = sections.find(s => s.sectionKind === 'declaration')

    expect(decl).toBeTruthy()
    expect(decl.contentText).toContain('View')
    expect(decl.heading).toBe('Declaration')
    expect(decl.contentJson).toBeTruthy()
  })

  test('extracts topics section', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const topics = sections.find(s => s.sectionKind === 'topics')

    expect(topics).toBeTruthy()
    expect(topics.heading).toBe('Topics')
    expect(topics.contentText).toBeTruthy()
  })

  test('extracts relationships as child/see_also/inherits_from', () => {
    const { relationships } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(relationships.length).toBeGreaterThan(0)

    const types = new Set(relationships.map(r => r.relationType))
    // View should have at least child relations (from topics)
    expect(types.has('child')).toBe(true)

    // All relationships should have fromKey = our key
    for (const rel of relationships) {
      expect(rel.fromKey).toBe('swiftui/view')
      expect(rel.toKey).toBeTruthy()
    }
  })

  test('headings field contains section heading text', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')
    // headings may be null if no content sections with headings
    if (document.headings) {
      expect(typeof document.headings).toBe('string')
    }
  })

  test('handles empty/minimal JSON gracefully', () => {
    const { document, sections, relationships } = normalize({}, 'test/empty', 'apple-docc')

    expect(document.key).toBe('test/empty')
    expect(document.title).toBeNull()
    expect(sections.length).toBe(0)
    expect(relationships.length).toBe(0)
  })

  test('handles null payload gracefully', () => {
    const { document } = normalize(null, 'test/null', 'apple-docc')
    expect(document.key).toBe('test/null')
  })
})

describe('normalize — Guidelines', () => {
  test('normalizes guideline section', () => {
    const section = {
      title: '1.1 - App Completeness',
      role: 'article',
      roleHeading: 'Section',
      path: 'app-store-review/1.1',
      markdown: 'Submissions must be final versions.',
      abstract: 'Submissions must be final.',
      id: '1.1',
      children: ['app-store-review/1.1.1'],
    }

    const { document, sections, relationships } = normalize(section, 'app-store-review/1.1', 'guidelines')

    expect(document.sourceType).toBe('guidelines')
    expect(document.framework).toBe('app-store-review')
    expect(document.title).toBe('1.1 - App Completeness')

    expect(sections.length).toBe(2) // abstract + discussion
    expect(sections[0].sectionKind).toBe('abstract')
    expect(sections[1].sectionKind).toBe('discussion')

    expect(relationships.length).toBe(1)
    expect(relationships[0].relationType).toBe('child')
    expect(relationships[0].toKey).toBe('app-store-review/1.1.1')
  })

  test('handles guideline with no children', () => {
    const section = {
      title: 'Leaf Section',
      role: 'article',
      path: 'app-store-review/leaf',
      markdown: 'Content here.',
      abstract: null,
      children: [],
    }

    const { relationships } = normalize(section, 'app-store-review/leaf', 'guidelines')
    expect(relationships.length).toBe(0)
  })
})

describe('renderContentNodesToText', () => {
  test('renders paragraph to text', () => {
    const nodes = [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Hello world' }] }]
    expect(renderContentNodesToText(nodes, {})).toContain('Hello world')
  })

  test('renders heading to text', () => {
    const nodes = [{ type: 'heading', level: 2, text: 'Overview' }]
    expect(renderContentNodesToText(nodes, {})).toContain('Overview')
  })

  test('renders codeListing to text', () => {
    const nodes = [{ type: 'codeListing', syntax: 'swift', code: ['let x = 1', 'print(x)'] }]
    const text = renderContentNodesToText(nodes, {})
    expect(text).toContain('let x = 1')
    expect(text).toContain('print(x)')
  })

  test('renders unorderedList to text', () => {
    const nodes = [{
      type: 'unorderedList',
      items: [
        { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Item A' }] }] },
        { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Item B' }] }] },
      ],
    }]
    const text = renderContentNodesToText(nodes, {})
    expect(text).toContain('Item A')
    expect(text).toContain('Item B')
  })

  test('renders codeVoice inline', () => {
    const nodes = [{ type: 'paragraph', inlineContent: [
      { type: 'text', text: 'Use ' },
      { type: 'codeVoice', code: 'View' },
      { type: 'text', text: ' protocol' },
    ]}]
    expect(renderContentNodesToText(nodes, {})).toContain('Use View protocol')
  })

  test('handles empty/null input', () => {
    expect(renderContentNodesToText(null, {})).toBe('')
    expect(renderContentNodesToText([], {})).toBe('')
    expect(renderContentNodesToText(undefined, {})).toBe('')
  })
})
