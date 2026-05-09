// Lightweight markdown → HTML converter. Used by:
//   - swift-book / WWDC / Swift Evolution sources that ship raw .md
//   - Discussion-section fallback when DocC `contentJson` isn't present
//   - Abstract sections from HTML-source articles (they capture multi-
//     paragraph intros that need structural rendering)
//
// Pulled out of content/render-html.js as part of Phase B.

import { highlightCode } from '../highlight.js'
import { escapeHtml, isSafeHref } from './helpers.js'

export function markdownToHtml(md) {
  if (!md) return ''

  // Strip stray XML declarations/processing instructions
  const cleaned = md.replace(/<\?[^?]*\?>/g, '').trim()
  if (!cleaned) return ''

  const lines = cleaned.split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i++; continue }

    // HTML comment — skip entirely
    if (line.trim().startsWith('<!--')) {
      let comment = line
      while (!comment.includes('-->') && i + 1 < lines.length) {
        i++
        comment += `\n${lines[i]}`
      }
      i++
      continue
    }

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})(\w*)/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2] || 'swift'
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      const fencedCode = codeLines.join('\n')

      // DocC placeholder substitution inside code blocks. Shiki tokenizes
      // `<#name#>` across span boundaries (e.g. `&#x3C;`, `#name`, `#`, `>`),
      // so a post-Shiki regex over `&lt;#name#&gt;` can't match. Replace
      // placeholders with identifier-safe tokens BEFORE highlighting, then
      // swap them back to styled spans on the highlighted output.
      const placeholders = []
      const codeWithTokens = fencedCode.replace(/<#([^#>\n]+?)#>/g, (_m, name) => {
        const idx = placeholders.length
        placeholders.push(name)
        return `DoccPh${idx}DoccPh`
      })

      const highlighted = highlightCode(codeWithTokens, lang)
      let block = highlighted ?? `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(codeWithTokens)}</code></pre>`

      block = block.replace(/DoccPh(\d+)DoccPh/g, (_m, idx) => {
        const name = placeholders[Number(idx)] ?? ''
        return `<span class="placeholder">${escapeHtml(name)}</span>`
      })

      out.push(block)
      continue
    }

    // ATX Heading. `.*` (not `.+`) on the trailing capture so a line like
    // `### ` (hashes + space + nothing) still matches and advances `i`.
    // Without it, the line is rejected by the heading regex but matched by
    // the paragraph-skip regex `^#{1,6}\s`, which leaves the outer loop
    // spinning on the same line forever — the JS thread pins, the per-page
    // timeout can't fire (no event-loop turn to schedule it), and the build
    // wedges. Bisected on packages/417-72ki/stubnetworkkit + several swift-
    // evolution proposals on 2026-05-06.
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length + 1, 6) // bump by 1 since h2 is section heading
      const headingText = headingMatch[2].trim()
      if (headingText) {
        out.push(`<h${level}>${inlineMarkdown(headingText)}</h${level}>`)
      }
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const quoteLines = []
      while (i < lines.length && (lines[i].startsWith('> ') || lines[i] === '>')) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${markdownToHtml(quoteLines.join('\n'))}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^[\-\*\+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[\-\*\+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-\*\+]\s+/, ''))
        i++
      }
      out.push(`<ul>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\d+[\.\)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+[\.\)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+[\.\)]\s+/, ''))
        i++
      }
      out.push(`<ol>${items.map(item => `<li>${inlineMarkdown(item)}</li>`).join('')}</ol>`)
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines = []
    while (i < lines.length && lines[i].trim() !== '' &&
      !lines[i].match(/^(`{3,}|~{3,})/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^>\s/) &&
      !lines[i].match(/^[\-\*\+]\s+/) &&
      !lines[i].match(/^\d+[\.\)]\s+/) &&
      !lines[i].match(/^[-*_]{3,}\s*$/) &&
      !lines[i].trim().startsWith('<!--')) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      out.push(`<p>${inlineMarkdown(paraLines.join(' '))}</p>`)
    } else {
      // Defense-in-depth: if no other branch consumed the line and the
      // paragraph collector rejected it (e.g. an `> ` blockquote followed
      // by something that fails every guard, or a future regex tweak that
      // introduces a new gap), advance `i` anyway so the outer loop cannot
      // hang. Dropping the rare unparseable line is preferable to wedging
      // a worker for hours.
      i++
    }
  }

  return out.join('')
}

/** Convert inline markdown syntax to HTML. */
export function inlineMarkdown(text) {
  // Pre-process: convert <doc:PageName> and <doc:PageName#Section> references before escaping
  const pre = text.replace(/<doc:([^>#]+)(?:#([^>]+))?>/g, (_match, page, section) => {
    const displayName = section
      ? `${page.replace(/-/g, ' ')} — ${section.replace(/-/g, ' ')}`
      : page.replace(/-/g, ' ')
    // Link to a search-friendly path — use the page name as the last segment
    return `[${displayName}](/docs/swift-book/?q=${encodeURIComponent(page)})`
  })

  let s = escapeHtml(pre)

  // DocC fill-in placeholder syntax: <#name#>. After escapeHtml the source
  // form is `&lt;#name#&gt;`. Render as a styled span so it visually
  // distinguishes from surrounding code, matching docc-render's behavior.
  s = s.replace(/&lt;#([^#]+?)#&gt;/g, (_m, name) =>
    `<span class="placeholder">${name}</span>`,
  )
  // Images: ![alt](url) — render alt text only (no images in docs)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt) => alt ? `<em>[${alt}]</em>` : '')
  // Remove empty image/link brackets: ![] or []
  s = s.replace(/!\[\]/g, '')
  s = s.replace(/\[\]\([^)]*\)/g, '')
  s = s.replace(/\[\]/g, '')
  // Links: [text](url) — block javascript: protocol
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    const href = isSafeHref(url) ? url : '#'
    return `<a href="${href}">${text}</a>`
  })
  // Bold+italic: ***text*** or ___text___
  s = s.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
  s = s.replace(/_{3}(.+?)_{3}/g, '<strong><em>$1</em></strong>')
  // Bold: **text** or __text__
  s = s.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
  s = s.replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>')
  // Italic: *text* or _text_ (avoid matching underscores inside words)
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>')
  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  return s
}
