// RFC 0001 P6 concurrency sweep: the SwiftNIO ad-server full cascade vs the Bun
// reader-pool full cascade (/search-core), driven by ApacheBench (the
// authoritative load client — bun's fetch under-drives NIO). Runs ab -k at
// c=1,4,8,16 against both and tabulates rps + mean latency so we can see
// whether throughput SCALES with concurrency (the serving-model question — the
// async model degraded; this measures the classic EL-handler).
//
//   bun scripts/p6-sweep.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const BENCH_SERVER = new URL('./p6-bun-bench-server.mjs', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const THREADS = 8
const AD_PORT = 3032
const BUN_PORT = 3033
const N = 6000
const CONCURRENCIES = [1, 4, 8, 16]
const QUERY = 'q=view&limit=100'

const dir = mkdtempSync(join(tmpdir(), 'p6-sweep-'))
const dbPath = join(dir, 'corpus.db')
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
  console.log(`seeded ${n} docs / ${FRAMEWORKS.length} frameworks`)
}

const adServer = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(AD_PORT), '--threads', String(THREADS)], { stdout: 'inherit', stderr: 'inherit' })
const bunServer = Bun.spawn(['bun', BENCH_SERVER, dbPath, String(BUN_PORT), String(THREADS)], { stdout: 'inherit', stderr: 'inherit', env: { ...process.env, APPLE_DOCS_NATIVE: 'off' } })

async function waitHealthz(port) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) { await r.text(); return } } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`server on :${port} never healthy`)
}

async function ab(url, concurrency) {
  const p = Bun.spawn(['ab', '-k', '-c', String(concurrency), '-n', String(N), url], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  await p.exited
  const rps = Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0)
  const mean = Number(out.match(/Time per request:\s+([\d.]+)\s+\[ms\]\s+\(mean\)/)?.[1] ?? 0)
  const failed = Number(out.match(/Failed requests:\s+(\d+)/)?.[1] ?? 0)
  const p50 = Number(out.match(/\s+50%\s+(\d+)/)?.[1] ?? 0)
  return { rps, mean, p50, failed }
}

try {
  await Promise.all([waitHealthz(AD_PORT), waitHealthz(BUN_PORT)])
  const adUrl = `http://127.0.0.1:${AD_PORT}/search?${QUERY}`
  const bunUrl = `http://127.0.0.1:${BUN_PORT}/search-core?${QUERY}`
  // Warm both (FTS5 verify, JIT, page cache).
  await ab(adUrl, 4); await ab(bunUrl, 4)

  console.log(`\n=== full cascade, ab -k, n=${N} (query: ${QUERY}) ===`)
  console.log('  c    SwiftNIO rps  (p50ms)   Bun rps  (p50ms)   Bun/Swift')
  for (const c of CONCURRENCIES) {
    const s = await ab(adUrl, c)
    const b = await ab(bunUrl, c)
    const ratio = s.rps > 0 ? (b.rps / s.rps).toFixed(2) : 'n/a'
    const fail = (s.failed || b.failed) ? `  [failed S=${s.failed} B=${b.failed}]` : ''
    console.log(`  ${String(c).padEnd(4)} ${String(Math.round(s.rps)).padStart(8)}     (${s.p50})      ${String(Math.round(b.rps)).padStart(7)}    (${b.p50})       ${ratio}x${fail}`)
  }
} finally {
  adServer.kill(); bunServer.kill()
  await Promise.allSettled([adServer.exited, bunServer.exited])
  rmSync(dir, { recursive: true, force: true })
}
