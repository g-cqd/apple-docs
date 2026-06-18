import { randomBytes } from 'node:crypto'
import { copyFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir, stableStringify } from '../storage/files.js'

/** @param {string} filePath */
function createTempPath(filePath) {
  // Crypto-random suffix (~64 bits) so the staging name can't be
  // pre-guessed by a co-resident attacker who watches the
  // `.tmp-<pid>-…` prefix and races a symlink in before
  // `Bun.write()` opens it. Hex output keeps the path POSIX-safe.
  return `${filePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
}

/** @param {string} tempPath @param {string} filePath */
async function finalizeAtomicWrite(tempPath, filePath) {
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error)
    if (err?.code === 'EXDEV') {
      await copyFile(tempPath, filePath)
      await unlink(tempPath)
      return
    }

    await discardAtomicWrite(tempPath)

    throw error
  }
}

/** @param {string | null | undefined} tempPath */
export async function discardAtomicWrite(tempPath) {
  if (tempPath == null) return
  try {
    await unlink(tempPath)
  } catch {}
}

/** @param {string} filePath @param {string} text */
export async function stageTextAtomic(filePath, text) {
  ensureDir(dirname(filePath))
  const tempPath = createTempPath(filePath)
  await Bun.write(tempPath, text)
  return tempPath
}

/** @param {string} tempPath @param {string} filePath */
export async function promoteAtomicWrite(tempPath, filePath) {
  await finalizeAtomicWrite(tempPath, filePath)
}

/**
 * Atomically replace a UTF-8 text file via temp-file-and-rename.
 * @param {string} filePath
 * @param {string} text
 */
export async function writeTextAtomic(filePath, text) {
  const tempPath = await stageTextAtomic(filePath, text)
  await promoteAtomicWrite(tempPath, filePath)
  return text
}

/**
 * Atomically replace a JSON file with deterministic key ordering.
 * @param {string} filePath
 * @param {unknown} obj
 */
export async function writeJSONAtomic(filePath, obj) {
  const text = stableStringify(obj)
  await writeTextAtomic(filePath, text)
  return text
}
