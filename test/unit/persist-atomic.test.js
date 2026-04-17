import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistFetchedDocPage } from '../../src/pipeline/persist.js'
import { DocsDatabase } from '../../src/storage/database.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

let db
let tmpDir

beforeEach(() => {
  tmpDir = join(tmpdir(), `apple-docs-persist-atomic-${crypto.randomUUID()}`)
  mkdirSync(join(tmpDir, 'raw-json'), { recursive: true })
  mkdirSync(join(tmpDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('persist atomic behavior', () => {
  test('does not write files or commit DB rows when rendering fails before persistence', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

    await expect(persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
      renderPageFn() {
        throw new Error('render failed')
      },
    })).rejects.toThrow('render failed')

    expect(existsSync(join(tmpDir, 'raw-json', 'swiftui', 'view.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'markdown', 'swiftui', 'view.md'))).toBe(false)
    expect(db.getPage('swiftui/view')).toBeNull()
    expect(db.getDocumentSections('swiftui/view')).toHaveLength(0)
  })

  test('rolls back staged files when the database transaction fails', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const originalUpsertNormalizedDocument = db.upsertNormalizedDocument.bind(db)
    db.upsertNormalizedDocument = () => {
      throw new Error('db failed')
    }

    await expect(persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
    })).rejects.toThrow('db failed')

    db.upsertNormalizedDocument = originalUpsertNormalizedDocument

    expect(existsSync(join(tmpDir, 'raw-json', 'swiftui', 'view.json'))).toBe(false)
    expect(existsSync(join(tmpDir, 'markdown', 'swiftui', 'view.md'))).toBe(false)
    expect(db.getPage('swiftui/view')).toBeNull()
    expect(db.getDocumentSections('swiftui/view')).toHaveLength(0)
  })

  test('restores previous files when the database transaction fails during an update', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const rawFile = join(tmpDir, 'raw-json', 'swiftui', 'view.json')
    const markdownFile = join(tmpDir, 'markdown', 'swiftui', 'view.md')
    mkdirSync(join(tmpDir, 'raw-json', 'swiftui'), { recursive: true })
    mkdirSync(join(tmpDir, 'markdown', 'swiftui'), { recursive: true })
    writeFileSync(rawFile, '{"previous":true}')
    writeFileSync(markdownFile, '# Previous')

    const originalUpsertNormalizedDocument = db.upsertNormalizedDocument.bind(db)
    db.upsertNormalizedDocument = () => {
      throw new Error('db failed')
    }

    await expect(persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
    })).rejects.toThrow('db failed')

    db.upsertNormalizedDocument = originalUpsertNormalizedDocument

    expect(readFileSync(rawFile, 'utf8')).toBe('{"previous":true}')
    expect(readFileSync(markdownFile, 'utf8')).toBe('# Previous')
    expect(db.getPage('swiftui/view')).toBeNull()
  })
})
