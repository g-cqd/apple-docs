/**
 * Validate that a font's on-disk path lives under an approved root before
 * the web layer reads it.
 *
 * Audit A6: apple_font_files.file_path is filled at sync time from either
 * a system-font directory (/Library/Fonts, /System/Library/Fonts,
 * ~/Library/Fonts) or the DMG-extract output under
 * <dataDir>/resources/fonts/extracted. Without a runtime containment
 * check, a malicious DB row (or a sync-time bug that lands a path
 * pointing outside those roots) would let the route serve arbitrary
 * filesystem bytes.
 *
 * Rather than a schema migration (the plan's first sketch — add a
 * relative_path column), this module enforces the invariant at every
 * read. The existing rows are unchanged; the route refuses paths that
 * canonicalize outside the allowlist.
 */

import { resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { ValidationError } from '../../lib/errors.js'

const SYSTEM_FONT_ROOTS = [
  '/Library/Fonts',
  '/System/Library/Fonts',
]

/**
 * Build the set of canonical roots a font's file_path may reside under.
 * The user-home one and the dataDir one are computed per-call since
 * they're only known at request time.
 *
 * @param {string} dataDir
 * @returns {string[]}
 */
function approvedFontRoots(dataDir) {
  const roots = SYSTEM_FONT_ROOTS.map(p => resolve(p) + sep)
  roots.push(resolve(homedir(), 'Library', 'Fonts') + sep)
  roots.push(resolve(dataDir, 'resources', 'fonts', 'extracted') + sep)
  return roots
}

/**
 * Throw ValidationError if `filePath` doesn't canonicalize under one of
 * the approved roots; otherwise return the canonical absolute path.
 *
 * @param {string} filePath
 * @param {string} dataDir
 * @returns {string}
 */
export function assertFontPathContained(filePath, dataDir) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new ValidationError('Font file_path is missing or empty', {
      field: 'file_path', value: filePath,
    })
  }
  const resolved = resolve(filePath)
  const roots = approvedFontRoots(dataDir)
  for (const root of roots) {
    if (resolved.startsWith(root) || resolved === root.slice(0, -1)) {
      return resolved
    }
  }
  throw new ValidationError(
    `Font file_path escapes approved roots: ${filePath}`,
    { field: 'file_path', value: filePath },
  )
}
