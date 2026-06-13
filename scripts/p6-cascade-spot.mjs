// P6 cascade spot-parity: seed a rich corpus, boot ad-server, and compare the
// Swift /search JSON to the JS search()→projectSearchResult JSON byte-for-byte
// over a query matrix. Lexical subset → JS runs with noDeep + fuzzy:false + no
// semantic vectors so both sides do T1+T2+rerank+project only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { DocsDatabase } from '../src/storage/database.js'
import { search } from '../src/commands/search.js'
import { projectSearchResult } from '../src/output/projection.js'

const AD_SERVER = new URL("../swift/.build/release/ad-server", import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'p6-cascade-'))
const dbPath = join(dir, 'corpus.db')
const db = new DocsDatabase(dbPath)

// Rich seed: varied sourceType / kind / deprecated / release-notes / depth /
// titles (tier 0-3) so the rerank rules + intents + tier merge are exercised.
db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'seed')
db.upsertRoot('uikit', 'UIKit', 'framework', 'seed')
db.upsertRoot('hig', 'Human Interface Guidelines', 'guide', 'seed')
const docs = [
  { key: 'swiftui/view', title: 'View', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Protocol', kind: 'protocol', language: 'swift', abstractText: 'A type that represents part of your app interface.', urlDepth: 2 },
  { key: 'swiftui/viewbuilder', title: 'ViewBuilder', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'Constructs views from closures.', urlDepth: 3 },
  { key: 'swiftui/contentview', title: 'ContentView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'The root view of an app.', urlDepth: 2, isBeta: true },
  { key: 'swiftui/canvas', title: 'Canvas', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'Renders a 2D view with drawing.', urlDepth: 4 },
  { key: 'swiftui/legacyview', title: 'LegacyView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'swift', abstractText: 'An old deprecated view API.', urlDepth: 2, isDeprecated: true },
  { key: 'swiftui/building-views', title: 'Building views with SwiftUI', framework: 'swiftui', sourceType: 'apple-docc', role: 'article', roleHeading: 'Article', kind: 'article', language: 'swift', abstractText: 'How to build views. A tutorial.', urlDepth: 2 },
  { key: 'uikit/uiview', title: 'UIView', framework: 'uikit', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'occ', abstractText: 'Manages content for a rectangular view area.', urlDepth: 2 },
  { key: 'hig/views', title: 'Views', framework: 'hig', sourceType: 'hig', role: 'article', roleHeading: 'Article', kind: 'article', language: 'both', abstractText: 'Design guidance for views.', urlDepth: 2 },
  { key: 'samples/view-sample', title: 'View sample code', framework: 'swiftui', sourceType: 'sample-code', role: 'sample', roleHeading: 'Sample Code', kind: 'sample', language: 'swift', abstractText: 'A sample showing a view.', urlDepth: 2 },
  { key: 'swiftui/release-notes/2024', title: 'SwiftUI release notes', framework: 'swiftui', sourceType: 'apple-docc', role: 'article', roleHeading: 'Article', kind: 'article', language: 'swift', abstractText: 'What changed in views this year.', urlDepth: 3, isReleaseNotes: true },
]
for (const d of docs) db.upsertDocument(d)
db.close()

const adServer = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', '3037', '--threads', '4'], { stdout: 'ignore', stderr: 'inherit' })
const ro = new DocsDatabase(dbPath)
const ctx = { db: ro, logger: { debug() {}, warn() {}, info() {} } }

async function waitHealthz() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://127.0.0.1:3037/healthz')).ok) return } catch {}
    await Bun.sleep(80)
  }
  throw new Error('ad-server never healthy')
}

const CASES = ['view', 'View', 'ViewBuilder', 'building views', 'uiview', 'nonexistentxyz', 'AVAudioSession.RouteSharingPolicy']
try {
  await waitHealthz()
  let pass = 0
  for (const q of CASES) {
    const jsResult = await search({ query: q, limit: 10, offset: 0, noDeep: true, fuzzy: false }, ctx)
    const jsProjected = projectSearchResult(jsResult, { webPaths: false })
    // Phase 1: enrichment (snippet/relatedCount) is deferred — strip it from both sides.
    for (const r of jsProjected.results) { delete r.snippet; delete r.relatedCount }
    const jsJson = JSON.stringify(jsProjected)
    const swiftJson = await (await fetch(`http://127.0.0.1:3037/search?q=${encodeURIComponent(q)}&limit=10`)).text()
    if (jsJson === swiftJson) {
      pass++
      console.log(`✓ "${q}"`)
    } else {
      console.log(`✗ "${q}"`)
      console.log(`  JS   : ${jsJson.slice(0, 400)}`)
      console.log(`  Swift: ${swiftJson.slice(0, 400)}`)
    }
  }
  console.log(`\n${pass}/${CASES.length} byte-identical`)
} finally {
  adServer.kill()
  await adServer.exited
  ro.close()
  rmSync(dir, { recursive: true, force: true })
}
