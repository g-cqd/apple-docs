import { describe, expect, test } from 'bun:test'
import { indexBodyFull, indexBodyIncremental } from '../../../src/pipeline/index-body.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeDb(docCount = 3) {
  const db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  for (let i = 0; i < docCount; i++) {
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: `swiftui/thing-${i}`,
        title: `Thing ${i}`,
        kind: 'symbol',
        role: 'symbol',
      },
      sections: [
        { sectionKind: 'discussion', heading: null, contentText: `Body content for thing ${i}.`, sortOrder: 0 },
      ],
      relationships: [],
    })
  }
  return db
}

const bodyCount = (db) => db.db.query('SELECT COUNT(*) AS c FROM documents_body_fts').get().c

describe('body index state machine', () => {
  test('an incremental run resumes an interrupted full rebuild', async () => {
    const db = makeDb(3)
    // Simulate an interrupted `--full`: the FTS was cleared up front and a
    // full-rebuild checkpoint is on disk, but only one doc was indexed.
    db.setSyncCheckpoint('body-index:full', {
      since: null, total: 3, indexed: 0, errors: 0, lastDocumentId: 0,
    })
    db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [new Date().toISOString()])

    const result = await indexBodyIncremental(db, '/tmp/apple-docs-bodyidx-test', noopLogger)

    // Without the resume, the incremental path would have compared
    // updated_at against a fresh stamp and indexed nothing.
    expect(result.indexed).toBe(3)
    expect(bodyCount(db)).toBe(3)
    expect(db.getSyncCheckpoint('body-index:full')).toBeNull()
    db.close()
  })

  test('body_indexed_at is stamped with the scan start time', async () => {
    const db = makeDb(2)
    const before = new Date().toISOString()
    await indexBodyFull(db, '/tmp/apple-docs-bodyidx-test', noopLogger)
    const after = new Date().toISOString()

    const stamp = db.db.query("SELECT value FROM schema_meta WHERE key = 'body_indexed_at'").get().value
    expect(stamp >= before).toBe(true)
    expect(stamp <= after).toBe(true)
    db.close()
  })

  test('a changed document whose body renders empty drops its stale FTS row', async () => {
    const db = makeDb(1)
    await indexBodyFull(db, '/tmp/apple-docs-bodyidx-test', noopLogger)
    expect(bodyCount(db)).toBe(1)

    // The document changes to render an empty body: blank out the indexed
    // text fields and its section content, then bump updated_at past the
    // last index stamp.
    const id = db.db.query('SELECT id FROM documents WHERE key = ?').get('swiftui/thing-0').id
    db.db.run("UPDATE documents SET title = '', abstract_text = NULL, declaration_text = NULL, headings = NULL WHERE id = ?", [id])
    db.db.run("UPDATE document_sections SET content_text = '' WHERE document_id = ?", [id])
    // ISO format to match the upsert's timestamps (body_indexed_at compares
    // lexicographically against updated_at).
    db.db.run('UPDATE documents SET updated_at = ? WHERE id = ?', [new Date(Date.now() + 3_600_000).toISOString(), id])

    const result = await indexBodyIncremental(db, '/tmp/apple-docs-bodyidx-test', noopLogger)

    expect(result.indexed).toBe(0)
    expect(bodyCount(db)).toBe(0)
    db.close()
  })
})
