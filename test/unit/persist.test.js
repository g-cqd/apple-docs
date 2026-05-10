import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNormalizedDocument } from '../../src/content/hydrate.js'
import { persistFetchedDocPage } from '../../src/pipeline/persist.js'
import { DocsDatabase } from '../../src/storage/database.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

let db
let tmpDir

beforeEach(() => {
  tmpDir = join(tmpdir(), `apple-docs-persist-${crypto.randomUUID()}`)
  mkdirSync(join(tmpDir, 'raw-json'), { recursive: true })
  mkdirSync(join(tmpDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('persistFetchedDocPage', () => {
  test('writes legacy page state, markdown, and normalized sections together', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

    await persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
      etag: '"abc"',
      lastModified: 'Mon, 01 Jan 2026 00:00:00 GMT',
    })

    const page = db.getPage('swiftui/view')
    expect(page.title).toBe('View')
    expect(db.getDocumentSections('swiftui/view').length).toBeGreaterThan(3)

    const markdown = await Bun.file(join(tmpDir, 'markdown', 'swiftui', 'view.md')).text()
    expect(markdown).toContain('# View')
    expect(markdown).toContain('## Declaration')
  })

  test('coalesces concurrent calls for the same path onto one promise (Audit 5 §4.5)', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const args = {
      db, dataDir: tmpDir, rootId: root.id,
      path: 'swiftui/view', sourceType: 'apple-docc', json: fixture,
    }

    // Spawn three concurrent calls with identical args. Coalescing means
    // they share one in-flight promise — the same returned object is
    // shared across all three callers, and only one DB upsert + file
    // promote runs.
    const [a, b, c] = await Promise.all([
      persistFetchedDocPage(args),
      persistFetchedDocPage(args),
      persistFetchedDocPage(args),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)

    // After the in-flight promise settles, a fresh call must run a new
    // persist (different result identity).
    const d = await persistFetchedDocPage(args)
    expect(d).not.toBe(a)
  })
})

describe('ensureNormalizedDocument', () => {
  test('hydrates normalized sections from stored raw JSON for legacy corpora', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

    db.upsertPage({
      rootId: root.id,
      path: 'swiftui/view',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      title: 'View',
      role: 'symbol',
      roleHeading: 'Protocol',
      sourceType: 'apple-docc',
      skipDocumentSync: false,
    })

    await Bun.write(join(tmpDir, 'raw-json', 'swiftui', 'view.json'), JSON.stringify(fixture))

    expect(db.getDocumentSections('swiftui/view').length).toBe(0)

    const hydrated = await ensureNormalizedDocument(db, tmpDir, 'swiftui/view', 'apple-docc')
    expect(hydrated).toBe(true)
    expect(db.getDocumentSections('swiftui/view').length).toBeGreaterThan(3)
  })
})
