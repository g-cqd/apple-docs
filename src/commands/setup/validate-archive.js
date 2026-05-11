/**
 * Pre-flight validation for snapshot release archives.
 *
 * `tar -xzf <archive> -C <dataDir>` refuses literal `..` and absolute
 * paths in modern tar, but does NOT block symlink-based escape during
 * extraction: one entry creates a symlink, a later entry writes through
 * it. A compromised release archive could plant `manifest.json`
 * → `~/.ssh/authorized_keys` and overwrite it. This validator runs
 * `tar -tvzf` first, parses the entry type letter (`-`, `d`, `l`, `h`,
 * …) and the path, and rejects anything that:
 *   - is a symlink (`l`) or hardlink (`h`),
 *   - is an absolute path,
 *   - canonicalizes outside the destination directory, or
 *   - is anything other than a regular file or directory.
 */

import { resolve, sep } from 'node:path'

const ALLOWED_TYPES = new Set(['-', 'd'])

/**
 * Run `tar -tvzf` on `archivePath` and validate every member.
 *
 * @param {string} archivePath
 * @param {string} destDir
 * @param {{ spawn?: typeof Bun.spawn }} [deps]
 * @returns {Promise<{ entries: Array<{ type: string, path: string }> }>}
 * @throws {Error} on any unsafe member; the archive is left untouched.
 */
export async function validateArchive(archivePath, destDir, deps = {}) {
  const spawn = deps.spawn ?? Bun.spawn
  const proc = spawn(['tar', '-tvzf', archivePath], { stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`archive listing failed (tar exit ${exitCode}): ${stderr.trim()}`)
  }
  const stdoutText = await new Response(proc.stdout).text()

  const root = resolve(destDir) + sep
  const entries = []
  let lineno = 0
  for (const rawLine of stdoutText.split('\n')) {
    lineno++
    const line = rawLine.trim()
    if (!line) continue
    const parsed = parseTarVerboseLine(line)
    if (!parsed) {
      throw new Error(`archive listing line ${lineno} did not parse: ${line.slice(0, 80)}`)
    }
    const { type, path } = parsed
    if (!ALLOWED_TYPES.has(type)) {
      throw new Error(`archive contains disallowed entry type "${type}" at line ${lineno}: ${path}`)
    }
    if (path.startsWith('/') || path.startsWith('~')) {
      throw new Error(`archive contains absolute path: ${path}`)
    }
    const resolved = resolve(destDir, path)
    if (resolved !== resolve(destDir) && !resolved.startsWith(root)) {
      throw new Error(`archive entry escapes destDir after canonicalization: ${path} → ${resolved}`)
    }
    entries.push({ type, path })
  }

  return { entries }
}

/**
 * Parse a `tar -tvzf` long-listing line. Two real-world formats are handled:
 *   BSD : <type><perms>  <links> <user>  <group>     <size> <month> <day> <time> <path>[ -> <link>]
 *   GNU : <type><perms>  <user>/<group>              <size> <date>      <time>  <path>[ -> <link>]
 *
 * Strategy: anchor on type+perms then walk the rest tolerantly. The link
 * target is captured but unused — symlinks are rejected upstream regardless
 * of where they point.
 */
export function parseTarVerboseLine(line) {
  const m = line.match(/^([-dlhfpcs])[rwxstST-]{9}\s+(.+)$/)
  if (!m) return null
  const [, type, rest] = m
  // Strip the optional " -> target" tail first so it doesn't confuse the
  // path extraction.
  const arrowIdx = rest.indexOf(' -> ')
  const head = arrowIdx >= 0 ? rest.slice(0, arrowIdx) : rest
  const link = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : null
  // Find the size: first token that is purely digits and is followed by
  // at least 3 more whitespace-separated tokens (date / time / path...).
  // The path is everything after the time token.
  const tokens = head.split(/\s+/)
  let sizeIdx = -1
  for (let i = 1; i < tokens.length - 3; i++) {
    if (/^\d+$/.test(tokens[i])) {
      sizeIdx = i
      break
    }
  }
  if (sizeIdx < 0) return null
  // After size: BSD ships `<month> <day> <time>` (3 tokens), GNU ships
  // `<YYYY-MM-DD> <HH:MM>` (2 tokens). Detect by counting hyphens.
  const possibleDate = tokens[sizeIdx + 1] ?? ''
  const dateTokenCount = /^\d{4}-\d{2}-\d{2}$/.test(possibleDate) ? 2 : 3
  const pathTokens = tokens.slice(sizeIdx + 1 + dateTokenCount)
  if (pathTokens.length === 0) return null
  const path = pathTokens.join(' ').replace(/\/$/, '')
  return { type, path, link }
}
