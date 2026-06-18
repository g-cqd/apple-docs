// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'
import { withFileTempStore } from '../../../src/storage/pragmas.js'

function tempStoreOf(db) {
  const row = db.query('PRAGMA temp_store').get()
  return Number(Object.values(row)[0])
}

describe('withFileTempStore', () => {
  test('switches to FILE for the callback and restores MEMORY after', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA temp_store = MEMORY')
    let inside = null
    withFileTempStore(db, () => {
      inside = tempStoreOf(db)
    })
    expect(inside).toBe(1) // FILE
    expect(tempStoreOf(db)).toBe(2) // MEMORY restored
    db.close()
  })

  test('restores MEMORY even when the callback throws', () => {
    const db = new Database(':memory:')
    db.run('PRAGMA temp_store = MEMORY')
    expect(() =>
      withFileTempStore(db, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(tempStoreOf(db)).toBe(2)
    db.close()
  })
})

describe('migration boot under contention', () => {
  test('a second process booting while another holds the write lock succeeds (busy retry)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apple-docs-bootlock-'))
    const dbPath = join(dir, 'apple-docs.db')
    try {
      // Sibling process: opens the raw DB, takes the write lock for ~1.5s,
      // then releases — simulating a concurrent first boot mid-migration.
      const holder = Bun.spawn(
        [
          'bun',
          '-e',
          `
        const { Database } = require('bun:sqlite')
        const db = new Database(${JSON.stringify(dbPath)})
        db.run('CREATE TABLE IF NOT EXISTS warmup (x)')
        db.run('BEGIN IMMEDIATE')
        console.log('LOCKED')
        await Bun.sleep(1500)
        db.run('COMMIT')
        db.close()
        console.log('RELEASED')
      `,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )

      // Wait until the lock is actually held.
      const reader = holder.stdout.getReader()
      let seen = ''
      while (!seen.includes('LOCKED')) {
        const { done, value } = await reader.read()
        if (done) break
        seen += new TextDecoder().decode(value)
      }
      reader.releaseLock()

      // Booting DocsDatabase runs migrations; without the busy retry this
      // throws "database is locked" (busy_timeout alone is applied later
      // in the boot sequence than the first schema write).
      const booted = new DocsDatabase(dbPath)
      expect(booted.getSchemaVersion()).toBeGreaterThan(0)
      booted.close()
      await holder.exited
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
