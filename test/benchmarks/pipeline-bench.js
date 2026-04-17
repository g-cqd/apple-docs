import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { downloadMissing } from '../../src/pipeline/download.js'
import { convertAll } from '../../src/pipeline/convert.js'
import { DocsDatabase } from '../../src/storage/database.js'
import { createMockLogger, createMockRateLimiter } from '../helpers/mocks.js'
import { compareToPrevious, recordBenchmark } from './history.js'

const ITERATIONS = 10
const DOWNLOAD_PAGE_COUNT = 25
const CONVERT_PAGE_COUNT = 25
const originalFetch = globalThis.fetch

function percentile(values, p) {
  return values[Math.floor(values.length * p)]
}

function buildFixture(path) {
  const title = path.split('/').at(-1)
  return {
    metadata: {
      title,
      roleHeading: 'Structure',
      role: 'symbol',
      symbolKind: 'struct',
      modules: [{ name: 'SwiftUI' }],
    },
    identifier: {
      url: `/documentation/${path}`,
      interfaceLanguage: 'swift',
    },
    abstract: [{ type: 'text', text: `${title} benchmark fixture.` }],
    primaryContentSections: [],
    topicSections: [],
    relationshipsSections: [],
    variants: [],
  }
}

function writeRawFixture(dataDir, path) {
  const filePath = join(dataDir, 'raw-json', `${path}.json`)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(buildFixture(path)))
}

function seedPage(db, rootId, path, downloadedAt = null) {
  db.upsertPage({
    rootId,
    path,
    url: `https://developer.apple.com/documentation/${path}`,
    title: path.split('/').at(-1),
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: `Fixture for ${path}`,
    platforms: null,
    declaration: null,
    etag: null,
    lastModified: null,
    contentHash: null,
    downloadedAt,
    sourceType: 'apple-docc',
  })
}

function installFetchStub() {
  globalThis.fetch = async (url) => {
    const pathname = new URL(url).pathname
    const key = pathname
      .replace(/^\/tutorials\/data\/documentation\//, '')
      .replace(/^\/tutorials\/data\//, '')
      .replace(/\.json$/, '')

    return new Response(JSON.stringify(buildFixture(key)), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: `"etag-${key}"`,
        'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
      },
    })
  }
}

/**
 * Run pipeline benchmarks and optionally record history.
 * Usage: bun test/benchmarks/pipeline-bench.js [--record]
 */
async function main() {
  const shouldRecord = process.argv.includes('--record')
  const logger = createMockLogger()
  const rateLimiter = createMockRateLimiter()
  const times = []

  installFetchStub()

  try {
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-pipeline-bench-'))
      mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
      mkdirSync(join(dataDir, 'markdown'), { recursive: true })

      const db = new DocsDatabase(':memory:')

      try {
        const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')

        for (let index = 0; index < DOWNLOAD_PAGE_COUNT; index++) {
          seedPage(db, root.id, `swiftui/download-${iteration}-${index}`)
        }

        for (let index = 0; index < CONVERT_PAGE_COUNT; index++) {
          const path = `swiftui/convert-${iteration}-${index}`
          seedPage(db, root.id, path, new Date().toISOString())
          writeRawFixture(dataDir, path)
        }

        const start = performance.now()
        const downloadResult = await downloadMissing(db, dataDir, rateLimiter, logger)
        const convertResult = await convertAll(db, dataDir, logger)
        times.push(performance.now() - start)

        if (downloadResult.downloaded !== DOWNLOAD_PAGE_COUNT) {
          throw new Error(`Expected ${DOWNLOAD_PAGE_COUNT} downloads, got ${downloadResult.downloaded}`)
        }
        if (convertResult.converted !== CONVERT_PAGE_COUNT) {
          throw new Error(`Expected ${CONVERT_PAGE_COUNT} conversions, got ${convertResult.converted}`)
        }
      } finally {
        db.close()
        rmSync(dataDir, { recursive: true, force: true })
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  times.sort((a, b) => a - b)
  const p50 = percentile(times, 0.5)
  const p95 = percentile(times, 0.95)
  const p99 = percentile(times, 0.99)

  console.log(`Pipeline benchmark (${ITERATIONS} runs):`)
  console.log(`  p50: ${p50.toFixed(2)}ms`)
  console.log(`  p95: ${p95.toFixed(2)}ms`)
  console.log(`  p99: ${p99.toFixed(2)}ms`)

  if (shouldRecord) {
    const comparison = compareToPrevious('pipeline-p50', p50)

    recordBenchmark('pipeline-p50', { value: p50, unit: 'ms' })
    recordBenchmark('pipeline-p95', { value: p95, unit: 'ms' })
    recordBenchmark('pipeline-p99', { value: p99, unit: 'ms' })

    if (comparison.regressed) {
      console.log(`WARNING REGRESSION: p50 is ${comparison.changePercent}% slower than previous (${comparison.previousValue.toFixed(2)}ms -> ${p50.toFixed(2)}ms)`)
    } else if (comparison.previousValue) {
      console.log(`  vs previous: ${comparison.changePercent > 0 ? '+' : ''}${comparison.changePercent}%`)
    }
    console.log('  Results recorded to .benchmarks/history.jsonl')
  }
}

main()
