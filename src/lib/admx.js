/**
 * ADMX v1 weights artifact (RFC 0002 D-0002-1): the potion embedding matrix
 * re-exported from the pinned model.onnx into a dumb mmap-able layout the
 * Swift side reads directly (swift/Sources/ADEmbed/MatrixArtifact.swift —
 * change both together).
 *
 * Layout (u32 LE integers):
 *   magic 'ADMX' | version=1 | flags (bit0 = sparse) | dtype=1 (f32 LE)
 *   rows | dims | reserved ×2 | sourceSha256 (32 raw bytes of model.onnx)
 *   [sparse] rows × u32 ascending token ids
 *   zero-pad to a 64-byte boundary | rows × dims × f32 LE row-major
 * plus a `.sha256` sidecar of the artifact bytes.
 *
 * Extraction is mandatory, not a convenience: the ONNX graph L2-normalizes
 * its outputs, so raw row magnitudes exist only in the
 * `embedding_bag.weight` initializer. The walk below reads exactly
 * ModelProto.graph(7) → GraphProto.initializer(5) → TensorProto
 * {dims:1, data_type:2, name:8, raw_data:9} — no protobuf dependency.
 *
 * Callers own integrity policy: pass the EXPECTED model.onnx sha in (this
 * module deliberately does not import model-integrity — the generator
 * script and the native-embedder bootstrap both verify pins first).
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promoteAtomicWrite } from './atomic-write.js'

export const ADMX_HEADER_BYTES = 4 + 4 + 4 + 4 + 4 + 4 + 8 + 32

/** @param {Buffer} buf @param {number} pos @returns {[bigint, number]} */
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

/**
 * Yield [fieldNumber, wireType, varintValue, start, end] for each field.
 * @param {Buffer} buf @param {number} start @param {number} end
 * @returns {Generator<[number, number, bigint | null, number, number]>}
 */
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

/**
 * Locate the embedding initializer inside a model.onnx buffer.
 * @param {Buffer} buf
 * @returns {{ rows: number, dims: number, rawStart: number, rawEnd: number }}
 */
export function findEmbeddingInitializer(buf) {
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
      if (name !== 'embedding_bag.weight') continue
      const [rows, cols] = dims
      if (dataType !== 1 || dims.length !== 2 || rawEnd - rawStart !== rows * cols * 4) {
        throw new Error(`unexpected initializer shape: dims=${dims} dtype=${dataType} bytes=${rawEnd - rawStart}`)
      }
      return { rows, dims: cols, rawStart, rawEnd }
    }
  }
  throw new Error('embedding_bag.weight initializer not found in model.onnx')
}

/**
 * Build an ADMX v1 artifact buffer from an onnx buffer.
 * @param {Buffer} onnx
 * @param {string} sourceShaHex sha256 of the SOURCE model.onnx (the pin)
 * @param {Uint32Array|null} sparseIds ascending token ids, or null for dense
 */
export function buildAdmxArtifact(onnx, sourceShaHex, sparseIds = null) {
  const init = findEmbeddingInitializer(onnx)
  const count = sparseIds ? sparseIds.length : init.rows
  const idTableBytes = sparseIds ? count * 4 : 0
  const dataOffset = Math.ceil((ADMX_HEADER_BYTES + idTableBytes) / 64) * 64
  const out = Buffer.alloc(dataOffset + count * init.dims * 4)
  out.write('ADMX', 0, 'ascii')
  out.writeUInt32LE(1, 4) // version
  out.writeUInt32LE(sparseIds ? 1 : 0, 8) // flags
  out.writeUInt32LE(1, 12) // dtype f32 LE
  out.writeUInt32LE(count, 16)
  out.writeUInt32LE(init.dims, 20)
  Buffer.from(sourceShaHex, 'hex').copy(out, 32)
  if (sparseIds) {
    for (let i = 0; i < count; i++) {
      if (sparseIds[i] >= init.rows) throw new Error(`token id ${sparseIds[i]} out of matrix range`)
      out.writeUInt32LE(sparseIds[i], ADMX_HEADER_BYTES + i * 4)
    }
  }
  for (let i = 0; i < count; i++) {
    const tokenId = sparseIds ? sparseIds[i] : i
    const srcStart = init.rawStart + tokenId * init.dims * 4
    onnx.copy(out, dataOffset + i * init.dims * 4, srcStart, srcStart + init.dims * 4)
  }
  return { artifact: out, rows: count, dims: init.dims }
}

/**
 * Generate an ADMX artifact on disk, atomically (temp + rename; concurrent
 * generators converge — the bytes are deterministic). Writes a `.sha256`
 * sidecar. The caller must have verified the source pin already.
 *
 * @param {{ onnxPath: string, outPath: string, sourceShaHex: string, sparseIds?: Uint32Array | null }} options
 * @returns {Promise<{ rows: number, dims: number, bytes: number }>}
 */
export async function generateMatrixArtifact({ onnxPath, outPath, sourceShaHex, sparseIds = null }) {
  const onnx = readFileSync(onnxPath)
  const { artifact, rows, dims } = buildAdmxArtifact(onnx, sourceShaHex, sparseIds)
  mkdirSync(dirname(outPath), { recursive: true })
  const temp = join(dirname(outPath), `.${process.pid}-${Date.now()}.admx-tmp`)
  writeFileSync(temp, artifact)
  await promoteAtomicWrite(temp, outPath)
  const digest = createHash('sha256').update(artifact).digest('hex')
  writeFileSync(`${outPath}.sha256`, `${digest}\n`)
  return { rows, dims, bytes: artifact.length }
}
