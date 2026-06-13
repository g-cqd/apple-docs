// RFC 0001 P6 — localize the cascade's concurrency serialization. ELG count is
// irrelevant (2/4/6 identical) and throughput plateaus ~10x below the CPU
// ceiling with latency rising linearly in concurrency → a single serialization
// point. Hypothesis: the cascade decodes EVERY FTS match into ~24 String
// fields (~11k allocations/req for a 480-row match), and concurrent
// malloc-heavy work contends on the system allocator (where Bun's per-isolate
// bump allocator does not). Two probes at fixed c=16:
//   A) query match-volume sweep (480 / ~120 / ~60 / 0 rows) — if rps tracks
//      INVERSELY with row count, it is allocation/decode-bound.
//   B) thread-count sweep (4/6/8/10) — distinguishes E-core drag from a lock.
//
//   bun scripts/p6-alloc.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const PORT = 3035
const N = 6000
const C = 16

const dir = mkdtempSync(join(tmpdir(), 'p6-alloc-'))
const dbPath = join(dir, 'corpus.db')
{
  const { DocsDatabase } = await import('../src/storage/database.js')
  const db = new DocsDatabase(dbPath)
  for (const fw of FRAMEWORKS) db.upsertRoot(fw, fw.toUpperCase(), 'framework', 'bench')
  for (const fw of FRAMEWORKS)
    for (let i = 0; i < 60; i++) {
      const t = TERMS[i % TERMS.length]
      db.upsertDocument({ key: `${fw}/sym${i}`, title: `${t[0].toUpperCase()}${t.slice(1)}${i}`, framework: fw, sourceType: 'apple-docc', role: 'symbol', kind: 'struct', language: 'swift', urlDepth: 2, abstractText: `A ${t} that manages ${TERMS[(i * 3) % TERMS.length]} for the ${fw} view layer.` })
    }
  db.close()
}
async function waitHealthz() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/healthz`); if (r.ok) { await r.text(); return } } catch {}
    await Bun.sleep(80)
  }
  throw new Error('never healthy')
}
async function ab(path, c = C) {
  const p = Bun.spawn(['ab', '-k', '-c', String(c), '-n', String(N), `http://127.0.0.1:${PORT}${path}`], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return { rps: Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0), p50: Number(out.match(/\s+50%\s+(\d+)/)?.[1] ?? 0) }
}
async function rowCount(q) {
  return (await (await fetch(`http://127.0.0.1:${PORT}/search?q=${encodeURIComponent(q)}&limit=1`)).json()).total
}

async function boot(threads) {
  const srv = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', String(threads), '--loops', '2'], { stdout: 'ignore', stderr: 'ignore' })
  await waitHealthz()
  return srv
}

try {
  // Probe A — match-volume sweep at threads=8.
  let srv = await boot(8)
  await ab('/healthz') // warm
  console.log(`\n=== A) match-volume sweep (threads=8, c=${C}, n=${N}) ===`)
  console.log('  query         rows   rps   p50ms')
  for (const q of ['view', 'controller', 'metal', 'zzznomatch']) {
    const rows = await rowCount(q)
    const r = await ab(`/search?q=${q}&limit=100`)
    console.log(`  ${q.padEnd(13)} ${String(rows).padStart(4)}  ${String(Math.round(r.rps)).padStart(5)}   ${r.p50}`)
  }
  // healthz under the SAME concurrency — the no-alloc, no-offload control.
  const h = await ab('/healthz')
  console.log(`  ${'(healthz)'.padEnd(13)}    -  ${String(Math.round(h.rps)).padStart(5)}   ${h.p50}`)
  srv.kill(); await srv.exited; await Bun.sleep(150)

  // Probe B — thread-count sweep at the heavy query.
  console.log(`\n=== B) thread sweep (query=view 480 rows, c=${C}, n=${N}) ===`)
  console.log('  threads   rps   p50ms')
  for (const threads of [4, 6, 8, 10]) {
    srv = await boot(threads)
    await ab('/healthz')
    const r = await ab('/search?q=view&limit=100')
    console.log(`  ${String(threads).padStart(7)}  ${String(Math.round(r.rps)).padStart(5)}   ${r.p50}`)
    srv.kill(); await srv.exited; await Bun.sleep(150)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
