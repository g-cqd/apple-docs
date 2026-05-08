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

async function buildReleaseFixtures() {
  const sourceDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-release-source-')))
  const outDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-release-out-')))
  const sourceDb = await seedSnapshotSource(sourceDir)

  try {
    const lite = await snapshotBuild({ tier: 'lite', out: outDir, tag: 'test-lite-1' }, { db: sourceDb, dataDir: sourceDir, logger })
    const standard = await snapshotBuild({ tier: 'standard', out: outDir, tag: 'test-standard-1' }, { db: sourceDb, dataDir: sourceDir, logger })
    const full = await snapshotBuild({ tier: 'full', out: outDir, tag: 'test-full-1' }, { db: sourceDb, dataDir: sourceDir, logger })

    const fixtures = {}
    for (const result of [lite, standard, full]) {
      const archiveUrl = `https://fake.github.com/${result.tier}.tar.gz`
      const checksumUrl = `https://fake.github.com/${result.tier}.sha256`
      fixtures[result.tier] = {
        tag: result.tag,
        archiveUrl,
        checksumUrl,
        archiveBytes: await Bun.file(result.archivePath).arrayBuffer(),
        checksumText: await Bun.file(result.checksumPath).text(),
      }
    }

    return fixtures
  } finally {
    sourceDb.close()
  }
}

function installReleaseMock(fixtures) {
  let currentTier = 'standard'
  globalThis.fetch = mock(async (url, opts) => {
    const urlStr = String(url)
    const current = fixtures[currentTier]

    if (urlStr.includes('/releases/latest')) {
      return new Response(JSON.stringify({
        tag_name: current.tag,
        published_at: '2026-04-13T00:00:00Z',
        assets: [
          {
            name: `apple-docs-${currentTier}-${current.tag}.tar.gz`,
            size: current.archiveBytes.byteLength,
            browser_download_url: current.archiveUrl,
          },
          {
            name: `apple-docs-${currentTier}-${current.tag}.sha256`,
            size: current.checksumText.length,
            browser_download_url: current.checksumUrl,
          },
        ],
      }), { status: 200 })
    }

    for (const fixture of Object.values(fixtures)) {
      if (urlStr === fixture.archiveUrl) {
        return new Response(fixture.archiveBytes, { status: 200 })
      }
      if (urlStr === fixture.checksumUrl) {
        return new Response(fixture.checksumText, { status: 200 })
      }
    }

    return originalFetch(url, opts)
  })

  return {
    setCurrentTier(tier) {
      currentTier = tier
    },
  }
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
  test('lite install, standard upgrade, and downgrade transitions behave correctly', async () => {
    const fixtures = await buildReleaseFixtures()
    const releases = installReleaseMock(fixtures)
    const installDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-install-')))

    releases.setCurrentTier('lite')
    let setupCtx = openCtx(installDir)
    const liteSetup = await setup({ tier: 'lite', skipResources: true }, setupCtx)
    expect(liteSetup.status).toBe('ok')
    expect(liteSetup.tier).toBe('lite')

    let liveCtx = openCtx(installDir)
    let currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.tier).toBe('lite')
    expect(currentStatus.capabilities.readContent).toBe(false)
    expect(currentStatus.capabilities.searchTrigram).toBe(false)

    const liteSearch = await search({ query: 'View', noDeep: true }, liveCtx)
    expect(liteSearch.results[0].path).toBe('swiftui/view')

    const liteLookup = await lookup({ path: 'swiftui/view' }, liveCtx)
    expect(liteLookup.content).toBeNull()
    expect(liteLookup.tierLimitation?.tier).toBe('lite')

    const trigramResult = await rebuildTrigram({}, liveCtx)
    expect(trigramResult.status).toBe('ok')

    currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.capabilities.searchTrigram).toBe(true)

    const liteBodyResult = await rebuildBody({}, liveCtx)
    expect(liteBodyResult.status).toBe('error')
    liveCtx.db.close()

    releases.setCurrentTier('standard')
    setupCtx = openCtx(installDir)
    const standardSetup = await setup({ tier: 'standard', force: true, skipResources: true }, setupCtx)
    expect(standardSetup.status).toBe('ok')
    expect(standardSetup.transition).toEqual({ from: 'lite', to: 'standard' })

    liveCtx = openCtx(installDir)
    currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.tier).toBe('standard')
    expect(currentStatus.capabilities.readContent).toBe(true)

    const standardLookup = await lookup({ path: 'swiftui/view' }, liveCtx)
    expect(standardLookup.content).toContain('# View')
    expect(standardLookup.content).toContain('Use this to compose SwiftUI interfaces.')

    const standardBodyResult = await rebuildBody({}, liveCtx)
    expect(standardBodyResult.indexed).toBeGreaterThan(0)

    currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.capabilities.searchBody).toBe(true)
    liveCtx.db.close()

    setupCtx = openCtx(installDir)
    await expect(
      setup({ tier: 'lite', force: true, skipResources: true }, setupCtx),
    ).rejects.toThrow('Refusing to downgrade from standard to lite without --downgrade')
    setupCtx.db.close()

    releases.setCurrentTier('lite')
    setupCtx = openCtx(installDir)
    const downgradedSetup = await setup({ tier: 'lite', force: true, downgrade: true, skipResources: true }, setupCtx)
    expect(downgradedSetup.status).toBe('ok')
    expect(downgradedSetup.transition).toEqual({ from: 'standard', to: 'lite' })

    liveCtx = openCtx(installDir)
    currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.tier).toBe('lite')
    expect(currentStatus.capabilities.readContent).toBe(false)

    const downgradedLookup = await lookup({ path: 'swiftui/view' }, liveCtx)
    expect(downgradedLookup.content).toBeNull()
    expect(downgradedLookup.tierLimitation?.tier).toBe('lite')
    liveCtx.db.close()
  })

  test('full snapshot setup preserves raw and markdown payloads', async () => {
    const fixtures = await buildReleaseFixtures()
    const releases = installReleaseMock(fixtures)
    const installDir = trackDir(mkdtempSync(join(tmpdir(), 'apple-docs-full-install-')))

    releases.setCurrentTier('full')
    const setupCtx = openCtx(installDir)
    const result = await setup({ tier: 'full', skipResources: true }, setupCtx)
    expect(result.status).toBe('ok')
    expect(result.tier).toBe('full')

    expect(existsSync(join(installDir, 'raw-json', 'swiftui', 'view.json'))).toBe(true)
    expect(existsSync(join(installDir, 'markdown', 'swiftui', 'view.md'))).toBe(true)

    const liveCtx = openCtx(installDir)
    const currentStatus = await status({ skipUpdateCheck: true }, liveCtx)
    expect(currentStatus.tier).toBe('full')
    expect(currentStatus.capabilities.readContent).toBe(true)

    const fullLookup = await lookup({ path: 'swiftui/view' }, liveCtx)
    expect(fullLookup.content).toContain('# View')
    liveCtx.db.close()
  })
})
