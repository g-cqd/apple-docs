import { describe, expect, test } from 'bun:test'
import { update } from '../../src/commands/update.js'
import { normalizeList, validateRequestedSources } from '../../src/commands/command-helpers.js'

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
