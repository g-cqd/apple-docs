function coerceDocument(document) {
  return {
    key: document?.key ?? document?.path ?? null,
    title: document?.title ?? null,
    abstractText: document?.abstractText ?? document?.abstract_text ?? null,
    declarationText: document?.declarationText ?? document?.declaration_text ?? null,
    headings: document?.headings ?? null,
  }
}

function coerceSection(section) {
  return {
    sectionKind: section?.sectionKind ?? section?.section_kind ?? null,
    heading: section?.heading ?? null,
    contentText: section?.contentText ?? section?.content_text ?? '',
    sortOrder: section?.sortOrder ?? section?.sort_order ?? 0,
  }
}

export function renderPlainText(document, sections = []) {
  const doc = coerceDocument(document)
  const orderedSections = sections
    .map(coerceSection)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const parts = [
    doc.title,
    doc.abstractText,
    doc.declarationText,
    doc.headings,
    ...orderedSections.map(section => {
      const body = [section.heading, section.contentText].filter(Boolean).join('\n')
      return body.trim() || null
    }),
  ].filter(Boolean)

  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}
