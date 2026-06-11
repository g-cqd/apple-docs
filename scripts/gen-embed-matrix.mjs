/**
 * Extract the potion embedding matrix from the pinned model.onnx into the
 * "ADMX" v1 weights artifact (RFC 0002 D-0002-1: raw-matrix re-export,
 * sha-pinned).
 *
 * Why an export at all: the ONNX graph is NOT a plain EmbeddingBag — it
 * L2-normalizes each bag output, so raw row magnitudes are unrecoverable
 * from model outputs; the only source of truth is the
 * `embedding_bag.weight` initializer ([63091, 512] f32 LE) inside the
 * protobuf. The walk below reads exactly ModelProto.graph(7) →
 * GraphProto.initializer(5) → TensorProto {dims:1, data_type:2, name:8,
 * raw_data:9} — no protobuf dependency.
 *
 * ADMX v1 layout (all integers u32 LE):
 *   magic 'ADMX' | version=1 | flags (bit0 = sparse) | dtype=1 (f32 LE)
 *   rows | dims | reserved ×2 | sourceSha256 (32 raw bytes of model.onnx)
 *   [sparse only] rows × u32 ascending token ids
 *   zero-pad to a 64-byte boundary
 *   rows × dims × f32 LE row-major
 * plus a `.sha256` sidecar of the artifact itself.
 *
 * Modes:
 *   --full    → <modelsDir>/<hfId>/matrix-v1.admx (~129 MB, NOT committed)
 *   --subset  → test/fixtures/embed-parity/matrix-subset.admx — only the
 *               rows used by test/fixtures/tokenizer-parity/cases.json
 *               (∪ the [0] pad row), small enough to commit so the CI
 *               native matrix can gate vector parity without the model.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from '../src/lib/hash.js'
import { resolveActiveSpec } from '../src/search/embedder.js'
import { PINNED_MODEL_FILES, verifyPinnedModelFiles } from '../src/search/model-integrity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test', 'fixtures')

const modes = process.argv.slice(2).filter((a) => a === '--full' || a === '--subset')
if (modes.length === 0) {
  console.error('usage: bun scripts/gen-embed-matrix.mjs [--full] [--subset]')
  process.exit(1)
}

const spec = resolveActiveSpec()
if (spec.hfId !== 'minishlab/potion-retrieval-32M') {
  throw new Error(`artifact targets the default model; unset APPLE_DOCS_EMBED_MODEL (got ${spec.hfId})`)
}

const modelsDir =
  process.env.APPLE_DOCS_MODELS_DIR ??
  join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')

await verifyPinnedModelFiles(modelsDir, spec.hfId)
const onnxPath = join(modelsDir, spec.hfId, 'onnx', 'model.onnx')
const sourceSha = PINNED_MODEL_FILES[spec.hfId]['onnx/model.onnx']

// --- minimal protobuf walk -----------------------------------------------

function varint(buf, pos) {
  let value = 0n
  let shift = 0n
  for (;;) {
    const byte = buf[pos++]
    value |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [value, pos]
    shift += 7n
  }
}

/** Yield [fieldNumber, wireType, varintValue, start, end] for each field. */
function* fields(buf, start, end) {
  let pos = start
  while (pos < end) {
    let tag
    ;[tag, pos] = varint(buf, pos)
    const num = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      let value
      ;[value, pos] = varint(buf, pos)
      yield [num, wire, value, 0, 0]
    } else if (wire === 2) {
      let len
      ;[len, pos] = varint(buf, pos)
      yield [num, wire, null, pos, pos + Number(len)]
      pos += Number(len)
    } else if (wire === 5) {
      yield [num, wire, null, pos, pos + 4]
      pos += 4
    } else if (wire === 1) {
      yield [num, wire, null, pos, pos + 8]
      pos += 8
    } else {
      throw new Error(`unsupported wire type ${wire} at ${pos}`)
    }
  }
}

function findEmbeddingInitializer(buf) {
  for (const [num, , , start, end] of fields(buf, 0, buf.length)) {
    if (num !== 7) continue // ModelProto.graph
    for (const [gnum, , , gstart, gend] of fields(buf, start, end)) {
      if (gnum !== 5) continue // GraphProto.initializer
      const dims = []
      let dataType = 0
      let name = ''
      let rawStart = 0
      let rawEnd = 0
      for (const [tnum, twire, tvalue, tstart, tend] of fields(buf, gstart, gend)) {
        if (tnum === 1 && twire === 0) dims.push(Number(tvalue))
        else if (tnum === 2 && twire === 0) dataType = Number(tvalue)
        else if (tnum === 8) name = buf.toString('utf8', tstart, tend)
        else if (tnum === 9) {
          rawStart = tstart
          rawEnd = tend
        }
      }
      if (name === 'embedding_bag.weight') return { dims, dataType, rawStart, rawEnd }
    }
  }
  throw new Error('embedding_bag.weight initializer not found in model.onnx')
}

const onnx = readFileSync(onnxPath)
const init = findEmbeddingInitializer(onnx)
const [rows, dims] = init.dims
if (init.dataType !== 1 || init.dims.length !== 2 || init.rawEnd - init.rawStart !== rows * dims * 4) {
  throw new Error(`unexpected initializer shape: dims=${init.dims} dtype=${init.dataType} bytes=${init.rawEnd - init.rawStart}`)
}
console.log(`initializer: [${rows}, ${dims}] f32, ${init.rawEnd - init.rawStart} bytes`)

// --- artifact writer ------------------------------------------------------

const HEADER_BYTES = 4 + 4 + 4 + 4 + 4 + 4 + 8 + 32

/** @param {Uint32Array|null} sparseIds ascending token ids, or null for dense */
function writeArtifact(path, sparseIds) {
  const count = sparseIds ? sparseIds.length : rows
  const idTableBytes = sparseIds ? count * 4 : 0
  const dataOffset = Math.ceil((HEADER_BYTES + idTableBytes) / 64) * 64
  const out = Buffer.alloc(dataOffset + count * dims * 4)
  out.write('ADMX', 0, 'ascii')
  out.writeUInt32LE(1, 4) // version
  out.writeUInt32LE(sparseIds ? 1 : 0, 8) // flags
  out.writeUInt32LE(1, 12) // dtype f32 LE
  out.writeUInt32LE(count, 16)
  out.writeUInt32LE(dims, 20)
  Buffer.from(sourceSha, 'hex').copy(out, 32)
  if (sparseIds) {
    for (let i = 0; i < count; i++) out.writeUInt32LE(sparseIds[i], HEADER_BYTES + i * 4)
  }
  for (let i = 0; i < count; i++) {
    const tokenId = sparseIds ? sparseIds[i] : i
    const srcStart = init.rawStart + tokenId * dims * 4
    onnx.copy(out, dataOffset + i * dims * 4, srcStart, srcStart + dims * 4)
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, out)
  const digest = createHash('sha256').update(out).digest('hex')
  writeFileSync(`${path}.sha256`, `${digest}\n`)
  console.log(`wrote ${path} (${out.length} bytes, ${count} rows, sha256 ${digest.slice(0, 12)}…)`)
}

for (const mode of modes) {
  if (mode === '--full') {
    writeArtifact(join(modelsDir, spec.hfId, 'matrix-v1.admx'), null)
  } else {
    const { cases } = JSON.parse(readFileSync(join(FIXTURES, 'tokenizer-parity', 'cases.json'), 'utf8'))
    const ids = new Set([0]) // the embedder's empty-input pad row
    for (const c of cases) for (const id of c.ids) ids.add(id)
    const sorted = Uint32Array.from([...ids].sort((a, b) => a - b))
    if (sorted[sorted.length - 1] >= rows) throw new Error('case token id out of matrix range')
    writeArtifact(join(FIXTURES, 'embed-parity', 'matrix-subset.admx'), sorted)
  }
}
