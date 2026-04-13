import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PackagesAdapter } from '../../../src/sources/packages.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GITHUB_TOKEN
const originalGhToken = process.env.GH_TOKEN
const originalLimit = process.env.APPLE_DOCS_PACKAGES_LIMIT

function makeCtx() {
  return {
    db: {
      getRootBySlug: mock(() => ({ id: 1, slug: 'packages', source_type: 'packages' })),
      upsertRoot: mock(() => {}),
    },
    rateLimiter: { acquire: mock(() => Promise.resolve()) },
    logger: { info: mock(), warn: mock(), error: mock() },
  }
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, { status, headers })
}

describe('PackagesAdapter', () => {
  let adapter
  let fetchImpl

  beforeEach(() => {
    adapter = new PackagesAdapter()
    process.env.GITHUB_TOKEN = 'test-token'
    Reflect.deleteProperty(process.env, 'GH_TOKEN')
    Reflect.deleteProperty(process.env, 'APPLE_DOCS_PACKAGES_LIMIT')

    fetchImpl = mock(async () => new Response('Not found', { status: 404 }))
    globalThis.fetch = mock((url, opts) => fetchImpl(url, opts))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch

    if (originalToken == null) Reflect.deleteProperty(process.env, 'GITHUB_TOKEN')
    else process.env.GITHUB_TOKEN = originalToken

    if (originalGhToken == null) Reflect.deleteProperty(process.env, 'GH_TOKEN')
    else process.env.GH_TOKEN = originalGhToken

    if (originalLimit == null) Reflect.deleteProperty(process.env, 'APPLE_DOCS_PACKAGES_LIMIT')
    else process.env.APPLE_DOCS_PACKAGES_LIMIT = originalLimit
  })

  test('has correct static properties', () => {
    expect(PackagesAdapter.type).toBe('packages')
    expect(PackagesAdapter.displayName).toBe('Swift Package Catalog')
    expect(PackagesAdapter.syncMode).toBe('flat')
  })

  test('discover builds package keys from the Swift Package Index list', async () => {
    fetchImpl.mockImplementation(async (url) => {
      if (String(url).includes('raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json')) {
        return textResponse(JSON.stringify([
          'https://github.com/Apple/Swift-Argument-Parser.git',
          'https://github.com/apple/swift-argument-parser',
          'https://github.com/pointfreeco/swift-composable-architecture',
          'https://example.com/not-github',
        ]), 200, { etag: '"packages"' })
      }
      return new Response('Not found', { status: 404 })
    })

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('packages/apple/swift-argument-parser')
    expect(result.keys).toContain('packages/pointfreeco/swift-composable-architecture')
    expect(result.keys).toHaveLength(2)
    expect(result.roots).toEqual([{ id: 1, slug: 'packages', source_type: 'packages' }])
  })

  test('discover registers the root if missing', async () => {
    fetchImpl.mockImplementation(async (url) => {
      if (String(url).includes('raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json')) {
        return textResponse(JSON.stringify([]))
      }
      return new Response('Not found', { status: 404 })
    })

    const ctx = makeCtx()
    ctx.db.getRootBySlug.mockReturnValue(null)

    await adapter.discover(ctx)

    expect(ctx.db.upsertRoot).toHaveBeenCalledWith('packages', 'Swift Package Catalog', 'collection', 'packages')
  })

  test('discover requires GitHub auth for full syncs', async () => {
    Reflect.deleteProperty(process.env, 'GITHUB_TOKEN')

    await expect(adapter.discover(makeCtx())).rejects.toThrow('packages source requires GITHUB_TOKEN or GH_TOKEN')
  })

  test('discover allows a limited unauthenticated sample', async () => {
    Reflect.deleteProperty(process.env, 'GITHUB_TOKEN')
    process.env.APPLE_DOCS_PACKAGES_LIMIT = '1'

    fetchImpl.mockImplementation(async (url) => {
      if (String(url).includes('raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json')) {
        return textResponse(JSON.stringify([
          'https://github.com/apple/swift-argument-parser',
          'https://github.com/pointfreeco/swift-composable-architecture',
        ]))
      }
      return new Response('Not found', { status: 404 })
    })

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toEqual(['packages/apple/swift-argument-parser'])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  test('fetch combines repo metadata and README content', async () => {
    fetchImpl.mockImplementation(async (url) => {
      const urlStr = String(url)
      if (urlStr === 'https://api.github.com/repos/apple/swift-argument-parser') {
        return jsonResponse({
          full_name: 'apple/swift-argument-parser',
          default_branch: 'main',
        }, 200, { etag: '"repo"', 'last-modified': '2026-04-13T00:00:00Z' })
      }
      if (urlStr === 'https://api.github.com/repos/apple/swift-argument-parser/readme?ref=main') {
        return jsonResponse({
          path: 'README.md',
          sha: 'abc123',
          html_url: 'https://github.com/apple/swift-argument-parser/blob/main/README.md',
          download_url: 'https://raw.githubusercontent.com/apple/swift-argument-parser/main/README.md',
          content: Buffer.from('# swift-argument-parser\n\nArgument parsing for Swift.\n').toString('base64'),
          encoding: 'base64',
        }, 200, { etag: '"readme"', 'last-modified': '2026-04-13T01:00:00Z' })
      }
      return new Response('Not found', { status: 404 })
    })

    const result = await adapter.fetch('packages/apple/swift-argument-parser', makeCtx())

    expect(result.key).toBe('packages/apple/swift-argument-parser')
    expect(result.payload.repo.full_name).toBe('apple/swift-argument-parser')
    expect(result.payload.readme.path).toBe('README.md')
    expect(JSON.parse(result.etag)).toEqual({
      repo: '"repo"',
      readme: '"readme"',
      branch: 'main',
    })
  })

  test('check reports repo deletion', async () => {
    fetchImpl.mockImplementation(async (url, opts) => {
      if (opts?.method === 'HEAD' && String(url) === 'https://api.github.com/repos/apple/swift-argument-parser') {
        return new Response('', { status: 404 })
      }
      return new Response('Not found', { status: 404 })
    })

    const result = await adapter.check('packages/apple/swift-argument-parser', { etag: null }, makeCtx())

    expect(result.status).toBe('deleted')
    expect(result.deleted).toBe(true)
  })

  test('check reports README removal as modified when a README previously existed', async () => {
    fetchImpl.mockImplementation(async (url, opts) => {
      const urlStr = String(url)
      if (opts?.method === 'HEAD' && urlStr === 'https://api.github.com/repos/apple/swift-argument-parser') {
        return new Response('', { status: 304 })
      }
      if (opts?.method === 'HEAD' && urlStr === 'https://api.github.com/repos/apple/swift-argument-parser/readme?ref=main') {
        return new Response('', { status: 404 })
      }
      return new Response('Not found', { status: 404 })
    })

    const result = await adapter.check(
      'packages/apple/swift-argument-parser',
      { etag: JSON.stringify({ repo: '"repo"', readme: '"readme"', branch: 'main' }) },
      makeCtx(),
    )

    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
  })

  test('check treats missing README as unchanged when none was previously indexed', async () => {
    fetchImpl.mockImplementation(async (url, opts) => {
      const urlStr = String(url)
      if (opts?.method === 'HEAD' && urlStr === 'https://api.github.com/repos/apple/swift-argument-parser') {
        return new Response('', { status: 304 })
      }
      if (opts?.method === 'HEAD' && urlStr === 'https://api.github.com/repos/apple/swift-argument-parser/readme?ref=main') {
        return new Response('', { status: 404 })
      }
      return new Response('Not found', { status: 404 })
    })

    const result = await adapter.check(
      'packages/apple/swift-argument-parser',
      { etag: JSON.stringify({ repo: '"repo"', readme: null, branch: 'main' }) },
      makeCtx(),
    )

    expect(result.status).toBe('unchanged')
    expect(result.changed).toBe(false)
  })

  test('normalize produces a package document with metadata and README sections', () => {
    const result = adapter.normalize('packages/apple/swift-argument-parser', {
      repo: {
        name: 'swift-argument-parser',
        full_name: 'apple/swift-argument-parser',
        html_url: 'https://github.com/apple/swift-argument-parser',
        description: 'Straightforward, type-safe argument parsing for Swift',
        language: 'Swift',
        stargazers_count: 3695,
        forks_count: 233,
        open_issues_count: 12,
        topics: ['swift', 'cli'],
        homepage: 'https://swiftpackageindex.com/apple/swift-argument-parser/documentation',
        default_branch: 'main',
        archived: false,
        fork: false,
        owner: { login: 'apple' },
        license: { spdx_id: 'Apache-2.0', name: 'Apache License 2.0' },
        pushed_at: '2026-04-10T23:10:50Z',
        updated_at: '2026-04-12T13:36:00Z',
      },
      readme: {
        text: '# Swift Argument Parser\n\nBuild command-line tools in Swift.\n\n## Usage\n\nUse it from your Package.swift.\n',
        path: 'README.md',
        htmlUrl: 'https://github.com/apple/swift-argument-parser/blob/main/README.md',
        downloadUrl: 'https://raw.githubusercontent.com/apple/swift-argument-parser/main/README.md',
      },
    })

    expect(result.document.key).toBe('packages/apple/swift-argument-parser')
    expect(result.document.title).toBe('apple/swift-argument-parser')
    expect(result.document.kind).toBe('package')
    expect(result.document.framework).toBe('packages')
    expect(result.document.sourceType).toBe('packages')
    expect(result.document.url).toBe('https://github.com/apple/swift-argument-parser')
    expect(result.document.abstractText).toBe('Straightforward, type-safe argument parsing for Swift')
    expect(result.document.language).toBe('swift')

    const meta = JSON.parse(result.document.sourceMetadata)
    expect(meta.package).toBe(true)
    expect(meta.fullName).toBe('apple/swift-argument-parser')
    expect(meta.license).toBe('Apache-2.0')
    expect(meta.topics).toContain('swift')
    expect(meta.readmePath).toBe('README.md')

    expect(result.sections.find(section => section.sectionKind === 'abstract')?.contentText).toBe(
      'Straightforward, type-safe argument parsing for Swift',
    )
    expect(result.sections.find(section => section.heading === 'Usage')).toBeTruthy()
    expect(result.sections.find(section => section.heading === 'Package Metadata')).toBeTruthy()
  })

  test('normalize falls back to synthesized content when a repository has no README', () => {
    const result = adapter.normalize('packages/pointfreeco/swift-dependencies', {
      repo: {
        name: 'swift-dependencies',
        full_name: 'pointfreeco/swift-dependencies',
        html_url: 'https://github.com/pointfreeco/swift-dependencies',
        description: 'A dependency management library for Swift',
        language: 'Swift',
        owner: { login: 'pointfreeco' },
        default_branch: 'main',
        topics: [],
        archived: false,
        fork: false,
      },
      readme: null,
    })

    expect(result.document.title).toBe('pointfreeco/swift-dependencies')
    expect(result.sections.find(section => section.sectionKind === 'abstract')).toBeTruthy()
    expect(result.sections.find(section => section.heading === 'Package Metadata')).toBeTruthy()
  })
})
