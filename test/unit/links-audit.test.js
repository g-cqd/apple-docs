import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { linksAudit } from '../../src/commands/links.js'

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
