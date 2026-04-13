import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { recordBenchmark, compareToPrevious } from './history.js'

/**
 * Run search benchmarks and optionally record history.
 * Usage: bun test/benchmarks/search-bench.js [--record]
 */
async function main() {
  const shouldRecord = process.argv.includes('--record')

  const db = new DocsDatabase(':memory:')
  const ctx = { db, dataDir: '/tmp', logger: { debug() {}, info() {}, warn() {}, error() {} } }

  // Seed test data
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  const symbols = ['View', 'Text', 'Button', 'List', 'NavigationStack', 'ScrollView', 'HStack', 'VStack', 'ZStack', 'Image']
  for (const sym of symbols) {
    db.upsertPage({
      rootId: root.id,
      path: `documentation/swiftui/${sym.toLowerCase()}`,
      url: 'u',
      title: sym,
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: `A ${sym} component for SwiftUI`,
    })
  }

  // Benchmark
  const iterations = 100
  const times = []

  for (let i = 0; i < iterations; i++) {
    const query = symbols[i % symbols.length]
    const start = performance.now()
    await search({ query, limit: 10, fuzzy: true, noDeep: true }, ctx)
    times.push(performance.now() - start)
  }

  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.floor(times.length * 0.95)]
  const p99 = times[Math.floor(times.length * 0.99)]

  console.log(`Search benchmark (${iterations} iterations):`)
  console.log(`  p50: ${p50.toFixed(2)}ms`)
  console.log(`  p95: ${p95.toFixed(2)}ms`)
  console.log(`  p99: ${p99.toFixed(2)}ms`)

  if (shouldRecord) {
    recordBenchmark('search-p50', { value: p50, unit: 'ms' })
    recordBenchmark('search-p95', { value: p95, unit: 'ms' })
    recordBenchmark('search-p99', { value: p99, unit: 'ms' })

    const comparison = compareToPrevious('search-p50', p50)
    if (comparison.regressed) {
      console.log(`WARNING REGRESSION: p50 is ${comparison.changePercent}% slower than previous (${comparison.previousValue.toFixed(2)}ms -> ${p50.toFixed(2)}ms)`)
    } else if (comparison.previousValue) {
      console.log(`  vs previous: ${comparison.changePercent > 0 ? '+' : ''}${comparison.changePercent}%`)
    }
    console.log('  Results recorded to .benchmarks/history.jsonl')
  }

  db.close()
}

main()
