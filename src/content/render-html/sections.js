// Per-section HTML renderers. Each function consumes a single
// (sectionKind, contentJson, contentText) tuple and emits the matching
// <section>…</section> markup. The dispatcher in render-html.js routes
// each section through here based on its sectionKind.
//
// Pulled out of content/render-html.js as part of Phase B.

import { highlightCode } from '../highlight.js'
import { safeJson } from '../safe-json.js'
import { escapeHtml, skipDuplicateHeading, slugify } from './helpers.js'
import { markdownToHtml } from './markdown.js'
import { renderContentNodesToHtml, renderInlineNodesToHtml } from './nodes.js'
import { joinTokenTexts, renderDeclarationTokens, renderTypeTokens } from './tokens.js'

/**
 * Defensive cap on `markdownToHtml` input size: above this, render the raw
 * source in a `<pre><code>` block instead. The home-grown parser is O(n)
 * per line in normal cases but historically had a wedge on certain pages
 * (since fixed at the ATX-heading regex). The cap stays as belt-and-braces.
 */
export const MARKDOWN_MAX_BYTES = Math.max(
  512,
  Number.parseInt(process.env.APPLE_DOCS_MD_MAX_BYTES ?? '', 10) || 256 * 1024,
)

export function renderAbstractHtml(section) {
  const nodes = safeJson(section.contentJson)
  if (Array.isArray(nodes) && nodes.length > 0) {
    return `<p>${renderInlineNodesToHtml(nodes)}</p>`
  }
  const text = section.contentText?.trim() ?? ''
  if (!text) return ''
  // HTML-source abstracts (swift-org articles, apple-archive) capture the
  // entire intro before the first <h2>, which may contain multiple paragraphs,
  // markdown emphasis, inline code, and links. Route through markdownToHtml
  // so those render as structured HTML instead of one escaped blob.
  return text.length > MARKDOWN_MAX_BYTES
    ? `<p>${escapeHtml(text)}</p>`
    : markdownToHtml(text)
}

export function renderDeclarationHtml(section, opts = {}) {
  const declarations = safeJson(section.contentJson)
  const blocks = Array.isArray(declarations) ? declarations : []
  const knownKeys = opts.knownKeys

  // Detect available language variants
  const langSet = new Set()
  for (const decl of blocks) {
    for (const lang of decl?.languages ?? []) langSet.add(lang)
  }
  const hasMultipleLangs = langSet.size > 1

  const snippets = blocks
    .map(declaration => {
      const tokens = declaration?.tokens ?? []
      if (tokens.length === 0) return null
      const hasTypeLinks = knownKeys && tokens.some(t =>
        t._resolvedKey && (t.kind === 'typeIdentifier' || t.kind === 'attribute'))
      let html
      if (hasTypeLinks) {
        html = renderDeclarationTokens(tokens, knownKeys)
      } else {
        // Fall back to Shiki for declarations without type link data
        const code = joinTokenTexts(tokens).trim()
        const language = declaration?.languages?.[0] ?? 'swift'
        if (!code) return null
        const highlighted = highlightCode(code, language)
        html = highlighted ?? `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code)}</code></pre>`
      }
      // Wrap in a language variant container when multiple languages exist
      if (hasMultipleLangs && declaration?.languages?.length) {
        const lang = declaration.languages[0]
        return `<div class="decl-variant" data-lang="${escapeHtml(lang)}">${html}</div>`
      }
      return html
    })
    .filter(Boolean)

  if (snippets.length === 0 && section.contentText?.trim()) {
    const highlighted = highlightCode(section.contentText.trim(), 'swift')
    snippets.push(highlighted ?? `<pre><code class="language-swift">${escapeHtml(section.contentText.trim())}</code></pre>`)
  }

  if (snippets.length === 0) return ''

  const langAttr = hasMultipleLangs ? ` data-languages="${[...langSet].map(escapeHtml).join(',')}"` : ''
  return `<section id="declaration"${langAttr}><h2>Declaration</h2>${snippets.join('')}</section>`
}

export function renderParametersHtml(section) {
  const parameters = safeJson(section.contentJson)
  const items = Array.isArray(parameters)
    ? parameters.map(parameter => {
      const html = renderContentNodesToHtml(parameter?.content ?? [])
      return `<li><strong>${escapeHtml(parameter?.name ?? 'Value')}</strong>: ${html}</li>`
    })
    : section.contentText?.trim()
      ? section.contentText.trim().split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`)
      : []

  if (items.length === 0) return ''
  return `<section id="parameters"><h2>Parameters</h2><ul>${items.join('')}</ul></section>`
}

export function renderPropertiesHtml(section, opts = {}) {
  const items = safeJson(section.contentJson)
  if (!Array.isArray(items) || items.length === 0) return ''
  const knownKeys = opts.knownKeys
  const heading = section.heading ?? 'Properties'
  const sectionId = slugify(heading)
  const rows = items.map(item => {
    const name = escapeHtml(item.name ?? '')
    const typeHtml = renderTypeTokens(item.type ?? [], knownKeys)
    const desc = renderContentNodesToHtml(item.content ?? [])
    const requiredBadge = item.required ? ' <span class="badge badge-required">Required</span>' : ''
    return `<tr><td><code>${name}</code>${requiredBadge}</td><td>${typeHtml}</td><td>${desc}</td></tr>`
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><table class="properties-table"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`
}

export function renderRestEndpointHtml(section) {
  const tokens = safeJson(section.contentJson)
  if (!Array.isArray(tokens) || tokens.length === 0) return ''
  const heading = section.heading ?? 'URL'
  const sectionId = slugify(heading)
  const spans = tokens.map(token => {
    const text = escapeHtml(token.text ?? '')
    switch (token.kind) {
      case 'method': return `<span class="rest-method">${text}</span>`
      case 'baseURL': return `<span class="rest-base-url">${text}</span>`
      case 'path': return `<span class="rest-path">${text}</span>`
      case 'parameter': return `<span class="rest-param">${text}</span>`
      default: return text
    }
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><pre class="rest-endpoint"><code>${spans.join('')}</code></pre></section>`
}

export function renderRestParametersHtml(section, opts = {}) {
  const items = safeJson(section.contentJson)
  if (!Array.isArray(items) || items.length === 0) return ''
  const knownKeys = opts.knownKeys
  const heading = section.heading ?? 'Parameters'
  const sectionId = slugify(heading)
  const rows = items.map(item => {
    const name = escapeHtml(item.name ?? '')
    const typeHtml = renderTypeTokens(item.type ?? [], knownKeys)
    const desc = renderContentNodesToHtml(item.content ?? [])
    const requiredBadge = item.required
      ? '<span class="badge badge-required">Required</span>'
      : '<span class="badge badge-optional">Optional</span>'
    return `<tr><td><code>${name}</code> ${requiredBadge}</td><td>${typeHtml}</td><td>${desc}</td></tr>`
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><table class="params-table"><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`
}

export function renderRestResponsesHtml(section, opts = {}) {
  const items = safeJson(section.contentJson)
  if (!Array.isArray(items) || items.length === 0) return ''
  const knownKeys = opts.knownKeys
  const heading = section.heading ?? 'Response Codes'
  const sectionId = slugify(heading)
  const rows = items.map(item => {
    const status = escapeHtml(String(item.status ?? ''))
    const reason = escapeHtml(item.reason ?? '')
    const mimeType = item.mimeType ? `<div class="rest-mime">Content-Type: ${escapeHtml(item.mimeType)}</div>` : ''
    const typeHtml = renderTypeTokens(item.type ?? [], knownKeys)
    const desc = renderContentNodesToHtml(item.content ?? [])
    return `<tr><td><strong>${status}</strong></td><td>${reason}${mimeType}</td><td>${typeHtml}</td><td>${desc}</td></tr>`
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><table class="responses-table"><thead><tr><th>Status</th><th>Reason</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>`
}

export function renderPossibleValuesHtml(section) {
  const values = safeJson(section.contentJson)
  if (!Array.isArray(values) || values.length === 0) return ''
  const heading = section.heading ?? 'Possible Values'
  const sectionId = slugify(heading)
  const items = values.map(v => {
    const name = escapeHtml(v.name ?? '')
    const desc = renderContentNodesToHtml(v.content ?? [])
    return `<dt><code>${name}</code></dt><dd>${desc}</dd>`
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><dl class="possible-values">${items.join('')}</dl></section>`
}

export function renderMentionedInHtml(section) {
  const items = safeJson(section.contentJson)
  if (!Array.isArray(items) || items.length === 0) return ''
  const heading = section.heading ?? 'Mentioned in'
  const sectionId = slugify(heading)
  const listItems = items.map(item => {
    if (item.key) {
      return `<li><a href="/docs/${escapeHtml(item.key)}/">${escapeHtml(item.title ?? item.key)}</a></li>`
    }
    return `<li>${escapeHtml(item.title ?? item.identifier ?? '')}</li>`
  })
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2><ul>${listItems.join('')}</ul></section>`
}

export function renderDiscussionHtml(section) {
  const heading = section.heading ?? 'Overview'
  const sectionId = slugify(heading)
  const nodes = safeJson(section.contentJson)

  if (Array.isArray(nodes) && nodes.length > 0) {
    // Skip the first heading node if it duplicates the section heading
    const filtered = skipDuplicateHeading(nodes, heading)
    const body = renderContentNodesToHtml(filtered)
    if (!body.trim()) return ''
    return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2>${body}</section>`
  }

  // Fallback: render markdown/plain text content as HTML — but only when
  // the content is small enough to be safe under markdownToHtml. Above
  // MARKDOWN_MAX_BYTES we emit a plain pre/code block instead of risking
  // the parser wedging on the page.
  const text = section.contentText?.trim() ?? ''
  if (!text) return ''
  const body = text.length > MARKDOWN_MAX_BYTES
    ? `<pre class="markdown-fallback"><code>${escapeHtml(text)}</code></pre>`
    : markdownToHtml(text)
  return `<section id="${sectionId}"><h2>${escapeHtml(heading)}</h2>${body}</section>`
}

export function renderLinkSectionHtml(title, section) {
  const sectionId = slugify(title)
  const groups = safeJson(section.contentJson)
  const body = []

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        body.push(`<h3>${escapeHtml(group.title)}</h3>`)
      }
      const items = (group?.items ?? [])
        .map(item => {
          const filterAttr = item?._resolvedRoleHeading
            ? ` data-filter-kind="${escapeHtml(item._resolvedRoleHeading)}"`
            : ''
          return item?.key
            ? `<li${filterAttr}><a href="/docs/${escapeHtml(item.key)}/"><code>${escapeHtml(item.title ?? item.key)}</code></a></li>`
            : `<li>${escapeHtml(item?.title ?? item?.identifier ?? '')}</li>`
        })
        .join('')
      if (items) {
        body.push(`<ul>${items}</ul>`)
      }
    }
  } else if (section.contentText?.trim()) {
    const items = section.contentText.trim().split('\n').filter(Boolean).map(line => `<li>${escapeHtml(line)}</li>`).join('')
    body.push(`<ul>${items}</ul>`)
  }

  if (body.length === 0) return ''
  return `<section id="${sectionId}"><h2>${escapeHtml(title)}</h2>${body.join('')}</section>`
}
