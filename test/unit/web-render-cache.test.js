import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { createWebRenderCache } from '../../src/web/render-cache.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

  const now = new Date().toISOString()
  for (const doc of [
    {
      key: 'documentation/swiftui',
      title: 'SwiftUI Overview',
      kind: 'collection',
      role: 'collection',
      roleHeading: 'Framework',
    },
    {
      key: 'documentation/swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
    },
    {
      key: 'documentation/swiftui/text',
      title: 'Text',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Structure',
    },
  ]) {
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, role, role_heading, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', ?, ?, ?, ?, ?, 'swiftui', '', ?, ?)`,
      [doc.key, doc.title, doc.kind, doc.role, doc.roleHeading, now, now]
    )
  }
})

afterEach(() => {
  db.close()
})

describe('createWebRenderCache', () => {
  test('reuses ancestor title and role heading lookups', () => {
    const cache = createWebRenderCache(db)

    const ancestorTitles = cache.getAncestorTitles('documentation/swiftui/view')
    const roleHeadings = cache.getRoleHeadings([
      'documentation/swiftui/view',
      'documentation/swiftui/text',
      'documentation/swiftui/missing',
    ])

    expect(cache.getKnownKeys().has('documentation/swiftui/view')).toBe(true)
    expect(ancestorTitles.get('documentation/swiftui')).toBe('SwiftUI Overview')
    expect(roleHeadings.get('documentation/swiftui/view')).toBe('Protocol')
    expect(roleHeadings.get('documentation/swiftui/text')).toBe('Structure')
    expect(roleHeadings.has('documentation/swiftui/missing')).toBe(false)
  })

  test('invalidate refreshes stale corpus-derived lookups', () => {
    const cache = createWebRenderCache(db)

    expect(cache.getKnownKeys().has('documentation/swiftui/color')).toBe(false)
    expect(cache.getAncestorTitles('documentation/swiftui/view').get('documentation/swiftui')).toBe('SwiftUI Overview')
    expect(cache.getRoleHeadings(['documentation/swiftui/view']).get('documentation/swiftui/view')).toBe('Protocol')

    db.db.run(`UPDATE documents SET title = 'SwiftUI Docs' WHERE key = 'documentation/swiftui'`)
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, role, role_heading, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/swiftui/color', 'Color', 'symbol', 'symbol', 'Enumeration', 'swiftui', '', ?, ?)`,
      [new Date().toISOString(), new Date().toISOString()]
    )

    expect(cache.getKnownKeys().has('documentation/swiftui/color')).toBe(false)
    expect(cache.getAncestorTitles('documentation/swiftui/view').get('documentation/swiftui')).toBe('SwiftUI Overview')
    expect(cache.getRoleHeadings(['documentation/swiftui/color']).has('documentation/swiftui/color')).toBe(false)

    cache.invalidate()

    expect(cache.getKnownKeys().has('documentation/swiftui/color')).toBe(true)
    expect(cache.getAncestorTitles('documentation/swiftui/view').get('documentation/swiftui')).toBe('SwiftUI Docs')
    expect(cache.getRoleHeadings(['documentation/swiftui/color']).get('documentation/swiftui/color')).toBe('Enumeration')
  })
})
