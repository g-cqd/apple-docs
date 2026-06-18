// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Supply-chain pin + acquisition for the shipped embedding model.
 *
 * Stage C (RFC 0002 §6f): snapshots ship the derived ADMX weights artifact
 * instead of model.onnx, and the default-model embed path is native-only —
 * transformers.js no longer exists as the release build's model downloader.
 * This module therefore owns BOTH halves of the trust story:
 *
 *  - PINS: the files a snapshot ships (tokenizer{,_config}.json +
 *    matrix-v1.admx). The admx pin is stable because the artifact bytes are
 *    deterministic (RFC 0002 §6b) — and its header embeds the sha of the
 *    SOURCE model.onnx, so `LEGACY_ONNX_SHA256` must survive the onnx
 *    de-listing forever: byte-identical derivation depends on it.
 *  - ACQUISITION (release builds, `APPLE_DOCS_ALLOW_REMOTE_MODELS=1`):
 *    pin-verified direct fetches from huggingface.co for missing inputs
 *    (fail-closed — a sha mismatch aborts the build), then ADMX derivation.
 *    Ad-hoc/consumer boots never fetch; they only DERIVE the artifact when
 *    an older onnx-bearing snapshot provides the source (one-cycle compat).
 *
 * Bumping the model is a deliberate act: re-pin every hash in the same
 * commit that revalidates retrieval quality (and regenerate the committed
 * embed fixtures — see scripts/gen-embed-fixtures.mjs).
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateMatrixArtifact } from '../lib/admx.js'
import { promoteAtomicWrite } from '../lib/atomic-write.js'
import { ValidationError } from '../lib/errors.js'
import { sha256File } from '../lib/hash.js'
import { getEmbedder, resolveActiveSpec } from './embedder.js'

// minishlab/potion-retrieval-32M @ HF main 6fc8051fab2a1e0ee76689cf08c853792ac285e7
// (2026-06-09), cross-verified against the snapshot-20260609 production install.
// The onnx itself left the pin set with Stage C (snapshots no longer ship it)
// but remains the immutable derivation source for matrix-v1.admx.
export const LEGACY_ONNX_SHA256 = 'e82f46335878dd5d72f9544a2a7c61061659c6273ceb8815e10ff952c2e07457'

export const PINNED_MODEL_FILES = {
  'minishlab/potion-retrieval-32M': {
    'tokenizer.json': '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18',
    'tokenizer_config.json': '6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567',
    // Deterministic ADMX export of the legacy onnx (RFC 0002 §6b/§6f).
    'matrix-v1.admx': 'fb938b1e0e14838480fd7abfc67f510908a500362c5cb6c64ba1ff9c88068255',
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
    throw new ValidationError(`Embedding model failed its integrity pin — upstream drift or tampering. Do not ship.\n  ${mismatches.join('\n  ')}`)
  }
  return { verified: Object.keys(pinned).length }
}

/** Pin-verified fetch of one model file into the models layout. Fail-closed. */
async function fetchPinned(dir, hfId, rel, wantSha, logger) {
  const url = `https://huggingface.co/${hfId}/resolve/main/${rel}`
  const dest = join(dir, hfId, rel)
  mkdirSync(dirname(dest), { recursive: true })
  // 15-minute hard deadline: a hung CDN stream must fail the release build
  // loudly, never hang it. Chunk-streamed to disk (Bun.write(path, response)
  // was observed stalling indefinitely on multi-MB HF bodies).
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok) {
    throw new ValidationError(`model fetch failed (${response.status}): ${url}`)
  }
  const temp = `${dest}.fetch-${process.pid}`
  const sink = Bun.file(temp).writer()
  let received = 0
  let lastLogged = 0
  for await (const chunk of response.body) {
    sink.write(chunk)
    received += chunk.length
    if (received - lastLogged >= 32 * 1024 * 1024) {
      lastLogged = received
      logger?.info?.(`Fetching ${rel}: ${(received / 1e6).toFixed(0)} MB…`)
    }
  }
  await sink.end()
  const got = await sha256File(temp)
  if (got !== wantSha) {
    rmSync(temp, { force: true })
    throw new ValidationError(`fetched ${rel} failed its pin: ${got} != ${wantSha}. Do not ship.`)
  }
  await promoteAtomicWrite(temp, dest)
  logger?.info?.(`Fetched ${rel} (pin-verified) for ${hfId}`)
}

/**
 * Make the pinned model inputs exist locally.
 *
 * Release builds (`allowRemote`) fetch anything missing — tokenizer files
 * against their pins, and the legacy onnx (against LEGACY_ONNX_SHA256) only
 * when the ADMX artifact still needs deriving. Consumer boots never fetch:
 * they only derive ADMX from an onnx an older snapshot shipped.
 */
async function acquireModelInputs(dir, hfId, { allowRemote, logger }) {
  const pins = PINNED_MODEL_FILES[hfId]
  if (!pins) return
  for (const rel of ['tokenizer.json', 'tokenizer_config.json']) {
    if (existsSync(join(dir, hfId, rel))) continue
    if (!allowRemote) return // nothing acquirable offline; verification reports
    await fetchPinned(dir, hfId, rel, pins[rel], logger)
  }
  const admxPath = join(dir, hfId, 'matrix-v1.admx')
  if (existsSync(admxPath)) return
  const onnxPath = join(dir, hfId, 'onnx', 'model.onnx')
  if (!existsSync(onnxPath)) {
    if (!allowRemote) return
    await fetchPinned(dir, hfId, 'onnx/model.onnx', LEGACY_ONNX_SHA256, logger)
  } else {
    const got = await sha256File(onnxPath)
    if (got !== LEGACY_ONNX_SHA256) {
      throw new ValidationError(`model.onnx failed its legacy derivation pin: ${got} != ${LEGACY_ONNX_SHA256}`)
    }
  }
  const { rows, dims } = await generateMatrixArtifact({
    onnxPath,
    outPath: admxPath,
    sourceShaHex: LEGACY_ONNX_SHA256,
  })
  logger?.info?.(`Derived matrix-v1.admx (${rows}×${dims}) from the pinned model.onnx`)
}

/**
 * Make sure the active embedding model is on disk, runs, and matches its
 * pins. Strict when `APPLE_DOCS_ALLOW_REMOTE_MODELS=1` (a release build): a
 * missing model there would silently ship a snapshot with no semantic tier
 * for every consumer, so it throws instead of skipping.
 *
 * @param {{ modelsDir?: string, logger?: object, embedder?: object|null }} [opts]
 *   `embedder` is a test seam: `null` forces the unavailable path, an object
 *   skips the real getEmbedder (and skips acquisition — unit scope).
 * @returns {Promise<{ status: 'ok'|'skipped', hfId?: string, verified?: number, message?: string }>}
 */
export async function ensureEmbeddingModel({ modelsDir, logger, embedder } = {}) {
  // The remote-models flag is set only by the CI snapshot build, so it doubles
  // as the "this is a release build" signal — a missing model there must fail
  // hard rather than silently ship a snapshot with no semantic tier.
  const isReleaseBuild = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'
  const spec = resolveActiveSpec()
  const dir = process.env.APPLE_DOCS_MODELS_DIR ?? modelsDir ?? join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')

  if (embedder === undefined) {
    // Acquire/derive BEFORE building the embedder: the native default path
    // needs the artifact on disk, and release builds must not depend on a
    // library-side downloader (transformers' was removed with Stage C).
    try {
      await acquireModelInputs(dir, spec.hfId, { allowRemote: isReleaseBuild, logger })
    } catch (error) {
      if (isReleaseBuild) throw error
      logger?.debug?.(`model acquisition skipped: ${error.message}`)
    }
  }

  const active = embedder !== undefined ? embedder : await getEmbedder({ logger, modelsDir })
  if (!active) {
    const message = 'embedder unavailable (native bundle/artifact missing, or optional @huggingface/transformers absent for gated models)'
    if (isReleaseBuild) throw new ValidationError(`Release build requires the embedding model to ship: ${message}`)
    return { status: 'skipped', message }
  }
  await active.embed('integrity probe') // the model must actually run, not just hash

  const { verified } = await verifyPinnedModelFiles(dir, spec.hfId)
  return verified === 0
    ? // Gated non-default variants build separate artifacts; pin them when (if)
      // one is ever promoted to a published snapshot.
      { status: 'ok', hfId: spec.hfId, verified, message: 'no pins for this model (non-default variant)' }
    : { status: 'ok', hfId: spec.hfId, verified }
}
