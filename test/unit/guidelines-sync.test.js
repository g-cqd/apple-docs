import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyGuidelinesSnapshot } from '../../src/pipeline/sync-guidelines.js'
import { DocsDatabase } from '../../src/storage/database.js'

let db
let tmpDir

beforeEach(() => {
  tmpDir = join(tmpdir(), `apple-docs-guidelines-${crypto.randomUUID()}`)
  mkdirSync(join(tmpDir, 'raw-json'), { recursive: true })
  mkdirSync(join(tmpDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('applyGuidelinesSnapshot', () => {
  test('marks removed sections deleted and removes normalized documents', async () => {
    await applyGuidelinesSnapshot(db, tmpDir, {
      html: '<html>v1</html>',
      etag: '"v1"',
      sections: [
        {
          id: 's1',
          path: 'app-store-review/1.0',
          title: '1.0 - Intro',
          abstract: 'Intro abstract',
          markdown: 'Intro body',
          role: 'collection',
          roleHeading: 'Section',
          notarization: false,
          children: ['app-store-review/1.1'],
        },
        {
          id: 's2',
          path: 'app-store-review/1.1',
          title: '1.1 - Details',
          abstract: 'Details abstract',
          markdown: 'Details body',
          role: 'article',
          roleHeading: 'Guideline',
          notarization: false,
          children: [],
        },
      ],
      lastUpdated: '2026-04-13',
    })

    expect(db.getPage('app-store-review/1.1')).not.toBeNull()
    expect(db.getDocumentSections('app-store-review/1.1').length).toBeGreaterThan(0)

    await applyGuidelinesSnapshot(db, tmpDir, {
      html: '<html>v2</html>',
      etag: '"v2"',
      sections: [
        {
          id: 's1',
          path: 'app-store-review/1.0',
          title: '1.0 - Intro',
          abstract: 'Intro abstract updated',
          markdown: 'Intro body updated',
          role: 'collection',
          roleHeading: 'Section',
          notarization: false,
          children: [],
        },
      ],
      lastUpdated: '2026-04-14',
    })

    const deletedPage = db.db.query('SELECT status FROM pages WHERE path = ?').get('app-store-review/1.1')
    expect(deletedPage.status).toBe('deleted')
    expect(db.getPage('app-store-review/1.1')).toBeNull()
    expect(db.getDocumentSections('app-store-review/1.1')).toEqual([])
  })
})
