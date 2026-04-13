import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { convertAll } from '../../src/pipeline/convert.js'
import { createMockLogger } from '../helpers/mocks.js'

let db
let dataDir
let logger

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'convert-test-'))
  mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
  mkdirSync(join(dataDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(':memory:')
  logger = createMockLogger()
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('convertAll', () => {
  test('returns zero when no unconverted pages', async () => {
    const result = await convertAll(db, dataDir, logger)
    expect(result).toEqual({ converted: 0, total: 0 })
  })

  test('converts a page from raw JSON to Markdown', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/text',
      url: 'https://developer.apple.com/documentation/swiftui/text',
      title: 'Text',
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: 'A view that displays text.',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    // Create a minimal raw JSON that the renderer can handle
    const rawJson = {
      metadata: {
        title: 'Text',
        roleHeading: 'Structure',
        role: 'symbol',
        symbolKind: 'struct',
        modules: [{ name: 'SwiftUI' }],
      },
      identifier: {
        url: '/documentation/swiftui/text',
        interfaceLanguage: 'swift',
      },
      abstract: [{ type: 'text', text: 'A view that displays text.' }],
      primaryContentSections: [],
      topicSections: [],
      relationshipsSections: [],
      variants: [],
    }

    mkdirSync(join(dataDir, 'raw-json', 'documentation', 'swiftui'), { recursive: true })
    writeFileSync(
      join(dataDir, 'raw-json', 'documentation', 'swiftui', 'text.json'),
      JSON.stringify(rawJson),
    )

    mkdirSync(join(dataDir, 'markdown', 'documentation', 'swiftui'), { recursive: true })

    const result = await convertAll(db, dataDir, logger)
    expect(result.converted).toBe(1)
    expect(result.total).toBe(1)

    // Verify markdown file was created
    const mdPath = join(dataDir, 'markdown', 'documentation', 'swiftui', 'text.md')
    expect(existsSync(mdPath)).toBe(true)
  })

  test('calls onProgress for each converted page', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/text',
      url: 'https://developer.apple.com/documentation/swiftui/text',
      title: 'Text',
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: 'A view that displays text.',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    const rawJson = {
      metadata: { title: 'Text', roleHeading: 'Structure', role: 'symbol', symbolKind: 'struct', modules: [{ name: 'SwiftUI' }] },
      identifier: { url: '/documentation/swiftui/text', interfaceLanguage: 'swift' },
      abstract: [{ type: 'text', text: 'Text' }],
      primaryContentSections: [],
      topicSections: [],
      relationshipsSections: [],
      variants: [],
    }

    mkdirSync(join(dataDir, 'raw-json', 'documentation', 'swiftui'), { recursive: true })
    writeFileSync(join(dataDir, 'raw-json', 'documentation', 'swiftui', 'text.json'), JSON.stringify(rawJson))
    mkdirSync(join(dataDir, 'markdown', 'documentation', 'swiftui'), { recursive: true })

    const progressCalls = []
    await convertAll(db, dataDir, logger, (info) => progressCalls.push(info))
    expect(progressCalls.length).toBe(1)
    expect(progressCalls[0].done).toBe(1)
    expect(progressCalls[0].total).toBe(1)
    expect(progressCalls[0].path).toBe('documentation/swiftui/text')
  })

  test('filters by roots', async () => {
    const root1 = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    const root2 = db.upsertRoot('uikit', 'UIKit', 'framework', 'apple-docc')

    for (const [root, name] of [[root1, 'swiftui'], [root2, 'uikit']]) {
      db.upsertPage({
        rootId: root.id,
        path: `documentation/${name}/view`,
        url: `https://developer.apple.com/documentation/${name}/view`,
        title: 'View',
        role: 'symbol',
        roleHeading: 'Protocol',
        abstract: 'A view.',
        platforms: null,
        declaration: null,
        etag: null,
        lastModified: null,
        contentHash: 'abc',
        downloadedAt: new Date().toISOString(),
        sourceType: 'apple-docc',
      })
    }

    // Only convert swiftui root — but no raw JSON exists, so it will log a warning and skip
    const result = await convertAll(db, dataDir, logger, null, { roots: ['swiftui'] })
    expect(result.total).toBe(1) // only 1 page selected
  })

  test('filters by sources', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/view',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      title: 'View',
      role: 'symbol',
      roleHeading: 'Protocol',
      abstract: 'A view.',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    // Filter to a non-matching source
    const result = await convertAll(db, dataDir, logger, null, { sources: ['hig'] })
    expect(result.total).toBe(0)
  })

  test('logs warning on convert failure and continues', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/missing',
      url: 'https://developer.apple.com/documentation/swiftui/missing',
      title: 'Missing',
      role: 'symbol',
      roleHeading: 'Protocol',
      abstract: 'Missing.',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    // No raw JSON file exists → convertPage returns false, done is not incremented
    const result = await convertAll(db, dataDir, logger)
    // Should not crash
    expect(result.total).toBe(1)
    // Missing JSON is not counted as a successful conversion
    expect(result.converted).toBe(0)
  })
})
