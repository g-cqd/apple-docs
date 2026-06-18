import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValidationError } from '../../../src/lib/errors.js'
import { ensureEmbeddingModel, verifyPinnedModelFiles } from '../../../src/search/model-integrity.js'

const dirs = []
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'apple-docs-model-pin-'))
  dirs.push(d)
  return d
}
const sha256 = (s) => new Bun.CryptoHasher('sha256').update(s).digest('hex')

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('verifyPinnedModelFiles', () => {
  const HFID = 'fake/model'

  test('passes when every pinned file matches', async () => {
    const dir = tmp()
    mkdirSync(join(dir, HFID, 'onnx'), { recursive: true })
    writeFileSync(join(dir, HFID, 'onnx', 'model.onnx'), 'WEIGHTS')
    writeFileSync(join(dir, HFID, 'tokenizer.json'), '{}')
    const pins = { [HFID]: { 'onnx/model.onnx': sha256('WEIGHTS'), 'tokenizer.json': sha256('{}') } }
    expect((await verifyPinnedModelFiles(dir, HFID, pins)).verified).toBe(2)
  })

  test('throws on drifted bytes', async () => {
    const dir = tmp()
    mkdirSync(join(dir, HFID), { recursive: true })
    writeFileSync(join(dir, HFID, 'tokenizer.json'), 'TAMPERED')
    const pins = { [HFID]: { 'tokenizer.json': sha256('{}') } }
    await expect(verifyPinnedModelFiles(dir, HFID, pins)).rejects.toThrow(/integrity pin/)
  })

  test('throws on a missing pinned file', async () => {
    const dir = tmp()
    const pins = { [HFID]: { 'tokenizer.json': sha256('{}') } }
    await expect(verifyPinnedModelFiles(dir, HFID, pins)).rejects.toThrow(/missing/)
  })

  test('unpinned model verifies zero files (gated variants)', async () => {
    expect((await verifyPinnedModelFiles(tmp(), 'other/model', {})).verified).toBe(0)
  })
})

describe('ensureEmbeddingModel', () => {
  test('release builds (remote flag set) hard-fail without an embedder', async () => {
    const prev = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS
    process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS = '1'
    try {
      await expect(ensureEmbeddingModel({ embedder: null })).rejects.toThrow(ValidationError)
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS
      else process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS = prev
    }
  })

  test('ad-hoc builds skip gracefully without an embedder', async () => {
    const prev = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS
    delete process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS
    try {
      const res = await ensureEmbeddingModel({ embedder: null })
      expect(res.status).toBe('skipped')
      expect(res.message).toContain('unavailable')
    } finally {
      if (prev !== undefined) process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS = prev
    }
  })
})
