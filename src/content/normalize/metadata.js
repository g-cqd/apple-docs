// Metadata extraction helpers for the DocC normalizer:
//   - resolveKind / resolveLanguage / resolveDeclarationText / resolvePlatforms
//   - findSection / extractFirstHeading / collectHeadings
//   - enrichDeclarationTokens / enrichTypeTokens (token → typed-link
//     decoration via the references map).

import { normalizeIdentifier } from '../../apple/normalizer.js'
import { renderInlineNodes } from './render-content.js'
import { resolveRefKey } from './refs.js'

const identity = (v) => v

/** Determine doc kind from symbolKind or role. */
export function resolveKind(json) {
  const meta = json?.metadata ?? {}
  if (meta.symbolKind) return meta.symbolKind

  const roleMap = {
    symbol: 'symbol',
    article: 'article',
    collectionGroup: 'collection',
    collection: 'collection',
    overview: 'overview',
    sampleCode: 'sampleCode',
    framework: 'framework',
    class: 'class',
    struct: 'struct',
    enum: 'enum',
    protocol: 'protocol',
    typealias: 'typealias',
    func: 'func',
    var: 'var',
    init: 'init',
  }
  return roleMap[meta.role] ?? meta.role ?? null
}

/**
 * Enrich declaration tokens with resolved keys for type linking.
 *
 * For each `typeIdentifier` or `attribute` token, resolve its `identifier`
 * (doc:// URL) via the references map, or fall back to matching the token
 * text against reference titles. Stores resolved path as `_resolvedKey`.
 */
export function enrichDeclarationTokens(declarations, refs, mapKey = identity) {
  if (!Array.isArray(declarations) || declarations.length === 0) return declarations

  // Build a title → canonical key lookup from references
  const titleToKey = new Map()
  if (refs && typeof refs === 'object') {
    for (const [id, ref] of Object.entries(refs)) {
      if (!id.startsWith('doc://')) continue
      if (!ref?.url) continue
      const key = normalizeIdentifier(ref.url)
      if (!key || !ref.title) continue
      // Only map type-like entries (not methods with parentheses)
      if (ref.title.includes('(')) continue
      titleToKey.set(ref.title, mapKey(key))
    }
  }

  return declarations.map(decl => {
    const tokens = decl?.tokens
    if (!Array.isArray(tokens)) return decl

    const enrichedTokens = tokens.map(token => {
      if (token.kind !== 'typeIdentifier' && token.kind !== 'attribute') return token

      // 1. Direct identifier resolution (doc:// URL on the token)
      if (token.identifier) {
        const key = mapKey(resolveRefKey(token.identifier, refs))
        if (key) return { ...token, _resolvedKey: key }
      }

      // 2. Title-based resolution from references map
      if (token.text && titleToKey.has(token.text)) {
        return { ...token, _resolvedKey: titleToKey.get(token.text) }
      }

      return token
    })

    return { ...decl, tokens: enrichedTokens }
  })
}

/**
 * Enrich type tokens (from properties, restParameters, restResponses)
 * with resolved keys for linking, similar to declaration tokens.
 */
export function enrichTypeTokens(tokens, refs, mapKey = identity) {
  if (!Array.isArray(tokens) || tokens.length === 0) return tokens
  return tokens.map(token => {
    if (token.kind !== 'typeIdentifier') return token
    if (token.identifier) {
      const key = mapKey(resolveRefKey(token.identifier, refs))
      if (key) return { ...token, _resolvedKey: key }
    }
    return token
  })
}

/** Detect the primary language from module name or declaration tokens. */
export function resolveLanguage(json) {
  // Scan explicit declaration languages first — they are the most precise signal
  for (const section of json?.primaryContentSections ?? []) {
    if (section.kind !== 'declarations') continue
    for (const decl of section.declarations ?? []) {
      const langs = decl.languages ?? []
      if (langs.includes('swift')) return 'swift'
      if (langs.includes('occ')) return 'occ'
    }
  }

  // Fall back to module name presence — Apple frameworks default to Swift
  const moduleName = json?.metadata?.modules?.[0]?.name
  if (moduleName) return 'swift'

  return null
}

/** Concatenate all declaration token texts from the first declarations section. */
export function resolveDeclarationText(json) {
  for (const section of json?.primaryContentSections ?? []) {
    if (section.kind !== 'declarations') continue
    const decl = section.declarations?.[0]
    if (decl?.tokens) {
      return decl.tokens.map(t => t.text ?? '').join('') || null
    }
  }
  return null
}

/**
 * Build a flat { ios, macos, watchos, tvos, visionos } map from metadata.platforms.
 * Keys are lowercase platform name slugs; values are the introducedAt version string.
 */
export function resolvePlatforms(meta) {
  const map = {}
  const nameToKey = {
    iOS: 'ios',
    macOS: 'macos',
    watchOS: 'watchos',
    tvOS: 'tvos',
    visionOS: 'visionos',
    'Mac Catalyst': 'maccatalyst',
    macCatalyst: 'maccatalyst',
    iPadOS: 'ipados',
  }
  for (const p of meta?.platforms ?? []) {
    if (!p.introducedAt) continue
    const slug = nameToKey[p.name] ?? p.name?.toLowerCase() ?? null
    if (slug) map[slug] = p.introducedAt
  }
  return map
}

/** Find the first section with a matching kind in an array of sections. */
export function findSection(sections, kind) {
  if (!Array.isArray(sections)) return null
  return sections.find(s => s.kind === kind) ?? null
}

/** Extract the text of the first heading node from a content nodes array. */
export function extractFirstHeading(nodes, refs) {
  if (!Array.isArray(nodes)) return null
  for (const node of nodes) {
    if (node.type === 'heading') {
      return node.text ?? renderInlineNodes(node.inlineContent ?? [], refs) ?? null
    }
  }
  return null
}

/**
 * Collect all heading texts from all 'content' primary sections, space-joined,
 * for use as an FTS hint field.
 */
export function collectHeadings(json, refs) {
  const texts = []
  for (const section of json?.primaryContentSections ?? []) {
    if (section.kind !== 'content') continue
    for (const node of section.content ?? []) {
      if (node.type === 'heading') {
        const text = node.text ?? renderInlineNodes(node.inlineContent ?? [], refs)
        if (text) texts.push(text)
      }
    }
  }
  return texts.length > 0 ? texts.join(' ') : null
}
