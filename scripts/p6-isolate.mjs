// RFC 0001 P6 — pin the cascade's concurrency contention by stage. ad-server
// exposes three diagnostic granularities of the SAME per-request work:
//   /search-rawscan  3 tier SQL, COUNT only        (SQLite scan, no decode)
//   /search-decode   + SearchRow String decode     (no merge/rerank/JSON)
//   /search          + merge/rerank/projection      (full)
// Sweeping c=1/4/8/16 across all three localizes which STAGE carries the
// negative thread scaling: if -rawscan scales but -decode/full degrade, it is
// the Swift String decode / post-processing (fixable); if -rawscan also
// degrades, it is the SQLite-in-Swift layer.
//
//   bun scripts/p6-isolate.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const THREADS = 8
const PORT = 3038
const N = 6000
const CS = [1, 4, 8, 16]
const QUERY = 'q=view&limit=100'
const PATHS = ['/search-rawscan', '/search-decode', '/search']

const dir = mkdtempSync(join(tmpdir(), 'p6-isolate-'))
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
async function ab(path, c) {
  const p = Bun.spawn(['ab', '-k', '-c', String(c), '-n', String(N), `http://127.0.0.1:${PORT}${path}?${QUERY}`], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return Math.round(Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0))
}

const srv = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', String(THREADS), '--loops', '2'], { stdout: 'ignore', stderr: 'ignore' })
try {
  await waitHealthz()
  for (const p of PATHS) { const r = await (await fetch(`http://127.0.0.1:${PORT}${p}?${QUERY}`)).text(); console.log(`  ${p} -> ${r.slice(0, 60)}`) }
  await ab('/search', 8) // warm
  console.log(`\n=== stage isolation (threads=${THREADS}, ab -k n=${N}, ${QUERY}) ===`)
  console.log(`  stage             ${CS.map((c) => `c=${c}`.padStart(7)).join('  ')}   c16/c1`)
  for (const path of PATHS) {
    const rps = []
    for (const c of CS) rps.push(await ab(path, c))
    const scale = (rps[rps.length - 1] / rps[0]).toFixed(2)
    console.log(`  ${path.padEnd(16)} ${rps.map((r) => String(r).padStart(7)).join('  ')}   ${scale}x`)
  }
} finally {
  srv.kill(); await srv.exited
  rmSync(dir, { recursive: true, force: true })
}
