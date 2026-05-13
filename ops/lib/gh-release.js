/**
 * GitHub Releases helper for the ops pipeline. Fetches the
 * /releases/latest endpoint, picks the snapshot tarball + its sha256
 * sidecar, streams the download to disk, verifies the checksum.
 *
 * No third-party deps — just `fetch`. Network access is fully
 * injectable for tests so the suite never hits api.github.com.
 *
 * Output of fetchLatest mirrors what the bash version extracted via
 * `python3 -c 'json.load(sys.stdin)...'` so the shape stays stable
 * across the migration.
 */

import { createWriteStream } from 'node:fs'
import { unlinkSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { CryptoHasher } from 'bun'

const USER_AGENT = 'apple-docs-ops/2.0'

/**
 * @typedef {Object} ReleaseAsset
 * @property {string} name
 * @property {number} size
 * @property {string} url           browser_download_url
 *
 * @typedef {Object} Release
 * @property {string} tagName
 * @property {string} publishedAt
 * @property {ReleaseAsset[]} assets
 */

export class GhReleaseError extends Error {
  constructor(message, { code, exitCode = 1, status, body } = {}) {
    super(message)
    this.name = 'GhReleaseError'
    this.code = code
    this.exitCode = exitCode
    this.status = status
    this.body = body
  }
}

/**
 * GET /repos/<repo>/releases/latest and normalise the payload.
 *
 * @param {string} repo            "g-cqd/apple-docs"
 * @param {{ fetcher?: typeof fetch }} [deps]
 * @returns {Promise<Release>}
 */
export async function fetchLatest(repo, deps = {}) {
  const fetcher = deps.fetcher ?? fetch
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetcher(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
  })
  if (!res.ok) {
    const body = await safeText(res)
    throw new GhReleaseError(`releases/latest fetch failed: HTTP ${res.status}`, {
      code: 'fetch-failed',
      status: res.status,
      body,
    })
  }
  const data = await res.json()
  if (!data.tag_name) {
    throw new GhReleaseError('releases/latest payload has no tag_name', { code: 'malformed' })
  }
  return {
    tagName: data.tag_name,
    publishedAt: data.published_at ?? '',
    assets: (data.assets ?? []).map(a => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
    })),
  }
}

/**
 * Pick the snapshot archive asset by suffix preference. Returns
 * `.tar.gz` first, falls back to legacy `.7z`. Throws if neither is
 * present (the release is malformed — no point downloading anything).
 *
 * @param {Release} release
 * @param {{ tier?: string }} [opts]   defaults to 'full'
 * @returns {{ archive: ReleaseAsset, checksum: ReleaseAsset }}
 */
export function pickSnapshotAssets(release, opts = {}) {
  const tier = opts.tier ?? 'full'
  const archive =
    release.assets.find(a => a.name.includes(`-${tier}-`) && a.name.endsWith('.tar.gz')) ??
    release.assets.find(a => a.name.includes(`-${tier}-`) && a.name.endsWith('.7z'))
  if (!archive) {
    throw new GhReleaseError(
      `release ${release.tagName} has no -${tier}- archive (available: ${release.assets.map(a => a.name).join(', ') || 'none'})`,
      { code: 'no-archive' },
    )
  }
  const expectedSidecar = `${archive.name}.sha256`
  const checksum = release.assets.find(a => a.name === expectedSidecar)
  if (!checksum) {
    throw new GhReleaseError(
      `release ${release.tagName} ships ${archive.name} without a matching .sha256 sidecar.`,
      { code: 'no-checksum' },
    )
  }
  return { archive, checksum }
}

/**
 * Stream-download a URL to a destination path, computing sha256 as
 * we go. Verifies against `expectedSha256` and throws on mismatch.
 * On any error the partial file is cleaned up.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {string} expectedSha256             64-char hex
 * @param {{ fetcher?: typeof fetch, logger?: any }} [deps]
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
export async function downloadAndVerify(url, destPath, expectedSha256, deps = {}) {
  const fetcher = deps.fetcher ?? fetch
  const log = deps.logger
  const tmpPath = `${destPath}.part`
  const res = await fetcher(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new GhReleaseError(`download failed: HTTP ${res.status} for ${url}`, {
      code: 'download-failed',
      status: res.status,
    })
  }
  if (!res.body) {
    throw new GhReleaseError(`download response had no body for ${url}`, { code: 'no-body' })
  }

  const total = Number.parseInt(res.headers.get?.('content-length') ?? '', 10) || null
  const hasher = new CryptoHasher('sha256')
  const sink = createWriteStream(tmpPath)
  const reader = res.body.getReader()
  let received = 0
  let lastTickAt = 0

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      hasher.update(value)
      const ok = sink.write(value)
      if (!ok) await new Promise(r => sink.once('drain', r))
      received += value.byteLength
      if (total && Date.now() - lastTickAt > 2_000) {
        const pct = ((received / total) * 100).toFixed(1)
        log?.say?.(`download: ${pct}% (${formatMB(received)}/${formatMB(total)})`)
        lastTickAt = Date.now()
      }
    }
    await new Promise((resolve, reject) => {
      sink.end((err) => err ? reject(err) : resolve())
    })
  } catch (err) {
    try { sink.destroy() } catch {}
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }

  const actual = hasher.digest('hex')
  if (actual !== expectedSha256) {
    try { unlinkSync(tmpPath) } catch {}
    throw new GhReleaseError(
      `sha256 mismatch for ${url}: expected ${expectedSha256.slice(0, 16)}..., got ${actual.slice(0, 16)}...`,
      { code: 'checksum-mismatch' },
    )
  }

  await rename(tmpPath, destPath)
  return { bytes: received, sha256: actual }
}

/**
 * Fetch a .sha256 sidecar URL and return the 64-char hex digest. The
 * sidecar format is `<digest>  <filename>\n` (shasum-style).
 *
 * @param {string} url
 * @param {{ fetcher?: typeof fetch }} [deps]
 * @returns {Promise<string>}
 */
export async function fetchSha256Sidecar(url, deps = {}) {
  const fetcher = deps.fetcher ?? fetch
  const res = await fetcher(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    throw new GhReleaseError(`sidecar fetch failed: HTTP ${res.status} for ${url}`, {
      code: 'sidecar-failed',
      status: res.status,
    })
  }
  const text = await res.text()
  const m = /^[0-9a-f]{64}/i.exec(text.trim())
  if (!m) {
    throw new GhReleaseError(`sidecar at ${url} did not start with a 64-char hex digest`, {
      code: 'sidecar-malformed',
      body: text.slice(0, 256),
    })
  }
  return m[0].toLowerCase()
}

function formatMB(bytes) { return `${(bytes / 1e6).toFixed(0)} MB` }

async function safeText(res) {
  try { return (await res.text()).slice(0, 1024) } catch { return '' }
}
