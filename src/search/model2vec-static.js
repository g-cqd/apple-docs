/**
 * Pure-JS model2vec backend: WordPiece tokenize → embedding-row lookup →
 * mean-pool. Replaces the transformers.js + onnxruntime path for the default
 * `potion-retrieval-32M` model.
 *
 * Why not ONNX: the model is a single EmbeddingBag (no forward pass), so the
 * whole runtime stack existed only to gather rows and average them. Worse, the
 * stack breaks inside the `bun build --compile` binary — `onnxruntime-node`'s
 * napi binding and transformers.js's eager `sharp` import both resolve native
 * files that aren't embedded, so every compiled install silently lost the
 * semantic tier. This module reads the *same shipped artifacts* (tokenizer.json
 * + onnx/model.onnx — the integrity pins are unchanged) with zero native deps.
 *
 * Parity: the tokenizer implements exactly the pipeline declared by the
 * shipped tokenizer.json (BertNormalizer → BertPreTokenizer → WordPiece,
 * no special tokens — mirroring the previous `add_special_tokens: false`),
 * and pooling averages the same fp32 rows. test/unit/search/
 * model2vec-static.test.js pins token-level and vector-level parity against
 * the transformers.js reference.
 */

import { join } from 'node:path'
import { l2normalize } from './pooling.js'

// ---------------------------------------------------------------------------
// ONNX parsing — just enough protobuf to pull one initializer tensor out of
// the shipped model.onnx. Wire format only; no schema dependency.
// ---------------------------------------------------------------------------

function readVarint(bytes, pos) {
  let result = 0n
  let shift = 0n
  for (;;) {
    const b = bytes[pos++]
    if (b === undefined) throw new Error('ONNX parse: truncated varint')
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [result, pos]
    shift += 7n
  }
}

/** Iterate protobuf fields in bytes[start, end). Yields varint values or
 *  sub-range views for length-delimited fields. */
function* protoFields(bytes, start, end) {
  let pos = start
  while (pos < end) {
    let tag
    ;[tag, pos] = readVarint(bytes, pos)
    const num = Number(tag >> 3n)
    const wireType = Number(tag & 7n)
    switch (wireType) {
      case 0: { // varint
        let v
        ;[v, pos] = readVarint(bytes, pos)
        yield { num, wireType, value: v }
        break
      }
      case 2: { // length-delimited
        let len
        ;[len, pos] = readVarint(bytes, pos)
        const s = pos
        pos += Number(len)
        if (pos > end) throw new Error('ONNX parse: field overruns buffer')
        yield { num, wireType, start: s, end: pos }
        break
      }
      case 5: pos += 4; yield { num, wireType }; break // fixed32
      case 1: pos += 8; yield { num, wireType }; break // fixed64
      default: throw new Error(`ONNX parse: unsupported wire type ${wireType}`)
    }
  }
}

const ONNX_FLOAT = 1 // TensorProto.DataType.FLOAT

/**
 * Extract the 2-D fp32 embedding matrix from an ONNX model2vec export.
 * Returns `{ rows, dims, data: Float32Array }`. Throws when no matching
 * initializer exists (not a model2vec artifact).
 *
 * @param {Uint8Array} bytes
 */
export function extractEmbeddingMatrix(bytes) {
  // ModelProto.graph = field 7; GraphProto.initializer = field 5 (TensorProto).
  for (const f of protoFields(bytes, 0, bytes.length)) {
    if (f.num !== 7 || f.wireType !== 2) continue
    for (const g of protoFields(bytes, f.start, f.end)) {
      if (g.num !== 5 || g.wireType !== 2) continue
      const tensor = parseTensor(bytes, g.start, g.end)
      if (tensor) return tensor
    }
  }
  throw new Error('model.onnx has no 2-D fp32 embedding initializer (not a model2vec export)')
}

function parseTensor(bytes, start, end) {
  const dims = []
  let dataType = null
  let raw = null
  for (const t of protoFields(bytes, start, end)) {
    if (t.num === 1) { // dims: packed or repeated int64
      if (t.wireType === 0) dims.push(Number(t.value))
      else {
        let p = t.start
        while (p < t.end) {
          let v
          ;[v, p] = readVarint(bytes, p)
          dims.push(Number(v))
        }
      }
    } else if (t.num === 2 && t.wireType === 0) dataType = Number(t.value)
    else if (t.num === 9 && t.wireType === 2) raw = { start: t.start, end: t.end }
  }
  if (dataType !== ONNX_FLOAT || dims.length !== 2 || !raw) return null
  const [rows, cols] = dims
  if (raw.end - raw.start !== rows * cols * 4) return null
  // Copy into an aligned buffer — raw_data's byte offset inside the protobuf
  // is arbitrary, and Float32Array views require 4-byte alignment.
  const copy = bytes.slice(raw.start, raw.end)
  return { rows, dims: cols, data: new Float32Array(copy.buffer, copy.byteOffset, rows * cols) }
}

// ---------------------------------------------------------------------------
// Tokenizer — BertNormalizer → BertPreTokenizer → WordPiece, driven by the
// shipped tokenizer.json. Special tokens are never added (parity with the
// previous `add_special_tokens: false` encode).
// ---------------------------------------------------------------------------

function isWhitespace(cp) {
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || /\s/u.test(String.fromCodePoint(cp))
}

function isControl(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false // treated as whitespace
  const cat = String.fromCodePoint(cp)
  return /[\p{Cc}\p{Cf}]/u.test(cat)
}

// HF's BertPreTokenizer punctuation: ASCII ranges 33-47, 58-64, 91-96, 123-126
// plus every unicode `P*` category char.
function isPunctuation(cp) {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true
  return /\p{P}/u.test(String.fromCodePoint(cp))
}

// CJK unified ideograph blocks (BertNormalizer.handle_chinese_chars pads
// these with spaces so each ideograph tokenizes alone).
function isChineseChar(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f)
}

/**
 * Build a WordPiece encoder from a parsed tokenizer.json. Supports the exact
 * pipeline the potion models ship (BertNormalizer / BertPreTokenizer /
 * WordPiece); throws on anything else so a future model swap fails loudly
 * instead of silently mis-tokenizing.
 *
 * @param {object} tokenizerJson
 * @returns {{ encode(text: string): number[] }}
 */
export function createWordPieceTokenizer(tokenizerJson) {
  const model = tokenizerJson?.model
  if (model?.type !== 'WordPiece') {
    throw new Error(`unsupported tokenizer model "${model?.type}" (expected WordPiece)`)
  }
  const norm = tokenizerJson.normalizer ?? {}
  if (norm.type && norm.type !== 'BertNormalizer') {
    throw new Error(`unsupported normalizer "${norm.type}" (expected BertNormalizer)`)
  }
  const pre = tokenizerJson.pre_tokenizer ?? {}
  if (pre.type && pre.type !== 'BertPreTokenizer') {
    throw new Error(`unsupported pre_tokenizer "${pre.type}" (expected BertPreTokenizer)`)
  }

  const vocab = new Map(Object.entries(model.vocab))
  const unkId = vocab.get(model.unk_token ?? '[UNK]') ?? 0
  const prefix = model.continuing_subword_prefix ?? '##'
  const maxChars = model.max_input_chars_per_word ?? 100
  const lowercase = norm.lowercase !== false
  const cleanText = norm.clean_text !== false
  const handleChinese = norm.handle_chinese_chars !== false
  // BertNormalizer semantics: strip_accents defaults to the lowercase flag.
  const stripAccents = norm.strip_accents ?? lowercase

  const normalize = (text) => {
    let out = ''
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cleanText && (cp === 0 || cp === 0xfffd || isControl(cp))) continue
      if (cleanText && isWhitespace(cp)) { out += ' '; continue }
      if (handleChinese && isChineseChar(cp)) { out += ` ${ch} `; continue }
      out += ch
    }
    if (stripAccents) out = out.normalize('NFD').replace(/\p{Mn}/gu, '')
    if (lowercase) out = out.toLowerCase()
    return out
  }

  const preTokenize = (text) => {
    const words = []
    let current = ''
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (isWhitespace(cp)) {
        if (current) { words.push(current); current = '' }
      } else if (isPunctuation(cp)) {
        if (current) { words.push(current); current = '' }
        words.push(ch)
      } else {
        current += ch
      }
    }
    if (current) words.push(current)
    return words
  }

  const wordPiece = (word, out) => {
    const chars = Array.from(word)
    if (chars.length > maxChars) { out.push(unkId); return }
    let start = 0
    const pieces = []
    while (start < chars.length) {
      let end = chars.length
      let id = null
      while (start < end) {
        const sub = (start > 0 ? prefix : '') + chars.slice(start, end).join('')
        const found = vocab.get(sub)
        if (found !== undefined) { id = found; break }
        end--
      }
      if (id === null) { out.push(unkId); return } // whole word → UNK on any gap
      pieces.push(id)
      start = end
    }
    out.push(...pieces)
  }

  return {
    encode(text) {
      const ids = []
      for (const word of preTokenize(normalize(text ?? ''))) wordPiece(word, ids)
      return ids
    },
  }
}

// ---------------------------------------------------------------------------
// int8 matrix codec — the compact shipping format for the embedding matrix.
//
// Snapshots ship `model2vec.q8` instead of the fp32 `onnx/model.onnx`
// (129 MB → ~33 MB, and fp32 weights barely compress under zstd so the
// archive saving is near-full). Per-row symmetric quantization:
// scale_r = maxAbs(row_r)/127, q = round(v/scale). Roundtrip measured on
// 3000 real corpus docs: mean cosine 0.999968 (min 0.999924), 0.285% sign
// flips, 100% top-10 ranking overlap over 15 queries — and because the same
// matrix embeds both documents and queries in an install, the residual
// error is self-consistent, never a doc/query-space mismatch.
//
// Layout (little-endian): "M2VQ8\0" | u8 version=1 | u32 rows | u32 dims |
// f32 scales[rows] | i8 data[rows*dims].
// ---------------------------------------------------------------------------

const Q8_MAGIC = 'M2VQ8\0'
export const Q8_FILENAME = 'model2vec.q8'

/** Quantize an fp32 matrix into the M2VQ8 file bytes. Deterministic. */
export function quantizeMatrixQ8({ rows, dims, data }) {
  const headerLen = Q8_MAGIC.length + 1 + 4 + 4
  const out = new Uint8Array(headerLen + rows * 4 + rows * dims)
  const view = new DataView(out.buffer)
  for (let i = 0; i < Q8_MAGIC.length; i++) out[i] = Q8_MAGIC.charCodeAt(i)
  out[Q8_MAGIC.length] = 1
  view.setUint32(Q8_MAGIC.length + 1, rows, true)
  view.setUint32(Q8_MAGIC.length + 5, dims, true)
  const scalesOff = headerLen
  const dataOff = headerLen + rows * 4
  for (let r = 0; r < rows; r++) {
    let maxAbs = 0
    for (let d = 0; d < dims; d++) {
      const a = Math.abs(data[r * dims + d])
      if (a > maxAbs) maxAbs = a
    }
    const scale = maxAbs / 127 || 1
    view.setFloat32(scalesOff + r * 4, scale, true)
    for (let d = 0; d < dims; d++) {
      const q = Math.max(-127, Math.min(127, Math.round(data[r * dims + d] / scale)))
      out[dataOff + r * dims + d] = q & 0xff
    }
  }
  return out
}

/** Parse M2VQ8 bytes and dequantize back to an fp32 matrix. */
export function parseQ8Matrix(bytes) {
  const magic = new TextDecoder().decode(bytes.subarray(0, Q8_MAGIC.length))
  if (magic !== Q8_MAGIC || bytes[Q8_MAGIC.length] !== 1) {
    throw new Error('model2vec.q8: bad magic or unsupported version')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rows = view.getUint32(Q8_MAGIC.length + 1, true)
  const dims = view.getUint32(Q8_MAGIC.length + 5, true)
  const headerLen = Q8_MAGIC.length + 1 + 4 + 4
  const expected = headerLen + rows * 4 + rows * dims
  if (bytes.byteLength !== expected) {
    throw new Error(`model2vec.q8: truncated (${bytes.byteLength} bytes, expected ${expected})`)
  }
  const dataOff = headerLen + rows * 4
  const data = new Float32Array(rows * dims)
  for (let r = 0; r < rows; r++) {
    const scale = view.getFloat32(headerLen + r * 4, true)
    for (let d = 0; d < dims; d++) {
      data[r * dims + d] = view.getInt8(dataOff + r * dims + d) * scale
    }
  }
  return { rows, dims, data }
}

// ---------------------------------------------------------------------------
// Embedder assembly
// ---------------------------------------------------------------------------

/**
 * Load the static model2vec embedder from on-disk model files.
 * Mean-pools fp32 embedding rows per token (accumulated in f64, emitted as
 * f32 — bit-differences vs the old ONNX fp32 accumulator are below
 * quantization resolution), then L2-normalizes — the ONNX graph ends with a
 * normalize node, and downstream int8 rescoring depends on the unit scale.
 * Empty inputs mirror the old path: token id 0.
 *
 * @param {{ modelDir: string }} opts `<modelsDir>/<hfId>`
 * @returns {Promise<{ embed(text: string): Promise<Float32Array>, embedBatch(texts: string[]): Promise<Float32Array[]> }>}
 */
export async function loadStaticModel2Vec({ modelDir }) {
  const tokenizerJson = await Bun.file(join(modelDir, 'tokenizer.json')).json()
  const tokenizer = createWordPieceTokenizer(tokenizerJson)
  // Prefer the compact q8 sidecar (what snapshots ship); fall back to the
  // fp32 ONNX export (HF fetch layout). Same embed code path either way —
  // q8 dequantizes to fp32 once at load.
  const q8File = Bun.file(join(modelDir, Q8_FILENAME))
  const { rows, dims, data } = (await q8File.exists())
    ? parseQ8Matrix(new Uint8Array(await q8File.arrayBuffer()))
    : extractEmbeddingMatrix(new Uint8Array(await Bun.file(join(modelDir, 'onnx', 'model.onnx')).arrayBuffer()))

  const embedOne = (text) => {
    const ids = tokenizer.encode(text ?? '')
    if (ids.length === 0) ids.push(0) // EmbeddingBag parity: ≥1 token
    const acc = new Float64Array(dims)
    for (const id of ids) {
      const base = (id < rows ? id : 0) * dims
      for (let d = 0; d < dims; d++) acc[d] += data[base + d]
    }
    const out = new Float32Array(dims)
    const inv = 1 / ids.length
    for (let d = 0; d < dims; d++) out[d] = acc[d] * inv
    return l2normalize(out)
  }

  return {
    async embed(text) { return embedOne(text) },
    async embedBatch(texts) { return (texts ?? []).map(embedOne) },
  }
}
