import { describe, expect, test } from 'bun:test'
import { sync } from '../../src/commands/sync.js'

describe('sync command', () => {
  test('rejects unknown source filters before running discovery', async () => {
    await expect(sync({
      sources: ['not-a-source'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('Unknown source type(s): not-a-source')
  })
})
