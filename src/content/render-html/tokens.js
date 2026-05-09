// Declaration / type-token rendering. Walks the DocC `tokens` array
// (semantic kind + text + optional `_resolvedKey` for type linking) and
// emits HTML with semantic CSS classes and per-type anchor links.
//
// Pulled out of content/render-html.js as part of Phase B.

import { escapeHtml } from './helpers.js'

const SEMANTIC_TOKEN_KINDS = new Set([
  'keyword', 'attribute', 'typeIdentifier', 'identifier',
  'genericParameter', 'externalParam', 'internalParam', 'number',
])

/** Join token texts, inserting spaces between adjacent semantic tokens that lack whitespace separators. */
export function joinTokenTexts(tokens) {
  let result = ''
  let prevWasSemantic = false
  let prevText = ''
  for (const t of tokens) {
    const text = t.text ?? ''
    if (!text) continue
    const isSemantic = SEMANTIC_TOKEN_KINDS.has(t.kind ?? 'text')
    if (isSemantic && prevWasSemantic && !prevText.endsWith('@')) result += ' '
    prevWasSemantic = isSemantic
    prevText = text
    result += text
  }
  return result
}

/**
 * Render declaration tokens with semantic CSS classes and type links.
 * Used when tokens have resolved type references for interactive navigation.
 */
export function renderDeclarationTokens(tokens, knownKeys) {
  const spans = []
  let prevWasSemantic = false
  let prevTokenText = ''

  for (const token of tokens) {
    const text = escapeHtml(token.text ?? '')
    if (!text) continue
    const kind = token.kind ?? 'text'
    const isSemantic = SEMANTIC_TOKEN_KINDS.has(kind)

    // Insert a space when two semantic tokens are adjacent with no whitespace
    // between them, but not after @ (attribute prefix like @MainActor).
    if (isSemantic && prevWasSemantic && !prevTokenText.endsWith('@')) {
      spans.push(' ')
    }
    prevWasSemantic = isSemantic
    prevTokenText = token.text ?? ''

    // Link resolved types to their documentation pages
    if (token._resolvedKey && (kind === 'typeIdentifier' || kind === 'attribute')) {
      if (knownKeys.has(token._resolvedKey)) {
        spans.push(`<a href="/docs/${escapeHtml(token._resolvedKey)}/" class="code-type-link"><span class="decl-${kind}">${text}</span></a>`)
        continue
      }
    }

    switch (kind) {
      case 'keyword':
      case 'attribute':
        spans.push(`<span class="decl-keyword">${text}</span>`); break
      case 'typeIdentifier':
        spans.push(`<span class="decl-type">${text}</span>`); break
      case 'identifier':
        spans.push(`<span class="decl-identifier">${text}</span>`); break
      case 'genericParameter':
        spans.push(`<span class="decl-generic">${text}</span>`); break
      case 'externalParam':
      case 'internalParam':
        spans.push(`<span class="decl-param">${text}</span>`); break
      case 'number':
        spans.push(`<span class="decl-number">${text}</span>`); break
      default:
        spans.push(text)
    }
  }
  return `<pre class="decl-tokens"><code>${spans.join('')}</code></pre>`
}

/** Render type tokens (from properties, restParams, restResponses) with links. */
export function renderTypeTokens(tokens, knownKeys) {
  if (!Array.isArray(tokens) || tokens.length === 0) return ''
  return tokens.map(token => {
    const text = escapeHtml(token.text ?? '')
    if (!text) return ''
    if (token.kind === 'typeIdentifier' && token._resolvedKey) {
      if (!knownKeys || knownKeys.has(token._resolvedKey)) {
        return `<a href="/docs/${escapeHtml(token._resolvedKey)}/" class="code-type-link"><code>${text}</code></a>`
      }
    }
    if (token.kind === 'typeIdentifier') {
      return `<code>${text}</code>`
    }
    return text
  }).join('')
}
