import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { disposeHighlighter, highlightCode, initHighlighter } from '../../src/content/highlight.js'

beforeEach(() => {
  disposeHighlighter()
})

afterEach(() => {
  disposeHighlighter()
})

describe('highlight', () => {
  test('shares one init promise while warming the highlighter', async () => {
    const first = initHighlighter()
    const second = initHighlighter()

    expect(first).toBe(second)
    await first
  })

  test('returns plain fallback until the highlighter is ready', async () => {
    expect(highlightCode('let value = 1', 'swift')).toBeNull()

    await initHighlighter()

    const html = highlightCode('let value = 1', 'swift')
    expect(html).toContain('shiki')
    expect(html).toContain('value')
  })
})
