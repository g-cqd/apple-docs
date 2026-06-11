// Small helpers shared by `apple-docs setup` — extracted from
// src/commands/setup.js to keep that file under the 400-line ceiling.

import { rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { HttpError, NotFoundError, ValidationError } from '../../lib/errors.js'
import { getGitHubToken } from '../../lib/github.js'

const GITHUB_REPO = 'g-cqd/apple-docs'
const USER_AGENT = 'apple-docs/2.0'

/**
 * Refuse to install from an archive path that lives outside `$HOME` or
 * the current working directory. Stops a script that accepts an
 * operator-supplied `--archive` value from being pointed at `/etc/...`
 * or another sensitive tree.
 */
export function resolveArchivePath(archive) {
  const absolute = isAbsolute(archive) ? archive : resolve(process.cwd(), archive)
  const home = process.env.HOME
  // Allow $HOME and the current repo checkout (a developer building +
  // installing from `dist/` is the canonical local-dev flow).
  const cwd = process.cwd()
  if (home && absolute.startsWith(`${home}/`)) return absolute
  if (absolute.startsWith(`${cwd}/`) || absolute === cwd) return absolute
  throw new ValidationError(
    `Refusing to install from ${absolute}: archive path must live under $HOME or the current working directory.`,
    { field: 'archive', value: absolute },
  )
}

/**
 * Strip the tar archive extension (`.tar.zst` / `.tar.gz` / `.tgz`) from a
 * path. Used to derive the manifest path from the archive path.
 */
export function stripTarGz(p) {
  const name = basename(p)
  for (const ext of ['.tar.zst', '.tar.gz', '.tgz']) {
    if (name.endsWith(ext)) return join(dirname(p), name.slice(0, -ext.length))
  }
  return p
}

/**
 * Stream-extract a `.tar.zst` snapshot into `dataDir`. macOS ships no `zstd`
 * binary and Apple's bsdtar lacks libzstd, so decompress with Bun's built-in
 * zstd (`DecompressionStream`) and pipe plain tar to `tar -xf -`. Streaming
 * keeps memory bounded on a multi-GB archive; no system zstd required.
 */
export async function extractTarZst(archivePath, dataDir) {
  // Decompress to a temp `.tar`, then extract from the real file. Streaming the
  // decompressed bytes to `tar -xf -` over stdin truncates past one pipe buffer
  // under Bun on Linux (GNU tar then errors mid-archive); materializing the tar
  // first matches the proven `.tar.gz` path. `Bun.write(file, stream)` streams
  // to disk with bounded memory, and Bun's native zstd needs no system zstd
  // (macOS ships none).
  const tarPath = join(dataDir, `.setup-extract-${process.pid}-${Date.now()}.tar`)
  try {
    const sink = Bun.file(tarPath).writer()
    for await (const chunk of Bun.file(archivePath).stream().pipeThrough(new DecompressionStream('zstd'))) sink.write(chunk)
    await sink.end()
    const proc = Bun.spawn(
      ['tar', '--no-same-owner', '--no-same-permissions', '-xf', tarPath, '-C', dataDir],
      { stdout: 'ignore', stderr: 'pipe', timeout: 10 * 60_000 },
    )
    const stderrText = new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new ValidationError(`Extraction failed (tar exit ${exitCode}): ${(await stderrText).trim().slice(0, 4096)}`)
    }
  } finally {
    try { rmSync(tarPath, { force: true }) } catch { /* tolerate */ }
  }
}

function ghHeaders() {
  const token = getGitHubToken()
  return {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

function shapeRelease(data) {
  return {
    tag: data.tag_name,
    date: data.published_at?.slice(0, 10) ?? 'unknown',
    prerelease: !!data.prerelease,
    assets: (data.assets ?? []).map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  }
}

const SNAPSHOT_ASSET = /^apple-docs-full-.*\.tar\.zst$/

/** Major component of a macOS version string ("27.1" → 27), or null. */
export function macosMajor(version) {
  const m = /^(\d+)/.exec(String(version ?? '').trim())
  return m ? Number(m[1]) : null
}

/**
 * Read a release's build-host macOS version from its tiny status.json
 * asset. Stable releases older than the field (or without status.json)
 * return null — callers treat that as unknown provenance.
 */
async function fetchReleaseBuildMacos(release) {
  const status = release.assets.find(a => a.name === 'status.json')
  if (!status) return null
  try {
    const res = await fetch(status.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    })
    if (!res.ok) return null
    const body = await res.json()
    return typeof body.buildMacos === 'string' ? body.buildMacos : null
  } catch {
    return null
  }
}

/**
 * Fetch the release to install from g-cqd/apple-docs. Returns the tag,
 * date, prerelease flag, and asset list in a shape independent of the
 * GitHub API response so the caller doesn't see the raw payload.
 *
 * Channels:
 *   - stable (default): GET /releases/latest — GitHub itself excludes
 *     prereleases and drafts there, so betas are invisible.
 *   - beta: walk /releases newest-first and take the first candidate —
 *     prerelease or stable — whose build-host macOS (from its
 *     status.json) is at least `localBuildMacos`. Snapshots inherit the
 *     SF Symbols catalog of the macOS that built them, so anything from
 *     an older base would silently shed symbols this install already
 *     has; a stable from the SAME (now GA) or newer base supersedes the
 *     beta. Candidates without provenance count as older-base, except
 *     prereleases when the local provenance is itself unknown.
 *     Fresh installs (no local provenance) pick the candidate with the
 *     newest build-host macOS, ties broken by release recency — the same
 *     corpus an existing beta-channel install would converge on. A newer
 *     stable from an older base never shadows a beta with more symbols;
 *     when no candidate carries provenance, the newest release wins.
 *
 * @param {{ channel?: 'stable'|'beta', localBuildMacos?: string|null }} [opts]
 */
export async function fetchLatestRelease({ channel = 'stable', localBuildMacos = null } = {}) {
  const url = channel === 'beta'
    ? `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=15`
    : `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15000) })

  if (!res.ok) {
    if (res.status === 404) {
      throw new NotFoundError(
        `https://api.github.com/repos/${GITHUB_REPO}/releases`,
        'No releases found. The repository may not have published any snapshots yet.',
      )
    }
    throw new HttpError(
      res.status,
      `https://api.github.com/repos/${GITHUB_REPO}/releases`,
      `GitHub API error: HTTP ${res.status}`,
    )
  }

  const data = await res.json()
  if (channel !== 'beta') return shapeRelease(data)

  const localMajor = macosMajor(localBuildMacos)
  const candidates = (Array.isArray(data) ? data : [])
    .filter(r => !r.draft && (r.assets ?? []).some(a => SNAPSHOT_ASSET.test(a.name)))
    .map(shapeRelease)
  if (localMajor == null && candidates.length > 0) {
    // Fresh install — nothing to protect yet, but "newest release" is the
    // wrong pick when a beta from a newer macOS base exists: the channel
    // exists to deliver those extra symbols, and an existing beta install
    // would refuse the older-base stable anyway. Pick the candidate with
    // the newest build host; ties (same major) go to the newest release,
    // so a stable from the same-or-newer base still supersedes the beta.
    // No provenance anywhere → newest release, as before.
    const majors = await Promise.all(
      candidates.map(async release => macosMajor(await fetchReleaseBuildMacos(release))),
    )
    let best = 0
    for (let i = 1; i < candidates.length; i++) {
      if ((majors[i] ?? -1) > (majors[best] ?? -1)) best = i
    }
    return candidates[best]
  }
  for (const release of candidates) {
    const releaseMajor = macosMajor(await fetchReleaseBuildMacos(release))
    if (releaseMajor != null && releaseMajor >= localMajor) return release
  }
  throw new NotFoundError(
    `https://api.github.com/repos/${GITHUB_REPO}/releases`,
    `No installable release on the beta channel matches this corpus (built on macOS ${localBuildMacos}). Releases from an older macOS base would shed symbols this install already has.`,
  )
}

/**
 * Human-readable byte size with two-digit precision for GB / one-digit
 * for MB and KB.
 */
export function formatSize(bytes) {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

// Export the constants for callers that need them (the GitHub repo
// string is also used in error messages built in setup.js).
export { GITHUB_REPO, USER_AGENT }
