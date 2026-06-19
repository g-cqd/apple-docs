/**
 * Native embedder dispatch (RFC 0002 phase 3): the bit-exact Swift pipeline
 * (libAppleDocsCore ad_embed_*) behind the `APPLE_DOCS_NATIVE=embed` kill
 * switch — for the DEFAULT model only (gated transformer models keep the
 * transformers.js path, D-0002-4).
 *
 * `buildNativeModel2Vec` NEVER throws: every failure logs a reason and
 * returns null so getEmbedder degrades to lexical-only (Stage C: the JS
 * default-model embed path no longer exists). Once
 * built, embed/embedBatch THROW on native errors instead of silently
 * re-dispatching — the whole-embedder selection already happened, and both
 * call sites degrade cleanly (query path catches → lexical-only; the index
 * command rolls back its batch and aborts resumably).
 *
 * The 129 MB ADMX weights artifact is generated ON DEMAND from the
 * snapshot-shipped model.onnx (full pin verification first, atomic write) —
 * snapshots don't grow, and the one-time cost is ~1-2 s.
 *
 * Byte layouts are shared verbatim with swift/Sources/ADCore/EmbedExports.swift.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateMatrixArtifact } from '../lib/admx.js'
import { sha256File } from '../lib/hash.js'
import { createLogger } from '../lib/logger.js'
import { getNativeLib } from '../native/loader.js'
import { NATIVE_STATUS_OK, nativeErrorMessage, readNativeResult } from '../native/result.js'
import { LEGACY_ONNX_SHA256, PINNED_MODEL_FILES, verifyPinnedModelFiles } from './model-integrity.js'

const DEFAULT_HF_ID = 'minishlab/potion-retrieval-32M'
// The embedding behavior version this JS expects from the dylib (mirrors
// swift/Sources/ADEmbed/EmbedBehavior.swift). The dylib's REPORTED version
// is what gets stamped into snapshot_meta — a stale APPLE_DOCS_NATIVE_LIB
// override must stamp what it actually computes.
export const EXPECTED_EMBED_VERSION = 2
const encoder = new TextEncoder()

/** @type {'js'|'native'|null} */
let forced = null // 'js' | 'native' | null
let announced = false
/** @type {any} */
let logger

function log() {
  logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
  return logger
}

/** Test seams. @param {'js'|'native'|null} impl */
export function _forceImpl(impl) {
  forced = impl
  announced = false
}
export function _resetNativeEmbedder() {
  getNativeLib()?.symbols.ad_embed_reset()
  announced = false
}

/** @param {boolean} served @param {number} [version] */
function announce(served, version) {
  if (announced) return
  log().info(`embed: served by ${served ? `native libAppleDocsCore (behavior v${version})` : 'js (native unavailable)'}`)
  announced = true
}

/**
 * Make sure the ADMX artifact exists next to the model, generating it from
 * the pinned model.onnx when needed. Returns the artifact path or null.
 */
/** @param {string} modelsDir @param {string} hfId @param {string[]} reasons */
async function ensureMatrixArtifact(modelsDir, hfId, reasons) {
  const matrixPath = join(modelsDir, hfId, 'matrix-v1.admx')
  if (existsSync(matrixPath)) return matrixPath
  const onnxPath = join(modelsDir, hfId, 'onnx', 'model.onnx')
  if (!existsSync(onnxPath)) {
    reasons.push(`no matrix artifact and no model.onnx at ${onnxPath}`)
    return null
  }
  try {
    // Integrity gates before deriving: the tokenizer pins from the active
    // pin set, and the LEGACY onnx sha explicitly — the onnx left
    // PINNED_MODEL_FILES with Stage C (snapshots ship the artifact), but it
    // remains the immutable derivation source on older snapshots.
    await verifyPinnedModelFiles(modelsDir, hfId, {
      [hfId]: {
        'tokenizer.json': PINNED_MODEL_FILES[hfId]['tokenizer.json'],
        'tokenizer_config.json': PINNED_MODEL_FILES[hfId]['tokenizer_config.json'],
      },
    })
    const got = await sha256File(onnxPath)
    if (got !== LEGACY_ONNX_SHA256) {
      reasons.push(`model.onnx failed its legacy derivation pin: ${got}`)
      return null
    }
    const { rows, dims } = await generateMatrixArtifact({
      onnxPath,
      outPath: matrixPath,
      sourceShaHex: LEGACY_ONNX_SHA256,
    })
    log().info(`embed: generated ${matrixPath} (${rows}×${dims}) from the pinned model.onnx`)
    return matrixPath
  } catch (error) {
    reasons.push(`matrix artifact generation failed: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

/**
 * Setup-time wrapper around the on-demand artifact derivation: best-effort,
 * warn-only (a missing model or read-only dir just means the artifact gets
 * derived lazily at first native-embed use instead).
 */
/** @param {any} modelsDir @param {any} logger */
export async function pregenerateMatrixArtifact(modelsDir, logger) {
  /** @type {string[]} */
  const reasons = []
  const path = await ensureMatrixArtifact(modelsDir, DEFAULT_HF_ID, reasons)
  if (!path) logger?.warn?.(`native embed artifact not pre-generated (${reasons.join('; ')})`)
  return path
}

/** Parse the sha-pinned tokenizer.json without touching transformers.js. @param {string} modelDir @param {string[]} reasons */
function loadTokenizerConfig(modelDir, reasons) {
  try {
    const tk = JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'))
    const entries = Object.entries(tk.model.vocab)
    const vocab = new Array(entries.length)
    for (const [token, id] of entries) {
      if (!Number.isInteger(id) || id < 0 || id >= vocab.length || vocab[id] !== undefined) {
        reasons.push(`tokenizer vocab ids are not contiguous at ${id}`)
        return null
      }
      vocab[id] = token
    }
    return {
      vocab,
      added: tk.added_tokens.map((/** @type {any} */ a) => ({ id: a.id, content: a.content })),
      unkToken: tk.model.unk_token,
      prefix: tk.model.continuing_subword_prefix,
      maxInputCharsPerWord: tk.model.max_input_chars_per_word ?? 100,
    }
  } catch (error) {
    reasons.push(`tokenizer.json unreadable: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

/** @param {string} matrixPath @param {any} config */
function packInitRequest(matrixPath, config) {
  /** @type {Uint8Array[]} */
  const parts = []
  let total = 0
  const pushU32 = (/** @type {number} */ value) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    parts.push(bytes)
    total += 4
  }
  const pushString = (/** @type {string} */ text) => {
    const utf8 = encoder.encode(text)
    pushU32(utf8.length)
    parts.push(utf8)
    total += utf8.length
  }
  pushU32(1)
  pushString(matrixPath)
  pushU32(config.vocab.length)
  for (const token of config.vocab) pushString(token)
  pushU32(config.added.length)
  for (const added of config.added) {
    pushU32(added.id)
    pushString(added.content)
  }
  pushString(config.unkToken)
  pushString(config.prefix)
  pushU32(config.maxInputCharsPerWord)
  // One-shot ~750 KB request — a fresh buffer, NOT the grow-only batch scratch.
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Batch packing reuses one grow-only scratch (fusion-native.js pattern):
// calls are synchronous and single-threaded, the native side consumes the
// bytes before the call returns.
let scratch = new ArrayBuffer(16384)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

/** @param {number} byteLength */
function ensureScratch(byteLength) {
  if (scratch.byteLength < byteLength) {
    let size = scratch.byteLength * 2
    while (size < byteLength) size *= 2
    scratch = new ArrayBuffer(size)
    scratchU8 = new Uint8Array(scratch)
    scratchView = new DataView(scratch)
  }
}

/** @param {string[]} texts */
function packBatchRequest(texts) {
  const encoded = texts.map((text) => encoder.encode(text))
  let total = 8
  for (const utf8 of encoded) total += 4 + utf8.length
  ensureScratch(total)
  scratchView.setUint32(0, 1, true)
  scratchView.setUint32(4, texts.length, true)
  let offset = 8
  for (const utf8 of encoded) {
    scratchView.setUint32(offset, utf8.length, true)
    offset += 4
    scratchU8.set(utf8, offset)
    offset += utf8.length
  }
  return { bytes: scratchU8, length: total }
}

/**
 * Build the native model2vec embedder, or null (with logged reasons) when
 * anything along the path is unavailable. Never throws.
 *
 * @param {{ hfId: string, dims: number }} spec resolved model spec
 * @param {string} modelsDir
 * @param {{ matrixPath?: string, modelDir?: string }} [opts] test seams
 */
export async function buildNativeModel2Vec(spec, modelsDir, opts = {}) {
  if (forced === 'js') return null
  /** @type {string[]} */
  const reasons = []
  try {
    if (spec.hfId !== DEFAULT_HF_ID) {
      reasons.push(`native embed serves the default model only (got ${spec.hfId})`)
      return logAndNull(reasons)
    }
    const lib = getNativeLib()
    if (!lib) {
      reasons.push('libAppleDocsCore unavailable')
      return logAndNull(reasons)
    }
    const modelDir = opts.modelDir ?? join(modelsDir, spec.hfId)
    const matrixPath = opts.matrixPath ?? (await ensureMatrixArtifact(modelsDir, spec.hfId, reasons))
    if (!matrixPath || !existsSync(matrixPath)) {
      if (reasons.length === 0) reasons.push(`matrix artifact missing at ${matrixPath}`)
      return logAndNull(reasons)
    }
    const config = loadTokenizerConfig(modelDir, reasons)
    if (!config) return logAndNull(reasons)

    const initRequest = packInitRequest(matrixPath, config)
    const init = readNativeResult(lib, lib.symbols.ad_embed_init(initRequest, BigInt(initRequest.length)))
    if (init.status !== NATIVE_STATUS_OK) {
      reasons.push(`ad_embed_init: ${nativeErrorMessage(init)}`)
      return logAndNull(reasons)
    }
    const view = new DataView(init.bytes.buffer, init.bytes.byteOffset, init.bytes.byteLength)
    const dims = view.getUint32(0, true)
    if (dims !== spec.dims) {
      reasons.push(`native dims ${dims} != spec dims ${spec.dims}`)
      return logAndNull(reasons)
    }
    // Pre-v2 dylibs emit an 8-byte payload — treat as behavior v1.
    const embedVersion = init.bytes.byteLength >= 12 ? view.getUint32(8, true) : 1
    if (embedVersion !== EXPECTED_EMBED_VERSION) {
      log().warn(
        `embed: dylib reports behavior v${embedVersion}, this build expects v${EXPECTED_EMBED_VERSION} ` +
          '(stale APPLE_DOCS_NATIVE_LIB override?) — embeddings will stamp the reported version',
      )
    }

    const embedBatch = async (/** @type {string[]} */ texts) => {
      if (!texts || texts.length === 0) return []
      const { bytes, length } = packBatchRequest(texts.map((t) => t ?? ''))
      const result = readNativeResult(lib, lib.symbols.ad_embed_batch(bytes, BigInt(length)))
      if (result.status !== NATIVE_STATUS_OK) {
        throw new Error(`native embed failed: ${nativeErrorMessage(result)}`)
      }
      const floats = new Float32Array(result.bytes.buffer, result.bytes.byteOffset, texts.length * dims)
      const out = new Array(texts.length)
      for (let i = 0; i < texts.length; i++) out[i] = floats.subarray(i * dims, (i + 1) * dims)
      return out
    }
    // The exact storage blobs (sign + int8+scale) the index pipeline writes —
    // 580 B/chunk across the bridge instead of the 2 KB f32 vector plus a JS
    // quantize pass. Views are stable: readNativeResult copies per call.
    const codeStride = dims / 8 + dims + 4
    const embedBatchCodes = async (/** @type {string[]} */ texts) => {
      if (!texts || texts.length === 0) return []
      const { bytes, length } = packBatchRequest(texts.map((t) => t ?? ''))
      const result = readNativeResult(lib, lib.symbols.ad_embed_batch_codes(bytes, BigInt(length)))
      if (result.status !== NATIVE_STATUS_OK) {
        throw new Error(`native embed failed: ${nativeErrorMessage(result)}`)
      }
      const out = new Array(texts.length)
      for (let i = 0; i < texts.length; i++) {
        const base = result.bytes.byteOffset + i * codeStride
        out[i] = {
          vecBin: new Uint8Array(result.bytes.buffer, base, dims / 8),
          vecI8: new Uint8Array(result.bytes.buffer, base + dims / 8, dims + 4),
        }
      }
      return out
    }
    announce(true, embedVersion)
    return {
      dims,
      embedVersion,
      async embed(/** @type {string} */ text) {
        return (await embedBatch([text ?? '']))[0]
      },
      embedBatch,
      embedBatchCodes,
    }
  } catch (error) {
    // Defensive: nothing above should throw, but this builder must not.
    reasons.push(`unexpected: ${error instanceof Error ? error.message : error}`)
    return logAndNull(reasons)
  }
}

/** @param {string[]} reasons */
function logAndNull(reasons) {
  announce(false)
  log().warn(`embed: native path unavailable (${reasons.join('; ')}) — semantic tier dormant (lexical-only)`)
  return null
}
