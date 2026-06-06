import { quantize } from '../search/embedding.js'
import { getEmbedder } from '../search/embedder.js'

/**
 * Build the binary embedding index (`document_vectors`) for the optional
 * semantic-search tier. Embeds `title + abstract + headings` per document with
 * all-MiniLM-L6-v2, sign-quantizes to 48 bytes, and upserts.
 *
 * Resumable: without `--full`, only documents missing a vector are processed.
 * The embedder is injectable (`opts.embedder`) so tests use a deterministic
 * fake and never need the optional `@huggingface/transformers` dependency.
 *
 * @param {{ full?: boolean, embedder?: { embed(t: string): Promise<Float32Array> } }} opts
 * @param {{ db, logger, onProgress? }} ctx
 */
export async function indexEmbeddings(opts, ctx) {
  const { db, logger } = ctx
  if (!db.hasTable('documents')) {
    return { status: 'error', message: 'No documents to embed. Run apple-docs sync first.' }
  }
  if (!db.hasTable('document_vectors')) {
    db.db.run(`CREATE TABLE IF NOT EXISTS document_vectors (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      vec         BLOB NOT NULL
    )`)
  }

  const embedder = opts?.embedder ?? (await getEmbedder({ logger }))
  if (!embedder) {
    return {
      status: 'error',
      message: 'Semantic embedder unavailable. Install the optional dependency: `bun add @huggingface/transformers`.',
    }
  }

  const full = !!opts?.full
  const rows = (full
    ? db.db.query('SELECT id, title, abstract_text, headings FROM documents ORDER BY id')
    : db.db.query('SELECT id, title, abstract_text, headings FROM documents WHERE id NOT IN (SELECT document_id FROM document_vectors) ORDER BY id')
  ).all()
  const total = rows.length
  if (total === 0) {
    logger?.info?.('Embedding index is up to date.')
    return { status: 'ok', indexed: 0, total: 0 }
  }

  const upsert = db.db.query('INSERT OR REPLACE INTO document_vectors(document_id, vec) VALUES ($id, $vec)')
  const BATCH = 256
  let indexed = 0
  for (let i = 0; i < total; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const out = []
    for (const r of batch) out.push({ id: r.id, vec: quantize(await embedder.embed(embedText(r))) })
    db.db.run('BEGIN')
    try {
      for (const v of out) upsert.run({ $id: v.id, $vec: v.vec })
      db.db.run('COMMIT')
    } catch (e) {
      db.db.run('ROLLBACK')
      throw e
    }
    indexed += out.length
    ctx.onProgress?.({ done: indexed, total })
  }
  logger?.info?.(`Embedding index built: ${indexed}/${total} documents.`)
  return { status: 'ok', indexed, total }
}

/** Bounded embedding input: the symbol/topic surface, not the full body. */
function embedText(row) {
  return [row.title, row.abstract_text, row.headings].filter(Boolean).join('. ').slice(0, 1200)
}
