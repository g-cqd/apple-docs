import { describe, test, expect } from 'bun:test'
import { renderPage, relativePath } from '../../src/apple/renderer.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

describe('relativePath', () => {
  test('same directory sibling', () => {
    expect(relativePath('swiftui/view', 'swiftui/text')).toBe('text')
  })

  test('child path', () => {
    expect(relativePath('swiftui/view', 'swiftui/view/body')).toBe('view/body')
  })

  test('parent path', () => {
    expect(relativePath('swiftui/view/body', 'swiftui/view')).toBe('../view')
  })

  test('cousin path', () => {
    expect(relativePath('swiftui/view/body', 'swiftui/text/init')).toBe('../text/init')
  })

  test('cross-framework path', () => {
    expect(relativePath('swiftui/view', 'foundation/nsstring')).toBe('../foundation/nsstring')
  })

  test('deeply nested to shallow', () => {
    expect(relativePath('a/b/c/d', 'a/e')).toBe('../../e')
  })

  test('self-reference', () => {
    expect(relativePath('swiftui/view', 'swiftui/view')).toBe('view')
  })

  test('root level', () => {
    expect(relativePath('swiftui', 'foundation')).toBe('foundation')
  })

  test('null inputs', () => {
    expect(relativePath(null, 'a/b')).toBe('a/b')
    expect(relativePath('a/b', null)).toBe('')
  })
})

describe('renderPage', () => {
  test('renders real fixture to Markdown', () => {
    const md = renderPage(fixture, 'swiftui/view')

    // Front matter
    expect(md).toContain('---')
    expect(md).toContain('title: View')
    expect(md).toContain('role: symbol')

    // Title
    expect(md).toContain('# View')

    // Abstract
    expect(md).toContain('user interface')

    // Declaration section
    expect(md).toContain('## Declaration')
    expect(md).toContain('```swift')

    // Overview heading
    expect(md).toContain('## Overview')

    // Code example
    expect(md).toContain('struct MyView: View')

    // Topics section
    expect(md).toContain('## Topics')
    expect(md).toContain('### Implementing a custom view')

    // Relationships
    expect(md).toContain('## Relationships')
    expect(md).toContain('### Inherited By')

    // See Also
    expect(md).toContain('## See Also')

    // Links should use .md extension
    expect(md).toMatch(/\]\([^)]+\.md\)/)
  })

  test('produces valid non-empty output', () => {
    const md = renderPage(fixture, 'swiftui/view')
    expect(md.length).toBeGreaterThan(500)
    // Should not have excessive blank lines
    expect(md).not.toContain('\n\n\n')
  })

  test('handles empty json gracefully', () => {
    const md = renderPage({}, 'test/empty')
    expect(md).toContain('---')
    expect(md.length).toBeGreaterThan(0)
  })
})
