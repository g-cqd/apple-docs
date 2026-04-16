import { describe, expect, test } from 'bun:test'
import { paginateDocumentPayload } from '../../src/mcp/pagination.js'

describe('paginateDocumentPayload — single-page pageInfo', () => {
  test('reports real totalSections/pageSections when payload fits in one page', () => {
    const payload = {
      metadata: { title: 'View', key: 'swiftui/view' },
      sections: [
        { sectionKind: 'abstract', contentText: 'Abstract.' },
        { sectionKind: 'declaration', contentText: 'protocol View' },
        { sectionKind: 'discussion', contentText: 'Short discussion.' },
      ],
    }

    const result = paginateDocumentPayload(payload, { maxChars: 100_000 })

    expect(result.pageInfo).toBeDefined()
    expect(result.pageInfo.page).toBe(1)
    expect(result.pageInfo.totalPages).toBe(1)
    expect(result.pageInfo.totalSections).toBe(3)
    expect(result.pageInfo.pageSections).toBe(3)
    expect(result.pageInfo.hasNextPage).toBe(false)
    expect(result.pageInfo.hasPreviousPage).toBe(false)
  })

  test('reports zero sections when payload has none', () => {
    const payload = { metadata: { title: 'Empty' }, sections: [] }
    const result = paginateDocumentPayload(payload, { maxChars: 100_000 })
    expect(result.pageInfo.totalSections).toBe(0)
    expect(result.pageInfo.pageSections).toBe(0)
  })
})
