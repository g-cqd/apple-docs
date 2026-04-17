import { DocsDatabase } from '../../src/storage/database.js'
import { seedFlatSourceProgress } from '../../src/lib/flat-source-progress.js'
import { compareToPrevious, recordBenchmark } from './history.js'

const ITERATIONS = 20
const KEY_COUNT = 10000
const processedKeys = new Set(Array.from({ length: KEY_COUNT / 2 }, (_, index) => `sample-code/doc-${index * 2}`))

function percentile(values, p) {
  return values[Math.floor(values.length * p)]
}

/**
 * Run flat-source seed benchmarks and optionally record history.
 * Usage: bun test/benchmarks/seed-bench.js [--record]
 */
async function main() {
  const shouldRecord = process.argv.includes('--record')
  const keys = Array.from({ length: KEY_COUNT }, (_, index) => `sample-code/doc-${index}`)
  const times = []

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const db = new DocsDatabase(':memory:')

    try {
      const start = performance.now()
      seedFlatSourceProgress(db, 'sample-code', keys, processedKeys)
      times.push(performance.now() - start)
    } finally {
      db.close()
    }
  }

  times.sort((a, b) => a - b)
  const p50 = percentile(times, 0.5)
  const p95 = percentile(times, 0.95)
  const p99 = percentile(times, 0.99)

  console.log(`Seed benchmark (${ITERATIONS} runs, ${KEY_COUNT} keys):`)
  console.log(`  p50: ${p50.toFixed(2)}ms`)
  console.log(`  p95: ${p95.toFixed(2)}ms`)
  console.log(`  p99: ${p99.toFixed(2)}ms`)

  if (shouldRecord) {
    const comparison = compareToPrevious('seed-p50', p50)

    recordBenchmark('seed-p50', { value: p50, unit: 'ms' })
    recordBenchmark('seed-p95', { value: p95, unit: 'ms' })
    recordBenchmark('seed-p99', { value: p99, unit: 'ms' })

    if (comparison.regressed) {
      console.log(`WARNING REGRESSION: p50 is ${comparison.changePercent}% slower than previous (${comparison.previousValue.toFixed(2)}ms -> ${p50.toFixed(2)}ms)`)
    } else if (comparison.previousValue) {
      console.log(`  vs previous: ${comparison.changePercent > 0 ? '+' : ''}${comparison.changePercent}%`)
    }
    console.log('  Results recorded to .benchmarks/history.jsonl')
  }
}

main()
