/**
 * Direct model-file fetcher for the static model2vec backend.
 *
 * The transformers.js path downloads its own files (env.allowRemoteModels);
 * the pure-JS backend reads plain files, so this module fills the same gap:
 * when a required file is missing and fetching is allowed, pull it from
 * huggingface.co and land it in the transformers.js-compatible layout
 * (`<modelsDir>/<hfId>/<relPath>`) so both backends and every already-shipped
 * snapshot resolve the same paths.
 *
 * Fail-closed integrity: after any download of a pinned model, the on-disk
 * files are sha256-verified against `PINNED_MODEL_FILES` and a mismatch
 * throws — a compromised upstream cannot slide bytes into the index build.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { verifyPinnedModelFiles, PINNED_MODEL_FILES } from './model-integrity.js'

const HF_BASE = 'https://huggingface.co'

/**
 * Ensure `files` exist under `<modelsDir>/<hfId>/`. Downloads the missing ones
 * when `allowFetch` is true; throws when a file is missing and fetching is
 * disabled, or when a pinned model fails verification after download.
 *
 * @param {{ modelsDir: string, hfId: string, files: string[], allowFetch: boolean, logger?: object }} opts
 * @returns {Promise<{ fetched: number }>}
 */
export async function ensureModelFiles({ modelsDir, hfId, files, allowFetch, logger }) {
  const missing = files.filter(rel => !existsSync(join(modelsDir, hfId, rel)))
  if (missing.length === 0) return { fetched: 0 }
  if (!allowFetch) {
    throw new Error(
      `embedding model ${hfId} is missing ${missing.join(', ')} and model fetching is disabled ` +
      '(re-run without --no-fetch-models, or run `apple-docs setup`)',
    )
  }
  for (const rel of missing) {
    const url = `${HF_BASE}/${hfId}/resolve/main/${rel}`
    const dest = join(modelsDir, hfId, rel)
    logger?.info?.(`Fetching embedding model file ${hfId}/${rel}…`)
    await downloadTo(url, dest)
  }
  if (PINNED_MODEL_FILES[hfId]) await verifyPinnedModelFiles(modelsDir, hfId)
  logger?.info?.(`Embedding model ${hfId} ready (${missing.length} file${missing.length === 1 ? '' : 's'} fetched).`)
  return { fetched: missing.length }
}

/** Stream a URL to disk atomically (tmp file + rename). */
async function downloadTo(url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`model download failed: HTTP ${res.status} for ${url}`)
  }
  const tmp = `${dest}.download`
  try {
    const sink = Bun.file(tmp).writer()
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sink.write(value)
      }
    } finally {
      await sink.end()
    }
    renameSync(tmp, dest)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
