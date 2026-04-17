import { copyFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ensureDir, stableStringify } from '../storage/files.js'

function createTempPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
}

async function finalizeAtomicWrite(tempPath, filePath) {
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    if (error?.code === 'EXDEV') {
      await copyFile(tempPath, filePath)
      await unlink(tempPath)
      return
    }

    await discardAtomicWrite(tempPath)

    throw error
  }
}

export async function discardAtomicWrite(tempPath) {
  try {
    await unlink(tempPath)
  } catch {}
}

export async function stageTextAtomic(filePath, text) {
  ensureDir(dirname(filePath))
  const tempPath = createTempPath(filePath)
  await Bun.write(tempPath, text)
  return tempPath
}

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
