// Apple DocC normalizer (apple-docc | hig | swift-docc).
//
// Pulled out of content/normalize.js as part of Phase B.

import { normalizeIdentifier } from "../../apple/normalizer.js"
import {
  collectHeadings,
  enrichDeclarationTokens,
  enrichTypeTokens,
  extractFirstHeading,
  findSection,
  resolveDeclarationText,
  resolveKind,
  resolveLanguage,
  resolvePlatforms,
} from "./metadata.js"
import {
  normalizeLinkSections,
  renderLinkSectionsToText,
  resolveContentReferences,
  resolveRefKey,
} from "./refs.js"
import { renderContentNodesToText, renderInlineNodes } from "./render-content.js"
import { extractDocCRelationships } from "./relationships.js"

const identity = (v) => v

export function normalizeDocC(json, key, sourceType, opts = {}) {
  const meta = json?.metadata ?? {}
  const refs = json?.references ?? {}
  const mapKey = opts.keyMapper ?? identity

  // ── Document ──────────────────────────────────────────────────────────────

  const title = meta.title ?? null
  const role = meta.role ?? null
  const roleHeading = meta.roleHeading ?? null
  const framework = key ? key.split('/')[0] : null

  const kind = resolveKind(json)

  const url = opts.urlBuilder
    ? (opts.urlBuilder(key) ?? null)
    : (key
      ? ((sourceType === 'hig' || key.startsWith('design/'))
        ? `https://developer.apple.com/${key}`
        : `https://developer.apple.com/documentation/${key}`)
      : null)

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
    const enrichedDeclarations = enrichDeclarationTokens(declarationSection.declarations ?? [], refs, mapKey)
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

  // 4. Properties (sortOrder 3, for objects/structs with property definitions)
  const propertiesSection = findSection(json?.primaryContentSections, 'properties')
  if (propertiesSection?.items?.length) {
    const items = propertiesSection.items.map(item => ({
      name: item.name ?? null,
      type: enrichTypeTokens(item.type ?? [], refs, mapKey),
      content: resolveContentReferences(item.content ?? [], refs, mapKey),
      required: item.required ?? false,
      attributes: item.attributes ?? [],
      introducedVersion: item.introducedVersion ?? null,
    }))
    const contentText = items.map(p => {
      const desc = p.content ? renderContentNodesToText(p.content, refs) : ''
      return `${p.name ?? ''}: ${desc}`.trim()
    }).join('\n') || null
    sections.push({
      sectionKind: 'properties',
      heading: propertiesSection.title ?? 'Properties',
      contentText,
      contentJson: JSON.stringify(items),
      sortOrder: order++,
    })
  } else {
    order++
  }

  // 5. REST endpoints (URL, Sandbox URL)
  const restEndpointSections = (json?.primaryContentSections ?? []).filter(s => s.kind === 'restEndpoint')
  for (const endpoint of restEndpointSections) {
    const tokens = (endpoint.tokens ?? []).map(t => ({
      kind: t.kind ?? 'text',
      text: t.text ?? '',
    }))
    const contentText = tokens.map(t => t.text).join('')
    sections.push({
      sectionKind: 'rest_endpoint',
      heading: endpoint.title ?? 'URL',
      contentText: contentText || null,
      contentJson: JSON.stringify(tokens),
      sortOrder: order++,
    })
  }

  // 6. REST parameters (path parameters, query parameters)
  const restParamSections = (json?.primaryContentSections ?? []).filter(s => s.kind === 'restParameters')
  for (const paramSection of restParamSections) {
    const items = (paramSection.items ?? []).map(item => ({
      name: item.name ?? null,
      type: enrichTypeTokens(item.type ?? [], refs, mapKey),
      content: resolveContentReferences(item.content ?? [], refs, mapKey),
      required: item.required ?? false,
      source: paramSection.source ?? null,
      attributes: item.attributes ?? [],
    }))
    const contentText = items.map(p => {
      const desc = p.content ? renderContentNodesToText(p.content, refs) : ''
      return `${p.name ?? ''}: ${desc}`.trim()
    }).join('\n') || null
    sections.push({
      sectionKind: 'rest_parameters',
      heading: paramSection.title ?? 'Parameters',
      contentText,
      contentJson: JSON.stringify(items),
      sortOrder: order++,
    })
  }

  // 7. REST responses (status codes)
  const restResponsesSection = findSection(json?.primaryContentSections, 'restResponses')
  if (restResponsesSection?.items?.length) {
    const items = restResponsesSection.items.map(item => ({
      status: item.status ?? null,
      reason: item.reason ?? null,
      mimeType: item.mimeType ?? null,
      type: enrichTypeTokens(item.type ?? [], refs, mapKey),
      content: resolveContentReferences(item.content ?? [], refs, mapKey),
    }))
    const contentText = items.map(r =>
      `${r.status ?? ''} ${r.reason ?? ''}: ${r.content ? renderContentNodesToText(r.content, refs) : ''}`.trim()
    ).join('\n') || null
    sections.push({
      sectionKind: 'rest_responses',
      heading: restResponsesSection.title ?? 'Response Codes',
      contentText,
      contentJson: JSON.stringify(items),
      sortOrder: order++,
    })
  }

  // 8. Possible values (enums/options)
  const possibleValuesSection = findSection(json?.primaryContentSections, 'possibleValues')
  if (possibleValuesSection?.values?.length) {
    const values = possibleValuesSection.values.map(v => ({
      name: v.name ?? null,
      content: resolveContentReferences(v.content ?? [], refs, mapKey),
    }))
    const contentText = values.map(v => {
      const desc = v.content ? renderContentNodesToText(v.content, refs) : ''
      return `${v.name ?? ''}: ${desc}`.trim()
    }).join('\n') || null
    sections.push({
      sectionKind: 'possible_values',
      heading: possibleValuesSection.title ?? 'Possible Values',
      contentText,
      contentJson: JSON.stringify(values),
      sortOrder: order++,
    })
  }

  // 9. Mentions ("Mentioned in")
  const mentionsSection = findSection(json?.primaryContentSections, 'mentions')
  if (mentionsSection?.mentions?.length) {
    const items = mentionsSection.mentions.map(id => ({
      identifier: id,
      key: mapKey(resolveRefKey(id, refs)),
      title: refs?.[id]?.title ?? normalizeIdentifier(id) ?? id,
    }))
    const contentText = items.map(m => m.title).join('\n') || null
    sections.push({
      sectionKind: 'mentioned_in',
      heading: 'Mentioned in',
      contentText,
      contentJson: JSON.stringify(items),
      sortOrder: order++,
    })
  }

  // 10. Discussion / content (one per 'content' section)
  for (const section of json?.primaryContentSections ?? []) {
    if (section.kind !== 'content') continue
    const nodes = section.content ?? []
    const heading = extractFirstHeading(nodes, refs) ?? 'Overview'
    sections.push({
      sectionKind: 'discussion',
      heading,
      contentText: renderContentNodesToText(nodes, refs) || null,
      contentJson: JSON.stringify(resolveContentReferences(nodes, refs, mapKey)),
      sortOrder: order++,
    })
  }

  // 11. Fallback: capture any unknown primaryContentSections kinds
  const handledKinds = new Set(['declarations', 'parameters', 'content', 'properties', 'restEndpoint', 'restParameters', 'restResponses', 'possibleValues', 'mentions'])
  for (const section of json?.primaryContentSections ?? []) {
    if (handledKinds.has(section.kind)) continue
    // Best-effort: if it has content nodes, store as discussion
    const nodes = section.content ?? []
    if (nodes.length === 0) continue
    const heading = section.title ?? extractFirstHeading(nodes, refs) ?? section.kind ?? 'Section'
    sections.push({
      sectionKind: 'discussion',
      heading,
      contentText: renderContentNodesToText(nodes, refs) || null,
      contentJson: JSON.stringify(resolveContentReferences(nodes, refs, mapKey)),
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
      contentJson: JSON.stringify(normalizeLinkSections(json.topicSections, refs, mapKey)),
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
      contentJson: JSON.stringify(normalizeLinkSections(json.relationshipsSections, refs, mapKey)),
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
      contentJson: JSON.stringify(normalizeLinkSections(json.seeAlsoSections, refs, mapKey)),
      sortOrder: order++,
    })
  }

  const relationships = extractDocCRelationships(json, key, refs, mapKey)

  return { document, sections, relationships }
}
