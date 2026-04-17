import { describe, expect, test } from 'bun:test'
import { downloadMissing } from '../../src/pipeline/download.js'

describe('downloadMissing pooled concurrency', () => {
  test('processes multiple pages with bounded parallelism', async () => {
    let active = 0
    let maxActive = 0
    let releaseCurrentBatch
    const batchGate = new Promise((resolve) => {
      releaseCurrentBatch = resolve
    })
    const persisted = []
    const progress = []

    const db = {
      db: {
        query() {
          return {
            all() {
              return [
                { path: 'docs/a', root_id: 1, root_slug: 'swiftui', source_type: 'apple-docc' },
                { path: 'docs/b', root_id: 1, root_slug: 'swiftui', source_type: 'apple-docc' },
                { path: 'docs/c', root_id: 1, root_slug: 'swiftui', source_type: 'apple-docc' },
              ]
            },
          }
        },
      },
    }

    const runPromise = downloadMissing(
      db,
      '/tmp',
      { acquire: async () => {} },
      { info() {}, warn() {} },
      (info) => progress.push(info),
      {},
      {
        semaphore: { max: 2 },
        fetchDocPage: async (path) => {
          active++
          maxActive = Math.max(maxActive, active)
          await batchGate
          active--
          return { json: { path }, etag: null, lastModified: null }
        },
        persistFetchedDocPage: async (payload) => {
          persisted.push(payload.path)
        },
      },
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(maxActive).toBe(2)

    releaseCurrentBatch()
    const result = await runPromise

    expect(result).toEqual({ downloaded: 3 })
    expect(persisted).toHaveLength(3)
    expect(progress).toHaveLength(3)
  })
})
