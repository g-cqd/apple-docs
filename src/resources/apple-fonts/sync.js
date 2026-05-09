/**
 * Apple-font discovery + DMG extraction helpers.
 *
 * Pulled out of resources/apple-assets.js as part of P3.7. Used by
 * syncAppleFonts (still in apple-assets.js) and the symbol-bundle plist
 * reader sites that need readPlist-backed maps.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { ensureDir } from '../../storage/files.js'
import { readPlist } from '../../lib/plist.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { sanitizeFileName } from '../apple-assets-helpers.js'

export const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.dfont'])

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

export function walkFiles(dir, visit) {
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
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`)
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
  const mountDir = await mkdtemp(join(tmpdir(), 'apple-docs-font-dmg-'))
  const expandedDir = await mkdtemp(join(tmpdir(), 'apple-docs-font-pkg-'))
  try {
    await run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mountDir, dmgPath])
    for (const pkg of findByExtension(mountDir, '.pkg')) {
      const out = join(expandedDir, sanitizeFileName(basename(pkg)))
      await run(['pkgutil', '--expand-full', pkg, out]).catch(error => {
        logger?.warn?.(`pkgutil failed for ${pkg}: ${error.message}`)
      })
    }
    const extracted = []
    for (const source of discoverAppleFontFiles([mountDir, expandedDir])) {
      const target = join(destinationDir, source.fileName)
      await copyFile(source.filePath, target)
      extracted.push(target)
    }
    return extracted
  } finally {
    await run(['hdiutil', 'detach', mountDir]).catch(() => {})
    await rm(mountDir, { recursive: true, force: true }).catch(() => {})
    await rm(expandedDir, { recursive: true, force: true }).catch(() => {})
  }
}

export function findByExtension(dir, extension) {
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
  if (exitCode !== 0) throw new Error(stderr.trim() || `exited ${exitCode}`)
}

export async function hashFile(path) {
  const { sha256 } = await import('../../lib/hash.js')
  const bytes = await Bun.file(path).arrayBuffer()
  return sha256(bytes)
}
