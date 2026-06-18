// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'
import { renderContentNodesToText, renderInlineNodes } from '../../../src/content/normalize/render-content.js'
import { renderContentNodesToHtml, renderInlineNodesToHtml } from '../../../src/content/render-html/nodes.js'

// A pathologically deep DocC tree (hostile or malformed input) must not overflow the call
// stack: the renderers cap recursion at MAX_RENDER_DEPTH and render a deeper subtree as empty.
// The depth here far exceeds anything real Apple payloads (≲ 10 levels) produce.
function nestBlocks(depth) {
  let node = { type: 'text', text: 'leaf' }
  for (let i = 0; i < depth; i++) node = { type: 'aside', content: [node] }
  return node
}

function nestInline(depth) {
  let node = { type: 'text', text: 'leaf' }
  for (let i = 0; i < depth; i++) node = { type: 'emphasis', inlineContent: [node] }
  return node
}

describe('content renderers — recursion depth cap', () => {
  test('deep block tree does not overflow the stack (text)', () => {
    const node = nestBlocks(50_000)
    let out
    expect(() => {
      out = renderContentNodesToText([node], {})
    }).not.toThrow()
    expect(typeof out).toBe('string')
  })

  test('deep block tree does not overflow the stack (html)', () => {
    const node = nestBlocks(50_000)
    let out
    expect(() => {
      out = renderContentNodesToHtml([node])
    }).not.toThrow()
    expect(typeof out).toBe('string')
  })

  test('deep inline tree does not overflow the stack (text + html)', () => {
    const node = nestInline(50_000)
    expect(() => renderInlineNodes([node], {})).not.toThrow()
    expect(() => renderInlineNodesToHtml([node])).not.toThrow()
  })

  test('shallow content is unchanged by the cap', () => {
    const nodes = [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Hello' }] }]
    expect(renderContentNodesToText(nodes, {})).toBe('Hello\n')
    expect(renderContentNodesToHtml(nodes)).toBe('<p>Hello</p>')
  })
})
