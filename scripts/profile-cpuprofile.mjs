#!/usr/bin/env bun
/**
 * Attribute self-time in a V8 .cpuprofile to coarse code buckets.
 *
 * Bun's `--cpu-prof` emits a standard V8 profile: nodes[] (each with
 * callFrame{functionName,url}), samples[] (node ids), timeDeltas[]
 * (microseconds between samples). Self-time per node = Σ timeDeltas where
 * the sample landed on that node. We bucket by callFrame.url substring so
 * a build profile answers "where does the per-page time go" without
 * flame-graph spelunking (RFC 0004 §6c, the phase-4 gate).
 *
 *   bun scripts/profile-cpuprofile.mjs <file.cpuprofile> [--top 30]
 *
 * Buckets are ordered; the FIRST match wins, so put specific paths before
 * general ones (markdown.js before render-html/*).
 */

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const topN = (() => {
  const i = args.indexOf('--top')
  return i >= 0 ? Number.parseInt(args[i + 1], 10) || 30 : 30
})()
if (!file) {
  console.error('usage: bun scripts/profile-cpuprofile.mjs <file.cpuprofile> [--top N]')
  process.exit(2)
}

// Ordered [bucket, test(urlDecoded, functionName)] — first match wins.
const BUCKETS = [
  ['markdown-parser', (u) => u.includes('/content/render-html/markdown.js')],
  ['render-html', (u) => u.includes('/content/render-html/') || u.endsWith('/content/render-html.js')],
  ['highlight', (u) => u.includes('/content/highlight') || /shiki|oniguruma|vscode-textmate|onig/i.test(u)],
  ['content-other', (u) => u.includes('/src/content/')],
  ['template', (u) => u.includes('/src/web/templates') || u.includes('/src/web/build/') || u.includes('/src/web/view-models') || u.includes('/src/web/lib/')],
  ['web-other', (u) => u.includes('/src/web/')],
  ['sqlite', (u) => u.includes('bun:sqlite') || u.includes('/src/storage/') || /sqlite/i.test(u)],
  ['compress', (u) => /zlib|brotli|gzip/i.test(u) || u.includes('precompress')],
  ['hash', (u) => u.includes('/lib/hash') || /crypto/i.test(u) || u.includes('checkpoint')],
  ['io-fs', (u) => u.includes('node:fs') || u.includes('/storage/files')],
  ['app-other-js', (u) => u.includes('/apple-docs/src/') || u.includes('/apple-docs/cli.js')],
  ['node-builtin', (u) => u.startsWith('node:') || u.includes('/node_modules/')],
]

// Native frames carry an EMPTY url (bun runtime / system bindings). We
// attribute the hot ones by function name: bun:sqlite Statement methods,
// shiki's oniguruma WASM, and the libuv fs syscalls — otherwise a build
// profile hides SQLite and the highlighter inside "native/runtime".
function classifyNative(fn) {
  if (fn === 'all' || fn === 'get' || fn === 'run' || fn === 'iterate') return 'sqlite'
  if (fn?.startsWith('.wasm-function')) return 'highlight' // oniguruma (shiki)
  if (/^(writeSync|write|read|readSync|mkdirSync|existsSync|statSync|fsync|open|close|unlink|rename|copyWithin)$/.test(fn)) {
    return 'io-fs'
  }
  if (fn?.startsWith('/') && /\/[gimsuy]*$/.test(fn)) return 'regex-exec'
  return 'native/runtime'
}

function classify(url, fn) {
  const u = (() => {
    try {
      return decodeURIComponent(url || '')
    } catch {
      return url || ''
    }
  })()
  if (!u || !u.startsWith('file:')) return classifyNative(fn)
  for (const [name, test] of BUCKETS) {
    if (test(u, fn)) return name
  }
  return 'unclassified'
}

const profile = JSON.parse(readFileSync(file, 'utf8'))
const nodesById = new Map(profile.nodes.map((n) => [n.id, n]))
const samples = profile.samples
const deltas = profile.timeDeltas

// Self-time (µs) per node id. timeDeltas[i] is the gap BEFORE samples[i];
// attribute it to the sample it precedes (V8 convention).
const selfByNode = new Map()
let totalUs = 0
for (let i = 0; i < samples.length; i++) {
  const dt = deltas[i] ?? 0
  if (dt < 0) continue
  selfByNode.set(samples[i], (selfByNode.get(samples[i]) ?? 0) + dt)
  totalUs += dt
}

const byBucket = new Map()
const byLeaf = new Map() // "bucket │ fn @ url:line" → µs (for --top)
for (const [nodeId, us] of selfByNode) {
  const node = nodesById.get(nodeId)
  const cf = node?.callFrame ?? {}
  const bucket = classify(cf.url, cf.functionName)
  byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + us)
  const loc = `${cf.functionName || '(anon)'}  ${shortUrl(cf.url)}:${cf.lineNumber + 1}`
  byLeaf.set(`${bucket} │ ${loc}`, (byLeaf.get(`${bucket} │ ${loc}`) ?? 0) + us)
}

function shortUrl(url) {
  try {
    url = decodeURIComponent(url || '')
  } catch {}
  const idx = url.indexOf('/apple-docs/')
  return idx >= 0 ? url.slice(idx + '/apple-docs/'.length) : url.replace(/^file:\/\//, '')
}

const ms = (us) => (us / 1000).toFixed(1)
const pct = (us) => ((us / totalUs) * 100).toFixed(1)
const wall = ((profile.endTime - profile.startTime) / 1000).toFixed(0)

console.log(`profile: ${file}`)
console.log(`wall ${wall}ms · sampled self-time ${ms(totalUs)}ms across ${samples.length} samples\n`)

console.log('bucket                  self(ms)    %')
console.log('─'.repeat(44))
const rows = [...byBucket.entries()].sort((a, b) => b[1] - a[1])
for (const [bucket, us] of rows) {
  console.log(`${bucket.padEnd(22)} ${ms(us).padStart(9)} ${pct(us).padStart(6)}`)
}

// Render-surface roll-up (the phase-4 gate number).
const renderSurfaces = ['markdown-parser', 'render-html', 'highlight']
const renderUs = renderSurfaces.reduce((s, b) => s + (byBucket.get(b) ?? 0), 0)
console.log('─'.repeat(44))
console.log(`render surfaces (md+html+highlight): ${ms(renderUs)}ms  ${pct(renderUs)}%`)
console.log(`template layer:                      ${ms(byBucket.get('template') ?? 0)}ms  ${pct(byBucket.get('template') ?? 0)}%`)

console.log(`\ntop ${topN} self-time leaves`)
console.log('─'.repeat(60))
const leaves = [...byLeaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
for (const [loc, us] of leaves) {
  console.log(`${ms(us).padStart(8)}ms ${pct(us).padStart(5)}%  ${loc}`)
}
