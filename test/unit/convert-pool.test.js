import { describe, expect, mock, test } from 'bun:test'
import { convertAll } from '../../src/pipeline/convert.js'

describe('convertAll semaphore options', () => {
  test('uses bounded parallelism when a semaphore-backed opts object is provided', async () => {
    let active = 0
    let maxActive = 0
    let releaseCurrentBatch
    const batchGate = new Promise((resolve) => {
      releaseCurrentBatch = resolve
    })
    const progress = []
    const db = {
      getUnconvertedPages() {
        return [
          { path: 'docs/a', root_slug: 'swiftui', source_type: 'apple-docc' },
          { path: 'docs/b', root_slug: 'swiftui', source_type: 'apple-docc' },
          { path: 'docs/c', root_slug: 'swiftui', source_type: 'apple-docc' },
        ]
      },
    }
    const convertPage = mock(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await batchGate
      active--
      return true
    })

    const runPromise = convertAll(
      db,
      '/tmp',
      { warn() {} },
      (info) => progress.push(info),
      {},
      { semaphore: { max: 2 }, convertPage },
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(maxActive).toBe(2)

    releaseCurrentBatch()
    const result = await runPromise

    expect(result).toEqual({ converted: 3, total: 3 })
    expect(convertPage).toHaveBeenCalledTimes(3)
    expect(progress).toHaveLength(3)
  })
})
