// HTML → text/markdown converters used by extractHtmlContent and the
// section splitter. htmlToPlainText drops every structural tag in favour
// of paragraph breaks; htmlToMarkdown preserves code, links, lists,
// emphasis, and sub-headings so legacy archive HTML (apple-archive)
// round-trips through the renderer.

import { BLOCK_TAGS, STRIP_ELEMENTS } from './constants.js'
import { decodeEntities } from './entities.js'
import { stripElements } from './strip-elements.js'

export function htmlToPlainText(html) {
  if (!html) return ''

  // Strip XML declarations and processing instructions
  let cleaned = html.replace(/<\?[^?]*\?>/g, '')
  // Strip SVG elements entirely
  cleaned = cleaned.replace(/<svg[\s\S]*?<\/svg>/gi, '')

  // Replace opening block tags with a paragraph-break sentinel
  const withBreaks = cleaned.replace(
    /<(\/?)(\w+)([^>]*)>/g,
    (_match, _slash, tag) => {
      const lower = tag.toLowerCase()
      if (BLOCK_TAGS.has(lower)) return '\n\n'
      return ' '
    },
  )

  const decoded = decodeEntities(withBreaks)

  // Normalise: collapse runs of spaces/tabs within each paragraph; then
  // collapse 3+ newlines to exactly 2 (one blank line).
  const lines = decoded
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())

  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n')

  return joined.trim()
}

/**
 * Convert an HTML fragment to a Markdown-flavored plain string while
 * preserving structural elements that `htmlToPlainText` would discard:
 * code blocks, inline code, links, lists, sub-headings, and emphasis.
 *
 * The output is fed back through `markdownToHtml` at render time, so the
 * format only needs to be valid CommonMark + the few extensions our renderer
 * supports.
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {(href: string) => string|null} [opts.linkResolver] Rewrite each
 *   `<a href="…">` URL. Returns the new URL, the original if no rewrite is
 *   needed, or `null` to drop the link wrapper (keep the inner text).
 */
export function htmlToMarkdown(html, opts = {}) {
  if (!html) return ''

  const linkResolver = typeof opts.linkResolver === 'function' ? opts.linkResolver : null
  let s = html

  s = s.replace(/<\?[^?]*\?>/g, '')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '')
  s = stripElements(s, STRIP_ELEMENTS)

  // Apple-archive code samples: <div class="codesample"><table>...<tr><td><pre>line</pre></td></tr>...
  // Concatenate every <pre> cell into a single fenced code block.
  s = s.replace(/<div[^>]+class=["'][^"']*codesample[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi, (_m, inner) => {
    const cellLines = []
    inner.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
      cellLines.push(decodeEntities(stripInlineTags(code)))
      return ''
    })
    if (cellLines.length === 0) return ''
    return `\n\n@@FENCE\n${cellLines.join('\n')}\n@@/FENCE\n\n`
  })

  // Strip legacy named anchors (no href, only `name`/`title`) — they were used
  // for cross-doc links in the old archive format and add only noise now.
  s = s.replace(/<a\s[^>]*\bname\s*=\s*["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')

  // Standalone <pre> blocks → fenced code (after codesample handling above).
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(stripInlineTags(inner))
    return `\n\n@@FENCE\n${code.replace(/^\n+|\n+$/g, '')}\n@@/FENCE\n\n`
  })

  // Inline <code>X</code>
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const text = decodeEntities(stripInlineTags(inner)).replace(/`/g, "'")
    return text ? `\`${text}\`` : ''
  })

  // <a href="X">Y</a> — markdown link.
  s = s.replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => {
    const text = decodeEntities(stripInlineTags(txt)).trim()
    if (!text) return ''
    let resolved = href
    if (linkResolver) {
      const result = linkResolver(href)
      if (result === null) return text
      if (typeof result === 'string') resolved = result
    }
    return `[${text}](${resolved})`
  })

  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
    const text = decodeEntities(stripInlineTags(inner))
    return text ? `**${text}**` : ''
  })
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => {
    const text = decodeEntities(stripInlineTags(inner))
    return text ? `*${text}*` : ''
  })

  // Lists — process before <dl> so list items nested inside <dd> survive.
  s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, inner) => listToMarkdown(inner, false))
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner) => listToMarkdown(inner, true))

  // Definition lists (<dl><dt>term</dt><dd>def</dd>) — render as paragraphs
  // with bold terms. Apple archive uses these heavily for protocol descriptions
  // and additionally uses <h5> as the term inside <dl class="termdef">.
  // Run BEFORE the h3-h6 transform so the dl handler can see embedded headings.
  s = s.replace(/<dl[^>]*>([\s\S]*?)<\/dl>/gi, (_m, inner) => {
    const termRe = /<(dt|h[3-6])[^>]*>([\s\S]*?)<\/\1>/gi
    const ddRe = /<dd[^>]*>([\s\S]*?)<\/dd>/gi
    const terms = []
    const defs = []
    for (const m of inner.matchAll(termRe)) {
      const text = decodeEntities(stripInlineTags(m[2])).trim()
      if (text) terms.push(text)
    }
    for (const m of inner.matchAll(ddRe)) {
      const text = stripInlineTags(m[1]).trim()
      if (text) defs.push(text)
    }
    const out = []
    const len = Math.max(terms.length, defs.length)
    for (let i = 0; i < len; i++) {
      const t = terms[i]
      const d = defs[i]
      if (t && d) out.push(`**${t}** — ${decodeEntities(d)}`)
      else if (t) out.push(`**${t}**`)
      else if (d) out.push(decodeEntities(d))
    }
    return out.length ? `\n\n${out.join('\n\n')}\n\n` : ''
  })

  // Sub-headings inside the section body. h1 + h2 are extracted by the section
  // splitter upstream; render h3-h6 as nested markdown headings.
  for (let level = 3; level <= 6; level++) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi')
    const prefix = '#'.repeat(level)
    s = s.replace(re, (_m, inner) => {
      const text = decodeEntities(stripInlineTags(inner)).trim()
      return text ? `\n\n${prefix} ${text}\n\n` : ''
    })
  }

  // Convert remaining block tags to paragraph breaks; collapse all other tags to a space.
  s = s.replace(/<(\/?)(\w+)[^>]*>/g, (_match, _slash, tag) => {
    const lower = tag.toLowerCase()
    return BLOCK_TAGS.has(lower) ? '\n\n' : ' '
  })

  s = decodeEntities(s)

  // Stash fenced code content in opaque sentinels so whitespace normalization
  // below cannot collapse leading indentation inside code blocks.
  const fences = []
  s = s.replace(/@@FENCE\n([\s\S]*?)\n@@\/FENCE/g, (_m, code) => {
    fences.push(code)
    return `@@FENCE_SLOT_${fences.length - 1}@@`
  })

  // Whitespace normalization: collapse runs of spaces/tabs *within* prose lines,
  // trim trailing whitespace, collapse 3+ blank lines to 2.
  const lines = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // Restore fenced code blocks last, preserving their original indentation.
  s = s.replace(/@@FENCE_SLOT_(\d+)@@/g, (_m, idx) => {
    const code = fences[Number(idx)] ?? ''
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`
  })

  return s.trim()
}

function stripInlineTags(s) {
  return s.replace(/<[^>]+>/g, '')
}

function listToMarkdown(inner, ordered) {
  const items = []
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let n = 1
  for (const m of inner.matchAll(liRe)) {
    const text = decodeEntities(stripInlineTags(m[1])).replace(/\s+/g, ' ').trim()
    if (text) {
      items.push(ordered ? `${n}. ${text}` : `- ${text}`)
      n++
    }
  }
  return items.length ? `\n\n${items.join('\n')}\n\n` : ''
}
