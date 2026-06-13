/**
 * Byte-parity gate for the native lexical search cascade (RFC 0001 P6). The
 * Swift /search endpoint (ad-server → ADSearchCascade, in-process) must
 * produce the SAME JSON as JS search()→projectSearchResult for the lexical
 * subset (T1 title-exact + FTS, T2 trigram, merge, intent, rerank,
 * projection). The JS reference runs with noDeep + fuzzy:false + no semantic
 * vectors so both sides do T1+T2+rerank+project only; snippet/relatedCount
 * enrichment is phase 2, stripped from both sides here.
 *
 * Boots ad-server (release) as a subprocess and compares over HTTP. Skipped
 * when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'
import { search } from '../../../src/commands/search.js'
import { projectSearchResult } from '../../../src/output/projection.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PORT = 3039
let dir
let db
let server
let ready = false

const DOCS = [
  { key: 'swiftui/view', title: 'View', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Protocol', kind: 'protocol', language: 'swift', abstractText: 'A type that represents part of your app interface.', urlDepth: 2 },
  { key: 'swiftui/viewbuilder', title: 'ViewBuilder', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'Constructs views from closures.', urlDepth: 3 },
  { key: 'swiftui/contentview', title: 'ContentView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'The root view of an app.', urlDepth: 2, isBeta: true },
  { key: 'swiftui/legacyview', title: 'LegacyView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'swift', abstractText: 'An old deprecated view API.', urlDepth: 2, isDeprecated: true },
  { key: 'swiftui/building-views', title: 'Building views with SwiftUI', framework: 'swiftui', sourceType: 'apple-docc', role: 'article', roleHeading: 'Article', kind: 'article', language: 'swift', abstractText: 'How to build views. A tutorial.', urlDepth: 2 },
  { key: 'uikit/uiview', title: 'UIView', framework: 'uikit', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'occ', abstractText: 'Manages content for a rectangular view area.', urlDepth: 2 },
  { key: 'hig/views', title: 'Views', framework: 'hig', sourceType: 'hig', role: 'article', roleHeading: 'Article', kind: 'article', language: 'both', abstractText: 'Design guidance for views.', urlDepth: 2 },
  { key: 'samples/view-sample', title: 'View sample code', framework: 'swiftui', sourceType: 'sample-code', role: 'sample', roleHeading: 'Sample Code', kind: 'sample', language: 'swift', abstractText: 'A sample showing a view.', urlDepth: 2 },
  { key: 'swiftui/release-notes/2024', title: 'SwiftUI release notes', framework: 'swiftui', sourceType: 'apple-docc', role: 'article', roleHeading: 'Article', kind: 'article', language: 'swift', abstractText: 'What changed in views this year.', urlDepth: 3, isReleaseNotes: true },
  // Long abstract with the query term mid-text → exercises the snippet window +
  // both `...` ellipses (the term is not at index 0 and the text exceeds 220).
  { key: 'swiftui/layout-guide', title: 'SwiftUI Layout', framework: 'swiftui', sourceType: 'apple-docc', role: 'article', roleHeading: 'Article', kind: 'article', language: 'swift', abstractText: 'Build adaptive, data-driven interfaces that fit every Apple platform and device size class, and learn how to compose a navigation hierarchy that moves between screens while preserving scroll position, deep links, and accessibility focus across the entire user journey from launch through to a detail screen.', urlDepth: 2 },
  // Platform-availability docs (slice 4) — exercise the platform '0' sentinel +
  // the version compare. platview has iOS+macOS; deskview is macOS-only (so a
  // platform=ios filter must EXCLUDE it via the explicit-keys check).
  { key: 'swiftui/platview', title: 'PlatView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'A view available on iOS and macOS.', urlDepth: 2, platformsJson: { ios: '17.0', macos: '14.0', ipados: '17.0' }, minIos: '17.0', minMacos: '14.0' },
  { key: 'swiftui/deskview', title: 'DeskView', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'A desktop-only view for macOS apps.', urlDepth: 2, platformsJson: { macos: '15.0' }, minMacos: '15.0' },
]
const QUERIES = ['view', 'View', 'ViewBuilder', 'building views', 'uiview', 'guide', 'design', 'nonexistentxyz', 'AVAudioSession.RouteSharingPolicy', 'navigation', 'frobnicator', 'uivew', 'contentvieww', 'how do you represent app interface parts', 'deprecated programming interface guidance']

// Filtered queries (slice 4): { q, opts (JS search bag), qs (Swift query string) }.
const FILTERED = [
  { label: 'kind=protocol', q: 'view', opts: { kind: 'protocol' }, qs: 'kind=protocol' },
  { label: 'kind=Article', q: 'views', opts: { kind: 'Article' }, qs: 'kind=Article' },
  { label: 'kind=class', q: 'view', opts: { kind: 'class' }, qs: 'kind=class' },
  { label: 'framework=uikit', q: 'view', opts: { framework: 'uikit' }, qs: 'framework=uikit' },
  { label: 'framework=swiftui', q: 'view', opts: { framework: 'swiftui' }, qs: 'framework=swiftui' },
  { label: 'source=hig', q: 'view', opts: { source: 'hig' }, qs: 'source=hig' },
  { label: 'source=multi', q: 'view', opts: { source: 'apple-docc,sample-code' }, qs: 'source=' + encodeURIComponent('apple-docc,sample-code') },
  { label: 'language=occ', q: 'view', opts: { language: 'occ' }, qs: 'language=occ' },
  { label: 'language=swift', q: 'view', opts: { language: 'swift' }, qs: 'language=swift' },
  { label: 'deprecated=only', q: 'view', opts: { deprecated: 'only' }, qs: 'deprecated=only' },
  { label: 'deprecated=exclude', q: 'view', opts: { deprecated: 'exclude' }, qs: 'deprecated=exclude' },
  { label: 'framework+kind', q: 'view', opts: { framework: 'swiftui', kind: 'struct' }, qs: 'framework=swiftui&kind=struct' },
  { label: 'platform=ios', q: 'view', opts: { platform: 'ios' }, qs: 'platform=ios' },
  { label: 'platform=tvos', q: 'view', opts: { platform: 'tvos' }, qs: 'platform=tvos' },
  { label: 'minIos=18.0', q: 'view', opts: { minIos: '18.0' }, qs: 'minIos=18.0' },
  { label: 'minIos=16.0', q: 'view', opts: { minIos: '16.0' }, qs: 'minIos=16.0' },
  { label: 'minMacos=14.5', q: 'view', opts: { minMacos: '14.5' }, qs: 'minMacos=14.5' },
]

if (existsSync(AD_SERVER)) {
  dir = mkdtempSync(join(tmpdir(), 'cascade-parity-'))
  const dbPath = join(dir, 'corpus.db')
  const seed = new DocsDatabase(dbPath)
  seed.upsertRoot('swiftui', 'SwiftUI', 'framework', 'seed')
  seed.upsertRoot('uikit', 'UIKit', 'framework', 'seed')
  seed.upsertRoot('hig', 'Human Interface Guidelines', 'guide', 'seed')
  for (const d of DOCS) seed.upsertDocument(d)
  // Enrichment fixtures (RFC 0001 P6 slice 1): sections (one plain TEXT, one
  // zstd-compacted BLOB → exercises the section codec + the decompress binding)
  // + relationships (relatedCount > 0). Both the Swift and JS paths read these.
  const viewId = seed.db.query('SELECT id FROM documents WHERE key = ?').get('swiftui/view').id
  seed.replaceDocumentSections(viewId, [
    { sectionKind: 'discussion', heading: 'Overview', contentText: 'A view is the fundamental building block of a SwiftUI interface; you compose small views into a navigation hierarchy and layout that adapts to every device.', sortOrder: 0 },
    { sectionKind: 'discussion', heading: 'Storage', contentText: Buffer.from(Bun.zstdCompressSync(Buffer.from('This discussion section is stored zstd-compacted to exercise the decompress binding from the Swift section codec, end to end.'))), sortOrder: 1 },
  ])
  seed.replaceDocumentRelationships('swiftui/view', [
    { toKey: 'swiftui/viewbuilder', relationType: 'seeAlso' },
    { toKey: 'swiftui/contentview', relationType: 'conformsTo' },
  ])
  // Body index (T4 fallback): a term that appears ONLY in the body, so a query
  // for it misses T1+T2 (title/abstract) and is found via the body tier.
  seed.insertBody(viewId, 'An extended discussion covering frobnicator internals, gizmo lifecycles, and widget composition patterns.')
  seed.close()
  db = new DocsDatabase(dbPath)
  server = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', '2'], { stdout: 'ignore', stderr: 'ignore' })
}

describe.skipIf(!existsSync(AD_SERVER))('search-cascade parity (Swift /search == JS search)', () => {
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { ready = true; break } } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    server?.kill()
    db?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('ad-server is reachable', () => {
    expect(ready).toBe(true)
  })

  for (const q of QUERIES) {
    test(`byte-identical: "${q}"`, async () => {
      const ctx = { db, logger: { debug() {}, warn() {}, info() {} } }
      const result = await search({ query: q, limit: 10, offset: 0, noDeep: false, fuzzy: true }, ctx)
      const projected = projectSearchResult(result, { webPaths: false })
      const expected = JSON.stringify(projected)
      const swift = await (await fetch(`http://127.0.0.1:${PORT}/search?q=${encodeURIComponent(q)}&limit=10`)).text()
      expect(swift).toBe(expected)
    })
  }

  for (const f of FILTERED) {
    test(`filtered byte-identical: ${f.label}`, async () => {
      const ctx = { db, logger: { debug() {}, warn() {}, info() {} } }
      const result = await search({ query: f.q, limit: 10, offset: 0, noDeep: false, fuzzy: true, ...f.opts }, ctx)
      const projected = projectSearchResult(result, { webPaths: false })
      const expected = JSON.stringify(projected)
      const swift = await (await fetch(`http://127.0.0.1:${PORT}/search?q=${encodeURIComponent(f.q)}&limit=10&${f.qs}`)).text()
      expect(swift).toBe(expected)
    })
  }
})
