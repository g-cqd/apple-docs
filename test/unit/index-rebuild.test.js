import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rebuildBody, rebuildTrigram } from '../../src/commands/index-rebuild.js'
import { DocsDatabase } from '../../src/storage/database.js'
import { createMockLogger } from '../helpers/mocks.js'

let dataDir
let db
let logger
let ctx

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-index-rebuild-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  logger = createMockLogger()
  ctx = { db, dataDir, logger }

  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app UI.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app UI.', sortOrder: 0 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'Build your interface by composing views.', sortOrder: 1 },
    ],
    relationships: [],
  })
})

afterEach(() => {
  try { db.close() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
})

describe('index rebuild commands', () => {
  test('rebuildTrigram recreates the trigram index from document titles', async () => {
    db.db.run('DROP TABLE documents_trigram')
    db.db.run('DROP TRIGGER IF EXISTS documents_ai')
    db.db.run('DROP TRIGGER IF EXISTS documents_ad')
    db.db.run('DROP TRIGGER IF EXISTS documents_au')

    const result = await rebuildTrigram({}, ctx)

    expect(result.status).toBe('ok')
    expect(result.indexed).toBe(1)
    expect(db.hasTable('documents_trigram')).toBe(true)
    expect(db.searchTrigram('View')).toHaveLength(1)
  })

  test('rebuildBody recreates the body index from document sections', async () => {
    db.db.run('DROP TABLE documents_body_fts')
    db._prepareStatements()

    const result = await rebuildBody({}, ctx)

    expect(result.indexed).toBe(1)
    expect(db.hasTable('documents_body_fts')).toBe(true)
    expect(db.getBodyIndexCount()).toBe(1)
  })

  test('rebuildBody fails clearly when document_sections are unavailable', async () => {
    db.db.run('DROP TABLE document_sections')
    db._prepareStatements()

    const result = await rebuildBody({}, ctx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('document_sections table not available')
  })
})
