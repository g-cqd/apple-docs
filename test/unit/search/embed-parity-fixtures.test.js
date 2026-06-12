/**
 * Guards for the committed embed-parity fixtures.
 *
 * SELF-REGRESSION GOLDENS since embedding v2 (RFC 0002 §6h): the fixtures
 * record the native Swift pipeline's own output — any unintended change to
 * tokenization/pooling/quantization breaks the replay. Layers:
 *   - always-on: ADMX artifact header + pin coherence, byte-size sanity,
 *     and full code self-consistency (sign/int8 codes re-derived from the
 *     committed vectors with the JS quantizers — the cross-implementation
 *     lockstep check, no model needed);
 *   - replay (skipped without the dylib + local model): bit-exact
 *     reproduction of case vectors and a corpus sample. Regenerate via
 *     `bun scripts/gen-embed-{matrix,fixtures}.mjs` ONLY with a deliberate,
 *     RFC-recorded behavior change.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { quantizeI8, quantizeTo } from '../../../src/search/embedding.js'
import { LEGACY_ONNX_SHA256 } from '../../../src/search/model-integrity.js'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'embed-parity')
const HF_ID = 'minishlab/potion-retrieval-32M'
const DIMS = 512
const SIGN_BYTES = DIMS / 8
const CODE_STRIDE = SIGN_BYTES + DIMS + 4

// Stage C: the default embed path is native-only; since v2 the committed
// fixtures are the pipeline's own prior output (provenance in index.json),
// and the replay proves the production path still reproduces them.
const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const nativeAvailable = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)
const modelsDir =
  process.env.APPLE_DOCS_MODELS_DIR ??
  join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')
const modelPresent =
  existsSync(join(modelsDir, HF_ID, 'matrix-v1.admx')) || existsSync(join(modelsDir, HF_ID, 'onnx', 'model.onnx'))

const index = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8'))
const caseVectors = readFileSync(join(FIXTURES, 'case-vectors.bin'))
const caseCodes = readFileSync(join(FIXTURES, 'case-codes.bin'))
const corpusVectors = readFileSync(join(FIXTURES, 'corpus-vectors.bin'))
const corpusCodes = readFileSync(join(FIXTURES, 'corpus-codes.bin'))

const vectorAt = (buf, i) => new Float32Array(buf.buffer, buf.byteOffset + i * DIMS * 4, DIMS)

describe('embed-parity fixtures', () => {
  test('ADMX subset artifact header is coherent and pinned', () => {
    const admx = readFileSync(join(FIXTURES, 'matrix-subset.admx'))
    expect(admx.toString('ascii', 0, 4)).toBe('ADMX')
    expect(admx.readUInt32LE(4)).toBe(1) // version
    expect(admx.readUInt32LE(8)).toBe(1) // sparse
    expect(admx.readUInt32LE(12)).toBe(1) // f32 LE
    const rows = admx.readUInt32LE(16)
    const dims = admx.readUInt32LE(20)
    expect(dims).toBe(DIMS)
    expect(admx.subarray(32, 64).toString('hex')).toBe(LEGACY_ONNX_SHA256)
    const headerBytes = 64
    let prev = -1
    for (let i = 0; i < rows; i++) {
      const id = admx.readUInt32LE(headerBytes + i * 4)
      expect(id).toBeGreaterThan(prev)
      prev = id
    }
    const dataOffset = Math.ceil((headerBytes + rows * 4) / 64) * 64
    expect(admx.length).toBe(dataOffset + rows * dims * 4)
    const sidecar = readFileSync(join(FIXTURES, 'matrix-subset.admx.sha256'), 'utf8').trim()
    expect(sidecar).toMatch(/^[0-9a-f]{64}$/)
  })

  test('index meta and binary sizes are consistent', () => {
    expect(index.meta.model).toBe(HF_ID)
    expect(index.meta.dims).toBe(DIMS)
    expect(index.meta.runtime).toBe('native-libAppleDocsCore')
    expect(index.meta.behaviorVersion).toBeGreaterThanOrEqual(2)
    expect(index.meta.modelOnnxSha256).toBe(LEGACY_ONNX_SHA256)
    expect(index.meta.codeStride).toBe(CODE_STRIDE)
    expect(index.caseNames.length).toBe(index.meta.caseCount)
    expect(caseVectors.length).toBe(index.meta.caseCount * DIMS * 4)
    expect(caseCodes.length).toBe(index.meta.caseCount * CODE_STRIDE)
    expect(corpusVectors.length).toBe(index.meta.corpusCount * DIMS * 4)
    expect(corpusCodes.length).toBe(index.meta.corpusCount * CODE_STRIDE)
  })

  test('codes are exactly the JS quantizers applied to the committed vectors', () => {
    const check = (vectors, codes, count) => {
      for (let i = 0; i < count; i++) {
        const vec = vectorAt(vectors, i)
        const sign = Buffer.from(quantizeTo(vec, vec.length))
        const i8 = Buffer.from(quantizeI8(vec))
        const got = codes.subarray(i * CODE_STRIDE, (i + 1) * CODE_STRIDE)
        if (!got.subarray(0, SIGN_BYTES).equals(sign) || !got.subarray(SIGN_BYTES).equals(i8)) {
          throw new Error(`code mismatch at row ${i}`)
        }
      }
    }
    check(caseVectors, caseCodes, index.meta.caseCount)
    check(corpusVectors, corpusCodes, index.meta.corpusCount)
  })

  test('committed vectors are unit-norm (the graph L2-normalizes)', () => {
    for (let i = 0; i < index.meta.caseCount; i++) {
      const vec = vectorAt(caseVectors, i)
      let sum = 0
      for (const v of vec) sum += v * v
      expect(Math.abs(Math.sqrt(sum) - 1)).toBeLessThan(1e-5)
    }
  })

  describe.skipIf(!nativeAvailable || !modelPresent)('production replay (native vs its own committed goldens)', () => {
    test('case vectors reproduce bit-exactly', async () => {
      const { getEmbedder } = await import('../../../src/search/embedder.js')
      const embedder = await getEmbedder({ modelsDir })
      expect(embedder).not.toBeNull()
      const { cases } = JSON.parse(
        readFileSync(join(FIXTURES, '..', 'tokenizer-parity', 'cases.json'), 'utf8'),
      )
      expect(cases.map((c) => c.name)).toEqual(index.caseNames)
      const vecs = await embedder.embedBatch(cases.map((c) => c.text))
      const mismatches = []
      for (let i = 0; i < vecs.length; i++) {
        const got = Buffer.from(vecs[i].buffer, vecs[i].byteOffset, DIMS * 4)
        if (!got.equals(caseVectors.subarray(i * DIMS * 4, (i + 1) * DIMS * 4))) {
          mismatches.push(index.caseNames[i])
        }
      }
      expect(mismatches).toEqual([])
    })

    test('corpus sample reproduces bit-exactly', async () => {
      const { getEmbedder } = await import('../../../src/search/embedder.js')
      const embedder = await getEmbedder({ modelsDir })
      const corpus = JSON.parse(readFileSync(join(FIXTURES, 'corpus-texts.json'), 'utf8'))
      const sampleIdx = []
      for (let i = 0; i < corpus.length; i += 97) sampleIdx.push(i)
      const vecs = await embedder.embedBatch(sampleIdx.map((i) => corpus[i].text))
      const mismatches = []
      for (let k = 0; k < sampleIdx.length; k++) {
        const i = sampleIdx[k]
        const got = Buffer.from(vecs[k].buffer, vecs[k].byteOffset, DIMS * 4)
        if (!got.equals(corpusVectors.subarray(i * DIMS * 4, (i + 1) * DIMS * 4))) mismatches.push(i)
      }
      expect(mismatches).toEqual([])
    })
  })
})
