// RFC 0001 P6 host-spike GO/NO-GO benchmark. Spawns ad-server (SwiftNIO,
// in-process ADStorage) + the Bun comparison server (main-thread + worker
// pool), then drives a concurrent keep-alive burst over HTTP against all
// three search paths + healthz. The decisive gate is SwiftNIO ≤ the Bun
// worker-pool path (the production serving path); main-thread is a reference.
//
//   bun scripts/p6-host-bench.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const BENCH_SERVER = new URL('./p6-bun-bench-server.mjs', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const THREADS = 6
const AD_PORT = 3032
const BUN_PORT = 3033

const dir = mkdtempSync(join(tmpdir(), 'p6-bench-'))
const dbPath = join(dir, 'corpus.db')

// Seed a realistic corpus (8 frameworks × 60 docs) once.
{
  const { DocsDatabase } = await import('../src/storage/database.js')
  const db = new DocsDatabase(dbPath)
  for (const fw of FRAMEWORKS) db.upsertRoot(fw, fw.toUpperCase(), 'framework', 'bench')
  let n = 0
  for (const fw of FRAMEWORKS) {
    for (let i = 0; i < 60; i++) {
      const t = TERMS[i % TERMS.length]
      db.upsertDocument({
        key: `${fw}/sym${i}`, title: `${t[0].toUpperCase()}${t.slice(1)}${i}`, framework: fw,
        sourceType: 'apple-docc', role: 'symbol', kind: 'struct', language: 'swift', urlDepth: 2,
        abstractText: `A ${t} that manages ${TERMS[(i * 3) % TERMS.length]} for the ${fw} view layer.`,
      })
      n++
    }
  }
  db.close()
  console.log(`seeded ${n} docs / ${FRAMEWORKS.length} frameworks at ${dbPath}`)
}

const adServer = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(AD_PORT), '--threads', String(THREADS)], {
  stdout: 'inherit', stderr: 'inherit',
})
const bunServer = Bun.spawn(['bun', BENCH_SERVER, dbPath, String(BUN_PORT), String(THREADS)], {
  stdout: 'inherit', stderr: 'inherit', env: { ...process.env, APPLE_DOCS_NATIVE: 'off' },
})

async function waitHealthz(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (r.ok) { await r.text(); return }
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`server on :${port} never became healthy`)
}

async function bench(makeUrl, { n = 4000, concurrency = 16, warmup = 400 } = {}) {
  for (let i = 0; i < warmup; i++) await fetch(makeUrl(i)).then((r) => r.text())
  const samples = new Float64Array(n)
  let next = 0
  async function worker() {
    while (true) {
      const k = next++
      if (k >= n) return
      const t0 = performance.now()
      const r = await fetch(makeUrl(k))
      await r.text()
      samples[k] = performance.now() - t0
    }
  }
  const t0 = performance.now()
  await Promise.all(Array.from({ length: concurrency }, worker))
  const wallMs = performance.now() - t0
  const sorted = Float64Array.from(samples).sort()
  const pct = (p) => sorted[Math.floor(n * p)]
  return { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), rps: n / (wallMs / 1000) }
}

const searchUrl = (base) => (k) =>
  `${base}?q=${TERMS[k % TERMS.length]}&framework=${FRAMEWORKS[k % FRAMEWORKS.length]}&limit=100`

try {
  await Promise.all([waitHealthz(AD_PORT), waitHealthz(BUN_PORT)])
  const f = (x) => x.toFixed(3)
  const line = (label, r) =>
    console.log(`  ${label.padEnd(34)} p50=${f(r.p50)}  p95=${f(r.p95)}  p99=${f(r.p99)}  rps=${Math.round(r.rps)}`)

  console.log("\n=== healthz (host overhead, concurrency 16) ===")
  line('Bun.serve   /healthz', await bench(() => `http://127.0.0.1:${BUN_PORT}/healthz`))
  line('SwiftNIO    /healthz', await bench(() => `http://127.0.0.1:${AD_PORT}/healthz`))

  console.log("\n=== searchPages over HTTP (concurrency 16, multi-framework) ===")
  const main = await bench(searchUrl(`http://127.0.0.1:${BUN_PORT}/search-main`))
  const pool = await bench(searchUrl(`http://127.0.0.1:${BUN_PORT}/search-pool`))
  const nio = await bench(searchUrl(`http://127.0.0.1:${AD_PORT}/search`))
  line('(i)  Bun main-thread bun:sqlite', main)
  line('(ii) Bun worker-pool (postMessage)', pool)
  line('(iii) SwiftNIO in-process', nio)

  console.log("\n=== verdict ===")
  console.log(`  SwiftNIO vs worker-pool (ii)  p50 ${(nio.p50 / pool.p50).toFixed(2)}x  rps ${(nio.rps / pool.rps).toFixed(2)}x  (GATE: ≤1.0 / ≥1.0)`)
  console.log(`  SwiftNIO vs main-thread (i)   p50 ${(nio.p50 / main.p50).toFixed(2)}x  rps ${(nio.rps / main.rps).toFixed(2)}x  (reference)`)

  // Event-loop-stall check: hammer /search while probing /healthz.
  console.log("\n=== healthz under search load (event-loop stall check) ===")
  let stop = false
  const flood = (async () => {
    while (!stop) await fetch(searchUrl(`http://127.0.0.1:${AD_PORT}/search`)(Math.floor(Math.random() * 1e6))).then((r) => r.text())
  })()
  const probes = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    await fetch(`http://127.0.0.1:${AD_PORT}/healthz`).then((r) => r.text())
    probes.push(performance.now() - t0)
    await Bun.sleep(10)
  }
  stop = true
  await flood
  probes.sort((a, b) => a - b)
  console.log(`  SwiftNIO /healthz during search burst: p50=${f(probes[25])}  p95=${f(probes[47])}  max=${f(probes[49])} ms`)
} finally {
  adServer.kill()
  bunServer.kill()
  await Promise.allSettled([adServer.exited, bunServer.exited])
  rmSync(dir, { recursive: true, force: true })
}
