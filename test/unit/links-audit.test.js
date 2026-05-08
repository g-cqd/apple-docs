import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { linksAudit, linksConsolidate } from '../../src/commands/links.js'

const tempDirs = []

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const dir = join(tmpdir(), `apple-docs-links-${crypto.randomUUID()}`)
  mkdirSync(join(dir, 'docs', 'swiftui'), { recursive: true })
  mkdirSync(join(dir, 'docs', 'swift-org'), { recursive: true })
  tempDirs.push(dir)

  // A simple page with a mix of link types.
  writeFileSync(join(dir, 'docs', 'swiftui', 'index.html'), `<!DOCTYPE html>
<html>
  <body>
    <nav class="breadcrumbs"><a href="/docs/swiftui/">SwiftUI</a> / <a href="/docs/swiftui/missing/">Missing</a></nav>
    <article>
      <p><a href="/docs/swiftui/view/">view</a></p>
      <p><a href="https://developer.apple.com/documentation/swiftui/view">apple.com view</a></p>
      <p><a href="https://forums.swift.org/t/abc">forums</a></p>
      <p><a href="/install">install (relative-broken)</a></p>
      <p><a href="#section">anchor</a></p>
    </article>
  </body>
</html>`)
  writeFileSync(join(dir, 'docs', 'swift-org', 'index.html'), `<!DOCTYPE html>
<html><body><article><a href="/docs/swift-org/install/">install</a></article></body></html>`)

  const db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
  db.upsertRoot('swift-org', 'Swift.org', 'collection', 'swift-org')
  db.upsertPage({
    rootId: db.getRootBySlug('swiftui').id,
    path: 'swiftui',
    url: 'https://developer.apple.com/documentation/swiftui',
    title: 'SwiftUI', sourceType: 'apple-docc',
  })
  db.upsertPage({
    rootId: db.getRootBySlug('swiftui').id,
    path: 'swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View', sourceType: 'apple-docc',
  })
  db.upsertPage({
    rootId: db.getRootBySlug('swift-org').id,
    path: 'swift-org/install',
    url: 'https://swift.org/install',
    title: 'Install', sourceType: 'swift-org',
  })

  return { dir, db }
}

describe('linksAudit', () => {
  test('classifies every link by category and section', async () => {
    const { dir, db } = setup()
    const result = await linksAudit({ outDir: dir }, { db, logger: { info() {} } })
    db.close()

    expect(result.filesScanned).toBe(2)
    expect(result.linksTotal).toBe(8)
    expect(result.byCategory.internal_ok).toBe(3)        // /docs/swiftui/, /docs/swiftui/view/, /docs/swift-org/install/
    expect(result.byCategory.internal_broken).toBe(1)    // /docs/swiftui/missing/
    expect(result.byCategory.external_resolvable).toBe(1) // apple.com/swiftui/view → swiftui/view
    expect(result.byCategory.external).toBe(1)            // forums.swift.org
    expect(result.byCategory.relative_broken).toBe(1)     // /install
    expect(result.byCategory.fragment).toBe(1)
  })

  test('attributes links to their containing section', async () => {
    const { dir, db } = setup()
    const result = await linksAudit({ outDir: dir }, { db, logger: { info() {} } })
    db.close()

    expect(result.bySection.breadcrumb).toBe(2)
    expect(result.bySection.article).toBeGreaterThanOrEqual(5)
  })

  test('reports top broken-internal targets with sample sources', async () => {
    const { dir, db } = setup()
    const result = await linksAudit({ outDir: dir }, { db, logger: { info() {} } })
    db.close()

    expect(result.topBrokenInternal.length).toBeGreaterThanOrEqual(1)
    const top = result.topBrokenInternal[0]
    expect(top.value).toBe('swiftui/missing')
    expect(top.count).toBe(1)
    expect(top.sources[0]).toContain('/docs/swiftui/')
  })

  test('reports top external-resolvable URLs', async () => {
    const { dir, db } = setup()
    const result = await linksAudit({ outDir: dir }, { db, logger: { info() {} } })
    db.close()

    const apple = result.topExternalResolvable.find(e => e.value === 'swiftui/view')
    expect(apple).toBeDefined()
    expect(apple.count).toBe(1)
  })

  test('throws when outDir does not exist', async () => {
    const db = new DocsDatabase(':memory:')
    await expect(
      linksAudit({ outDir: '/nonexistent/path' }, { db, logger: { info() {} } }),
    ).rejects.toThrow(/does not exist/)
    db.close()
  })
})

function seedDoc(db, { key, sourceType = 'apple-docc', framework, contentJson }) {
  const root = db.getRootBySlug(framework) ?? db.upsertRoot(framework, framework, 'framework', sourceType)
  db.upsertPage({
    rootId: root.id,
    path: key,
    url: `https://developer.apple.com/documentation/${key}`,
    title: key.split('/').pop(),
    sourceType,
  })
  db.upsertNormalizedDocument({
    document: {
      sourceType,
      key,
      title: key.split('/').pop(),
      kind: 'article',
      framework,
      url: `https://developer.apple.com/documentation/${key}`,
    },
    sections: [
      {
        sectionKind: 'discussion',
        heading: 'Overview',
        contentText: 'placeholder',
        contentJson,
        sortOrder: 0,
      },
    ],
    relationships: [],
  })
}

describe('linksConsolidate', () => {
  test('adds _resolvedKey to link nodes whose destination maps to a known key', async () => {
    const db = new DocsDatabase(':memory:')
    seedDoc(db, {
      key: 'wwdc/wwdc2024-10001',
      sourceType: 'wwdc',
      framework: 'wwdc',
      contentJson: JSON.stringify([{
        type: 'paragraph',
        inlineContent: [
          { type: 'link', destination: 'https://developer.apple.com/videos/play/wwdc2024/10001/', title: 'Session' },
          { type: 'link', destination: 'https://forums.swift.org/t/123', title: 'External' },
        ],
      }]),
    })

    const result = await linksConsolidate({}, { db, logger: { info() {} } })
    expect(result.added).toBe(1)
    expect(result.removed).toBe(0)
    expect(result.sectionsTouched).toBe(1)

    const stored = db.db.query('SELECT content_json FROM document_sections').get().content_json
    const parsed = JSON.parse(stored)
    expect(parsed[0].inlineContent[0]._resolvedKey).toBe('wwdc/wwdc2024-10001')
    expect(parsed[0].inlineContent[1]._resolvedKey).toBeUndefined()
    db.close()
  })

  test('removes _resolvedKey when the target no longer exists in the corpus', async () => {
    const db = new DocsDatabase(':memory:')
    seedDoc(db, {
      key: 'orphan',
      framework: 'orphan',
      contentJson: JSON.stringify([{
        type: 'paragraph',
        inlineContent: [{ type: 'reference', identifier: 'foo', _resolvedKey: 'missing/page' }],
      }]),
    })

    const result = await linksConsolidate({}, { db, logger: { info() {} } })
    expect(result.removed).toBe(1)
    const parsed = JSON.parse(db.db.query('SELECT content_json FROM document_sections').get().content_json)
    expect(parsed[0].inlineContent[0]._resolvedKey).toBeUndefined()
    db.close()
  })

  test('--dry-run reports counts without writing to the DB', async () => {
    const db = new DocsDatabase(':memory:')
    seedDoc(db, {
      key: 'swiftui/view',
      framework: 'swiftui',
      contentJson: JSON.stringify([{
        type: 'link', destination: 'https://developer.apple.com/documentation/swiftui/view',
      }]),
    })

    const result = await linksConsolidate({ dryRun: true }, { db, logger: { info() {} } })
    expect(result.added).toBe(1)
    const stored = JSON.parse(db.db.query('SELECT content_json FROM document_sections').get().content_json)
    expect(stored[0]._resolvedKey).toBeUndefined() // not written in dry-run mode
    db.close()
  })

  test('idempotent — re-running produces no further changes', async () => {
    const db = new DocsDatabase(':memory:')
    seedDoc(db, {
      key: 'swiftui/view',
      framework: 'swiftui',
      contentJson: JSON.stringify([{
        type: 'link', destination: 'https://developer.apple.com/documentation/swiftui/view',
      }]),
    })

    await linksConsolidate({}, { db, logger: { info() {} } })
    const second = await linksConsolidate({}, { db, logger: { info() {} } })
    expect(second.added).toBe(0)
    expect(second.removed).toBe(0)
    expect(second.sectionsTouched).toBe(0)
    db.close()
  })
})
