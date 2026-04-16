import { normalizeIdentifier } from '../apple/normalizer.js'

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Apple DocC (or guidelines) payload into a canonical document
 * model suitable for database insertion and search indexing.
 *
 * @param {object} rawPayload - Raw JSON/object payload as fetched or parsed.
 * @param {string} key        - Canonical path key, e.g. 'swiftui/view'.
 * @param {string} sourceType - One of: 'apple-docc', 'hig', 'guidelines'.
 * @returns {{ document: object, sections: object[], relationships: object[] }}
 */
export function normalize(rawPayload, key, sourceType) {
  if (sourceType === 'guidelines') {
    return normalizeGuidelines(rawPayload, key)
  }
  // 'apple-docc' and 'hig' share the same DocC JSON format
  return normalizeDocC(rawPayload, key, sourceType)
}

// ---------------------------------------------------------------------------
// Apple DocC normalizer ('apple-docc' | 'hig')
// ---------------------------------------------------------------------------

function normalizeDocC(json, key, sourceType) {
  const meta = json?.metadata ?? {}
  const refs = json?.references ?? {}

  // ── Document ──────────────────────────────────────────────────────────────

  const title = meta.title ?? null
  const role = meta.role ?? null
  const roleHeading = meta.roleHeading ?? null
  const framework = key ? key.split('/')[0] : null

  const kind = resolveKind(json)

  const url = key
    ? ((sourceType === 'hig' || key.startsWith('design/'))
      ? `https://developer.apple.com/${key}`
      : `https://developer.apple.com/documentation/${key}`)
    : null

  // Language: prefer module name, fall back to scanning declaration languages
  const language = resolveLanguage(json)

  const abstractText = json?.abstract ? renderInlineNodes(json.abstract, refs) : null

  // Declaration text: first declarations section, all token texts joined
  const declarationText = resolveDeclarationText(json)

  // Platforms
  const platformsObj = resolvePlatforms(meta)
  const platformsJson = Object.keys(platformsObj).length > 0
    ? JSON.stringify(platformsObj)
    : null

  const minIos = platformsObj.ios ?? null
  const minMacos = platformsObj.macos ?? null
  const minWatchos = platformsObj.watchos ?? null
  const minTvos = platformsObj.tvos ?? null
  const minVisionos = platformsObj.visionos ?? null

  const isDeprecated = meta.deprecated === true
  const isBeta = meta.beta === true
  const isReleaseNotes = Boolean(
    (key?.includes('release-notes')) || role === 'releaseNotes'
  )
  const urlDepth = key ? key.split('/').length - 1 : 0

  // Collect headings from all content sections for FTS
  const headings = collectHeadings(json, refs)

  const document = {
    sourceType,
    key,
    title,
    kind,
    role,
    roleHeading,
    framework,
    url,
    language,
    abstractText,
    declarationText,
    platformsJson,
    minIos,
    minMacos,
    minWatchos,
    minTvos,
    minVisionos,
    isDeprecated,
    isBeta,
    isReleaseNotes,
    urlDepth,
    headings,
    sourceMetadata: null,
  }

  // ── Sections ─────────────────────────────────────────────────────────────

  const sections = []
  let order = 0

  // 1. Abstract (sortOrder 0)
  if (json?.abstract && Array.isArray(json.abstract) && json.abstract.length > 0) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: renderInlineNodes(json.abstract, refs),
      contentJson: JSON.stringify(json.abstract),
      sortOrder: order++,
    })
  } else {
    order++ // keep slot 0 even when absent so declaration is always slot 1
  }

  // 2. Declaration (sortOrder 1)
  const declarationSection = findSection(json?.primaryContentSections, 'declarations')
  if (declarationSection) {
    const enrichedDeclarations = enrichDeclarationTokens(declarationSection.declarations ?? [], refs)
    const tokens = enrichedDeclarations[0]?.tokens ?? []
    sections.push({
      sectionKind: 'declaration',
      heading: 'Declaration',
      contentText: tokens.map(t => t.text ?? '').join('') || null,
      contentJson: JSON.stringify(enrichedDeclarations),
      sortOrder: order++,
    })
  } else {
    order++
  }

  // 3. Parameters (sortOrder 2)
  const parametersSection = findSection(json?.primaryContentSections, 'parameters')
  if (parametersSection?.parameters?.length) {
    const contentText = parametersSection.parameters
      .map(p => {
        const desc = p.content ? renderContentNodesToText(p.content, refs) : ''
        return `${p.name ?? ''}: ${desc}`.trim()
      })
      .join('\n') || null
    sections.push({
      sectionKind: 'parameters',
      heading: 'Parameters',
      contentText,
      contentJson: JSON.stringify(parametersSection.parameters),
      sortOrder: order++,
    })
  } else {
    order++
  }

  // 4. Discussion / content (sortOrder 3+, one per 'content' section)
  for (const section of json?.primaryContentSections ?? []) {
    if (section.kind !== 'content') continue
    const nodes = section.content ?? []
    const heading = extractFirstHeading(nodes, refs) ?? 'Overview'
    sections.push({
      sectionKind: 'discussion',
      heading,
      contentText: renderContentNodesToText(nodes, refs) || null,
      contentJson: JSON.stringify(resolveContentReferences(nodes, refs)),
      sortOrder: order++,
    })
  }

  // 5. Topics
  if (json?.topicSections?.length) {
    const contentText = renderLinkSectionsToText(json.topicSections, refs)
    sections.push({
      sectionKind: 'topics',
      heading: 'Topics',
      contentText,
      contentJson: JSON.stringify(normalizeLinkSections(json.topicSections, refs)),
      sortOrder: order++,
    })
  }

  // 6. Relationships
  if (json?.relationshipsSections?.length) {
    const contentText = renderLinkSectionsToText(json.relationshipsSections, refs)
    sections.push({
      sectionKind: 'relationships',
      heading: 'Relationships',
      contentText,
      contentJson: JSON.stringify(normalizeLinkSections(json.relationshipsSections, refs)),
      sortOrder: order++,
    })
  }

  // 7. See Also
  if (json?.seeAlsoSections?.length) {
    const contentText = renderLinkSectionsToText(json.seeAlsoSections, refs)
    sections.push({
      sectionKind: 'see_also',
      heading: 'See Also',
      contentText,
      contentJson: JSON.stringify(normalizeLinkSections(json.seeAlsoSections, refs)),
      sortOrder: order++,
    })
  }

  // ── Relationships ─────────────────────────────────────────────────────────

  const relationships = []
  let relOrder = 0

  // Topics → 'child' relations
  for (const section of json?.topicSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const toKey = resolveRefKey(id, refs)
      if (toKey) {
        relationships.push({
          fromKey: key,
          toKey,
          relationType: 'child',
          section: section.title ?? null,
          sortOrder: relOrder++,
        })
      }
    }
  }

  // Relationships sections
  const relationTypeMap = {
    inheritsFrom: 'inherits_from',
    conformsTo: 'conforms_to',
    inheritedBy: 'inherited_by',
  }
  for (const section of json?.relationshipsSections ?? []) {
    const relationType = relationTypeMap[section.type] ?? section.type ?? 'related'
    for (const id of section.identifiers ?? []) {
      const toKey = resolveRefKey(id, refs)
      if (toKey) {
        relationships.push({
          fromKey: key,
          toKey,
          relationType,
          section: section.title ?? null,
          sortOrder: relOrder++,
        })
      }
    }
  }

  // See Also → 'see_also' relations
  for (const section of json?.seeAlsoSections ?? []) {
    for (const id of section.identifiers ?? []) {
      const toKey = resolveRefKey(id, refs)
      if (toKey) {
        relationships.push({
          fromKey: key,
          toKey,
          relationType: 'see_also',
          section: section.title ?? null,
          sortOrder: relOrder++,
        })
      }
    }
  }

  return { document, sections, relationships }
}

// ---------------------------------------------------------------------------
// Guidelines normalizer ('guidelines')
// ---------------------------------------------------------------------------

function normalizeGuidelines(payload, key) {
  // payload: { title, role, roleHeading, path, markdown, abstract, id, children: [childPath...] }
  const title = payload?.title ?? null
  const role = payload?.role ?? null
  const roleHeading = payload?.roleHeading ?? null
  const path = payload?.path ?? key ?? null

  const url = path
    ? `https://developer.apple.com/app-store/review/guidelines/#${payload?.id ?? ''}`
    : null

  const document = {
    sourceType: 'guidelines',
    key: key ?? path,
    title,
    kind: role ?? 'article',
    role,
    roleHeading,
    framework: 'app-store-review',
    url,
    language: null,
    abstractText: payload?.abstract ?? null,
    declarationText: null,
    platformsJson: null,
    minIos: null,
    minMacos: null,
    minWatchos: null,
    minTvos: null,
    minVisionos: null,
    isDeprecated: false,
    isBeta: false,
    isReleaseNotes: false,
    urlDepth: path ? path.split('/').length - 1 : 0,
    headings: null,
    sourceMetadata: null,
  }

  const sections = []
  let order = 0

  // Abstract section
  if (payload?.abstract) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: payload.abstract,
      contentJson: null,
      sortOrder: order++,
    })
  }

  // Content section (markdown body)
  if (payload?.markdown) {
    sections.push({
      sectionKind: 'discussion',
      heading: 'Overview',
      contentText: payload.markdown,
      contentJson: null,
      sortOrder: order++,
    })
  }

  // Relationships: children
  const relationships = []
  let relOrder = 0
  for (const childPath of payload?.children ?? []) {
    if (childPath) {
      relationships.push({
        fromKey: key ?? path,
        toKey: childPath,
        relationType: 'child',
        section: 'Topics',
        sortOrder: relOrder++,
      })
    }
  }

  return { document, sections, relationships }
}

// ---------------------------------------------------------------------------
// DocC helpers
// ---------------------------------------------------------------------------

/**
 * Determine doc kind from symbolKind or role.
 */
function resolveKind(json) {
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
function enrichDeclarationTokens(declarations, refs) {
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
      titleToKey.set(ref.title, key)
    }
  }

  return declarations.map(decl => {
    const tokens = decl?.tokens
    if (!Array.isArray(tokens)) return decl

    const enrichedTokens = tokens.map(token => {
      if (token.kind !== 'typeIdentifier' && token.kind !== 'attribute') return token

      // 1. Direct identifier resolution (doc:// URL on the token)
      if (token.identifier) {
        const key = resolveRefKey(token.identifier, refs)
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
 * Detect the primary language from module name or declaration tokens.
 */
function resolveLanguage(json) {
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

/**
 * Concatenate all declaration token texts from the first declarations section.
 */
function resolveDeclarationText(json) {
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
function resolvePlatforms(meta) {
  const map = {}
  const nameToKey = {
    iOS: 'ios',
    macOS: 'macos',
    watchOS: 'watchos',
    tvOS: 'tvos',
    visionOS: 'visionos',
    'Mac Catalyst': 'maccatalyst',
    macCatalyst: 'maccatalyst',
    'iPadOS': 'ipados',
  }
  for (const p of meta?.platforms ?? []) {
    if (!p.introducedAt) continue
    const slug = nameToKey[p.name] ?? p.name?.toLowerCase() ?? null
    if (slug) map[slug] = p.introducedAt
  }
  return map
}

/**
 * Find the first section with a matching kind in an array of sections.
 */
function findSection(sections, kind) {
  if (!Array.isArray(sections)) return null
  return sections.find(s => s.kind === kind) ?? null
}

/**
 * Extract the text of the first heading node from a content nodes array.
 */
function extractFirstHeading(nodes, refs) {
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
function collectHeadings(json, refs) {
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

/**
 * Render an array of link-section objects (topicSections / seeAlsoSections)
 * to a plain-text string: section title, then referenced doc titles, newline-separated.
 */
function renderLinkSectionsToText(sections, refs) {
  const lines = []
  for (const section of sections ?? []) {
    if (section.title) lines.push(section.title)
    for (const id of section.identifiers ?? []) {
      const ref = refs?.[id]
      const title = ref?.title ?? normalizeIdentifier(id) ?? id
      if (title) lines.push(title)
    }
  }
  return lines.join('\n') || null
}

function normalizeLinkSections(sections, refs) {
  return (sections ?? []).map(section => ({
    title: section.title ?? null,
    type: section.type ?? null,
    items: (section.identifiers ?? []).map(id => {
      const ref = refs?.[id]
      return {
        identifier: id,
        key: resolveRefKey(id, refs),
        title: ref?.title ?? normalizeIdentifier(id) ?? id,
      }
    }),
  }))
}

/**
 * Resolve a DocC identifier to its canonical key via the references map,
 * then via normalizeIdentifier directly.
 */
function resolveRefKey(id, refs) {
  const ref = refs?.[id]
  if (ref?.url) {
    const norm = normalizeIdentifier(ref.url)
    if (norm) return norm
  }
  return normalizeIdentifier(id)
}

// ---------------------------------------------------------------------------
// resolveContentReferences — embed titles and keys into content nodes
// ---------------------------------------------------------------------------

/**
 * Deep-clone content nodes and resolve all reference identifiers to include
 * human-readable titles and canonical keys for HTML rendering.
 */
function resolveContentReferences(nodes, refs) {
  if (!Array.isArray(nodes)) return nodes
  return nodes.map(node => resolveNodeRefs(node, refs))
}

function resolveNodeRefs(node, refs) {
  if (!node || typeof node !== 'object') return node

  // Reference inline node — embed title and key
  if (node.type === 'reference') {
    const ref = refs?.[node.identifier]
    const key = resolveRefKey(node.identifier, refs)
    const title = ref?.title ?? node.title ?? null
    return { ...node, _resolvedTitle: title, _resolvedKey: key }
  }

  // Links block node — resolve each item identifier
  if (node.type === 'links' && Array.isArray(node.items)) {
    const resolvedItems = node.items.map(id => {
      const ref = refs?.[id]
      const key = resolveRefKey(id, refs)
      const title = ref?.title ?? null
      return { identifier: id, _resolvedTitle: title, _resolvedKey: key }
    })
    return { ...node, items: resolvedItems }
  }

  // Recurse into child content
  const clone = { ...node }
  if (Array.isArray(clone.inlineContent)) {
    clone.inlineContent = clone.inlineContent.map(child => resolveNodeRefs(child, refs))
  }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map(child => resolveNodeRefs(child, refs))
  }
  if (Array.isArray(clone.items)) {
    clone.items = clone.items.map(item => {
      if (item?.content) return { ...item, content: item.content.map(child => resolveNodeRefs(child, refs)) }
      return item
    })
  }
  // Term list items
  if (node.type === 'termList' && Array.isArray(clone.items)) {
    clone.items = clone.items.map(item => {
      const resolved = { ...item }
      if (resolved.term?.inlineContent) {
        resolved.term = { ...resolved.term, inlineContent: resolved.term.inlineContent.map(child => resolveNodeRefs(child, refs)) }
      }
      if (resolved.definition?.content) {
        resolved.definition = { ...resolved.definition, content: resolved.definition.content.map(child => resolveNodeRefs(child, refs)) }
      }
      return resolved
    })
  }
  return clone
}

// ---------------------------------------------------------------------------
// renderContentNodesToText
// ---------------------------------------------------------------------------

/**
 * Recursively render an array of DocC block/inline content nodes to plain text.
 *
 * @param {object[]} nodes - DocC content node array (block or inline).
 * @param {object}   refs  - The `references` map from the DocC JSON payload.
 * @returns {string}
 */
export function renderContentNodesToText(nodes, refs) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(node => renderNode(node, refs)).join('')
}

function renderNode(node, refs) {
  if (!node || typeof node !== 'object') return ''

  switch (node.type) {
    case 'paragraph':
      return `${renderInlineNodes(node.inlineContent ?? [], refs)}\n`

    case 'heading': {
      const text = node.text ?? renderInlineNodes(node.inlineContent ?? [], refs)
      return `${text ?? ''}\n`
    }

    case 'codeListing':
      return `${(node.code ?? []).join('\n')}\n`

    case 'unorderedList':
    case 'orderedList':
      return (node.items ?? [])
        .map(item => renderContentNodesToText(item.content ?? [], refs))
        .join('')

    case 'aside': {
      const style = node.style ?? 'Note'
      const inner = renderContentNodesToText(node.content ?? [], refs).trim()
      return `${style}: ${inner}\n`
    }

    case 'table': {
      const rows = node.rows ?? []
      return `${rows
        .map(row => {
          const cells = Array.isArray(row) ? row : (row.cells ?? [])
          return cells
            .map(cell => renderContentNodesToText(cell.content ?? [], refs).trim())
            .join(' | ')
        })
        .join('\n')}\n`
    }

    case 'links':
      return `${(node.items ?? [])
        .map(id => {
          const ref = refs?.[id]
          return ref?.title ?? normalizeIdentifier(id) ?? id
        })
        .join('\n')}\n`

    // Inline types that may appear at block level
    case 'text':
      return node.text ?? ''

    case 'codeVoice':
      return node.code ?? ''

    case 'emphasis':
    case 'strong':
    case 'newTerm':
    case 'inlineHead':
    case 'superscript':
    case 'subscript':
    case 'strikethrough':
      return renderInlineNodes(node.inlineContent ?? [], refs)

    case 'reference': {
      const ref = refs?.[node.identifier]
      return ref?.title ?? node.title ?? node.identifier ?? ''
    }

    case 'link':
      return node.title ?? node.destination ?? ''

    default:
      // Best-effort: try text, code, then recurse into inlineContent / content
      if (node.text) return node.text
      if (node.code) return String(node.code)
      if (Array.isArray(node.inlineContent)) {
        return renderInlineNodes(node.inlineContent, refs)
      }
      if (Array.isArray(node.content)) {
        return renderContentNodesToText(node.content, refs)
      }
      return ''
  }
}

/**
 * Render an array of inline nodes to plain text.
 * Mirrors the logic in extractor.js but also handles reference lookups.
 */
function renderInlineNodes(nodes, refs) {
  if (!Array.isArray(nodes)) return ''
  return nodes.map(node => {
    switch (node.type) {
      case 'text': return node.text ?? ''
      case 'codeVoice': return node.code ?? ''
      case 'emphasis':
      case 'strong':
      case 'newTerm':
      case 'inlineHead':
      case 'superscript':
      case 'subscript':
      case 'strikethrough':
        return renderInlineNodes(node.inlineContent ?? [], refs)
      case 'reference': {
        const ref = refs?.[node.identifier]
        return ref?.title ?? node.title ?? node.identifier ?? ''
      }
      case 'link': return node.title ?? node.destination ?? ''
      default: return node.text ?? node.code ?? ''
    }
  }).join('')
}
