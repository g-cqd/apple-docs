import { describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'

describe('tombstone counter on resurrection', () => {
  test('a successful re-persist resets the consecutive 404 streak', () => {
    const db = new DocsDatabase(':memory:')
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const root = db.getRootBySlug('swiftui')
    const page = { rootId: root.id, path: 'swiftui/view', url: 'https://x/y', sourceType: 'apple-docc' }

    db.upsertPage(page)
    db.bumpConsecutive404(page.path)
    db.bumpConsecutive404(page.path)
    db.bumpConsecutive404(page.path)
    db.markPageDeleted(page.path)

    const dead = db.db.query('SELECT status, consecutive_404_count FROM pages WHERE path = ?').get(page.path)
    expect(dead.status).toBe('deleted')
    expect(dead.consecutive_404_count).toBe(3)

    // Page comes back upstream: the upsert must reset the streak, or the
    // next transient 404 would instantly re-delete it (4 >= threshold).
    db.upsertPage(page)

    const alive = db.db.query('SELECT status, consecutive_404_count FROM pages WHERE path = ?').get(page.path)
    expect(alive.status).toBe('active')
    expect(alive.consecutive_404_count).toBe(0)
    db.close()
  })
})
