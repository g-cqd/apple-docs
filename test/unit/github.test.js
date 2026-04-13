import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  checkRawGitHub,
  fetchGitHubTree,
  fetchRawGitHub,
} from '../../src/lib/github.js'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

afterEach(() => {
  globalThis.fetch = originalFetch
  // Restore env vars touched by tests
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    if (key in originalEnv) {
      process.env[key] = originalEnv[key]
    } else {
      delete process.env[key]
    }
  }
})

/** Minimal no-op rate limiter for unit tests. */
const noopLimiter = { acquire: async () => {} }

// ---------------------------------------------------------------------------
// fetchGitHubTree
// ---------------------------------------------------------------------------

describe('fetchGitHubTree', () => {
  test('returns tree array from a mocked response', async () => {
    const treeFixture = [
      { path: 'README.md', type: 'blob', sha: 'abc', size: 42 },
      { path: 'proposals', type: 'tree', sha: 'def', size: 0 },
    ]

    globalThis.fetch = async () =>
      Response.json({ tree: treeFixture, truncated: false })

    const tree = await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(tree).toEqual(treeFixture)
  })

  test('throws on non-OK HTTP status', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 })

    await expect(
      fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter),
    ).rejects.toThrow('HTTP 404')
  })
})

// ---------------------------------------------------------------------------
// fetchRawGitHub
// ---------------------------------------------------------------------------

describe('fetchRawGitHub', () => {
  test('returns text, etag, and lastModified from a mocked response', async () => {
    const bodyText = '# Swift Evolution Proposal'

    globalThis.fetch = async () =>
      new Response(bodyText, {
        status: 200,
        headers: {
          etag: '"etag-123"',
          'last-modified': 'Mon, 01 Jan 2026 00:00:00 GMT',
        },
      })

    const result = await fetchRawGitHub(
      'apple', 'swift-evolution', 'main',
      'proposals/0001-example.md',
      noopLimiter,
    )

    expect(result.text).toBe(bodyText)
    expect(result.etag).toBe('"etag-123"')
    expect(result.lastModified).toBe('Mon, 01 Jan 2026 00:00:00 GMT')
  })

  test('throws a 404 error for a missing file', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 })

    await expect(
      fetchRawGitHub('apple', 'swift-evolution', 'main', 'missing.md', noopLimiter),
    ).rejects.toThrow('Not found:')
  })

  test('returns null etag and lastModified when headers are absent', async () => {
    globalThis.fetch = async () => new Response('content', { status: 200 })

    const result = await fetchRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', noopLimiter,
    )

    expect(result.etag).toBeNull()
    expect(result.lastModified).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// checkRawGitHub
// ---------------------------------------------------------------------------

describe('checkRawGitHub', () => {
  test('returns unchanged for 304', async () => {
    globalThis.fetch = async () => new Response('', { status: 304 })

    const result = await checkRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', '"old-etag"', noopLimiter,
    )

    expect(result.status).toBe('unchanged')
  })

  test('returns modified with new etag for 200', async () => {
    globalThis.fetch = async () =>
      new Response('', { status: 200, headers: { etag: '"new-etag"' } })

    const result = await checkRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', '"old-etag"', noopLimiter,
    )

    expect(result.status).toBe('modified')
    expect(result.etag).toBe('"new-etag"')
  })

  test('returns deleted for 404', async () => {
    globalThis.fetch = async () => new Response('', { status: 404 })

    const result = await checkRawGitHub(
      'apple', 'swift-evolution', 'main', 'removed.md', null, noopLimiter,
    )

    expect(result.status).toBe('deleted')
  })

  test('returns error for unexpected status codes', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 })

    const result = await checkRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', null, noopLimiter,
    )

    expect(result.status).toBe('error')
  })

  test('returns error when fetch throws', async () => {
    globalThis.fetch = async () => { throw new Error('network failure') }

    const result = await checkRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', null, noopLimiter,
    )

    expect(result.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// Token authentication
// ---------------------------------------------------------------------------

describe('token authentication', () => {
  test('includes Authorization header when GITHUB_TOKEN is set', async () => {
    process.env.GITHUB_TOKEN = 'ghp_test_token'
    delete process.env.GH_TOKEN

    let capturedHeaders

    globalThis.fetch = async (url, options) => {
      capturedHeaders = options?.headers ?? {}
      return Response.json({ tree: [] })
    }

    await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(capturedHeaders['Authorization']).toBe('Bearer ghp_test_token')
  })

  test('includes Authorization header when GH_TOKEN is set (fallback)', async () => {
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'ghp_fallback_token'

    let capturedHeaders

    globalThis.fetch = async (url, options) => {
      capturedHeaders = options?.headers ?? {}
      return Response.json({ tree: [] })
    }

    await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(capturedHeaders['Authorization']).toBe('Bearer ghp_fallback_token')
  })

  test('omits Authorization header when no token is set', async () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    let capturedHeaders

    globalThis.fetch = async (url, options) => {
      capturedHeaders = options?.headers ?? {}
      return Response.json({ tree: [] })
    }

    await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(capturedHeaders['Authorization']).toBeUndefined()
  })

  test('GITHUB_TOKEN takes precedence over GH_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'primary_token'
    process.env.GH_TOKEN = 'fallback_token'

    let capturedHeaders

    globalThis.fetch = async (url, options) => {
      capturedHeaders = options?.headers ?? {}
      return Response.json({ tree: [] })
    }

    await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(capturedHeaders['Authorization']).toBe('Bearer primary_token')
  })
})

// ---------------------------------------------------------------------------
// 429 retry with Retry-After
// ---------------------------------------------------------------------------

describe('retry on 429', () => {
  test('retries fetchGitHubTree after a 429 and resolves on the subsequent success', async () => {
    const treeFixture = [{ path: 'file.md', type: 'blob', sha: 'abc', size: 10 }]
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      }
      return Response.json({ tree: treeFixture })
    }

    const tree = await fetchGitHubTree('apple', 'swift-evolution', 'main', noopLimiter)

    expect(callCount).toBe(2)
    expect(tree).toEqual(treeFixture)
  })

  test('retries fetchRawGitHub after a 429 and resolves on the subsequent success', async () => {
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      }
      return new Response('file content', {
        status: 200,
        headers: { etag: '"etag-1"' },
      })
    }

    const result = await fetchRawGitHub(
      'apple', 'swift-evolution', 'main', 'file.md', noopLimiter,
    )

    expect(callCount).toBe(2)
    expect(result.text).toBe('file content')
  })

  test('acquires the rate limiter once per attempt including retries', async () => {
    const treeFixture = [{ path: 'a.md', type: 'blob', sha: 'sha1', size: 1 }]
    let acquireCount = 0
    let fetchCount = 0

    const countingLimiter = {
      acquire: async () => { acquireCount += 1 },
    }

    globalThis.fetch = async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      }
      return Response.json({ tree: treeFixture })
    }

    await fetchGitHubTree('apple', 'swift-evolution', 'main', countingLimiter)

    // One acquire per attempt: initial + 1 retry = 2
    expect(acquireCount).toBe(2)
  })
})
