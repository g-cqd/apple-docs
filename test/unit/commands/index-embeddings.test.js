import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'
import { indexEmbeddings } from '../../../src/commands/index-embeddings.js'
import { VECTOR_DIMS, VECTOR_BYTES } from '../../../src/search/embedding.js'

// Deterministic fake embedder (xorshift seeded by text) — no ONNX dependency.
export function fakeEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(VECTOR_DIMS)
      let h = 2166136261
      for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
      for (let i = 0; i < VECTOR_DIMS; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; v[i] = ((h >>> 0) / 0xffffffff) - 0.5 }
      return v
    },
  }
}

let db
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  ctx = { db, logger: { info() {}, warn() {}, error() {}, debug() {} } }
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  for (let i = 0; i < 5; i++) {
    const key = `documentation/swiftui/sym${i}`
    db.upsertPage({ rootId: root.id, path: key, url: 'u', title: `Sym${i}`, role: 'symbol', abstract: `Abstract ${i}` })
    db.upsertNormalizedDocument({
      document: { key, title: `Sym${i}`, sourceType: 'apple-docc', framework: 'swiftui', role: 'symbol', abstractText: `Abstract ${i}` },
      sections: [], relationships: [],
    })
  }
})

afterEach(() => db.close())

describe('indexEmbeddings', () => {
  test('embeds all documents and stores 48-byte vectors', async () => {
    const res = await indexEmbeddings({ embedder: fakeEmbedder() }, ctx)
    expect(res.status).toBe('ok')
    expect(res.indexed).toBe(5)
    expect(db.getVectorCount()).toBe(5)
    const rows = db.getAllVectors()
    expect(rows.length).toBe(5)
    expect(rows[0].vec.length).toBe(VECTOR_BYTES)
  })

  test('resumable — a second run without --full is a no-op', async () => {
    await indexEmbeddings({ embedder: fakeEmbedder() }, ctx)
    const res2 = await indexEmbeddings({ embedder: fakeEmbedder() }, ctx)
    expect(res2.indexed).toBe(0)
    expect(db.getVectorCount()).toBe(5)
  })

  test('errors clearly when no embedder is available', async () => {
    const prev = process.env.APPLE_DOCS_SEMANTIC
    process.env.APPLE_DOCS_SEMANTIC = 'off' // forces getEmbedder() → null
    try {
      const res = await indexEmbeddings({}, ctx)
      expect(res.status).toBe('error')
      expect(res.message).toMatch(/@huggingface\/transformers/)
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_SEMANTIC
      else process.env.APPLE_DOCS_SEMANTIC = prev
    }
  })
})
