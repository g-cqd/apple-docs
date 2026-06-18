import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, join } from 'node:path'

/** @param {string} dirPath */
export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Serialize an object to minified JSON with sorted keys.
 * Deterministic output: same input always produces same string.
 * @param {unknown} obj
 */
export function stableStringify(obj) {
  return JSON.stringify(obj, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    }
    return value
  })
}

/**
 * Write a JSON object to disk as minified, key-sorted JSON.
 * Returns the serialized string (reuse for hashing — no double-stringify).
 * @param {string} filePath @param {unknown} obj
 */
export async function writeJSON(filePath, obj) {
  ensureDir(dirname(filePath))
  const str = stableStringify(obj)
  await Bun.write(filePath, str)
  return str
}

/** @param {string} filePath */
export async function readJSON(filePath) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  return file.json()
}

/** @param {string} filePath @param {string} text */
export async function writeText(filePath, text) {
  ensureDir(dirname(filePath))
  await Bun.write(filePath, text)
}

/** @param {string} filePath */
export async function readText(filePath) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return null
  return file.text()
}

/** Get total size of a directory in bytes (recursive). Returns 0 if missing. @param {string} dirPath */
export function dirSize(dirPath) {
  if (!existsSync(dirPath)) return 0
  let total = 0
  /** @param {string} p */
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dirPath)
  return total
}

/**
 * Recursive copy that prefers APFS `clonefile(2)` (`cp -c -R`) on macOS.
 * Falls back to a regular `cpSync` recursive copy on every other host
 * and whenever the clone path fails for any reason.
 *
 * Why: snapshotBuild stages ~946k file entries (DB + raw JSON + markdown
 * + symbol pre-renders + fonts) into a temp tree before invoking 7zz.
 * On the GH macos-26 runner (3-core M1 / 7 GiB / virtualised SSD) a
 * plain recursive copy of that many tiny files took 15-20 minutes
 * before compression even started, which alone could blow past the
 * spawn deadline. APFS `clonefile` makes the per-file work O(1) — it
 * publishes a new directory entry that shares the same data extents
 * via copy-on-write, so the entire 4 GiB tree stages in seconds. Same
 * filesystem is required; the snapshot temp dir and dataDir both live
 * under `/Users/runner/work/_temp` on the runner, so this holds.
 *
 * The `-c` flag is a BSD `cp` extension. macOS ships BSD cp; GNU
 * coreutils' `cp -c` is unrelated (SELinux context). The fallback
 * keeps the function correct on Linux test runners that exercise
 * snapshot helpers in unit tests.
 */
/** @param {string} src @param {string} dst */
export function copyTreeFast(src, dst) {
  if (platform() === 'darwin') {
    ensureDir(dirname(dst))
    const r = spawnSync('/bin/cp', ['-c', '-R', src, dst], { stdio: 'pipe' })
    if (r.status === 0) return
    // Fall through to cpSync if `cp -c` failed (cross-fs, non-APFS, etc).
  }
  cpSync(src, dst, { recursive: true })
}

/** Count files in a directory (recursive). Returns 0 if missing. @param {string} dirPath */
export function fileCount(dirPath) {
  if (!existsSync(dirPath)) return 0
  let count = 0
  /** @param {string} p */
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(p, entry.name))
      else count++
    }
  }
  walk(dirPath)
  return count
}
