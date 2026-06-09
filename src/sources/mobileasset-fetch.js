/**
 * Download path for the Xcode Developer Documentation MobileAsset, for
 * machines without Xcode (CI, servers). The asset is a plain zip on Apple's
 * public CDN (`updates.cdn-apple.com`, no auth — the CDN echoes the
 * manifest's SHA-1 in `x-amz-meta-digest-sh1`).
 *
 * URL resolution order: explicit `url` → the local MobileAsset manifest XML
 * (present once Xcode downloaded the component; carries every variant's URL,
 * size, and SHA-1) → the pinned fallback below. Live discovery via
 * gdmf.apple.com needs an Xcode-private asset audience and is left as a
 * future option.
 *
 * The zip is streamed to disk (FileSink — never buffered in memory),
 * SHA-1-verified against the manifest measurement, and only
 * `AssetData/documentation-db/*` is extracted. Cached per content hash;
 * re-runs are no-ops.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ValidationError } from '../lib/errors.js'
import { spawnWithDeadline } from '../lib/spawn-with-deadline.js'
import { DEFAULT_ASSET_ROOT } from './mobileasset-docs.js'

export const DEFAULT_MANIFEST_PATH = join(
  DEFAULT_ASSET_ROOT,
  'com_apple_MobileAsset_AppleDeveloperDocumentation.xml',
)

// Xcode 27.0 / OS 27.0 / build 10M13306 — verified live (HTTP 200, size and
// x-amz-meta-digest-sh1 matching). Re-pin alongside Xcode releases.
export const FALLBACK_ASSET = Object.freeze({
  osVersion: '27.0',
  xcodeVersion: '27.0',
  build: '10M13306',
  size: 652639225,
  sha1: 'b4f781a3bf2c614ddab10fba299eff2d0a9f303c',
  url: 'https://updates.cdn-apple.com/MobileAssets2026/mobileassets/140-08809/DFAEDC55-DD2C-4D48-9B89-4668EFE5E8D6/com_apple_MobileAsset_AppleDeveloperDocumentation/b706f16d88b168d99434ff235a054ef2d9a1859e.zip',
})

/** Parse the MobileAsset manifest plist into download candidates. */
export function parseAssetManifest(xml) {
  const out = []
  // Each asset is a <dict> inside the Assets <array>; the fields we need are
  // flat string/integer/data pairs. A targeted scan keeps us free of a plist
  // dependency and is pinned by a unit test against the real structure.
  const dicts = String(xml).split('<dict>').slice(1)
  for (const d of dicts) {
    const field = (key, tag) => {
      const m = d.match(new RegExp(`<key>${key}</key>\\s*<${tag}>([^<]*)</${tag}>`))
      return m ? m[1].trim() : null
    }
    const base = field('__BaseURL', 'string')
    const rel = field('__RelativePath', 'string')
    if (!base || !rel) continue
    const meas = field('_Measurement', 'data')
    out.push({
      osVersion: field('OSVersion', 'string'),
      xcodeVersion: field('XcodeVersion', 'string'),
      build: field('Build', 'string'),
      size: Number(field('_DownloadSize', 'integer')) || null,
      sha1: meas ? Buffer.from(meas.replace(/\s+/g, ''), 'base64').toString('hex') : null,
      url: base + rel,
    })
  }
  return out.sort((a, b) => Number.parseFloat(b.osVersion) - Number.parseFloat(a.osVersion))
}

/** Pick the download: explicit url → newest manifest variant → pinned fallback. */
export async function resolveDownload({ url, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  if (url) return { url, sha1: null, size: null, source: 'explicit' }
  if (existsSync(manifestPath)) {
    const candidates = parseAssetManifest(await Bun.file(manifestPath).text())
    if (candidates.length > 0) return { ...candidates[0], source: 'local-manifest' }
  }
  return { ...FALLBACK_ASSET, source: 'pinned-fallback' }
}

/**
 * Download + verify + extract the documentation DB. Returns the index.sql
 * path. Cached: if the extracted DB already exists for this URL, no network.
 *
 * @param {{ url: string, sha1?: string|null, size?: number|null,
 *   cacheDir?: string, logger?: object, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ dbPath: string, cached: boolean }>}
 */
export async function fetchDocumentationAsset({ url, sha1 = null, size = null, cacheDir, logger, fetchImpl = fetch }) {
  if (!url) throw new ValidationError('fetchDocumentationAsset: url is required')
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  const root = cacheDir ?? join(home, 'cache', 'xcode-docs')
  // Cache key is the content hash when pinned; for an unpinned --url it must be
  // derived from the full URL, not basename(url) — two assets named e.g.
  // `docs.zip` on different hosts would otherwise share a slot.
  const cacheKey = sha1 ?? new Bun.CryptoHasher('sha256').update(url).digest('hex')
  const slot = join(root, cacheKey.replace(/[^a-z0-9._-]/gi, '_'))
  const dbDir = join(slot, 'AssetData', 'documentation-db')
  const dbPath = join(dbDir, 'index.sql')
  if (existsSync(dbPath)) return { dbPath, cached: true }
  if (!Bun.which('unzip')) {
    throw new ValidationError('`unzip` is required to extract the documentation asset (install it and retry).')
  }

  mkdirSync(slot, { recursive: true })
  const zipPath = join(slot, `.download-${process.pid}.zip`)
  try {
    logger?.info?.(`Downloading documentation asset (${size ? `${(size / 1e6).toFixed(0)} MB` : 'size unknown'})…`)
    const res = await fetchImpl(url)
    if (!res.ok) throw new ValidationError(`Asset download failed: HTTP ${res.status} for ${url}`)
    const hasher = new Bun.CryptoHasher('sha1')
    const sink = Bun.file(zipPath).writer()
    let written = 0
    for await (const chunk of res.body) {
      hasher.update(chunk)
      sink.write(chunk)
      written += chunk.byteLength
    }
    await sink.end()
    const gotSha1 = hasher.digest('hex')
    if (size != null && written !== size) {
      throw new ValidationError(`Asset size mismatch: got ${written}, manifest says ${size} (truncated download?)`)
    }
    if (sha1 && gotSha1 !== sha1) {
      throw new ValidationError(`Asset SHA-1 mismatch: got ${gotSha1}, manifest says ${sha1}. Do not use.`)
    }
    if (!sha1) logger?.info?.(`Asset SHA-1 (unpinned URL): ${gotSha1}`)

    // `-j` (junk paths) flattens every matched member into dbDir, so a crafted
    // member name like `documentation-db/../../evil` can't escape the slot even
    // though the glob would match it. Only index.sql (+ its WAL/SHM) is needed.
    mkdirSync(dbDir, { recursive: true })
    const { exitCode, stderr } = await spawnWithDeadline(
      ['unzip', '-j', '-o', '-q', zipPath, 'AssetData/documentation-db/*', '-d', dbDir],
      { deadlineMs: 10 * 60_000 },
    )
    if (exitCode !== 0 || !existsSync(dbPath)) {
      throw new ValidationError(`Asset extraction failed (unzip exit ${exitCode}): ${stderr}`)
    }
    return { dbPath, cached: false }
  } finally {
    rmSync(zipPath, { force: true })
  }
}
