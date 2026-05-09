import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { snapshotBuild } from '../../src/commands/snapshot.js'
import { setup } from '../../src/commands/setup.js'
import { createLogger } from '../../src/lib/logger.js'
import { setResolvedGitHubToken } from '../../src/lib/github.js'

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

    const result = await setup({ tier: 'standard', force: false }, { db, dataDir, logger })
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
      { tier: 'standard', out: snapshotOutDir, tag: 'test-release-1' },
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
              name: 'apple-docs-standard-test-release-1.tar.gz',
              size: archiveBytes.byteLength,
              browser_download_url: 'https://fake.github.com/archive.tar.gz',
            },
            {
              name: 'apple-docs-standard-test-release-1.sha256',
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
          { tier: 'standard', force: false },
          { db: setupDb, dataDir: setupDir, logger },
        )

        expect(result.status).toBe('ok')
        expect(result.tag).toBe('test-release-1')
        expect(result.tier).toBe('standard')
        expect(result.documentCount).toBeGreaterThanOrEqual(1)
        expect(result.schemaVersion).toBe(13)

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
              name: 'apple-docs-standard-bad-v1.tar.gz',
              size: 100,
              browser_download_url: 'https://fake.github.com/archive.tar.gz',
            },
            {
              name: 'apple-docs-standard-bad-v1.sha256',
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
        setup({ tier: 'standard', force: true }, { db, dataDir, logger })
      ).rejects.toThrow('Checksum mismatch')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects invalid tier', async () => {
    await expect(
      setup({ tier: 'mega' }, { db, dataDir, logger })
    ).rejects.toThrow('Invalid tier')
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
        setup({ tier: 'standard', force: true }, { db, dataDir, logger })
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

  test('rejects downgrades without --downgrade', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'swiftui/view',
      url: 'u',
      title: 'View',
      role: 'symbol',
    })
    db.setSnapshotMeta('snapshot_tier', 'full')

    await expect(
      setup({ tier: 'standard', force: true }, { db, dataDir, logger })
    ).rejects.toThrow('Refusing to downgrade from full to standard without --downgrade')
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
              name: 'apple-docs-standard-test-release-no-checksum.tar.gz',
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
        setup({ tier: 'standard', force: true }, { db, dataDir, logger })
      ).rejects.toThrow(/without a matching \.sha256/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
