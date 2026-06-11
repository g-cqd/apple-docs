/**
 * Embed js-vs-native benchmark for the RFC 0002 §3 gates (local-only: needs
 * the pinned model AND the full matrix artifact; CI never runs this). Run:
 *
 *   swift build -c release --package-path swift
 *   bun test/benchmarks/embed-bench.js
 *
 * Measures, over the committed 2,000-chunk corpus (real production shapes):
 *   - index-build throughput, batch=64 (gate: native ≥ 2× transformers.js)
 *   - single-embed latency p50/p95 (gate: p50 ≤ 1 ms on arm64)
 *   - native init time (gate: ≤ 500 ms) and process RSS
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _resetNativeLoader } from '../../src/native/loader.js'
import { buildNativeModel2Vec } from '../../src/search/embedder-native.js'

const ROOT = new URL('../../', import.meta.url).pathname
const DEV_LIB = `${ROOT}swift/.build/release/libAppleDocsCore.${suffix}`
const modelsDir =
  process.env.APPLE_DOCS_MODELS_DIR ??
  join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')
const HF_ID = 'minishlab/potion-retrieval-32M'

if (!existsSync(DEV_LIB)) {
  console.error(`no dylib at ${DEV_LIB} — build it first`)
  process.exit(1)
}
if (!existsSync(join(modelsDir, HF_ID, 'onnx', 'model.onnx'))) {
  console.error(`no pinned model at ${modelsDir}/${HF_ID} — local-only benchmark`)
  process.exit(1)
}

process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
_resetNativeLoader()

const corpus = JSON.parse(readFileSync(`${ROOT}test/fixtures/embed-parity/corpus-texts.json`, 'utf8')).map(
  (c) => c.text,
)

async function throughput(label, embedBatch, passes = 5) {
  await embedBatch(corpus.slice(0, 64)) // warmup
  let done = 0
  const start = performance.now()
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < corpus.length; i += 64) {
      await embedBatch(corpus.slice(i, i + 64))
      done += Math.min(64, corpus.length - i)
    }
  }
  const seconds = (performance.now() - start) / 1000
  const rate = done / seconds
  console.log(`${label}: ${done} chunks in ${seconds.toFixed(2)}s → ${rate.toFixed(0)} chunks/s`)
  return rate
}

async function latency(label, embed, iterations = 500) {
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await embed(corpus[i % corpus.length])
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  const p50 = samples[Math.floor(iterations * 0.5)]
  const p95 = samples[Math.floor(iterations * 0.95)]
  console.log(`${label} single: p50 ${p50.toFixed(3)}ms p95 ${p95.toFixed(3)}ms`)
  return p50
}

// --- native ---
const initStart = performance.now()
const native = await buildNativeModel2Vec({ hfId: HF_ID, dims: 512 }, modelsDir, {})
const initMs = performance.now() - initStart
if (!native) {
  console.error('native embedder unavailable — see warnings above')
  process.exit(1)
}
console.log(`native init (pack + mmap + vocab table): ${initMs.toFixed(0)}ms (gate ≤ 500ms)`)
const nativeRate = await throughput('native', native.embedBatch)
await latency('native', native.embed)
console.log(`rss after native run: ${(process.memoryUsage.rss() / 1e6).toFixed(0)}MB (matrix is 129MB, mmap'd)`)

// --- transformers.js baseline (fresh embedder, native disabled) ---
delete process.env.APPLE_DOCS_NATIVE
const { getEmbedder, _resetEmbedder } = await import('../../src/search/embedder.js')
_resetEmbedder()
const js = await getEmbedder({})
if (!js) {
  console.error('transformers.js embedder unavailable for the baseline')
  process.exit(1)
}
const jsRate = await throughput('transformers.js', (texts) => js.embedBatch(texts))
await latency('transformers.js', (text) => js.embed(text), 200)

console.log(`\nthroughput ratio: ${(nativeRate / jsRate).toFixed(2)}x (gate ≥ 2x on arm64)`)
