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

// ---------------------------------------------------------------------------
// Correctness: Golden query suite
// ---------------------------------------------------------------------------

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
        noDeep: true,
        noEager: false,
      }, ctx)
      const latencyMs = performance.now() - startMs

      const paths = result.results.map(r => r.path)

      if (golden.expect.minResults !== undefined) {
        expect(result.results.length).toBeGreaterThanOrEqual(golden.expect.minResults)
      }

      if (golden.expect.firstResultPath) {
        expect(paths[0]).toBe(golden.expect.firstResultPath)
      }

      if (golden.expect.topContains) {
        const topPaths = paths.slice(0, 10)
        for (const expected of golden.expect.topContains) {
          expect(topPaths).toContain(expected)
        }
      }

      if (golden.expect.maxLatencyMs) {
        expect(latencyMs).toBeLessThan(golden.expect.maxLatencyMs)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// Enrichment: results carry snippet and intent metadata
// ---------------------------------------------------------------------------

describe('Search result enrichment', () => {
  test('results include snippet field when document has sections', async () => {
    const result = await search({ query: 'Swift Testing', framework: 'wwdc', noDeep: true }, ctx)
    expect(result.results.length).toBeGreaterThan(0)
    const withSnippet = result.results.find(r => r.snippet)
    expect(withSnippet).toBeDefined()
  })

  test('results include relatedCount field', async () => {
    const result = await search({ query: 'View', noDeep: true }, ctx)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0].relatedCount).toBeDefined()
    expect(typeof result.results[0].relatedCount).toBe('number')
  })

  test('search returns intent metadata', async () => {
    const result = await search({ query: 'NavigationStack', noDeep: true }, ctx)
    expect(result.intent).toBeDefined()
    expect(result.intent.type).toBe('symbol')
    expect(result.intent.confidence).toBeGreaterThan(0)
  })

  test('results include reranking score', async () => {
    const result = await search({ query: 'View', noDeep: true }, ctx)
    expect(result.results.length).toBeGreaterThan(0)
    expect(typeof result.results[0].score).toBe('number')
    // Scores should be descending
    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i - 1].score).toBeGreaterThanOrEqual(result.results[i].score)
    }
  })
})

// ---------------------------------------------------------------------------
// Performance: p95 latency benchmark
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

describe('Search latency benchmark', () => {
  const ITERATIONS = 50

  test('p95 latency under 50ms across all golden queries', async () => {
    const allLatencies = []

    for (const golden of goldenQueries) {
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now()
        await search({
          query: golden.query,
          framework: golden.framework,
          source: golden.source,
          language: golden.language,
          platform: golden.platform,
          minIos: golden.min_ios,
          minMacos: golden.min_macos,
          limit: 20,
          fuzzy: true,
          noDeep: true,
          noEager: false,
        }, ctx)
        allLatencies.push(performance.now() - start)
      }
    }

    allLatencies.sort((a, b) => a - b)
    const p50 = percentile(allLatencies, 50)
    const p95 = percentile(allLatencies, 95)
    const p99 = percentile(allLatencies, 99)

    // Log summary for visibility
    console.log(`  Benchmark: ${goldenQueries.length} queries × ${ITERATIONS} iterations = ${allLatencies.length} samples`)
    console.log(`  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms`)

    expect(p95).toBeLessThan(50)
  })
})
