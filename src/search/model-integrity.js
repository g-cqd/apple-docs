/**
 * Supply-chain pin for the shipped embedding model.
 *
 * `from_pretrained` floats whatever huggingface.co serves for the repo's
 * main branch, and the CI snapshot build runs with remote downloads enabled —
 * so a single-moment upstream compromise would bake silently into every
 * published artifact (the build-twice determinism gate only compares the two
 * passes of the same run). `ensureEmbeddingModel()` loads the model (fetching
 * it on first use in CI), runs one probe embedding, then sha256-verifies the
 * model files against the pins below and fails the release build on any
 * drift. Bumping the model is a deliberate act: re-pin the hashes in the same
 * commit that revalidates retrieval quality.
 *
 * Passing `revision:` to from_pretrained was rejected: a non-main revision
 * changes the transformers.js cache layout (`<repo>/<rev>/<file>`), which
 * would break model resolution for every already-shipped snapshot. Hash
 * verification gives the same fail-closed guarantee with zero layout risk.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getEmbedder, resolveActiveSpec } from './embedder.js'
import { sha256File } from '../lib/hash.js'
import { ValidationError } from '../lib/errors.js'

// minishlab/potion-retrieval-32M @ HF main 6fc8051fab2a1e0ee76689cf08c853792ac285e7
// (2026-06-09), cross-verified against the snapshot-20260609 production install.
export const PINNED_MODEL_FILES = {
  'minishlab/potion-retrieval-32M': {
    'onnx/model.onnx': 'e82f46335878dd5d72f9544a2a7c61061659c6273ceb8815e10ff952c2e07457',
    'tokenizer.json': '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18',
    'tokenizer_config.json': '6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567',
  },
}

/**
 * Verify a model's on-disk files against pinned sha256 hashes. Throws
 * ValidationError on any missing or drifted file.
 *
 * @param {string} dir models root (the dir that contains `<hfId>/…`)
 * @param {string} hfId
 * @param {Record<string, Record<string, string>>} [pins] test seam
 * @returns {Promise<{ verified: number }>}
 */
export async function verifyPinnedModelFiles(dir, hfId, pins = PINNED_MODEL_FILES) {
  const pinned = pins[hfId]
  if (!pinned) return { verified: 0 }
  const mismatches = []
  for (const [rel, want] of Object.entries(pinned)) {
    const path = join(dir, hfId, rel)
    const got = existsSync(path) ? await sha256File(path) : '(missing)'
    if (got !== want) mismatches.push(`${rel}: ${got} != ${want}`)
  }
  if (mismatches.length > 0) {
    throw new ValidationError(
      `Embedding model failed its integrity pin — upstream drift or tampering. Do not ship.\n  ${mismatches.join('\n  ')}`,
    )
  }
  return { verified: Object.keys(pinned).length }
}

/**
 * Make sure the active embedding model is on disk, runs, and matches its pin.
 * Strict when `APPLE_DOCS_ALLOW_REMOTE_MODELS=1` (a release build): a missing
 * model there would silently ship a snapshot with no semantic tier for every
 * consumer, so it throws instead of skipping.
 *
 * @param {{ modelsDir?: string, logger?: object, embedder?: object|null }} [opts]
 *   `embedder` is a test seam: `null` forces the unavailable path, an object
 *   skips the real getEmbedder.
 * @returns {Promise<{ status: 'ok'|'skipped', hfId?: string, verified?: number, message?: string }>}
 */
export async function ensureEmbeddingModel({ modelsDir, logger, embedder } = {}) {
  const strict = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'
  const active = embedder !== undefined ? embedder : await getEmbedder({ logger, modelsDir })
  if (!active) {
    const message = 'embedder unavailable (optional @huggingface/transformers dependency or model missing)'
    if (strict) throw new ValidationError(`Release build requires the embedding model to ship: ${message}`)
    return { status: 'skipped', message }
  }
  await active.embed('integrity probe') // the model must actually run, not just hash

  const spec = resolveActiveSpec()
  const dir = process.env.APPLE_DOCS_MODELS_DIR
    ?? modelsDir
    ?? join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')
  const { verified } = await verifyPinnedModelFiles(dir, spec.hfId)
  return verified === 0
    // Gated non-default variants build separate artifacts; pin them when (if)
    // one is ever promoted to a published snapshot.
    ? { status: 'ok', hfId: spec.hfId, verified, message: 'no pins for this model (non-default variant)' }
    : { status: 'ok', hfId: spec.hfId, verified }
}
