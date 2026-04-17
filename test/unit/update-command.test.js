import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { update } from '../../src/commands/update.js'
import { normalizeList, validateRequestedSources } from '../../src/commands/command-helpers.js'
import { DocsDatabase } from '../../src/storage/database.js'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('update command', () => {
  test('rejects unknown source filters before running discovery', async () => {
    await expect(update({
      sources: ['not-a-source'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('Unknown source type(s): not-a-source')
  })

  test('rejects multiple unknown sources', async () => {
    await expect(update({
      sources: ['bogus-a', 'bogus-b'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('bogus-a')
  })

  test('continues updating other adapters when one discovery fails', async () => {
    const dataDir = join(tmpdir(), `apple-docs-update-test-${crypto.randomUUID()}`)
    tempDirs.push(dataDir)
    mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
    mkdirSync(join(dataDir, 'markdown'), { recursive: true })

    const db = new DocsDatabase(':memory:')
    db.upsertRoot('good-root', 'Good Root', 'collection', 'test')
    const goodRoot = db.getRootBySlug('good-root')

    try {
      const result = await update({}, {
        db,
        dataDir,
        rateLimiter: { rate: 5, acquire: async () => {} },
        logger: { info() {}, warn() {}, error() {} },
        adapters: [
          {
            constructor: { type: 'bad-source', displayName: 'Bad Source', syncMode: 'flat' },
            async discover() {
              throw new Error('discover boom')
            },
            validateNormalizeResult() {},
          },
          {
            constructor: { type: 'good-source', displayName: 'Good Source', syncMode: 'flat' },
            async discover() {
              return { roots: [{ ...goodRoot, source_type: 'good-source' }], keys: [] }
            },
            validateNormalizeResult() {},
          },
        ],
      })

      expect(result.errCount).toBe(1)
      expect(result.newCount).toBe(0)
      expect(result.modCount).toBe(0)
      expect(result.delCount).toBe(0)
      expect(result.unchangedCount).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('command helpers (used by update)', () => {
  test('normalizeList handles edge cases', () => {
    expect(normalizeList(undefined)).toBeNull()
    expect(normalizeList(null)).toBeNull()
    expect(normalizeList([])).toEqual([])
    expect(normalizeList(['A'])).toEqual(['a'])
  })

  test('validateRequestedSources edge cases', () => {
    expect(() => validateRequestedSources(null)).not.toThrow()
    expect(() => validateRequestedSources(['apple-docc'])).not.toThrow()
    expect(() => validateRequestedSources(['hig'])).not.toThrow()
    expect(() => validateRequestedSources(['nonexistent'])).toThrow()
  })
})
