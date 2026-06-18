// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// Breadcrumbs and the matching `BreadcrumbList` JSON-LD shape.
//
// Extracted from src/web/templates.js so the parent stays under the
// 400-line file-size ceiling. The two helpers share the same segmenting
// logic on purpose: the visual nav and the structured-data declaration
// must always agree on the chain.

import { safeWebDocKey } from '../../lib/safe-path.js'
import { html } from '../lib/html.js'

/**
 * Render the breadcrumb nav for a doc / framework key.
 *
 * @param {string} key  slash-separated doc/framework key (e.g. `swiftui/view`).
 * @param {object} [opts]
 * @param {string} [opts.title]                     label for the final segment
 * @param {string} [opts.framework]                 label for the framework root
 * @param {Map<string, string>} [opts.ancestorTitles]  partial-key → display label
 * @param {Set<string>} [opts.knownKeys]            corpus keys that actually resolve
 * @returns {import('../lib/html.js').HtmlString}
 */
export function buildBreadcrumbs(key, opts = {}) {
  if (!key || typeof key !== 'string') return html``
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return html``

  // Use the document title for the last segment instead of the raw path.
  const lastLabel = opts.title ?? segments[segments.length - 1]
  if (segments.length === 1) {
    return html`<nav class="breadcrumbs" aria-label="Breadcrumb"><span>${lastLabel}</span></nav>`
  }

  // Ancestor title lookup (maps partial key path -> display title).
  const ancestorTitles = opts.ancestorTitles ?? new Map()
  // Set of corpus keys that actually resolve to a rendered page. Intermediate
  // path segments are common in non-DocC sources (swift-book/LanguageGuide/X,
  // apple-archive/documentation/AppleApplications/Conceptual/...) where the
  // joining segments are filesystem directories with no corresponding page.
  // Linking those produces 404s; render them as plain text instead.
  const knownKeys = opts.knownKeys ?? null

  const parts = []
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1
    const partialKey = segments.slice(0, i + 1).join('/')

    let label
    if (isLast) {
      label = lastLabel
    } else if (i === 0 && opts.framework) {
      // First segment is the framework slug — use the display name.
      label = opts.framework
    } else if (ancestorTitles.has(partialKey)) {
      label = ancestorTitles.get(partialKey)
    } else {
      label = segments[i]
    }

    // The root segment (`/docs/<framework>/`) always resolves: it's served
    // either by a stored doc page or by renderFrameworkPage at the
    // framework slug. Don't gate it through knownKeys.
    const isFrameworkRoot = i === 0
    if (isLast) {
      parts.push(html`<span aria-current="page">${label}</span>`)
    } else if (knownKeys && !isFrameworkRoot && !knownKeys.has(partialKey)) {
      // Intermediate hop has no corresponding page — keep the label visible
      // for context but don't dangle a 404 link off it.
      parts.push(html`<span>${label}</span>`)
    } else {
      const href = `/docs/${safeWebDocKey(partialKey)}/`
      parts.push(html`<a href="${href}">${label}</a>`)
    }
  }

  // Interleave with the breadcrumb separator span, matching the
  // historical `parts.join('<span class="breadcrumb-sep">…</span>')`.
  const sep = html`<span class="breadcrumb-sep" aria-hidden="true"> / </span>`
  const interleaved = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) interleaved.push(sep)
    interleaved.push(parts[i])
  }
  return html`<nav class="breadcrumbs" aria-label="Breadcrumb">${interleaved}</nav>`
}

/**
 * Build a `BreadcrumbList` schema.org object suitable for embedding under
 * the `breadcrumb` key of a parent JSON-LD entity (TechArticle,
 * APIReference, etc.). Mirrors the structure of `buildBreadcrumbs` so
 * the visual nav and the structured-data declaration always agree on
 * the chain.
 *
 * Returns null when no key is provided (caller should `?` the spread)
 * or when the key produces no segments. The terminal segment is
 * intentionally emitted WITHOUT an `item` URL — that's the current
 * page and Google's BreadcrumbList docs explicitly recommend omitting
 * it.
 *
 * @param {string} key  slash-separated doc/framework key
 * @param {string} baseUrl  absolute site base URL (no trailing slash)
 * @param {object} [opts]
 * @param {string} [opts.title]            display label for the final segment
 * @param {string} [opts.framework]        display label for the framework root segment
 * @param {Map<string, string>} [opts.ancestorTitles]  partial-key → display label
 * @returns {object | null}
 */
export function buildBreadcrumbListJsonLd(key, baseUrl, opts = {}) {
  if (!key || typeof key !== 'string') return null
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return null
  const cleanBase = (baseUrl ?? '').replace(/\/+$/, '')
  const lastLabel = opts.title ?? segments[segments.length - 1]
  const ancestorTitles = opts.ancestorTitles ?? new Map()
  const items = []
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1
    const partialKey = segments.slice(0, i + 1).join('/')
    let name
    if (isLast) {
      name = lastLabel
    } else if (i === 0 && opts.framework) {
      name = opts.framework
    } else if (ancestorTitles.has(partialKey)) {
      name = ancestorTitles.get(partialKey)
    } else {
      name = segments[i]
    }
    const entry = {
      '@type': 'ListItem',
      position: i + 1,
      name,
    }
    if (!isLast) {
      entry.item = `${cleanBase}/docs/${safeWebDocKey(partialKey)}/`
    }
    items.push(entry)
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items,
  }
}
