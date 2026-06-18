/**
 * Apple-font discovery + DMG extraction helpers. Used by syncAppleFonts
 * (in apple-assets.js) and the symbol-bundle plist reader sites that
 * need readPlist-backed maps.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { HttpError, ValidationError } from '../../lib/errors.js'
import { readPlist } from '../../lib/plist.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { ensureDir } from '../../storage/files.js'
import { sanitizeFileName } from '../apple-assets-helpers.js'
import { parseHdiutilMountPoints } from '../sf-symbols-app/dmg-helpers.js'

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.dfont'])

export function discoverAppleFontFiles(dirs) {
  const files = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    walkFiles(dir, (filePath) => {
      const ext = extname(filePath).toLowerCase()
      if (!FONT_EXTENSIONS.has(ext)) return
      const resolved = resolve(filePath)
      if (seen.has(resolved)) return
      seen.add(resolved)
      files.push({ fileName: basename(filePath), filePath: resolved })
    })
  }
  return files
}

function walkFiles(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__MACOSX') continue
      walkFiles(full, visit)
    } else if (entry.isFile()) {
      visit(full)
    }
  }
}

export async function downloadFileIfNeeded(url, filePath) {
  if (existsSync(filePath) && statSync(filePath).size > 0) return false
  ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) })
  if (!res.ok || !res.body) throw new HttpError(res.status, url, `HTTP ${res.status} downloading ${url}`)
  const sink = Bun.file(tmpPath).writer()
  const reader = res.body.getReader()
  let ended = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sink.write(value)
    }
    await sink.end()
    ended = true
    await rename(tmpPath, filePath)
  } finally {
    if (!ended) await sink.end().catch(() => {})
    await rm(tmpPath, { force: true }).catch(() => {})
  }
  return true
}

export async function extractDmgFonts(dmgPath, destinationDir, logger) {
  ensureDir(destinationDir)
  const expandedDir = await mkdtemp(join(tmpdir(), 'apple-docs-font-pkg-'))
  // Attach with `-plist` and NO forced `-mountpoint`: Apple font DMGs can be
  // SLA-wrapped / multi-volume, where forcing a single mountpoint latches the
  // wrong volume so the fonts are nowhere to be found — a silent partial that
  // left the snapshot non-deterministic (the New York family flickered in and
  // out between the two determinism builds). Enumerate every mounted volume.
  const plist = await runCapture(['hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-plist', dmgPath])
  const mountPoints = parseHdiutilMountPoints(plist)
  if (mountPoints.length === 0) {
    // The attach may still have mounted something we failed to parse —
    // a silent empty result here once shipped font-less snapshots (and
    // leaked the mount, since the finally-detach iterates mountPoints).
    throw new ValidationError(`hdiutil attached ${dmgPath} but no mount point was parsed`)
  }
  try {
    for (const mp of mountPoints) {
      for (const pkg of findByExtension(mp, '.pkg')) {
        const out = join(expandedDir, sanitizeFileName(basename(pkg)))
        await run(['pkgutil', '--expand-full', pkg, out]).catch((error) => {
          logger?.warn?.(`pkgutil failed for ${pkg}: ${error.message}`)
        })
      }
    }
    // Sort by file name so the extracted set + copy order is deterministic;
    // discoverAppleFontFiles' walk order is filesystem-dependent.
    const sources = discoverAppleFontFiles([...mountPoints, expandedDir]).sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0))
    const extracted = []
    for (const source of sources) {
      const target = join(destinationDir, source.fileName)
      await copyFile(source.filePath, target)
      extracted.push(target)
    }
    return extracted
  } finally {
    for (const mp of mountPoints) {
      await run(['hdiutil', 'detach', mp]).catch(() => {})
    }
    await rm(expandedDir, { recursive: true, force: true }).catch(() => {})
  }
}

function findByExtension(dir, extension) {
  const out = []
  if (!existsSync(dir)) return out
  walkFiles(dir, (filePath) => {
    if (extname(filePath).toLowerCase() === extension) out.push(filePath)
  })
  return out
}

export async function readStringsMap(path) {
  const value = await readPlist(path).catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const aliases = {}
  for (const [alias, canonical] of Object.entries(value)) {
    if (typeof canonical !== 'string') continue
    aliases[canonical] = [...(aliases[canonical] ?? []), alias]
  }
  return aliases
}

export async function readBundleVersion(contentsDir) {
  const info = await readPlist(join(contentsDir, 'Info.plist')).catch(() => null)
  return info?.CFBundleVersion ?? null
}

async function run(args) {
  // hdiutil attach / detach and pkgutil --expand-full each finish in seconds
  // on a normal DMG; 60s is generous and bounds an OS-level hang.
  const { stderr, exitCode } = await spawnWithDeadline(args, { deadlineMs: 60_000 })
  if (exitCode !== 0) throw new ValidationError(stderr.trim() || `exited ${exitCode}`)
}

/** Like {@link run} but returns stdout (used for `hdiutil attach -plist`). */
async function runCapture(args) {
  const { stdout, stderr, exitCode } = await spawnWithDeadline(args, { deadlineMs: 60_000 })
  if (exitCode !== 0) throw new ValidationError(stderr.trim() || `exited ${exitCode}`)
  // spawnWithDeadline returns stdout as an ArrayBuffer; the old
  // `String(stdout)` here produced "[object ArrayBuffer]", so the plist
  // never parsed, zero mount points were found, and every DMG extraction
  // silently yielded nothing (font-less snapshots).
  if (typeof stdout === 'string') return stdout
  return new TextDecoder().decode(stdout ?? new ArrayBuffer(0))
}

export async function hashFile(path) {
  const { sha256 } = await import('../../lib/hash.js')
  const bytes = await Bun.file(path).arrayBuffer()
  return sha256(bytes)
}
