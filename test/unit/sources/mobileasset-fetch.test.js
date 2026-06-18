// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FALLBACK_ASSET, fetchDocumentationAsset, parseAssetManifest, resolveDownload } from '../../../src/sources/mobileasset-fetch.js'

// Mirrors the real manifest structure (plist <dict> per asset). sha1 of the
// 26.2 entry is base64 "a/kcjiSuFnLI7ASIvyFIoDwroYc=" → hex below.
const MANIFEST_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Assets</key>
\t<array>
\t\t<dict>
\t\t\t<key>Build</key>
\t\t\t<string>10M13306</string>
\t\t\t<key>OSVersion</key>
\t\t\t<string>26.2</string>
\t\t\t<key>XcodeVersion</key>
\t\t\t<string>27.0</string>
\t\t\t<key>_DownloadSize</key>
\t\t\t<integer>652289669</integer>
\t\t\t<key>_Measurement</key>
\t\t\t<data>
\t\t\ta/kcjiSuFnLI7ASIvyFIoDwroYc=
\t\t\t</data>
\t\t\t<key>__BaseURL</key>
\t\t\t<string>https://updates.cdn-apple.com/MA/x/</string>
\t\t\t<key>__RelativePath</key>
\t\t\t<string>docs/aa.zip</string>
\t\t</dict>
\t\t<dict>
\t\t\t<key>Build</key>
\t\t\t<string>10M13306</string>
\t\t\t<key>OSVersion</key>
\t\t\t<string>27.0</string>
\t\t\t<key>XcodeVersion</key>
\t\t\t<string>27.0</string>
\t\t\t<key>_DownloadSize</key>
\t\t\t<integer>652639225</integer>
\t\t\t<key>_Measurement</key>
\t\t\t<data>
\t\t\ttPeBo78sYU3asQ+6KZ7/LQqfMDw=
\t\t\t</data>
\t\t\t<key>__BaseURL</key>
\t\t\t<string>https://updates.cdn-apple.com/MA/x/</string>
\t\t\t<key>__RelativePath</key>
\t\t\t<string>docs/bb.zip</string>
\t\t</dict>
\t</array>
</dict>
</plist>`

let dir
let zipBytes
let zipSha1
// The fetch fixture needs the `zip` binary to author a real archive. It's
// present on the CI runners, but guard so a minimal image skips rather than
// failing opaquely in beforeAll.
const HAS_ZIP = !!Bun.which('zip')

beforeAll(async () => {
  if (!HAS_ZIP) return
  dir = mkdtempSync(join(tmpdir(), 'apple-docs-ma-fetch-'))
  // Build a real zip with the expected inner layout.
  const stage = join(dir, 'stage')
  mkdirSync(join(stage, 'AssetData', 'documentation-db'), { recursive: true })
  writeFileSync(join(stage, 'AssetData', 'documentation-db', 'index.sql'), 'FAKE-SQLITE-BYTES')
  const zipPath = join(dir, 'asset.zip')
  const proc = Bun.spawnSync(['zip', '-q', '-r', zipPath, 'AssetData'], { cwd: stage })
  expect(proc.exitCode).toBe(0)
  zipBytes = await Bun.file(zipPath).arrayBuffer()
  zipSha1 = new Bun.CryptoHasher('sha1').update(zipBytes).digest('hex')
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('parseAssetManifest', () => {
  test('extracts every variant, newest OS first, with hex sha1', () => {
    const assets = parseAssetManifest(MANIFEST_FIXTURE)
    expect(assets).toHaveLength(2)
    expect(assets[0].osVersion).toBe('27.0')
    expect(assets[0].url).toBe('https://updates.cdn-apple.com/MA/x/docs/bb.zip')
    expect(assets[0].sha1).toBe('b4f781a3bf2c614ddab10fba299eff2d0a9f303c')
    expect(assets[0].size).toBe(652639225)
    expect(assets[1].sha1).toBe('6bf91c8e24ae1672c8ec0488bf2148a03c2ba187')
  })
})

describe('resolveDownload', () => {
  test('explicit url wins; absent manifest falls back to the pin', async () => {
    expect((await resolveDownload({ url: 'https://x/y.zip', manifestPath: '/nonexistent' })).source).toBe('explicit')
    const fb = await resolveDownload({ manifestPath: '/nonexistent' })
    expect(fb.source).toBe('pinned-fallback')
    expect(fb.url).toBe(FALLBACK_ASSET.url)
  })

  test('local manifest beats the fallback', async () => {
    const mp = join(dir, 'manifest.xml')
    writeFileSync(mp, MANIFEST_FIXTURE)
    const r = await resolveDownload({ manifestPath: mp })
    expect(r.source).toBe('local-manifest')
    expect(r.osVersion).toBe('27.0')
  })
})

describe.skipIf(!HAS_ZIP)('fetchDocumentationAsset', () => {
  const fetchImpl = async () => new Response(zipBytes, { status: 200 })

  test('downloads, verifies sha1 + size, extracts, then serves from cache', async () => {
    const cacheDir = join(dir, 'cache-a')
    const r1 = await fetchDocumentationAsset({
      url: 'https://updates.cdn-apple.com/MA/x/docs/bb.zip',
      sha1: zipSha1,
      size: zipBytes.byteLength,
      cacheDir,
      fetchImpl,
    })
    expect(r1.cached).toBe(false)
    expect(existsSync(r1.dbPath)).toBe(true)
    expect(await Bun.file(r1.dbPath).text()).toBe('FAKE-SQLITE-BYTES')

    let fetched = 0
    const r2 = await fetchDocumentationAsset({
      url: 'https://updates.cdn-apple.com/MA/x/docs/bb.zip',
      sha1: zipSha1,
      size: zipBytes.byteLength,
      cacheDir,
      fetchImpl: async () => {
        fetched++
        return new Response(zipBytes)
      },
    })
    expect(r2.cached).toBe(true)
    expect(fetched).toBe(0)
  })

  test('sha1 mismatch refuses the asset', async () => {
    await expect(
      fetchDocumentationAsset({
        url: 'https://updates.cdn-apple.com/MA/x/docs/cc.zip',
        sha1: 'deadbeef'.repeat(5),
        cacheDir: join(dir, 'cache-b'),
        fetchImpl,
      }),
    ).rejects.toThrow(/SHA-1 mismatch/)
  })

  test('size mismatch refuses the asset', async () => {
    await expect(
      fetchDocumentationAsset({
        url: 'https://updates.cdn-apple.com/MA/x/docs/dd.zip',
        size: zipBytes.byteLength + 1,
        cacheDir: join(dir, 'cache-c'),
        fetchImpl,
      }),
    ).rejects.toThrow(/size mismatch/)
  })
})
