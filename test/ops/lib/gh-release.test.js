import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchLatest,
  pickSnapshotAssets,
  downloadAndVerify,
  fetchSha256Sidecar,
  GhReleaseError,
} from '../../../ops/lib/gh-release.js'

function makeStream(text) {
  const bytes = new TextEncoder().encode(text)
  let cursor = 0
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(cursor))
      cursor = bytes.length
    },
  })
}

function fakeResp({ ok = true, status = 200, json, body = '', headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(body),
    body: makeStream(body),
  }
}

const sampleRelease = {
  tag_name: 'snapshot-20260513',
  published_at: '2026-05-13T00:28:00Z',
  assets: [
    { name: 'apple-docs-full-snapshot-20260513.tar.gz', size: 1_600_000_000, browser_download_url: 'https://x/a.tar.gz' },
    { name: 'apple-docs-full-snapshot-20260513.tar.gz.sha256', size: 100, browser_download_url: 'https://x/a.sha256' },
    { name: 'apple-docs-full-snapshot-20260513.manifest.json', size: 200, browser_download_url: 'https://x/a.manifest.json' },
  ],
}

describe('fetchLatest', () => {
  test('normalises the GH releases/latest payload', async () => {
    const fetcher = () => Promise.resolve(fakeResp({ json: sampleRelease }))
    const out = await fetchLatest('g-cqd/apple-docs', { fetcher })
    expect(out.tagName).toBe('snapshot-20260513')
    expect(out.publishedAt).toBe('2026-05-13T00:28:00Z')
    expect(out.assets).toHaveLength(3)
    expect(out.assets[0]).toEqual({
      name: 'apple-docs-full-snapshot-20260513.tar.gz',
      size: 1_600_000_000,
      url: 'https://x/a.tar.gz',
    })
  })

  test('throws when the response is not OK', async () => {
    const fetcher = () => Promise.resolve(fakeResp({ ok: false, status: 404, body: 'Not Found' }))
    try {
      await fetchLatest('foo/bar', { fetcher })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(GhReleaseError)
      expect(err.code).toBe('fetch-failed')
      expect(err.status).toBe(404)
    }
  })

  test('throws when payload has no tag_name', async () => {
    const fetcher = () => Promise.resolve(fakeResp({ json: { assets: [] } }))
    await expect(fetchLatest('x/y', { fetcher })).rejects.toThrow(/no tag_name/)
  })
})

describe('pickSnapshotAssets', () => {
  test('prefers .tar.gz over .7z', () => {
    const release = {
      tagName: 't', publishedAt: '', assets: [
        { name: 'apple-docs-full-t.7z', size: 1, url: 'a' },
        { name: 'apple-docs-full-t.7z.sha256', size: 1, url: 'b' },
        { name: 'apple-docs-full-t.tar.gz', size: 2, url: 'c' },
        { name: 'apple-docs-full-t.tar.gz.sha256', size: 1, url: 'd' },
      ],
    }
    const { archive, checksum } = pickSnapshotAssets(release)
    expect(archive.name).toBe('apple-docs-full-t.tar.gz')
    expect(checksum.name).toBe('apple-docs-full-t.tar.gz.sha256')
  })

  test('falls back to .7z when no .tar.gz present', () => {
    const release = {
      tagName: 't', publishedAt: '', assets: [
        { name: 'apple-docs-full-t.7z', size: 1, url: 'a' },
        { name: 'apple-docs-full-t.7z.sha256', size: 1, url: 'b' },
      ],
    }
    const { archive } = pickSnapshotAssets(release)
    expect(archive.name).toBe('apple-docs-full-t.7z')
  })

  test('throws when no archive matches the tier', () => {
    const release = { tagName: 't', publishedAt: '', assets: [{ name: 'other.zip', size: 1, url: 'x' }] }
    expect(() => pickSnapshotAssets(release)).toThrow(/no -full- archive/)
  })

  test('throws when sidecar is missing', () => {
    const release = {
      tagName: 't', publishedAt: '', assets: [
        { name: 'apple-docs-full-t.tar.gz', size: 2, url: 'c' },
      ],
    }
    expect(() => pickSnapshotAssets(release)).toThrow(/without a matching .sha256 sidecar/)
  })
})

describe('downloadAndVerify', () => {
  test('writes the bytes and returns sha256 + size', async () => {
    const body = 'hello world'
    const sha = '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069'
    // The above is a deliberately wrong sha for the body — we'll compute the real one first.
    const realSha = await sha256Hex(body)
    const fetcher = () => Promise.resolve(fakeResp({ body, headers: { 'content-length': String(body.length) } }))
    const dir = mkdtempSync(join(tmpdir(), 'dl-'))
    try {
      const dest = join(dir, 'out.bin')
      const r = await downloadAndVerify('http://x', dest, realSha, { fetcher })
      expect(r.bytes).toBe(body.length)
      expect(r.sha256).toBe(realSha)
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest, 'utf8')).toBe(body)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    void sha
  })

  test('throws checksum-mismatch and cleans up partial file on bad sha', async () => {
    const body = 'mismatched'
    const wrongSha = '0'.repeat(64)
    const fetcher = () => Promise.resolve(fakeResp({ body }))
    const dir = mkdtempSync(join(tmpdir(), 'dl-'))
    try {
      const dest = join(dir, 'out.bin')
      await expect(downloadAndVerify('http://x', dest, wrongSha, { fetcher }))
        .rejects.toMatchObject({ code: 'checksum-mismatch' })
      expect(existsSync(dest)).toBe(false)
      expect(existsSync(`${dest}.part`)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('throws download-failed on non-OK response', async () => {
    const fetcher = () => Promise.resolve(fakeResp({ ok: false, status: 503, body: '' }))
    const dir = mkdtempSync(join(tmpdir(), 'dl-'))
    try {
      await expect(downloadAndVerify('http://x', join(dir, 'a'), 'x'.repeat(64), { fetcher }))
        .rejects.toMatchObject({ code: 'download-failed', status: 503 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fetchSha256Sidecar', () => {
  test('extracts a 64-char hex digest from shasum-style output', async () => {
    const sha = 'a'.repeat(64)
    const fetcher = () => Promise.resolve(fakeResp({ body: `${sha}  apple-docs.tar.gz\n` }))
    expect(await fetchSha256Sidecar('http://x', { fetcher })).toBe(sha)
  })

  test('throws when the sidecar body is not shaped like a digest', async () => {
    const fetcher = () => Promise.resolve(fakeResp({ body: 'oops not a digest' }))
    await expect(fetchSha256Sidecar('http://x', { fetcher })).rejects.toMatchObject({
      code: 'sidecar-malformed',
    })
  })
})

async function sha256Hex(text) {
  const { CryptoHasher } = await import('bun')
  return new CryptoHasher('sha256').update(text).digest('hex')
}
