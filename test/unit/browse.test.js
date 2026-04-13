import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { browse } from '../../src/commands/browse.js'
import { DocsDatabase } from '../../src/storage/database.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('browse', () => {
  test('uses normalized relationships for page children', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: 'swiftui/view',
        title: 'View',
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Protocol',
        framework: 'swiftui',
      },
      sections: [],
      relationships: [
        {
          fromKey: 'swiftui/view',
          toKey: 'swiftui/text',
          relationType: 'child',
          section: 'Topics',
          sortOrder: 0,
        },
      ],
    })
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: 'swiftui/text',
        title: 'Text',
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Structure',
        framework: 'swiftui',
      },
      sections: [],
      relationships: [],
    })

    const result = await browse({ framework: 'swiftui', path: 'swiftui/view' }, { db })
    expect(result.children).toEqual([
      {
        path: 'swiftui/text',
        title: 'Text',
        section: 'Topics',
      },
    ])
  })
})
