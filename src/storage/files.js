import { mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true })
  }
}

/**
 * Serialize an object to minified JSON with sorted keys.
 * Deterministic output: same input always produces same string.
 */
export function stableStringify(obj) {
  return JSON.stringify(obj, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    }
    return value
  })
}

/**
 * Write a JSON object to disk as minified, key-sorted JSON.
 * Returns the serialized string (reuse for hashing — no double-stringify).
 */
export async function writeJSON(filePath, obj) {
  ensureDir(dirname(filePath))
  const str = stableStringify(obj)
  await Bun.write(filePath, str)
  return str
}

export async function readJSON(filePath) {
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  return file.json()
}

export async function writeText(filePath, text) {
  ensureDir(dirname(filePath))
  await Bun.write(filePath, text)
}

export async function readText(filePath) {
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  return file.text()
}

/** Get total size of a directory in bytes (recursive). Returns 0 if missing. */
export function dirSize(dirPath) {
  if (!existsSync(dirPath)) return 0
  let total = 0
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

/** Count files in a directory (recursive). Returns 0 if missing. */
export function fileCount(dirPath) {
  if (!existsSync(dirPath)) return 0
  let count = 0
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(p, entry.name))
      else count++
    }
  }
  walk(dirPath)
  return count
}
