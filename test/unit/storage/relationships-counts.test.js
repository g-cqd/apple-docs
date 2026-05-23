import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'
import { lookup } from '../../../src/commands/lookup.js'

let db
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  ctx = { db, dataDir: '/tmp/apple-docs-test-relationships', logger: console }

  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

  // Seed targets first so the join in getRelationshipCountsByType finds them.
  for (const key of ['swiftui/view-2', 'swiftui/protocol-a', 'swiftui/sibling', 'swiftui/child-1']) {
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key, title: key.split('/').pop(),
        kind: 'symbol', role: 'symbol', framework: 'swiftui',
      },
      sections: [], relationships: [],
    })
  }

  // Source doc with mixed-type relationships.
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/view', title: 'View',
      kind: 'symbol', role: 'symbol', roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app\'s user interface.',
    },
    sections: [],
    relationships: [
      { fromKey: 'swiftui/view', toKey: 'swiftui/view-2', relationType: 'inherits_from', sortOrder: 0 },
      { fromKey: 'swiftui/view', toKey: 'swiftui/protocol-a', relationType: 'conforms_to', sortOrder: 0 },
      { fromKey: 'swiftui/view', toKey: 'swiftui/sibling', relationType: 'see-also', sortOrder: 0 },
      { fromKey: 'swiftui/view', toKey: 'swiftui/child-1', relationType: 'child', sortOrder: 0 },
    ],
  })
})

afterEach(() => {
  if (db) db.close()
})

describe('getRelationshipCountsByType', () => {
  test('returns camelCase keys grouped by relation_type', () => {
    const counts = db.getRelationshipCountsByType('swiftui/view')
    expect(counts).toEqual({
      inheritsFrom: 1,
      conformsTo: 1,
      seeAlso: 1,
      children: 1,
    })
  })

  test('returns empty object for documents with no relationships', () => {
    expect(db.getRelationshipCountsByType('swiftui/sibling')).toEqual({})
  })

  test('returns empty object for missing key', () => {
    expect(db.getRelationshipCountsByType('not/a/doc')).toEqual({})
    expect(db.getRelationshipCountsByType('')).toEqual({})
    expect(db.getRelationshipCountsByType(null)).toEqual({})
  })
})

describe('lookup() surfaces relationships in metadata', () => {
  test('metadata.relationships present when doc has relationships', async () => {
    const out = await lookup({ path: 'swiftui/view' }, ctx)
    expect(out.found).toBe(true)
    expect(out.metadata.relationships).toEqual({
      inheritsFrom: 1, conformsTo: 1, seeAlso: 1, children: 1,
    })
  })

  test('metadata.relationships omitted when doc has none', async () => {
    const out = await lookup({ path: 'swiftui/sibling' }, ctx)
    expect(out.found).toBe(true)
    expect(out.metadata.relationships).toBeUndefined()
  })
})
