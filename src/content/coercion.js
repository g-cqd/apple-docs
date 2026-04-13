export function coerceDocument(document, { includeKey = false } = {}) {
  const result = {
    title: document?.title ?? null,
  }
  if (includeKey) {
    result.key = document?.key ?? document?.path ?? null
    result.abstractText = document?.abstractText ?? document?.abstract_text ?? null
    result.declarationText = document?.declarationText ?? document?.declaration_text ?? null
    result.headings = document?.headings ?? null
  }
  return result
}

export function coerceSection(section, { includeContentJson = false } = {}) {
  const result = {
    sectionKind: section?.sectionKind ?? section?.section_kind ?? null,
    heading: section?.heading ?? null,
    contentText: section?.contentText ?? section?.content_text ?? '',
    sortOrder: section?.sortOrder ?? section?.sort_order ?? 0,
  }
  if (includeContentJson) {
    result.contentJson = section?.contentJson ?? section?.content_json ?? null
  }
  return result
}
