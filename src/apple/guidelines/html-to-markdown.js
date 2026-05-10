/**
 * HTML → Markdown converter for Apple's App Store Review Guidelines page.
 * The HTML is hand-curated and Apple-stable; the regex pipeline here is
 * tuned to the patterns in that one page (anchor-and-section structure,
 * hand-rolled callouts, etc.) and would need rework for any other source.
 */

export async function htmlToMarkdown(html) {
  // Wrap in a root element so HTMLRewriter processes it properly
  const wrapped = `<div id="md-root">${html}</div>`

  const parts = []
  let linkHref = null
  let inStrong = false
  let strongBuf = ''
  const listStack = []  // track list nesting: 'disc' | 'no-bullet'
  let _inListItem = false
  let skipDepth = 0   // for elements we want to skip entirely

  const rw = new HTMLRewriter()

  // Skip navigation/sidebar elements that may be inside the content
  rw.on('.sidenav-container', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('.sticky-container', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('.form-checkbox', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })
  rw.on('#documentation', { element(el) { skipDepth++; el.onEndTag(() => skipDepth--) } })

  // Headings
  rw.on('h1, h2, h3', {
    element(el) {
      if (skipDepth > 0) return
      const level = Number.parseInt(el.tagName[1])
      parts.push(`\n${'#'.repeat(level)} `)
      el.onEndTag(() => parts.push('\n\n'))
    },
  })

  // Paragraphs
  rw.on('p', {
    element(el) {
      if (skipDepth > 0) return
      el.onEndTag(() => parts.push('\n\n'))
    },
  })

  // Strong / bold
  rw.on('strong', {
    element(el) {
      if (skipDepth > 0) return
      inStrong = true
      strongBuf = ''
      el.onEndTag(() => {
        inStrong = false
        parts.push(`**${strongBuf}**`)
        strongBuf = ''
      })
    },
  })

  // Emphasis
  rw.on('em', {
    element(el) {
      if (skipDepth > 0) return
      parts.push('*')
      el.onEndTag(() => parts.push('*'))
    },
  })

  // Links
  rw.on('a[href]', {
    element(el) {
      if (skipDepth > 0) return
      linkHref = el.getAttribute('href')
      parts.push('[')
      el.onEndTag(() => {
        // Make relative URLs absolute
        let href = linkHref
        if (href?.startsWith('/')) {
          href = `https://developer.apple.com${href}`
        }
        // Convert internal guideline anchors to section references
        if (href?.startsWith('#')) {
          href = `#${href.slice(1)}`
        }
        parts.push(`](${href})`)
        linkHref = null
      })
    },
  })

  // Code
  rw.on('code', {
    element(el) {
      if (skipDepth > 0) return
      parts.push('`')
      el.onEndTag(() => parts.push('`'))
    },
  })

  // Lists
  rw.on('ul', {
    element(el) {
      if (skipDepth > 0) return
      const cls = el.getAttribute('class') ?? ''
      const type = cls.includes('disc') ? 'disc' : 'no-bullet'
      listStack.push(type)
      el.onEndTag(() => {
        listStack.pop()
        parts.push('\n')
      })
    },
  })

  rw.on('ol', {
    element(el) {
      if (skipDepth > 0) return
      listStack.push('ordered')
      el.onEndTag(() => {
        listStack.pop()
        parts.push('\n')
      })
    },
  })

  // List items
  rw.on('li', {
    element(el) {
      if (skipDepth > 0) return
      const depth = Math.max(0, listStack.length - 1)
      const indent = '  '.repeat(depth)
      const currentList = listStack[listStack.length - 1]

      if (currentList === 'disc') {
        parts.push(`${indent}- `)
      } else if (currentList === 'ordered') {
        parts.push(`${indent}1. `)
      }
      // 'no-bullet' list items get no prefix — they're guideline sections
      _inListItem = true
      el.onEndTag(() => {
        _inListItem = false
        parts.push('\n')
      })
    },
  })

  // Line breaks
  rw.on('br', {
    element() {
      if (skipDepth > 0) return
      parts.push('\n')
    },
  })

  // Images (skip, they're mostly ASR/NR badges already stripped)
  rw.on('img', {
    element(_el) {
      // Already stripped ASR badges in phase 1, skip any remaining
    },
  })

  // Span elements with id (section number anchors) — skip the span, keep flow
  rw.on('span[id]', {
    element() {
      // These are anchor spans like <span id="1.1"></span>, skip silently
    },
  })

  // Text handler — capture all text
  rw.onDocument({
    text(chunk) {
      if (skipDepth > 0) return
      if (!chunk.text) return
      if (inStrong) {
        strongBuf += chunk.text
      } else {
        parts.push(chunk.text)
      }
    },
  })

  await rw.transform(new Response(wrapped)).text()

  // Clean up the markdown
  const md = parts.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u00a0/g, ' ')       // non-breaking space
    .replace(/\t/g, ' ')           // tabs
    .replace(/^[ \t]+/gm, '')      // leading whitespace on each line (HTML indentation)
    .replace(/ {2,}/g, ' ')        // collapse multiple spaces
    .replace(/\n{3,}/g, '\n\n')    // collapse blank lines
    .trim()

  return md
}

/**
 * Resolve the section title from metadata and markdown content.
 */
