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

  test('stamps embed_version and keeps resume a no-op at the same version', async () => {
    const versioned = { ...fakeEmbedder(), embedVersion: 2 }
    await indexEmbeddings({ embedder: versioned }, ctx)
    expect(db.getSnapshotMeta('embed_version')).toBe('2')
    const res2 = await indexEmbeddings({ embedder: versioned }, ctx)
    expect(res2.indexed).toBe(0)
  })

  test('a behavior-version mismatch forces a full re-embed in resume mode', async () => {
    // v1-era store: chunks exist but no embed_version stamp (reads as '1').
    await indexEmbeddings({ embedder: fakeEmbedder() }, ctx)
    expect(db.getSnapshotMeta('embed_version')).toBeFalsy()
    const res = await indexEmbeddings({ embedder: { ...fakeEmbedder(), embedVersion: 2 } }, ctx)
    expect(res.indexed).toBe(5) // not the resume no-op
    expect(db.getSnapshotMeta('embed_version')).toBe('2')
  })

  test('code-capable embedders store their blobs verbatim (native path shape)', async () => {
    // Mirror of the native bridge contract: embedBatchCodes returns the
    // storage blobs as OFFSET subarray views over one shared buffer — the
    // read-back below proves bun:sqlite binds views offset-correctly.
    const stride = VECTOR_DIMS / 8 + VECTOR_DIMS + 4
    const backing = new Uint8Array(stride * 64)
    const codesEmbedder = {
      dims: VECTOR_DIMS,
      async embedBatchCodes(texts) {
        return texts.map((text, i) => {
          const base = i * stride
          for (let b = 0; b < stride; b++) backing[base + b] = (text.length * 31 + i * 7 + b) & 0xff
          return {
            vecBin: new Uint8Array(backing.buffer, base, VECTOR_DIMS / 8),
            vecI8: new Uint8Array(backing.buffer, base + VECTOR_DIMS / 8, VECTOR_DIMS + 4),
          }
        })
      },
    }
    const res = await indexEmbeddings({ embedder: codesEmbedder }, ctx)
    expect(res.status).toBe('ok')
    expect(res.indexed).toBe(5)
    expect(db.getSnapshotMeta('embed_dims')).toBe(String(VECTOR_DIMS))
    const stored = db.db.query('SELECT document_id, ord, vec_bin, vec_i8 FROM document_chunks ORDER BY document_id, ord').all()
    expect(stored.length).toBeGreaterThan(0)
    for (const row of stored) {
      expect(row.vec_bin.length).toBe(VECTOR_DIMS / 8)
      expect(row.vec_i8.length).toBe(VECTOR_DIMS + 4)
    }
    // Anchor vectors mirror ord-0 chunk codes byte-for-byte.
    const anchors = db.getAllVectors()
    const ordZero = new Map(stored.filter((r) => r.ord === 0).map((r) => [r.document_id, r.vec_bin]))
    for (const anchor of anchors) {
      expect(Buffer.from(anchor.vec).equals(Buffer.from(ordZero.get(anchor.document_id)))).toBe(true)
    }
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
