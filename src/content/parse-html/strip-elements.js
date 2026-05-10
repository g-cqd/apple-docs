// Strip whole elements (and their content) from an HTML string. Linear
// single-pass: walk all open/close events, depth-counter the matched
// ranges, splice them out. A non-greedy regex replace in a do-while
// loop would hit O(N×depth) on adversarial input.

export function stripElements(html, tags) {
  let result = html
  for (const tag of tags) {
    result = stripElementOnce(result, tag)
  }
  return result
}

function stripElementOnce(html, tag) {
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?\\s*/?>`, 'gi')
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi')

  const events = []
  for (const m of html.matchAll(openRe)) {
    const isSelfClosing = m[0].endsWith('/>')
    events.push({ pos: m.index, end: m.index + m[0].length, kind: isSelfClosing ? 'self' : 'open' })
  }
  for (const m of html.matchAll(closeRe)) {
    events.push({ pos: m.index, end: m.index + m[0].length, kind: 'close' })
  }
  if (events.length === 0) return html
  events.sort((a, b) => a.pos - b.pos)

  // Walk events; ranges accumulates outermost matched [open, close] pairs
  // plus any orphan opens/closes that should be removed in isolation
  // (preserves the previous behavior of dropping just the tag and keeping
  // the content for unclosed elements).
  const ranges = []
  const stack = []
  let outerOpen = null
  for (const ev of events) {
    if (ev.kind === 'self') {
      if (stack.length === 0) ranges.push([ev.pos, ev.end])
      // a self-close inside an outer match is already covered by the outer range
    } else if (ev.kind === 'open') {
      if (stack.length === 0) outerOpen = ev
      stack.push(ev)
    } else if (ev.kind === 'close') {
      if (stack.length > 0) {
        stack.pop()
        if (stack.length === 0 && outerOpen) {
          ranges.push([outerOpen.pos, ev.end])
          outerOpen = null
        }
      } else {
        ranges.push([ev.pos, ev.end])
      }
    }
  }
  for (const open of stack) ranges.push([open.pos, open.end])

  ranges.sort((a, b) => a[0] - b[0])
  const out = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    if (start > cursor) out.push(html.slice(cursor, start))
    cursor = end
  }
  if (cursor < html.length) out.push(html.slice(cursor))
  return out.join('')
}
