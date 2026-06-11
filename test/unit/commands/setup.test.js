import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../../src/storage/database.js'
import { snapshotBuild } from '../../../src/commands/snapshot.js'
import { setup } from '../../../src/commands/setup.js'
import { createLogger } from '../../../src/lib/logger.js'
import { setResolvedGitHubToken } from '../../../src/lib/github.js'
import { fetchLatestRelease, macosMajor } from '../../../src/commands/setup/helpers.js'

let dataDir
let db
let logger

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-setup-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  logger = createLogger('error')
})

afterEach(() => {
  try { db.close() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
})

describe('setup', () => {
  test('detects existing corpus without --force', async () => {
    // Seed a page so totalPages > 0
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'swiftui/view',
      url: 'u',
      title: 'View',
      role: 'symbol',
    })

    const result = await setup({ force: false }, { db, dataDir, logger })
    expect(result.status).toBe('exists')
    expect(result.dataDir).toBe(dataDir)
  })

  test('setup downloads, extracts, and verifies a snapshot', async () => {
    // Build a real snapshot to serve as the download
    const sourceDir = mkdtempSync(join(tmpdir(), 'apple-docs-source-'))
    const sourceDb = new DocsDatabase(join(sourceDir, 'apple-docs.db'))
    const root = sourceDb.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    sourceDb.upsertPage({
      rootId: root.id,
      path: 'swiftui/view',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      title: 'View',
      role: 'symbol',
      sourceType: 'apple-docc',
    })
    sourceDb.upsertNormalizedDocument({
      document: {
        key: 'swiftui/view',
        title: 'View',
        sourceType: 'apple-docc',
        framework: 'swiftui',
        role: 'symbol',
      },
      sections: [],
      relationships: [],
    })

    const snapshotOutDir = mkdtempSync(join(tmpdir(), 'apple-docs-snap-out-'))
    const snapshotResult = await snapshotBuild(
      { out: snapshotOutDir, tag: 'test-release-1' },
      { db: sourceDb, dataDir: sourceDir, logger },
    )
    sourceDb.close()

    // Read the built archive and checksum
    const archiveBytes = await Bun.file(snapshotResult.archivePath).arrayBuffer()
    const checksumText = await Bun.file(snapshotResult.checksumPath).text()

    // Mock fetch to serve the release API and asset downloads
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url, opts) => {
      const urlStr = String(url)

      if (urlStr.includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'test-release-1',
          published_at: '2026-04-13T00:00:00Z',
          assets: [
            {
              name: 'apple-docs-full-test-release-1.tar.zst',
              size: archiveBytes.byteLength,
              browser_download_url: 'https://fake.github.com/archive.tar.gz',
            },
            {
              name: 'apple-docs-full-test-release-1.tar.zst.sha256',
              size: checksumText.length,
              browser_download_url: 'https://fake.github.com/checksum.sha256',
            },
          ],
        }), { status: 200 })
      }

      if (urlStr.includes('archive.tar.gz')) {
        return new Response(archiveBytes, { status: 200 })
      }

      if (urlStr.includes('checksum.sha256')) {
        return new Response(checksumText, { status: 200 })
      }

      return originalFetch(url, opts)
    })

    try {
      // Use a fresh empty data dir for setup
      const setupDir = mkdtempSync(join(tmpdir(), 'apple-docs-fresh-'))
      const setupDb = new DocsDatabase(join(setupDir, 'apple-docs.db'))

      try {
        const result = await setup(
          { force: false },
          { db: setupDb, dataDir: setupDir, logger },
        )

        expect(result.status).toBe('ok')
        expect(result.tag).toBe('test-release-1')
        expect(result.tier).toBe('full')
        expect(result.documentCount).toBeGreaterThanOrEqual(1)
        expect(typeof result.schemaVersion).toBe('number')

        // Verify the DB was extracted and is valid
        const verifyDb = new DocsDatabase(join(setupDir, 'apple-docs.db'))
        try {
          expect(verifyDb.getSnapshotMeta('snapshot_tag')).toBe('test-release-1')
          expect(verifyDb.getSnapshotMeta('snapshot_installed_at')).not.toBeNull()
        } finally {
          verifyDb.close()
        }
      } finally {
        rmSync(setupDir, { recursive: true, force: true })
      }
    } finally {
      globalThis.fetch = originalFetch
      rmSync(snapshotOutDir, { recursive: true, force: true })
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  test('rejects checksum mismatch', async () => {
    // Mock fetch to return a bad checksum
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url) => {
      const urlStr = String(url)

      if (urlStr.includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'bad-v1',
          published_at: '2026-04-13T00:00:00Z',
          assets: [
            {
              name: 'apple-docs-full-bad-v1.tar.gz',
              size: 100,
              browser_download_url: 'https://fake.github.com/archive.tar.gz',
            },
            {
              name: 'apple-docs-full-bad-v1.tar.gz.sha256',
              size: 80,
              browser_download_url: 'https://fake.github.com/checksum.sha256',
            },
          ],
        }), { status: 200 })
      }

      if (urlStr.includes('archive.tar.gz')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }

      if (urlStr.includes('checksum.sha256')) {
        return new Response('0000000000000000000000000000000000000000000000000000000000000000  archive.tar.gz\n', { status: 200 })
      }

      return new Response('Not found', { status: 404 })
    })

    try {
      await expect(
        setup({ force: true }, { db, dataDir, logger })
      ).rejects.toThrow('Checksum mismatch')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('uses setResolvedGitHubToken fallback for release lookups', async () => {
    const originalEnv = { ...process.env }
    // biome-ignore lint/performance/noDelete: env vars require delete
    delete process.env.GITHUB_TOKEN
    // biome-ignore lint/performance/noDelete: env vars require delete
    delete process.env.GH_TOKEN
    setResolvedGitHubToken('resolved_setup_token')

    const originalFetch = globalThis.fetch
    let seenAuth = null
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/releases/latest')) {
        seenAuth = opts?.headers?.Authorization ?? null
        // Fail gracefully after we capture the header.
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      return new Response('nope', { status: 404 })
    }

    try {
      await expect(
        setup({ force: true }, { db, dataDir, logger })
      ).rejects.toThrow()
    } finally {
      globalThis.fetch = originalFetch
      setResolvedGitHubToken(null)
      for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
        if (k in originalEnv) process.env[k] = originalEnv[k]
        // biome-ignore lint/performance/noDelete: env vars require delete
        else delete process.env[k]
      }
    }

    expect(seenAuth).toBe('Bearer resolved_setup_token')
  })

  test('refuses install when checksum sidecar is missing (P1.5)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (url) => {
      const urlStr = String(url)
      if (urlStr.includes('/releases/latest')) {
        return new Response(JSON.stringify({
          tag_name: 'test-release-no-checksum',
          published_at: '2026-04-13T00:00:00Z',
          assets: [
            {
              name: 'apple-docs-full-test-release-no-checksum.tar.gz',
              size: 100,
              browser_download_url: 'https://fake.github.com/archive.tar.gz',
            },
            // intentionally NO .sha256 asset
          ],
        }), { status: 200 })
      }
      throw new Error(`unexpected url ${urlStr}`)
    })
    try {
      await expect(
        setup({ force: true }, { db, dataDir, logger })
      ).rejects.toThrow(/without a matching \.sha256/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('fetchLatestRelease channels', () => {

  const snapAsset = (tag) => ({
    name: `apple-docs-full-${tag}.tar.zst`,
    size: 1,
    browser_download_url: `https://fake.github.com/${tag}.tar.zst`,
  })
  const statusAsset = (tag) => ({
    name: 'status.json',
    size: 1,
    browser_download_url: `https://fake.github.com/${tag}-status.json`,
  })

  let originalFetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  test('macosMajor parses versions', () => {
    expect(macosMajor('27.1')).toBe(27)
    expect(macosMajor('26')).toBe(26)
    expect(macosMajor(null)).toBeNull()
    expect(macosMajor('garbage')).toBeNull()
  })

  test('stable channel hits /releases/latest and never sees prereleases', async () => {
    const urls = []
    globalThis.fetch = mock(async (url) => {
      urls.push(String(url))
      return new Response(JSON.stringify({
        tag_name: 'snapshot-20260609',
        published_at: '2026-06-09T00:00:00Z',
        prerelease: false,
        assets: [snapAsset('snapshot-20260609')],
      }), { status: 200 })
    })
    const r = await fetchLatestRelease()
    expect(r.tag).toBe('snapshot-20260609')
    expect(r.prerelease).toBe(false)
    expect(urls[0]).toContain('/releases/latest')
  })

  test('beta channel takes the newest same-or-newer-base prerelease', async () => {
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('beta.1-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '27.0' }), { status: 200 })
      }
      expect(u.includes('/releases?') || u.includes('-status.json')).toBe(true)
      return new Response(JSON.stringify([
        { tag_name: 'snapshot-20260610-beta.1', published_at: '2026-06-10T00:00:00Z', prerelease: true, draft: false, assets: [snapAsset('snapshot-20260610-beta.1'), statusAsset('snapshot-20260610-beta.1')] },
        { tag_name: 'snapshot-20260609', published_at: '2026-06-09T00:00:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260609')] },
      ]), { status: 200 })
    })
    const r = await fetchLatestRelease({ channel: 'beta', localBuildMacos: '27.1' })
    expect(r.tag).toBe('snapshot-20260610-beta.1')
    expect(r.prerelease).toBe(true)
  })

  test('beta channel skips a beta from an OLDER macOS base', async () => {
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('old-beta-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '26.2' }), { status: 200 })
      }
      if (u.includes('good-beta-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '27.0' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        { tag_name: 'old-beta', published_at: '2026-06-12T00:00:00Z', prerelease: true, draft: false, assets: [snapAsset('old-beta'), statusAsset('old-beta')] },
        { tag_name: 'good-beta', published_at: '2026-06-10T00:00:00Z', prerelease: true, draft: false, assets: [snapAsset('good-beta'), statusAsset('good-beta')] },
      ]), { status: 200 })
    })
    const r = await fetchLatestRelease({ channel: 'beta', localBuildMacos: '27.0' })
    expect(r.tag).toBe('good-beta')
  })

  test('beta channel skips drafts and asset-less releases', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify([
      { tag_name: 'bad-draft', published_at: '2026-06-12T00:00:00Z', prerelease: true, draft: true, assets: [snapAsset('bad-draft')] },
      { tag_name: 'binaries-1.0', published_at: '2026-06-11T00:00:00Z', prerelease: false, draft: false, assets: [{ name: 'apple-docs-darwin-arm64', size: 1, browser_download_url: 'https://fake.github.com/bin' }] },
      { tag_name: 'snapshot-20260610-beta.1', published_at: '2026-06-10T00:00:00Z', prerelease: true, draft: false, assets: [snapAsset('snapshot-20260610-beta.1')] },
    ]), { status: 200 }))
    const r = await fetchLatestRelease({ channel: 'beta' })
    expect(r.tag).toBe('snapshot-20260610-beta.1')
  })

  test('beta install refuses a newer stable from an older macOS', async () => {
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '26.2' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        { tag_name: 'snapshot-20260614', published_at: '2026-06-14T00:00:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260614'), statusAsset('snapshot-20260614')] },
      ]), { status: 200 })
    })
    await expect(
      fetchLatestRelease({ channel: 'beta', localBuildMacos: '27.1' }),
    ).rejects.toThrow(/beta channel/)
  })

  test('beta install accepts a stable built on at least the same macOS', async () => {
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '27.0' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        { tag_name: 'snapshot-20260614', published_at: '2026-06-14T00:00:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260614'), statusAsset('snapshot-20260614')] },
        { tag_name: 'snapshot-20260610-beta.1', published_at: '2026-06-10T00:00:00Z', prerelease: true, draft: false, assets: [snapAsset('snapshot-20260610-beta.1')] },
      ]), { status: 200 })
    })
    const r = await fetchLatestRelease({ channel: 'beta', localBuildMacos: '27.1' })
    expect(r.tag).toBe('snapshot-20260614')
    expect(r.prerelease).toBe(false)
  })

  test('beta channel without local provenance takes the newest installable release', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify([
      { tag_name: 'snapshot-20260614', published_at: '2026-06-14T00:00:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260614')] },
    ]), { status: 200 }))
    const r = await fetchLatestRelease({ channel: 'beta' })
    expect(r.tag).toBe('snapshot-20260614')
  })

  test('fresh beta install prefers the newest build-host macOS over a newer stable', async () => {
    // Real-world shape: the weekly stable lands AFTER the beta but is built
    // on an older macOS. A fresh `setup --beta` must still get the beta —
    // an existing beta install would refuse the older-base stable anyway.
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('snapshot-20260611-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '26.4' }), { status: 200 })
      }
      if (u.includes('beta.3-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '27.0' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        { tag_name: 'snapshot-20260611', published_at: '2026-06-11T02:48:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260611'), statusAsset('snapshot-20260611')] },
        { tag_name: 'snapshot-20260610-beta.3', published_at: '2026-06-10T23:51:00Z', prerelease: true, draft: false, assets: [snapAsset('snapshot-20260610-beta.3'), statusAsset('snapshot-20260610-beta.3')] },
      ]), { status: 200 })
    })
    const r = await fetchLatestRelease({ channel: 'beta' })
    expect(r.tag).toBe('snapshot-20260610-beta.3')
    expect(r.prerelease).toBe(true)
  })

  test('fresh beta install: a stable from the same base supersedes the beta', async () => {
    globalThis.fetch = mock(async (url) => {
      const u = String(url)
      if (u.includes('-status.json')) {
        return new Response(JSON.stringify({ buildMacos: '27.0' }), { status: 200 })
      }
      return new Response(JSON.stringify([
        { tag_name: 'snapshot-20260614', published_at: '2026-06-14T00:00:00Z', prerelease: false, draft: false, assets: [snapAsset('snapshot-20260614'), statusAsset('snapshot-20260614')] },
        { tag_name: 'snapshot-20260610-beta.3', published_at: '2026-06-10T23:51:00Z', prerelease: true, draft: false, assets: [snapAsset('snapshot-20260610-beta.3'), statusAsset('snapshot-20260610-beta.3')] },
      ]), { status: 200 })
    })
    const r = await fetchLatestRelease({ channel: 'beta' })
    expect(r.tag).toBe('snapshot-20260614')
    expect(r.prerelease).toBe(false)
  })
})
