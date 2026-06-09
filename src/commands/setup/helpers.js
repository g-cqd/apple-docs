// Small helpers shared by `apple-docs setup` — extracted from
// src/commands/setup.js to keep that file under the 400-line ceiling.

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
  const stream = Bun.file(archivePath).stream().pipeThrough(new DecompressionStream('zstd'))
  // Extract via `cwd: dataDir` rather than `-C dataDir`: GNU tar (Linux)
  // mis-parses `-xf - -C <dir>` when the archive is stdin and treats <dir>
  // as a member operand ("Cannot open"), whereas it's fine with `-xzf <file>
  // -C <dir>`. cwd is unambiguous on both GNU tar and bsdtar. dataDir is
  // ensured by the caller (and any decode failure now surfaces as a clear
  // EOF error instead of this confusing one).
  const proc = Bun.spawn(
    ['tar', '--no-same-owner', '--no-same-permissions', '-xf', '-'],
    { stdin: stream, cwd: dataDir, stdout: 'ignore', stderr: 'pipe', timeout: 10 * 60_000 },
  )
  const stderrText = new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new ValidationError(`Extraction failed (tar exit ${exitCode}): ${(await stderrText).trim().slice(0, 4096)}`)
  }
}

/**
 * Fetch the latest GitHub release of g-cqd/apple-docs. Returns the
 * tag, date, and asset list in a shape independent of the GitHub API
 * response so the caller doesn't see the raw payload.
 */
export async function fetchLatestRelease() {
  const token = getGitHubToken()
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers,
    signal: AbortSignal.timeout(15000),
  })

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
  return {
    tag: data.tag_name,
    date: data.published_at?.slice(0, 10) ?? 'unknown',
    assets: (data.assets ?? []).map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
    })),
  }
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
