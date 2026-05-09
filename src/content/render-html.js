// Top-level HTML renderer dispatch. Walks the canonical document/sections
// shape produced by content/normalize.js and delegates each section to
// the matching per-kind renderer in render-html/sections.js.
//
// Phase B decomposition:
//   - render-html/helpers.js   — escapeHtml, slugify, isSafeHref,
//                                resolveReferenceUrl, readableNameFromKey,
//                                skipDuplicateHeading, coerceDocument/Section.
//   - render-html/markdown.js  — markdownToHtml, inlineMarkdown.
//   - render-html/nodes.js     — DocC content-node → HTML walker (block + inline).
//   - render-html/tokens.js    — declaration / type token rendering.
//   - render-html/sections.js  — every renderXxxHtml: abstract, declaration,
//                                parameters, properties, rest-*, possible-values,
//                                mentioned-in, discussion, link sections.
//
// Tests in test/unit/render-html.test.js exercise the public surface
// (renderHtml + slugify) so the decomposition is invisible to callers.

import { coerceDocument, escapeHtml, slugify } from './render-html/helpers.js'
import {
  renderAbstractHtml,
  renderDeclarationHtml,
  renderDiscussionHtml,
  renderLinkSectionHtml,
  renderMentionedInHtml,
  renderParametersHtml,
  renderPossibleValuesHtml,
  renderPropertiesHtml,
  renderRestEndpointHtml,
  renderRestParametersHtml,
  renderRestResponsesHtml,
} from './render-html/sections.js'
import { coerceSection } from './render-html/helpers.js'

export { slugify }

const LINK_SECTION_TITLES = {
  topics: 'Topics',
  relationships: 'Relationships',
  see_also: 'See Also',
}

export function renderHtml(document, sections = [], opts = {}) {
  const doc = coerceDocument(document)
  const orderedSections = sections
    .map(coerceSection)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const parts = []

  if (doc.title) {
    parts.push(`<h1>${escapeHtml(doc.title)}</h1>`)
  }

  for (const section of orderedSections) {
    const rendered = renderSectionHtml(section, opts)
    if (rendered) parts.push(rendered)
  }

  return parts.join('\n').trim()
}

function renderSectionHtml(section, opts = {}) {
  switch (section.sectionKind) {
    case 'abstract':
      return renderAbstractHtml(section)
    case 'declaration':
      return renderDeclarationHtml(section, opts)
    case 'parameters':
      return renderParametersHtml(section)
    case 'properties':
      return renderPropertiesHtml(section, opts)
    case 'rest_endpoint':
      return renderRestEndpointHtml(section)
    case 'rest_parameters':
      return renderRestParametersHtml(section, opts)
    case 'rest_responses':
      return renderRestResponsesHtml(section, opts)
    case 'possible_values':
      return renderPossibleValuesHtml(section)
    case 'mentioned_in':
      return renderMentionedInHtml(section)
    case 'discussion':
      return renderDiscussionHtml(section)
    case 'topics':
    case 'relationships':
    case 'see_also':
      return renderLinkSectionHtml(LINK_SECTION_TITLES[section.sectionKind] ?? section.heading ?? 'Related', section)
    default:
      return renderDiscussionHtml(section) || ''
  }
}
