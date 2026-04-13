import { coerceDocument as _coerceDocument, coerceSection as _coerceSection } from './coercion.js'

const coerceDocument = (document) => _coerceDocument(document, { includeKey: true })
const coerceSection = (section) => _coerceSection(section)

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
