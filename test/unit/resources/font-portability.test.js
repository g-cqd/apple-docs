// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enforceFontPortability } from '../../../src/resources/apple-fonts/portability.js'
import { DocsDatabase } from '../../../src/storage/database.js'

let db
let dataDir

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-fontport-'))
  for (const id of ['sf-pro', 'sf-mono']) {
    db.upsertAppleFontFamily({ id, displayName: id, status: 'available' })
  }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function seedFile({ id, familyId, filePath }) {
  db.upsertAppleFontFile({
    id,
    familyId,
    fileName: filePath.split('/').pop(),
    filePath,
    source: filePath.startsWith(dataDir) ? 'remote' : 'system',
    italic: false,
    isVariable: false,
    axes: [],
    size: 10,
  })
}

describe('enforceFontPortability', () => {
  test('purges rows outside dataDir and keeps in-corpus rows', () => {
    const insideDir = join(dataDir, 'resources', 'fonts', 'extracted', 'sf-pro')
    mkdirSync(insideDir, { recursive: true })
    const inside = join(insideDir, 'SF-Pro.ttf')
    writeFileSync(inside, 'x')
    seedFile({ id: 'a'.repeat(24), familyId: 'sf-pro', filePath: inside })
    seedFile({ id: 'b'.repeat(24), familyId: 'sf-pro', filePath: '/Library/Fonts/SF-Pro-Italic.ttf' })
    seedFile({ id: 'c'.repeat(24), familyId: 'sf-mono', filePath: '/System/Library/Fonts/SFNSMono.ttf' })

    const r = enforceFontPortability(db, dataDir, {})
    expect(r.total).toBe(3)
    expect(r.purged).toBe(2)
    expect(r.kept).toBe(1)
    // sf-mono lost its only (system) row → flagged as missing.
    expect(r.missing).toEqual(['sf-mono'])
    const left = db.db
      .query('SELECT id FROM apple_font_files')
      .all()
      .map((x) => x.id)
    expect(left).toEqual(['a'.repeat(24)])
  })

  test('a portable path that does not exist on disk still counts as missing', () => {
    seedFile({
      id: 'd'.repeat(24),
      familyId: 'sf-pro',
      filePath: join(dataDir, 'resources', 'fonts', 'extracted', 'sf-pro', 'ghost.ttf'),
    })
    const r = enforceFontPortability(db, dataDir, {})
    expect(r.purged).toBe(0)
    expect(r.missing).toContain('sf-pro')
    expect(r.missing).toContain('sf-mono')
  })

  test('clean corpus passes with nothing purged and nothing missing', () => {
    for (const familyId of ['sf-pro', 'sf-mono']) {
      const dir = join(dataDir, 'resources', 'fonts', 'extracted', familyId)
      mkdirSync(dir, { recursive: true })
      const p = join(dir, `${familyId}.ttf`)
      writeFileSync(p, 'x')
      seedFile({ id: familyId === 'sf-pro' ? 'e'.repeat(24) : 'f'.repeat(24), familyId, filePath: p })
    }
    const r = enforceFontPortability(db, dataDir, {})
    expect(r.purged).toBe(0)
    expect(r.missing).toEqual([])
    expect(r.kept).toBe(2)
  })
})
