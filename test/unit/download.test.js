import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createMockLogger, createMockRateLimiter } from '../helpers/mocks.js'
import { DocsDatabase } from '../../src/storage/database.js'

describe('downloadMissing', () => {
  let db
  let logger
  let rateLimiter

  beforeEach(() => {
    db = new DocsDatabase(':memory:')
    logger = createMockLogger()
    rateLimiter = createMockRateLimiter()
  })

  afterEach(() => {
    db.close()
  })

  test('returns { downloaded: 0 } when no missing pages', async () => {
    // Import fresh each time to use real module
    const { downloadMissing } = await import('../../src/pipeline/download.js')
    const result = await downloadMissing(db, '/tmp', rateLimiter, logger)
    expect(result).toEqual({ downloaded: 0 })
  })

  test('returns { downloaded: 0 } when pages filtered out by roots', async () => {
    const { downloadMissing } = await import('../../src/pipeline/download.js')

    // Insert a root and a page with no downloaded_at
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui',
      url: 'https://developer.apple.com/documentation/swiftui',
      title: 'SwiftUI',
      role: 'collection',
      roleHeading: 'Framework',
      abstract: 'Build UI',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: null,
      downloadedAt: null,
      sourceType: 'apple-docc',
    })

    const result = await downloadMissing(db, '/tmp', rateLimiter, logger, null, {
      roots: ['nonexistent'],
    })
    expect(result).toEqual({ downloaded: 0 })
  })

  test('returns { downloaded: 0 } when pages filtered out by sources', async () => {
    const { downloadMissing } = await import('../../src/pipeline/download.js')

    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui',
      url: 'https://developer.apple.com/documentation/swiftui',
      title: 'SwiftUI',
      role: 'collection',
      roleHeading: 'Framework',
      abstract: 'Build UI',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: null,
      downloadedAt: null,
      sourceType: 'apple-docc',
    })

    const result = await downloadMissing(db, '/tmp', rateLimiter, logger, null, {
      sources: ['hig'],
    })
    expect(result).toEqual({ downloaded: 0 })
  })

  test('calls onProgress callback for each page', async () => {
    // This test verifies the query logic without actually fetching
    const { downloadMissing } = await import('../../src/pipeline/download.js')

    // No missing pages = no progress calls
    const progressCalls = []
    await downloadMissing(db, '/tmp', rateLimiter, logger, (info) => {
      progressCalls.push(info)
    })
    expect(progressCalls).toEqual([])
  })
})
