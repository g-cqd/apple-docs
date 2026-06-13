// RFC 0001 P6 — confirm the cascade's concurrency NO-GO is system-allocator
// contention. Boots ad-server twice — default libmalloc vs MallocNanoZone=0
// (disables macOS's nano allocator, whose per-magazine locks contend under
// concurrent small-allocation churn) — and sweeps c=4/8/16 on the heavy query.
// If NanoZone=0 raises throughput / restores positive scaling, the String-heavy
// row decode's allocation is the bottleneck (not the SwiftNIO serving model).
//
//   bun scripts/p6-malloc.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AD_SERVER = new URL('../swift/.build/release/ad-server', import.meta.url).pathname
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']
const PORT = 3036
const N = 6000
const CS = [4, 8, 16]

const dir = mkdtempSync(join(tmpdir(), 'p6-malloc-'))
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
async function ab(c) {
  const p = Bun.spawn(['ab', '-k', '-c', String(c), '-n', String(N), `http://127.0.0.1:${PORT}/search?q=view&limit=100`], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(p.stdout).text()
  await p.exited
  return Math.round(Number(out.match(/Requests per second:\s+([\d.]+)/)?.[1] ?? 0))
}
async function run(label, env) {
  const srv = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', '8', '--loops', '2'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...env } })
  try {
    await waitHealthz()
    await ab(8) // warm
    const cells = []
    for (const c of CS) cells.push(`c=${c}: ${String(await ab(c)).padStart(5)}`)
    console.log(`  ${label.padEnd(22)} ${cells.join('   ')}`)
  } finally { srv.kill(); await srv.exited; await Bun.sleep(150) }
}

try {
  console.log(`\n=== allocator attribution (query=view, threads=8, ab -k n=${N}) ===`)
  await run('default libmalloc', {})
  await run('MallocNanoZone=0', { MallocNanoZone: '0' })
} finally {
  rmSync(dir, { recursive: true, force: true })
}
