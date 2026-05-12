/**
 * Tests for the SF Symbols.app provisioner. The pure helpers (version
 * parsing/compare, URL discovery, version derivation) get deterministic
 * coverage; the actual `.dmg` download path is gated on real network
 * + admin disk space, so it only runs when explicitly opted into via
 * APPLE_DOCS_TEST_NETWORK=1.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  discoverLatest,
  ensureSfSymbolsApp,
  versionFromUrl,
} from '../../src/resources/sf-symbols-app/install.js'

describe('compareVersions', () => {
  test('numeric segment comparison', () => {
    expect(compareVersions('7.2', '7.1')).toBe(1)
    expect(compareVersions('7.1', '7.2')).toBe(-1)
    expect(compareVersions('7.2', '7.2')).toBe(0)
  })
  test('missing trailing segments treated as 0', () => {
    expect(compareVersions('7', '7.0')).toBe(0)
    expect(compareVersions('7.0.0', '7')).toBe(0)
  })
  test('orders 10 above 2 not below', () => {
    expect(compareVersions('7.10', '7.2')).toBe(1)
    expect(compareVersions('7.2', '7.10')).toBe(-1)
  })
  test('major bumps win over minor', () => {
    expect(compareVersions('6.99', '7')).toBe(-1)
    expect(compareVersions('8', '7.5')).toBe(1)
  })
})

describe('versionFromUrl', () => {
  test('appends cache-buster as minor when present', () => {
    expect(versionFromUrl({ major: 7, cacheBuster: 2 })).toBe('7.2')
    expect(versionFromUrl({ major: 8, cacheBuster: 11 })).toBe('8.11')
  })
  test('omits zero cache-buster', () => {
    expect(versionFromUrl({ major: 7, cacheBuster: 0 })).toBe('7')
  })
})

describe('discoverLatest', () => {
  test('parses the canonical landing page link', async () => {
    // Synthetic page that mimics Apple's actual format — multiple
    // .dmg links, including a previous-major fallback.
    const html = `
      <html><body>
        <a href="https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-6.dmg">SF Symbols 6</a>
        <a href="https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg?3">Download SF Symbols 7</a>
      </body></html>`
    const fetcher = makeFetcher({
      'https://developer.apple.com/sf-symbols/': { ok: true, text: html },
      'https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg?3': {
        ok: true,
        headers: { etag: '"abc"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' },
      },
    })
    const out = await discoverLatest({ fetcher })
    expect(out.major).toBe(7)
    expect(out.cacheBuster).toBe(3)
    expect(out.url).toBe('https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg?3')
    expect(out.etag).toBe('"abc"')
    expect(out.lastModified).toBe('Wed, 01 Jan 2026 00:00:00 GMT')
  })

  test('picks highest cache-buster on ties of major', async () => {
    const html = `
      <a href="https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg">v7</a>
      <a href="https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg?5">v7.5</a>
      <a href="https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-7.dmg?2">v7.2</a>`
    const fetcher = makeFetcher({
      'https://developer.apple.com/sf-symbols/': { ok: true, text: html },
    })
    const out = await discoverLatest({ fetcher })
    expect(out.cacheBuster).toBe(5)
  })

  test('rejects on landing-page fetch failure', async () => {
    const fetcher = makeFetcher({
      'https://developer.apple.com/sf-symbols/': { ok: false, status: 503, statusText: 'Service Unavailable' },
    })
    await expect(discoverLatest({ fetcher })).rejects.toThrow(/503/)
  })

  test('rejects when page has no .dmg links', async () => {
    const fetcher = makeFetcher({
      'https://developer.apple.com/sf-symbols/': { ok: true, text: '<html><body>Coming soon</body></html>' },
    })
    await expect(discoverLatest({ fetcher })).rejects.toThrow(/no recognised .dmg/)
  })
})

describe('ensureSfSymbolsApp (without network)', () => {
  test('skipDiscovery + system install present → uses /Applications', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-install-test-'))
    try {
      // On macOS hosts where SF Symbols.app is installed, the helper
      // should short-circuit on the system path with no network calls.
      // On hosts where it isn't installed, the helper should throw —
      // both outcomes prove the no-discovery branch is reachable.
      const fetcher = () => { throw new Error('network should not be reached') }
      try {
        const out = await ensureSfSymbolsApp({
          dataDir,
          fetcher,
          skipDiscovery: true,
        })
        expect(out.source).toBe('system')
        expect(out.appPath).toBe('/Applications/SF Symbols.app')
        expect(typeof out.version).toBe('string')
      } catch (err) {
        expect(err.message).toMatch(/SF Symbols\.app missing/)
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ---- helpers ---------------------------------------------------------------

/**
 * Build a fake `fetch` keyed by URL. Each entry can override
 * `{ ok, status, statusText, text, headers }`. `text` defaults to "".
 */
function makeFetcher(table) {
  return async function fakeFetch(url) {
    const entry = table[url]
    if (!entry) throw new Error(`fake fetch: no entry for ${url}`)
    return {
      ok: entry.ok ?? true,
      status: entry.status ?? 200,
      statusText: entry.statusText ?? 'OK',
      headers: {
        get(name) { return entry.headers?.[name.toLowerCase()] ?? null },
      },
      async text() { return entry.text ?? '' },
    }
  }
}
