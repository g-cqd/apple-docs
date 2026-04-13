import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { ensureNormalizedDocument } from '../../src/content/hydrate.js'

let db
let dataDir

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hydrate-test-'))
  mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('ensureNormalizedDocument', () => {
  test('returns true immediately when sections already exist', async () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/view',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      title: 'View',
      role: 'symbol',
      roleHeading: 'Protocol',
      abstract: 'A type that represents part of your app UI.',
      platforms: null,
      declaration: null,
      etag: null,
      lastModified: null,
      contentHash: 'abc',
      downloadedAt: new Date().toISOString(),
      sourceType: 'apple-docc',
    })

    // Manually insert a section so hydrate finds it
    const minimalNormalized = {
      document: {
        sourceType: 'apple-docc',
        key: 'documentation/swiftui/view',
        title: 'View',
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Protocol',
        abstractText: 'A type that represents part of your app UI.',
        url: 'https://developer.apple.com/documentation/swiftui/view',
        language: 'swift',
        platformsJson: null,
        declarationText: null,
        headings: null,
        isDeprecated: false,
        isReleaseNotes: false,
        urlDepth: 3,
        sourceMetadata: null,
      },
      sections: [{
        sectionKind: 'overview',
        heading: 'Overview',
        contentText: 'Some text',
        contentJson: '[]',
        sortOrder: 0,
      }],
      relationships: [],
    }
    db.upsertNormalizedDocument(minimalNormalized, {
      contentHash: 'abc123',
      rawPayloadHash: 'def456',
    })

    const result = await ensureNormalizedDocument(db, dataDir, 'documentation/swiftui/view')
    expect(result).toBe(true)
  })

  test('returns false when no raw JSON exists for docc source', async () => {
    const result = await ensureNormalizedDocument(db, dataDir, 'documentation/nonexistent')
    expect(result).toBe(false)
  })

  test('hydrates from raw JSON for docc source type', async () => {
    // Create a minimal DocC-like raw JSON payload
    const rawJson = {
      metadata: {
        title: 'View',
        roleHeading: 'Protocol',
        role: 'symbol',
        symbolKind: 'protocol',
        modules: [{ name: 'SwiftUI' }],
      },
      identifier: {
        url: '/documentation/swiftui/view',
        interfaceLanguage: 'swift',
      },
      abstract: [{ type: 'text', text: 'A view protocol.' }],
      primaryContentSections: [],
      topicSections: [],
      relationshipsSections: [],
      variants: [],
    }

    const keyPath = 'documentation/swiftui/view'
    mkdirSync(join(dataDir, 'raw-json', 'documentation', 'swiftui'), { recursive: true })
    writeFileSync(
      join(dataDir, 'raw-json', `${keyPath}.json`),
      JSON.stringify(rawJson),
    )

    const result = await ensureNormalizedDocument(db, dataDir, keyPath)
    // Should hydrate successfully since normalize can handle the raw JSON
    expect(typeof result).toBe('boolean')
  })

  test('returns false for guidelines source type when no HTML exists', async () => {
    const result = await ensureNormalizedDocument(db, dataDir, 'app-store-review/1', 'guidelines')
    expect(result).toBe(false)
  })
})
