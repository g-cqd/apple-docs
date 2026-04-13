import { describe, expect, test } from 'bun:test'
import { update } from '../../src/commands/update.js'

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
})
