/**
 * Ensure a working SF Symbols.app is on disk before the codepoint
 * worker runs. The worker depends on two private frameworks
 * (`SFSymbolsShared` + `CoreGlyphsLib`) and one font
 * (`SFSymbolsFallback.otf`) that Apple ships only inside SF Symbols.app
 * — the system /System/Library/PrivateFrameworks/SFSymbols.framework
 * has Resources but no Swift binaries. To keep the snapshot build
 * deterministic across hosts (CI, fresh dev machines), we discover the
 * current download from Apple's developer page, compare it with what's
 * installed in /Applications and what's cached under dataDir, and pull
 * the .dmg only when there's drift.
 *
 * No /Applications mutation: a downloaded copy lives entirely under
 * `<dataDir>/cache/sf-symbols/<version>/SF Symbols.app`. The codepoint
 * worker accepts either path via the `appPath` argument it threads
 * through to its framework search paths.
 *
 * Download URL pattern observed across SF Symbols 6 → 7.x:
 *   https://devimages-cdn.apple.com/design/resources/download/SF-Symbols-<major>.dmg[?<cacheBuster>]
 * The cache-buster (a small integer) increments on each minor release;
 * Apple bumps it to invalidate CDN caches. We scrape the developer
 * landing page so the exact URL (with cache-buster) tracks Apple's
 * "current" pointer automatically.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const LANDING_URL = 'https://developer.apple.com/sf-symbols/'
const SYSTEM_APP_PATH = '/Applications/SF Symbols.app'
const DMG_URL_PATTERN = /https:\/\/devimages-cdn\.apple\.com\/design\/resources\/download\/SF-Symbols-(\d+)\.dmg(?:\?(\d+))?/g

/**
 * Discover the URL Apple currently advertises for SF Symbols. Returns
 * the highest major + cache-buster found on the landing page. Throws
 * when the page can't be reached or contains no recognisable link.
 *
 * @param {{ fetcher?: typeof fetch, logger?: object }} [opts]
 * @returns {Promise<{ url: string, major: number, cacheBuster: number,
 *   etag?: string, lastModified?: string }>}
 */
export async function discoverLatest(opts = {}) {
  const fetcher = opts.fetcher ?? fetch
  const logger = opts.logger
  const res = await fetcher(LANDING_URL, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`SF Symbols landing fetch failed: ${res.status} ${res.statusText}`)
  }
  const html = await res.text()
  // Pull every SF-Symbols-N.dmg(?M)? URL; the page typically has
  // multiple (current major + an explicit "previous major" link).
  const seen = new Map() // key: `${major}.${cacheBuster}` → entry
  DMG_URL_PATTERN.lastIndex = 0
  let match
  while ((match = DMG_URL_PATTERN.exec(html)) != null) {
    const major = Number.parseInt(match[1], 10)
    const cacheBuster = match[2] != null ? Number.parseInt(match[2], 10) : 0
    const key = `${major}.${cacheBuster}`
    if (!seen.has(key)) seen.set(key, { url: match[0], major, cacheBuster })
  }
  if (seen.size === 0) {
    throw new Error('SF Symbols landing page had no recognised .dmg link')
  }
  // Latest = highest major, tie-break on cache-buster.
  const entries = [...seen.values()].sort((a, b) =>
    b.major - a.major || b.cacheBuster - a.cacheBuster,
  )
  const top = entries[0]
  logger?.debug?.(`SF Symbols current: major=${top.major} cb=${top.cacheBuster} url=${top.url}`)

  // HEAD the URL for ETag / Last-Modified so we can detect upstream
  // drift even when the cache-buster string hasn't changed.
  let etag, lastModified
  try {
    const head = await fetcher(top.url, { method: 'HEAD' })
    if (head.ok) {
      etag = head.headers.get('etag') ?? undefined
      lastModified = head.headers.get('last-modified') ?? undefined
    }
  } catch (err) {
    logger?.debug?.(`HEAD probe of ${top.url} failed: ${err?.message ?? err}`)
  }
  return { url: top.url, major: top.major, cacheBuster: top.cacheBuster, etag, lastModified }
}

/**
 * Read the installed SF Symbols.app version. Returns null when the
 * bundle is absent or its Info.plist is unreadable.
 *
 * @param {string} appPath
 * @returns {Promise<{ short: string, build: string } | null>}
 */
export async function readInstalledVersion(appPath) {
  if (!existsSync(appPath)) return null
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plistPath)) return null
  const short = await runCmd('defaults', ['read', plistPath, 'CFBundleShortVersionString'])
    .catch(() => null)
  const build = await runCmd('defaults', ['read', plistPath, 'CFBundleVersion'])
    .catch(() => null)
  if (!short) return null
  return { short: short.trim(), build: (build ?? '').trim() }
}

/**
 * Compare two version strings using natural numeric ordering on
 * dot-separated segments. Returns -1 / 0 / 1. Missing segments are
 * treated as 0. `compareVersions("7.2", "7")` → 1.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(s => Number.parseInt(s, 10) || 0)
  const pb = String(b).split('.').map(s => Number.parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da < db ? -1 : 1
  }
  return 0
}

/**
 * Approximate the SF Symbols version that a download URL represents.
 * The path encodes only the major; the `?N` cache-buster increments
 * per minor release. We treat (major, cacheBuster) as (X, Y) so the
 * pair "7.2" maps to URL with `?2` (verified manually on 2026-05-12).
 *
 * @param {{ major: number, cacheBuster: number }} info
 * @returns {string}
 */
export function versionFromUrl({ major, cacheBuster }) {
  return cacheBuster > 0 ? `${major}.${cacheBuster}` : String(major)
}

/**
 * Ensure SF Symbols.app is available at a path the codepoint worker
 * can use. Prefers the system install at /Applications when it's at
 * least as new as Apple's current download. Falls back to a cached
 * download under `<dataDir>/cache/sf-symbols/<version>/SF Symbols.app`.
 *
 * The cache is keyed on the discovered URL (which includes the
 * cache-buster), so a new minor on Apple's CDN forces a re-download
 * without operator intervention.
 *
 * @param {{
 *   dataDir: string,
 *   logger?: object,
 *   fetcher?: typeof fetch,
 *   skipDiscovery?: boolean,
 *   forceRefresh?: boolean,
 * }} opts
 * @returns {Promise<{ appPath: string, version: string, source: 'system'|'cache' }>}
 */
export async function ensureSfSymbolsApp(opts) {
  const { dataDir, logger, fetcher, skipDiscovery, forceRefresh } = opts
  if (!dataDir) throw new Error('ensureSfSymbolsApp: dataDir required')

  const cacheRoot = join(dataDir, 'cache', 'sf-symbols')
  const manifestPath = join(cacheRoot, 'manifest.json')

  // If we can't reach Apple (offline, CI without egress), prefer any
  // existing install rather than failing the build.
  let latest = null
  if (!skipDiscovery) {
    try {
      latest = await discoverLatest({ fetcher, logger })
    } catch (err) {
      logger?.warn?.(`SF Symbols discovery failed (${err?.message ?? err}); will use whatever is on disk`)
    }
  }

  const systemVersion = await readInstalledVersion(SYSTEM_APP_PATH)
  if (systemVersion && !forceRefresh) {
    const systemShort = systemVersion.short
    if (latest == null || compareVersions(systemShort, versionFromUrl(latest)) >= 0) {
      logger?.info?.(`SF Symbols.app ${systemShort} already at /Applications`)
      return { appPath: SYSTEM_APP_PATH, version: systemShort, source: 'system' }
    }
    logger?.info?.(
      `SF Symbols.app ${systemShort} at /Applications is older than published ${versionFromUrl(latest)}; ` +
      `downloading current to cache`,
    )
  }

  // Cache short-circuit: same URL as last download AND the app is
  // still on disk → reuse.
  const prevManifest = await readJsonIfExists(manifestPath)
  if (latest && prevManifest?.url === latest.url && !forceRefresh) {
    if (prevManifest.appPath && existsSync(prevManifest.appPath)) {
      logger?.info?.(`SF Symbols.app ${prevManifest.version} reused from cache`)
      return { appPath: prevManifest.appPath, version: prevManifest.version, source: 'cache' }
    }
  }

  if (latest == null) {
    // No network AND no usable cache. If a system install exists we
    // already returned above; otherwise we genuinely can't proceed.
    if (prevManifest?.appPath && existsSync(prevManifest.appPath)) {
      logger?.warn?.('Using stale cached SF Symbols.app (discovery unavailable)')
      return { appPath: prevManifest.appPath, version: prevManifest.version, source: 'cache' }
    }
    throw new Error(
      'SF Symbols.app missing and Apple developer site unreachable. ' +
      'Install SF Symbols.app from https://developer.apple.com/sf-symbols/ or retry with network.',
    )
  }

  const version = versionFromUrl(latest)
  const versionedDir = join(cacheRoot, version)
  const appPath = join(versionedDir, 'SF Symbols.app')
  await mkdir(versionedDir, { recursive: true })

  // Download + mount + copy. The .dmg is ~500 MB; download to a temp
  // file so a partial network failure doesn't poison the cache, then
  // mount it read-only in an ephemeral mountpoint.
  const dmgPath = join(versionedDir, `SF-Symbols-${version}.dmg.partial`)
  logger?.info?.(`Downloading SF Symbols.app ${version} from ${latest.url}`)
  await downloadFile(latest.url, dmgPath, { fetcher, logger })

  const mountPoint = await mkdtemp(join(tmpdir(), 'apple-docs-sfsymbols-mount-'))
  try {
    await runCmd('hdiutil', [
      'attach', dmgPath,
      '-nobrowse', '-readonly',
      '-mountpoint', mountPoint,
      '-quiet',
    ])
    try {
      const sourceApp = join(mountPoint, 'SF Symbols.app')
      if (!existsSync(sourceApp)) {
        throw new Error(`SF Symbols.app not found at expected path inside .dmg (${sourceApp})`)
      }
      // Clean any partial copy from a previous aborted run, then
      // copy the app out of the mounted volume.
      if (existsSync(appPath)) await rm(appPath, { recursive: true, force: true })
      await runCmd('cp', ['-R', sourceApp, versionedDir])
    } finally {
      await runCmd('hdiutil', ['detach', mountPoint, '-quiet']).catch(() => {})
    }
  } finally {
    await rm(mountPoint, { recursive: true, force: true }).catch(() => {})
    await rm(dmgPath, { force: true }).catch(() => {})
  }

  const installedVersion = (await readInstalledVersion(appPath))?.short ?? version
  const manifest = {
    url: latest.url,
    etag: latest.etag,
    lastModified: latest.lastModified,
    version: installedVersion,
    appPath,
    installedAt: new Date().toISOString(),
  }
  await mkdir(cacheRoot, { recursive: true })
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  logger?.info?.(`SF Symbols.app ${installedVersion} installed at ${appPath}`)
  return { appPath, version: installedVersion, source: 'cache' }
}

async function downloadFile(url, destPath, { fetcher = fetch, logger } = {}) {
  const res = await fetcher(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`)
  }
  // Stream to disk to keep memory bounded — the .dmg is ~500 MB.
  if (!res.body) throw new Error('download response had no body')
  const file = Bun.file(destPath)
  const writer = file.writer()
  const reader = res.body.getReader()
  let received = 0
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : null
  let lastLog = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      writer.write(value)
      received += value.length
      if (total && Date.now() - lastLog > 2000) {
        const pct = ((received / total) * 100).toFixed(1)
        logger?.debug?.(`SF Symbols.app download: ${pct}% (${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`)
        lastLog = Date.now()
      }
    }
  } finally {
    await writer.end()
  }
}

async function readJsonIfExists(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = nodeSpawn(cmd, args)
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => { out += chunk.toString('utf8') })
    proc.stderr.on('data', chunk => { err += chunk.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) resolve(out)
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.trim() || out.trim()}`))
    })
  })
}
