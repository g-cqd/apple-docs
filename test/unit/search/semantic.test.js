// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { indexEmbeddings } from '../../../src/commands/index-embeddings.js'
import { VECTOR_BYTES } from '../../../src/search/embedding.js'
import { _resetVectorCache, isSemanticAvailable, semanticCandidates } from '../../../src/search/semantic.js'
import { DocsDatabase } from '../../../src/storage/database.js'
import { topicEmbedder } from '../../helpers/topic-embedder.js'

let db
let ctx

beforeEach(async () => {
  _resetVectorCache()
  db = new DocsDatabase(':memory:')
  ctx = { db, logger: { debug() {} }, embedder: topicEmbedder() }
  const root = db.upsertRoot('fw', 'FW', 'framework', 'test')
  const docs = [
    { key: 'fw/alpha', title: 'Alpha', abstract: 'plays audio buffers' },
    { key: 'fw/beta', title: 'Beta', abstract: 'sends a network request' },
    { key: 'fw/gamma', title: 'Gamma', abstract: 'arranges layout' },
  ]
  for (const d of docs) {
    db.upsertPage({ rootId: root.id, path: d.key, url: 'u', title: d.title, role: 'symbol', abstract: d.abstract })
    db.upsertNormalizedDocument({
      document: { key: d.key, title: d.title, sourceType: 'apple-docc', framework: 'fw', role: 'symbol', abstractText: d.abstract },
      sections: [],
      relationships: [],
    })
  }
  await indexEmbeddings({ embedder: topicEmbedder() }, ctx)
})

afterEach(() => db.close())

describe('semanticCandidates', () => {
  test('available once vectors are present', () => {
    expect(isSemanticAvailable(db)).toBe(true)
    expect(db.getVectorCount()).toBe(3)
  })

  test('a synonym query is nearest the topically-matching doc (no lexical overlap)', async () => {
    const res = await semanticCandidates(ctx, 'sound', 3) // sound → audio → Alpha
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].distance).toBe(0)
    const top = db.getSearchRecordsByIds([res[0].documentId])[0]
    expect(top.path).toBe('fw/alpha')
  })

  test('behavior-version drift logs once but still serves (RFC 0002 §6h)', async () => {
    // Store stamped v1 (no embed_version meta), live embedder claims v2.
    const lines = []
    const vctx = {
      db,
      logger: { debug() {}, info: (m) => lines.push(m) },
      embedder: { ...topicEmbedder(), embedVersion: 2 },
    }
    const res = await semanticCandidates(vctx, 'sound', 3)
    expect(res.length).toBeGreaterThan(0) // serving, not degraded
    await semanticCandidates(vctx, 'sound', 3)
    expect(lines.filter((m) => m.includes('behavior v1')).length).toBe(1) // once per store
  })

  test('dormant when APPLE_DOCS_SEMANTIC=off', async () => {
    const prev = process.env.APPLE_DOCS_SEMANTIC
    process.env.APPLE_DOCS_SEMANTIC = 'off'
    try {
      expect(isSemanticAvailable(db)).toBe(false)
      expect(await semanticCandidates(ctx, 'sound', 3)).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_SEMANTIC
      else process.env.APPLE_DOCS_SEMANTIC = prev
    }
  })

  test('returns [] when no vectors are indexed', async () => {
    const bare = new DocsDatabase(':memory:')
    try {
      expect(isSemanticAvailable(bare)).toBe(false)
      expect(await semanticCandidates({ db: bare, embedder: topicEmbedder() }, 'sound', 3)).toEqual([])
    } finally {
      bare.close()
    }
  })

  // Compat guard for the LEGACY whole-doc path (document_vectors only). A
  // vector whose width != VECTOR_BYTES is an older snapshot's 48-byte MiniLM
  // code read by the 64-byte model2vec scanner — Hamming-scanning those
  // misaligned bytes would corrupt distances, so loadVectors drops them. These
  // tests delete document_chunks first so the reader takes the legacy path
  // (chunks present ⇒ the chunk path, which ignores document_vectors entirely).
  const idOf = (path) => {
    const ids = db.getAllVectors().map((v) => v.document_id)
    return db.getSearchRecordsByIds(ids).find((r) => r.path === path).id
  }
  const writeRawVector = (id, bytes) => db.db.query('INSERT OR REPLACE INTO document_vectors(document_id, vec) VALUES (?, ?)').run(id, new Uint8Array(bytes))
  const STALE_BYTES = 48 // older MiniLM-384 code width (vs the current 512-bit/64-byte)

  test('legacy path: document_vectors-only snapshot still ranks (no chunks)', async () => {
    db.db.run('DELETE FROM document_chunks')
    expect(db.getChunkCount()).toBe(0)
    expect(db.getVectorCount()).toBe(3)
    const res = await semanticCandidates(ctx, 'sound', 3)
    expect(res.length).toBeGreaterThan(0)
    const top = db.getSearchRecordsByIds([res[0].documentId])[0]
    expect(top.path).toBe('fw/alpha')
  })

  test('legacy path: skips a single width-mismatched vector, still ranks the rest', async () => {
    db.db.run('DELETE FROM document_chunks') // force the legacy whole-doc path
    expect(STALE_BYTES).not.toBe(VECTOR_BYTES) // the guard only bites while widths differ
    const alphaId = idOf('fw/alpha') // the doc "sound" would otherwise match
    writeRawVector(alphaId, STALE_BYTES)

    const res = await semanticCandidates(ctx, 'sound', 3)
    expect(res.length).toBe(2) // alpha skipped; beta + gamma remain scannable
    expect(res.map((r) => r.documentId)).not.toContain(alphaId)
  })

  test('legacy path: degrades to lexical-only when every vector is the wrong width', async () => {
    db.db.run('DELETE FROM document_chunks') // force the legacy whole-doc path
    for (const p of ['fw/alpha', 'fw/beta', 'fw/gamma']) writeRawVector(idOf(p), STALE_BYTES)

    expect(db.getVectorCount()).toBe(3) // rows present, so the cheap gate is open
    expect(isSemanticAvailable(db)).toBe(true)
    expect(await semanticCandidates(ctx, 'sound', 3)).toEqual([]) // but none are usable
  })
})

// ---------------------------------------------------------------------------
// Chunk path: body sections become their own chunks, max-pooled to documents.
// ---------------------------------------------------------------------------

describe('chunk body retrieval', () => {
  let bdb
  let bctx

  beforeEach(async () => {
    bdb = new DocsDatabase(':memory:')
    bctx = { db: bdb, logger: { debug() {} }, embedder: topicEmbedder() }
    bdb.upsertRoot('fw', 'FW', 'framework', 'test')
    // "Delta": its anchor (title + abstract) has NO topical word — only a body
    // discussion section mentions audio. A whole-doc embedding would miss it;
    // the body chunk recovers it.
    bdb.upsertPage({ rootId: 1, path: 'fw/delta', url: 'u', title: 'Delta', role: 'symbol', abstract: 'a general purpose utility' })
    bdb.upsertNormalizedDocument({
      document: { key: 'fw/delta', title: 'Delta', sourceType: 'apple-docc', framework: 'fw', role: 'symbol', abstractText: 'a general purpose utility' },
      sections: [{ sectionKind: 'discussion', heading: 'Discussion', contentText: 'plays audio buffers through the speaker', sortOrder: 0 }],
      relationships: [],
    })
    await indexEmbeddings({ embedder: topicEmbedder() }, bctx)
  })

  afterEach(() => bdb.close())

  test('multiple chunks are written per document (anchor + body)', () => {
    expect(bdb.getChunkCount()).toBeGreaterThan(1)
    expect(bdb.getVectorCount()).toBe(1) // exactly one anchor in document_vectors
  })

  test('a body-only topical match surfaces the document the anchor would miss', async () => {
    const res = await semanticCandidates(bctx, 'sound', 5) // sound → audio → Delta's body chunk
    expect(res.length).toBeGreaterThan(0)
    const top = bdb.getSearchRecordsByIds([res[0].documentId])[0]
    expect(top.path).toBe('fw/delta')
  })

  test('max-pool returns one row per document, not per chunk', async () => {
    const res = await semanticCandidates(bctx, 'sound', 5)
    const ids = res.map((r) => r.documentId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the query is embedded with isQuery (asymmetric-model prefix selection)', async () => {
    const seen = []
    const base = topicEmbedder()
    const spy = {
      async embed(text, opts) {
        seen.push(opts)
        return base.embed(text)
      },
    }
    const res = await semanticCandidates({ ...bctx, embedder: spy }, 'sound', 5)
    expect(res.length).toBeGreaterThan(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.isQuery).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Store-cache invalidation: same row counts, different bytes — only a reset
// (as issued by indexEmbeddings) makes the reader see the new codes.
// ---------------------------------------------------------------------------

describe('_resetVectorCache', () => {
  test('drops a stale store that row-count invalidation cannot detect', async () => {
    const first = await semanticCandidates(ctx, 'sound', 3)
    expect(first[0].distance).toBe(0) // alpha carries the exact audio code

    // Overwrite every chunk's binary code with gamma's (layout) code: row
    // counts are unchanged, so the cheap (mode, count) check keeps serving
    // the cached store.
    const gammaId = db.getSearchRecordsByIds(db.getAllVectors().map((v) => v.document_id)).find((r) => r.path === 'fw/gamma').id
    const gammaBin = db.db.query('SELECT vec_bin FROM document_chunks WHERE document_id = ?').get(gammaId).vec_bin
    db.db.query('UPDATE document_chunks SET vec_bin = ?').run(gammaBin)
    db.db.query('UPDATE document_chunks SET vec_i8 = NULL').run()

    const stale = await semanticCandidates(ctx, 'sound', 3)
    expect(stale[0].distance).toBe(0) // cached store still has the old codes

    _resetVectorCache()
    const fresh = await semanticCandidates(ctx, 'sound', 3)
    expect(fresh.every((r) => r.distance > 0)).toBe(true) // audio code is gone
  })
})

// ---------------------------------------------------------------------------
// Batched int8 fetch (repo): one IN(...) round-trip, chunked past the
// bound-parameter ceiling.
// ---------------------------------------------------------------------------

describe('getChunkI8Batch', () => {
  test('returns a chunk_id → vec_i8 map across the 500-id batching boundary', () => {
    const mem = new DocsDatabase(':memory:')
    try {
      mem.upsertRoot('fw', 'FW', 'framework', 'test')
      mem.upsertPage({ rootId: 1, path: 'fw/one', url: 'u', title: 'One', role: 'symbol', abstract: 'a' })
      mem.upsertNormalizedDocument({
        document: { key: 'fw/one', title: 'One', sourceType: 'apple-docc', framework: 'fw', role: 'symbol', abstractText: 'a' },
        sections: [],
        relationships: [],
      })
      const docId = mem.db.query('SELECT id FROM documents LIMIT 1').get().id
      for (let ord = 0; ord < 520; ord++) {
        mem.upsertChunk({ documentId: docId, ord, vecBin: new Uint8Array([ord % 256]), vecI8: new Uint8Array([1, 2, 3, ord % 256]) })
      }
      const ids = mem.db
        .query('SELECT chunk_id FROM document_chunks ORDER BY ord')
        .all()
        .map((r) => r.chunk_id)
      expect(ids).toHaveLength(520)

      const map = mem.getChunkI8Batch(ids)
      expect(map.size).toBe(520)
      expect([...map.get(ids[519])]).toEqual([1, 2, 3, 519 % 256])
      expect(mem.getChunkI8Batch([]).size).toBe(0)
    } finally {
      mem.close()
    }
  })
})
