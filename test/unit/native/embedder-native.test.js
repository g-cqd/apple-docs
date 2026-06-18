// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Full JS→FFI→Swift→JS round trip for the native embedder, runnable
 * anywhere the dylib exists (CI native matrix included): the committed
 * sparse matrix subset + tokenizer fixtures stand in for the model, and
 * every vector must reproduce the production reference BIT-EXACTLY.
 */

import { suffix } from 'bun:ffi'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetNativeLoader } from '../../../src/native/loader.js'
import { _resetNativeEmbedder, buildNativeModel2Vec, EXPECTED_EMBED_VERSION, pregenerateMatrixArtifact } from '../../../src/search/embedder-native.js'

test('pregenerateMatrixArtifact is warn-only without a model', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'pregen-'))
  const warnings = []
  try {
    const result = await pregenerateMatrixArtifact(empty, { warn: (m) => warnings.push(m) })
    expect(result).toBeNull()
    expect(warnings.length).toBe(1)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures')
const HF_ID = 'minishlab/potion-retrieval-32M'
const SPEC = { hfId: HF_ID, dims: 512 }
const SEAMS = {
  matrixPath: join(FIXTURES, 'embed-parity', 'matrix-subset.admx'),
  modelDir: join(FIXTURES, 'tokenizer-parity', 'models', HF_ID),
}

describe.skipIf(!existsSync(DEV_LIB))('embedder-native round trip', () => {
  beforeAll(() => {
    process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
    _resetNativeLoader()
    _resetNativeEmbedder()
  })
  afterAll(() => {
    _resetNativeEmbedder()
    if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
  })

  test('every case vector is bit-exact through the FFI', async () => {
    const embedder = await buildNativeModel2Vec(SPEC, '/nonexistent-models', SEAMS)
    expect(embedder).not.toBeNull()
    expect(embedder.embedVersion).toBe(EXPECTED_EMBED_VERSION)
    const { cases } = JSON.parse(readFileSync(join(FIXTURES, 'tokenizer-parity', 'cases.json'), 'utf8'))
    const want = readFileSync(join(FIXTURES, 'embed-parity', 'case-vectors.bin'))
    const vecs = await embedder.embedBatch(cases.map((c) => c.text))
    const mismatches = []
    for (let i = 0; i < vecs.length; i++) {
      const got = Buffer.from(vecs[i].buffer, vecs[i].byteOffset, 512 * 4)
      if (!got.equals(want.subarray(i * 2048, (i + 1) * 2048))) mismatches.push(cases[i].name)
    }
    expect(mismatches).toEqual([])
  })

  test('every case code is byte-exact through the FFI', async () => {
    const embedder = await buildNativeModel2Vec(SPEC, '/nonexistent-models', SEAMS)
    expect(embedder.dims).toBe(512)
    const { cases } = JSON.parse(readFileSync(join(FIXTURES, 'tokenizer-parity', 'cases.json'), 'utf8'))
    const want = readFileSync(join(FIXTURES, 'embed-parity', 'case-codes.bin'))
    const stride = 64 + 512 + 4
    const codes = await embedder.embedBatchCodes(cases.map((c) => c.text))
    const mismatches = []
    for (let i = 0; i < codes.length; i++) {
      const { vecBin, vecI8 } = codes[i]
      const slice = want.subarray(i * stride, (i + 1) * stride)
      if (
        !Buffer.from(vecBin.buffer, vecBin.byteOffset, 64).equals(slice.subarray(0, 64)) ||
        !Buffer.from(vecI8.buffer, vecI8.byteOffset, 516).equals(slice.subarray(64))
      ) {
        mismatches.push(cases[i].name)
      }
    }
    expect(mismatches).toEqual([])
    expect(await embedder.embedBatchCodes([])).toEqual([])
  })

  test('empty and nullish texts use the pad row', async () => {
    const embedder = await buildNativeModel2Vec(SPEC, '/nonexistent-models', SEAMS)
    const empty = await embedder.embed('')
    const nullish = await embedder.embed(null)
    expect(empty.length).toBe(512)
    expect(Buffer.from(empty.buffer, empty.byteOffset, 2048).equals(Buffer.from(nullish.buffer, nullish.byteOffset, 2048))).toBe(true)
    expect(await embedder.embedBatch([])).toEqual([])
  })

  test('a token outside the sparse subset surfaces as a thrown error', async () => {
    const embedder = await buildNativeModel2Vec(SPEC, '/nonexistent-models', SEAMS)
    const vocab = JSON.parse(readFileSync(join(FIXTURES, 'tokenizer-parity', 'vocab.json'), 'utf8'))
    let threw = null
    for (let id = 30000; id < 40000; id += 137) {
      const token = vocab[id]
      if (!/^[a-z]{4,}$/.test(token)) continue
      try {
        await embedder.embed(token)
      } catch (error) {
        threw = error
        break
      }
    }
    expect(threw?.message).toContain('native embed failed')
  })

  test('builder returns null on non-default model, bad dims, or missing artifact', async () => {
    expect(await buildNativeModel2Vec({ hfId: 'other/model', dims: 512 }, '/nonexistent', {})).toBeNull()
    expect(await buildNativeModel2Vec({ hfId: HF_ID, dims: 256 }, '/nonexistent', SEAMS)).toBeNull()
    const empty = mkdtempSync(join(tmpdir(), 'embed-native-'))
    try {
      expect(await buildNativeModel2Vec(SPEC, empty, {})).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  const realModelsDir = process.env.APPLE_DOCS_MODELS_DIR ?? join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')
  const modelPresent = existsSync(join(realModelsDir, HF_ID, 'onnx', 'model.onnx'))

  test.skipIf(!modelPresent)(
    'on-demand artifact generation from the pinned model.onnx',
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'embed-gen-'))
      try {
        // A models dir with the pinned files but no matrix artifact.
        cpSync(join(realModelsDir, HF_ID), join(scratch, HF_ID), { recursive: true })
        rmSync(join(scratch, HF_ID, 'matrix-v1.admx'), { force: true })
        rmSync(join(scratch, HF_ID, 'matrix-v1.admx.sha256'), { force: true })
        const embedder = await buildNativeModel2Vec(SPEC, scratch, {})
        expect(embedder).not.toBeNull()
        const generated = join(scratch, HF_ID, 'matrix-v1.admx')
        expect(existsSync(generated)).toBe(true)
        const stamp = statSync(generated).mtimeMs
        // Second build short-circuits on the existing artifact.
        expect(await buildNativeModel2Vec(SPEC, scratch, {})).not.toBeNull()
        expect(statSync(generated).mtimeMs).toBe(stamp)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    30000,
  )
})
