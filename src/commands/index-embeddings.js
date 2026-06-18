import { join } from 'node:path'
import { chunkDocument } from '../search/chunker.js'
import { getEmbedder } from '../search/embedder.js'
import { quantizeI8, quantizeTo } from '../search/embedding.js'
import { _resetVectorCache } from '../search/semantic.js'

/**
 * Build the per-chunk embedding index (`document_chunks`) for the body-aware
 * semantic-search tier. Each document is split by `chunkDocument` into an
 * anchor chunk (title + abstract + headings, identical to the old whole-doc
 * input) plus heading-aware body chunks from `document_sections`; every chunk
 * is embedded and stored as both a sign-quantized binary code (`vec_bin`, the
 * Hamming shortlist) and an int8 + f32-scale code (`vec_i8`, the rescore stage).
 *
 * The anchor code is also upserted into `document_vectors` so old whole-doc
 * readers and the cheap `getVectorCount()` availability gate keep working.
 * `embed_model` / `embed_dims` / `embed_version` are recorded in
 * snapshot_meta so the reader can width-guard against a mismatched snapshot
 * and version drift is observable (and self-heals on the next index run).
 *
 * Resumable: without `--full`, only documents with no chunks are processed.
 * The embedder is injectable (`opts.embedder`) so tests use a deterministic
 * fake and never need the optional `@huggingface/transformers` dependency.
 *
 * @param {{ full?: boolean, embedder?: { embed(t: string): Promise<Float32Array> } }} opts
 * @param {{ db, dataDir?, logger, onProgress? }} ctx
 */
export async function indexEmbeddings(opts, ctx) {
  const { db, dataDir, logger } = ctx
  if (!db.hasTable('documents')) {
    return { status: 'error', message: 'No documents to embed. Run apple-docs sync first.' }
  }
  if (!db.hasTable('document_vectors')) {
    db.db.run(`CREATE TABLE IF NOT EXISTS document_vectors (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      vec         BLOB NOT NULL
    )`)
  }

  const modelsDir = dataDir ? join(dataDir, 'resources', 'models') : undefined
  const embedder = opts?.embedder ?? (await getEmbedder({ logger, modelsDir }))
  if (!embedder) {
    return {
      status: 'error',
      message:
        'Semantic embedder unavailable. The default model is native: fetch the bundle with `apple-docs setup --native` and keep APPLE_DOCS_NATIVE enabled (gated models additionally need `bun add @huggingface/transformers`).',
    }
  }

  let full = !!opts?.full
  // A deliberate embedding-behavior change (RFC 0001 §10; stamped as
  // `embed_version`) invalidates stored chunks wholesale — resuming would
  // mix versions in one table. Checked BEFORE the resume query so an
  // "up to date" v1 store still re-embeds under a v2 embedder.
  if (!full && embedder.embedVersion !== undefined && typeof db.getChunkCount === 'function' && db.getChunkCount() > 0) {
    const stored = db.getSnapshotMeta?.('embed_version') ?? '1'
    if (stored !== String(embedder.embedVersion)) {
      logger?.info?.(`Embedding behavior changed (stored v${stored} → live v${embedder.embedVersion}) — full re-embed.`)
      full = true
    }
  }
  const rows = (
    full
      ? db.db.query('SELECT id, title, abstract_text, headings FROM documents ORDER BY id')
      : db.db.query('SELECT id, title, abstract_text, headings FROM documents WHERE id NOT IN (SELECT document_id FROM document_chunks) ORDER BY id')
  ).all()
  const total = rows.length
  if (total === 0) {
    logger?.info?.('Embedding index is up to date.')
    return { status: 'ok', indexed: 0, total: 0, chunks: 0 }
  }

  const anchorUpsert = db.db.query('INSERT OR REPLACE INTO document_vectors(document_id, vec) VALUES ($id, $vec)')
  const BATCH = 64
  let indexed = 0
  let chunkCount = 0
  let dims = 0
  for (let i = 0; i < total; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const sectionsMap = db.getSectionsByDocumentIds(batch.map((r) => r.id))
    // Flatten every chunk of the batch into one embed call so the ONNX
    // pipeline batches efficiently; map results back by index afterwards.
    const flat = []
    for (const r of batch) {
      const chunks = chunkDocument({
        title: r.title,
        abstract_text: r.abstract_text,
        headings: r.headings,
        sections: sectionsMap.get(r.id) ?? [],
      })
      for (let ord = 0; ord < chunks.length; ord++) flat.push({ docId: r.id, ord, text: chunks[ord] })
    }
    const texts = flat.map((f) => f.text)
    // Code-capable embedders (the native bridge) return the storage blobs
    // directly — byte-identical to the JS quantizers by the embed-parity
    // gates, at 580 B/chunk across the FFI instead of the 2 KB f32 vector.
    const codeRows = embedder.embedBatchCodes ? await embedder.embedBatchCodes(texts) : null
    const vecs = codeRows ? null : embedder.embedBatch ? await embedder.embedBatch(texts) : await sequentialEmbed(embedder, texts)
    if (!dims && flat.length) {
      dims = codeRows ? embedder.dims : vecs[0].length
      // Written with the first batch (idempotent) so an interrupted run never
      // leaves chunks on disk with absent/stale model meta.
      db.setSnapshotMeta('embed_dims', String(dims))
      db.setSnapshotMeta('embed_model', process.env.APPLE_DOCS_EMBED_MODEL ?? 'potion-retrieval-32M')
      if (embedder.embedVersion !== undefined) {
        db.setSnapshotMeta('embed_version', String(embedder.embedVersion))
      }
    }

    db.db.run('BEGIN')
    try {
      for (const r of batch) db.deleteChunksByDocId(r.id) // clear stale ords on re-index
      for (let k = 0; k < flat.length; k++) {
        const { docId, ord } = flat[k]
        let vecBin
        let vecI8
        if (codeRows) {
          ;({ vecBin, vecI8 } = codeRows[k])
        } else {
          const vec = vecs[k]
          vecBin = quantizeTo(vec, vec.length)
          vecI8 = quantizeI8(vec)
        }
        db.upsertChunk({ documentId: docId, ord, text: null, vecBin, vecI8 })
        if (ord === 0) anchorUpsert.run({ $id: docId, $vec: vecBin })
      }
      db.db.run('COMMIT')
    } catch (e) {
      db.db.run('ROLLBACK')
      throw e
    }
    indexed += batch.length
    chunkCount += flat.length
    ctx.onProgress?.({ done: indexed, total })
  }

  _resetVectorCache() // in-process readers must rebuild from the new tables
  db.resetSemanticCountCaches() // memoized vector/chunk counts are now stale (§10(B))
  logger?.info?.(`Embedding index built: ${chunkCount} chunks across ${indexed}/${total} documents.`)
  return { status: 'ok', indexed, total, chunks: chunkCount }
}

/** Fallback for embedders without embedBatch (injected test fakes). */
async function sequentialEmbed(embedder, texts) {
  const out = new Array(texts.length)
  for (let i = 0; i < texts.length; i++) out[i] = await embedder.embed(texts[i])
  return out
}
