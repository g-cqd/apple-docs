import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { snapshotBuild } from '../../src/commands/snapshot.js'
import { setup } from '../../src/commands/setup.js'
import { status } from '../../src/commands/status.js'
import { search } from '../../src/commands/search.js'
import { lookup } from '../../src/commands/lookup.js'
import { rebuildBody, rebuildTrigram } from '../../src/commands/index-rebuild.js'
import { createLogger } from '../../src/lib/logger.js'
import { writeJSON, writeText } from '../../src/storage/files.js'

const originalFetch = globalThis.fetch
const logger = createLogger('error')
const cleanupDirs = []

function trackDir(dir) {
  cleanupDirs.push(dir)
  return dir
}

async function seedSnapshotSource(dataDir) {
  const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

  db.upsertPage({
    rootId: root.id,
    path: 'swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app UI.',
    declaration: 'protocol View',
    sourceType: 'apple-docc',
  })

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
      framework: 'swiftui',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      abstractText: 'A type that represents part of your app UI.',
      declarationText: 'protocol View',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app UI.', sortOrder: 0 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'Use this to compose SwiftUI interfaces.', sortOrder: 1 },
    ],
    relationships: [],
  })

  mkdirSync(join(dataDir, 'raw-json', 'swiftui'), { recursive: true })
  mkdirSync(join(dataDir, 'markdown', 'swiftui'), { recursive: true })
  await writeJSON(join(dataDir, 'raw-json', 'swiftui', 'view.json'), {
    metadata: { title: 'View' },
    abstract: [{ type: 'text', text: 'A type that represents part of your app UI.' }],
  })
  await writeText(
    join(dataDir, 'markdown', 'swiftui', 'view.md'),
    '# View\n\nA type that represents part of your app UI.\n\n## Overview\n\nUse this to compose SwiftUI interfaces.\n',
  )

  return db
}

async function buildReleaseFixture() {
  const sourceDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-release-source-')))
  const outDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-release-out-')))
  const sourceDb = await seedSnapshotSource(sourceDir)

  try {
    const result = await snapshotBuild({ out: outDir, tag: 'test-full-1' }, { db: sourceDb, dataDir: sourceDir, logger })
    return {
      tag: result.tag,
      archiveUrl: 'https://fake.github.com/full.tar.gz',
      checksumUrl: 'https://fake.github.com/full.sha256',
      archiveBytes: await Bun.file(result.archivePath).arrayBuffer(),
      checksumText: await Bun.file(result.checksumPath).text(),
    }
  } finally {
    sourceDb.close()
  }
}

function installReleaseMock(fixture) {
  globalThis.fetch = mock(async (url, opts) => {
    const urlStr = String(url)

    if (urlStr.includes('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: fixture.tag,
        published_at: '2026-04-13T00:00:00Z',
        assets: [
          {
            name: `apple-docs-full-${fixture.tag}.tar.gz`,
            size: fixture.archiveBytes.byteLength,
            browser_download_url: fixture.archiveUrl,
          },
          {
            name: `apple-docs-full-${fixture.tag}.tar.gz.sha256`,
            size: fixture.checksumText.length,
            browser_download_url: fixture.checksumUrl,
          },
        ],
      }), { status: 200 })
    }

    if (urlStr === fixture.archiveUrl) return new Response(fixture.archiveBytes, { status: 200 })
    if (urlStr === fixture.checksumUrl) return new Response(fixture.checksumText, { status: 200 })

    return originalFetch(url, opts)
  })
}

function openCtx(dataDir) {
  const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  return {
    db,
    dataDir,
    logger,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('setup release smoke', () => {
  test('snapshot setup preserves raw and markdown payloads + body index works', async () => {
    const fixture = await buildReleaseFixture()
    installReleaseMock(fixture)
    const installDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-install-')))

    const setupCtx = openCtx(installDir)
    const result = await setup({ skipResources: true }, setupCtx)
    expect(result.status).toBe('ok')
    expect(result.tier).toBe('full')

    expect(existsSync(join(installDir, 'raw-json', 'swiftui', 'view.json'))).toBe(true)
    expect(existsSync(join(installDir, 'markdown', 'swiftui', 'view.md'))).toBe(true)
    setupCtx.db.close()

    const liveCtx = openCtx(installDir)
    const currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.tier).toBe('full')
    expect(currentStatus.capabilities.readContent).toBe(true)

    const fullLookup = await lookup({ path: 'swiftui/view' }, liveCtx)
    expect(fullLookup.content).toContain('# View')
    expect(fullLookup.content).toContain('Use this to compose SwiftUI interfaces.')

    const searchHit = await search({ query: 'View', noDeep: true }, liveCtx)
    expect(searchHit.results[0].path).toBe('swiftui/view')

    const trigramResult = await rebuildTrigram({}, liveCtx)
    expect(trigramResult.status).toBe('ok')

    const bodyResult = await rebuildBody({}, liveCtx)
    expect(bodyResult.indexed).toBeGreaterThan(0)
    liveCtx.db.close()
  })
})
