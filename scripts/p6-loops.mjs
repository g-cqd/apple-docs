// RFC 0001 P6 — event-loop-count sweep. The classic EL-handler ad-server
// degrades under concurrency with ELG=2 (throughput drops below c=1). This
// boots ad-server at a range of --loops (event-loop counts) and drives ab -c16
// against each, to test whether the ELG (not the serving model) bounds scaling.
//
//   bun scripts/p6-loops.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const THREADS = 8
const PORT = 3034
const N = 6000
const LOOPS = [2, 4, 6, 8, 10]
const CS = [1, 8, 16]
const QUERY = 'q=view&limit=100'

const dir = mkdtempSync(join(tmpdir(), 'p6-loops-'))
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

async function waitHealthz(port) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) { await r.text(); return } } catch {}
    await Bun.sleep(80)
  }
  throw new Error(`:${port} never healthy`)
}
async function ab(url, c) {
  const p = Bun.spawn(['ab', '-k', '-c', String(c), '-n', String(N), url], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return { rps: Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0), p50: Number(out.match(/\s+50%\s+(\d+)/)?.[1] ?? 0), failed: Number(out.match(/Failed requests:\s+(\d+)/)?.[1] ?? 0) }
}

const url = `http://127.0.0.1:${PORT}/search?${QUERY}`
console.log(`\n=== ELG sweep (threads=${THREADS}, ab -k n=${N}, query: ${QUERY}) ===`)
console.log(`  loops │  ${CS.map((c) => `c=${c} rps (p50ms)`).join('   ')}`)
for (const loops of LOOPS) {
  const srv = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', String(THREADS), '--loops', String(loops)], { stdout: 'ignore', stderr: 'ignore' })
  try {
    await waitHealthz(PORT)
    await ab(url, 8) // warm
    const cells = []
    for (const c of CS) { const r = await ab(url, c); cells.push(`${String(Math.round(r.rps)).padStart(5)} (${String(r.p50).padStart(3)})${r.failed ? '!' : ''}`) }
    console.log(`  ${String(loops).padStart(5)} │  ${cells.join('     ')}`)
  } finally {
    srv.kill(); await srv.exited
    await Bun.sleep(150)
  }
}
rmSync(dir, { recursive: true, force: true })
