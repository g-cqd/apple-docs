#!/usr/bin/env bun
/**
 * Chunking-parameter eval sweep (RFC 0001 §10(F)). For each candidate
 * {maxChunks, windowChars, overlapChars}, full re-embed the corpus (on a
 * COPY db — never the live one) and run scripts/eval-search.js, so the
 * retrieval-quality effect of the chunk boundaries is measured directly.
 * Baseline (the live defaults) is eval'd from the copy's existing chunks
 * without re-embedding. Embedding-changing: adopt a candidate only if it
 * beats baseline by a stated target; else NO-GO, keep 8/880/160.
 *
 *   bun scripts/chunk-sweep.mjs <copy.db>
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DocsDatabase } from '../src/storage/database.js'
import { getEmbedder } from '../src/search/embedder.js'
import { chunkDocument } from '../src/search/chunker.js'
import { quantizeTo, quantizeI8 } from '../src/search/embedding.js'

const ROOT = join(import.meta.dir, '..')
const SWEEP = process.argv[2]
if (!SWEEP) { console.error('usage: chunk-sweep.mjs <copy.db>'); process.exit(2) }
const modelsDir = join(homedir(), '.apple-docs', 'resources', 'models')

const candidates = [
  { name: 'baseline 8/880/160', params: { maxChunks: 8, windowChars: 880, overlapChars: 160 }, baseline: true },
  { name: 'finer 12/600/120', params: { maxChunks: 12, windowChars: 600, overlapChars: 120 } },
  { name: 'more-chunks 16/880/160', params: { maxChunks: 16, windowChars: 880, overlapChars: 160 } },
  { name: 'more-overlap 8/880/320', params: { maxChunks: 8, windowChars: 880, overlapChars: 320 } },
]

async function reembed(db, embedder, params) {
  const rows = db.db.query('SELECT id, title, abstract_text, headings FROM documents ORDER BY id').all()
  const anchorUpsert = db.db.query('INSERT OR REPLACE INTO document_vectors(document_id, vec) VALUES ($id, $vec)')
  const BATCH = 64
  let dims = 0
  let chunkCount = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const sectionsMap = db.getSectionsByDocumentIds(batch.map(r => r.id))
    const flat = []
    for (const r of batch) {
      const chunks = chunkDocument(
        { title: r.title, abstract_text: r.abstract_text, headings: r.headings, sections: sectionsMap.get(r.id) ?? [] },
        params,
      )
      for (let ord = 0; ord < chunks.length; ord++) flat.push({ docId: r.id, ord, text: chunks[ord] })
    }
    const texts = flat.map(f => f.text)
    const codeRows = embedder.embedBatchCodes ? await embedder.embedBatchCodes(texts) : null
    const vecs = codeRows ? null : await embedder.embedBatch(texts)
    if (!dims && flat.length) {
      dims = codeRows ? embedder.dims : vecs[0].length
      db.setSnapshotMeta('embed_dims', String(dims))
      db.setSnapshotMeta('embed_model', 'potion-retrieval-32M')
      if (embedder.embedVersion !== undefined) db.setSnapshotMeta('embed_version', String(embedder.embedVersion))
    }
    db.db.run('BEGIN')
    try {
      for (const r of batch) db.deleteChunksByDocId(r.id)
      for (let k = 0; k < flat.length; k++) {
        const { docId, ord } = flat[k]
        let vecBin
        let vecI8
        if (codeRows) ({ vecBin, vecI8 } = codeRows[k])
        else { vecBin = quantizeTo(vecs[k], vecs[k].length); vecI8 = quantizeI8(vecs[k]) }
        db.upsertChunk({ documentId: docId, ord, text: null, vecBin, vecI8 })
        if (ord === 0) anchorUpsert.run({ $id: docId, $vec: vecBin })
      }
      db.db.run('COMMIT')
    } catch (e) { db.db.run('ROLLBACK'); throw e }
    chunkCount += flat.length
    if ((i / BATCH) % 200 === 0) process.stderr.write(`\r  ${i}/${rows.length} docs, ${chunkCount} chunks`)
  }
  process.stderr.write('\r')
  return chunkCount
}

function evalDb() {
  const r = Bun.spawnSync(['bun', 'scripts/eval-search.js', '--db', SWEEP, '--json', '--anchors', '150'], {
    cwd: ROOT,
    env: { ...process.env },
  })
  if (r.exitCode !== 0) { console.error('eval failed:', new TextDecoder().decode(r.stderr).slice(-400)); process.exit(1) }
  const out = new TextDecoder().decode(r.stdout).trim()
  return JSON.parse(out.slice(out.lastIndexOf('\n{') >= 0 ? out.lastIndexOf('\n{') + 1 : 0))
}

const embedder = await getEmbedder({ modelsDir })
if (!embedder) { console.error('no embedder'); process.exit(2) }

for (const c of candidates) {
  if (!c.baseline) {
    const db = new DocsDatabase(SWEEP)
    const t0 = performance.now()
    c.chunks = await reembed(db, embedder, c.params)
    db.close()
    console.error(`${c.name}: re-embedded ${c.chunks} chunks in ${((performance.now() - t0) / 1000).toFixed(0)}s`)
  } else {
    console.error(`${c.name}: eval existing chunks (live defaults)`)
  }
  const j = evalDb()
  c.rows = j.rows
  c.chunks ??= j.chunks
}

// Report: focus on the semantic configs (lexical-only is the control).
console.log('\nchunk-sweep results (recall@10 / ndcg@10 / mrr, full 358k corpus, 168 judgments)\n')
const base = candidates[0]
const fmt = (r) => `${r.recall.toFixed(4)} ${r.ndcg.toFixed(4)} ${r.mrr.toFixed(4)}`
for (const cfg of ['lexical-only', 'baseline-rrf', 'hybrid', 'hybrid+mmr']) {
  console.log(`[${cfg}]`)
  for (const c of candidates) {
    const r = c.rows.find(x => x.name === cfg)
    const b = base.rows.find(x => x.name === cfg)
    const dM = (r.mrr - b.mrr)
    const dN = (r.ndcg - b.ndcg)
    const tag = c.baseline ? '' : `  Δmrr ${dM >= 0 ? '+' : ''}${dM.toFixed(4)} Δndcg ${dN >= 0 ? '+' : ''}${dN.toFixed(4)}`
    console.log(`  ${c.name.padEnd(24)} ${fmt(r)}${tag}`)
  }
}
console.log(`\nchunks: ${candidates.map(c => `${c.name.split(' ')[0]}=${c.chunks}`).join('  ')}`)
