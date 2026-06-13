// Seeds the P6 benchmark corpus (8 frameworks × 60 docs) at argv[2], then
// prints the JS searchPages reference for argv[3] (default "view", framework
// swiftui) — for the ad-server spot-parity + --bench diagnostic.
import { DocsDatabase } from '../src/storage/database.js'

const dbPath = process.argv[2]
const q = process.argv[3] ?? 'view'
if (!dbPath) {
  console.error('usage: bun scripts/p6-seed.mjs <db-path> [query]')
  process.exit(2)
}
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller']

const db = new DocsDatabase(dbPath)
for (const fw of FRAMEWORKS) db.upsertRoot(fw, fw.toUpperCase(), 'framework', 'seed')
for (const fw of FRAMEWORKS) {
  for (let i = 0; i < 60; i++) {
    const t = TERMS[i % TERMS.length]
    db.upsertDocument({
      key: `${fw}/sym${i}`, title: `${t[0].toUpperCase()}${t.slice(1)}${i}`, framework: fw,
      sourceType: 'apple-docc', role: 'symbol', kind: 'struct', language: 'swift', urlDepth: 2,
      abstractText: `A ${t} that manages ${TERMS[(i * 3) % TERMS.length]} for the ${fw} view layer.`,
    })
  }
}
process.stdout.write(JSON.stringify(db.searchPages(q, q, { framework: 'swiftui', limit: 100 })).slice(0, 200))
db.close()
