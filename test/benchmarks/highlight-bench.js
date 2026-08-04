import { compareToPrevious, recordBenchmark } from './history.js'
import { disposeHighlighter, highlightCode, initHighlighter } from '../../src/content/highlight.js'

// Unique snippet per timed call: repeating 50 snippets 10× meant ≥90% of
// timed calls were LRU cache hits — the benchmark measured a Map.get, not
// shiki. 500 distinct snippets keep every call a real highlight.
const UNIQUE_SNIPPETS = 500

function createSnippet(index) {
  const variants = [
    {
      lang: 'swift',
      code: `struct Example${index}: View {\n  var body: some View {\n    Text("Snippet ${index}")\n  }\n}`,
    },
    {
      lang: 'javascript',
      code: `export function example${index}(value) {\n  return value + ${index}\n}`,
    },
    {
      lang: 'json',
      code: `{"title":"Example ${index}","kind":"snippet","index":${index}}`,
    },
    {
      lang: 'bash',
      code: `curl -H "Accept: application/json" "https://example.com/${index}"`,
    },
    {
      lang: 'html',
      code: `<section data-index="${index}"><h1>Example ${index}</h1></section>`,
    },
  ]
  return variants[index % variants.length]
}

function percentile(values, p) {
  return values[Math.floor(values.length * p)]
}

/**
 * Run highlight benchmarks and optionally record history.
 * Usage: bun test/benchmarks/highlight-bench.js [--record]
 */
async function main() {
  const shouldRecord = process.argv.includes('--record')
  await initHighlighter()

  const calls = Array.from({ length: UNIQUE_SNIPPETS }, (_, index) => createSnippet(index))
  const times = []

  for (const { code, lang } of calls) {
    const start = performance.now()
    highlightCode(code, lang)
    times.push(performance.now() - start)
  }

  times.sort((a, b) => a - b)
  const p50 = percentile(times, 0.5)
  const p95 = percentile(times, 0.95)
  const p99 = percentile(times, 0.99)

  console.log(`Highlight benchmark (${calls.length} calls):`)
  console.log(`  p50: ${p50.toFixed(2)}ms`)
  console.log(`  p95: ${p95.toFixed(2)}ms`)
  console.log(`  p99: ${p99.toFixed(2)}ms`)

  if (shouldRecord) {
    const comparison = compareToPrevious('highlight-p50', p50)

    recordBenchmark('highlight-p50', { value: p50, unit: 'ms' })
    recordBenchmark('highlight-p95', { value: p95, unit: 'ms' })
    recordBenchmark('highlight-p99', { value: p99, unit: 'ms' })

    if (comparison.regressed) {
      console.log(`WARNING REGRESSION: p50 is ${comparison.changePercent}% slower than previous (${comparison.previousValue.toFixed(2)}ms -> ${p50.toFixed(2)}ms)`)
    } else if (comparison.previousValue) {
      console.log(`  vs previous: ${comparison.changePercent > 0 ? '+' : ''}${comparison.changePercent}%`)
    }
    console.log('  Results recorded to .benchmarks/history.jsonl')
  }

  disposeHighlighter()
}

main()
