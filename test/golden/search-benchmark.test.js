import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { seedDatabase } from './seed.js'
import goldenQueries from './search-queries.json'

let db
let ctx

beforeAll(() => {
  db = new DocsDatabase(':memory:')
  seedDatabase(db)
  ctx = {
    db,
    dataDir: '/tmp/apple-docs-test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
})

afterAll(() => {
  db.close()
})

describe('Golden Search Queries', () => {
  for (const golden of goldenQueries) {
    test(golden.name, async () => {
      const startMs = performance.now()
      const result = await search({
        query: golden.query,
        framework: golden.framework,
        source: golden.source,
        language: golden.language,
        platform: golden.platform,
        minIos: golden.min_ios,
        minMacos: golden.min_macos,
        limit: 20,
        fuzzy: true,
        noDeep: true, // No body index in test DB
        noEager: false,
      }, ctx)
      const latencyMs = performance.now() - startMs

      const paths = result.results.map(r => r.path)

      // Check minimum results
      if (golden.expect.minResults !== undefined) {
        expect(result.results.length).toBeGreaterThanOrEqual(golden.expect.minResults)
      }

      // Check first result path
      if (golden.expect.firstResultPath) {
        expect(paths[0]).toBe(golden.expect.firstResultPath)
      }

      // Check top results contain expected paths
      if (golden.expect.topContains) {
        const topPaths = paths.slice(0, 10)
        for (const expected of golden.expect.topContains) {
          expect(topPaths).toContain(expected)
        }
      }

      // Check latency (generous limit for CI)
      if (golden.expect.maxLatencyMs) {
        expect(latencyMs).toBeLessThan(golden.expect.maxLatencyMs)
      }
    })
  }
})
