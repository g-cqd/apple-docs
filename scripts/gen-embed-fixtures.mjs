/**
 * Generate test/fixtures/embed-parity/ — the committed vector/code
 * self-regression corpus for the Swift embedder.
 *
 * REFERENCE FLIPPED at embedding v2 (RFC 0002 §6h): vectors come from the
 * NATIVE embedder (libAppleDocsCore through the production getEmbedder
 * path) — the Swift pipeline is its own reference now; transformers.js/
 * onnxruntime are not inputs. Codes are computed by the JS quantizers,
 * which doubles as the cross-implementation lockstep check (the native
 * tests round-trip the same bins through ad_embed_batch_codes).
 *
 *   cases  — the tokenizer-parity texts → vectors + sign/int8 codes.
 *            Together with matrix-subset.admx this is the CI gate.
 *   corpus — ≥2,000 real chunks re-derived exactly like the indexer
 *            (src/commands/index-embeddings.js: lowest document ids →
 *            getSectionsByDocumentIds → chunkDocument, (docId, ord) order;
 *            chunk text is not stored in the DB, so it is re-derived and
 *            committed here) → texts + vectors + codes. Gates the FULL
 *            matrix artifact locally / at snapshot build.
 *
 * Layouts: vectors.bin = N×512 f32 LE; codes.bin = N × (64 B sign code +
 * 516 B int8+scale code); index.json carries names/(docId,ord) in order +
 * provenance meta.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEmbedder, resolveActiveSpec } from '../src/search/embedder.js'
import { quantizeI8, quantizeTo } from '../src/search/embedding.js'
import { chunkDocument } from '../src/search/chunker.js'
import { LEGACY_ONNX_SHA256, PINNED_MODEL_FILES, verifyPinnedModelFiles } from '../src/search/model-integrity.js'
import { isNativeEnabled } from '../src/native/loader.js'
import { DocsDatabase } from '../src/storage/database.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'test', 'fixtures', 'embed-parity')
const DIMS = 512
const CORPUS_CHUNKS = 2000

const spec = resolveActiveSpec()
if (spec.hfId !== 'minishlab/potion-retrieval-32M') {
  throw new Error(`fixtures target the default model; unset APPLE_DOCS_EMBED_MODEL (got ${spec.hfId})`)
}
if (!isNativeEnabled('embed')) {
  throw new Error('native embed is disabled — the reference is the Swift pipeline (unset APPLE_DOCS_NATIVE=off)')
}

const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const modelsDir = process.env.APPLE_DOCS_MODELS_DIR ?? join(home, 'resources', 'models')
// The full pin set: tokenizers + the derived admx the native embedder mmaps.
await verifyPinnedModelFiles(modelsDir, spec.hfId)

const embedder = await getEmbedder({ modelsDir })
if (!embedder) throw new Error('native embedder unavailable (build the dylib: swift build --package-path swift -c release)')

/** Embed in moderate batches; bags are independent in the graph. */
async function embedAll(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 256) {
    out.push(...(await embedder.embedBatch(texts.slice(i, i + 256))))
  }
  return out
}

function packLeg(vecs) {
  const vectors = Buffer.alloc(vecs.length * DIMS * 4)
  const codes = Buffer.alloc(vecs.length * (DIMS / 8 + DIMS + 4))
  const codeStride = DIMS / 8 + DIMS + 4
  for (let i = 0; i < vecs.length; i++) {
    const vec = vecs[i]
    if (vec.length !== DIMS) throw new Error(`vector ${i} has ${vec.length} dims`)
    Buffer.from(vec.buffer, vec.byteOffset, DIMS * 4).copy(vectors, i * DIMS * 4)
    Buffer.from(quantizeTo(vec, vec.length)).copy(codes, i * codeStride)
    Buffer.from(quantizeI8(vec)).copy(codes, i * codeStride + DIMS / 8)
  }
  return { vectors, codes }
}

// --- case leg -----------------------------------------------------------------

const { meta: tokenizerMeta, cases } = JSON.parse(
  readFileSync(join(ROOT, 'test', 'fixtures', 'tokenizer-parity', 'cases.json'), 'utf8'),
)
const caseVecs = await embedAll(cases.map((c) => c.text))
const caseLeg = packLeg(caseVecs)

// --- corpus leg ----------------------------------------------------------------

const db = new DocsDatabase(join(home, 'apple-docs.db'))
const snapshotVersion = db.getSnapshotMeta('snapshot_version') ?? null
const docStats = db.db.query('SELECT COUNT(*) AS count, MAX(id) AS maxId FROM documents').get()
const docs = db.db
  .query('SELECT id, title, abstract_text, headings FROM documents ORDER BY id LIMIT 600')
  .all()

const corpus = []
for (let i = 0; i < docs.length && corpus.length < CORPUS_CHUNKS; i += 64) {
  const batch = docs.slice(i, i + 64)
  const sectionsMap = db.getSectionsByDocumentIds(batch.map((r) => r.id))
  for (const r of batch) {
    const chunks = chunkDocument({
      title: r.title,
      abstract_text: r.abstract_text,
      headings: r.headings,
      sections: sectionsMap.get(r.id) ?? [],
    })
    for (let ord = 0; ord < chunks.length && corpus.length < CORPUS_CHUNKS; ord++) {
      corpus.push({ docId: r.id, ord, text: chunks[ord] })
    }
  }
}
if (corpus.length < CORPUS_CHUNKS) throw new Error(`only ${corpus.length} chunks derived — raise the document LIMIT`)

const corpusVecs = await embedAll(corpus.map((c) => c.text))
const corpusLeg = packLeg(corpusVecs)

// Cross-check against the live DB's stored codes where the vintage matches
// (informational — the snapshot may predate the current model files).
let dbMatches = 0
let dbChecked = 0
const chunkQuery = db.db.query('SELECT vec_bin FROM document_chunks WHERE document_id = ? AND ord = ?')
for (let i = 0; i < corpus.length; i += 97) {
  const { docId, ord } = corpus[i]
  const row = chunkQuery.get(docId, ord)
  if (!row?.vec_bin) continue
  dbChecked++
  const want = corpusLeg.codes.subarray(i * (DIMS / 8 + DIMS + 4), i * (DIMS / 8 + DIMS + 4) + DIMS / 8)
  if (Buffer.from(row.vec_bin).equals(want)) dbMatches++
}
db.close?.()

// --- write ----------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'case-vectors.bin'), caseLeg.vectors)
writeFileSync(join(OUT_DIR, 'case-codes.bin'), caseLeg.codes)
writeFileSync(join(OUT_DIR, 'corpus-vectors.bin'), corpusLeg.vectors)
writeFileSync(join(OUT_DIR, 'corpus-codes.bin'), corpusLeg.codes)
writeFileSync(join(OUT_DIR, 'corpus-texts.json'), JSON.stringify(corpus, null, 1))
writeFileSync(
  join(OUT_DIR, 'index.json'),
  JSON.stringify(
    {
      meta: {
        model: spec.hfId,
        dims: DIMS,
        runtime: 'native-libAppleDocsCore',
        behaviorVersion: tokenizerMeta.behaviorVersion,
        modelOnnxSha256: LEGACY_ONNX_SHA256,
        snapshotVersion,
        sourceDb: { documentCount: docStats.count, maxDocumentId: docStats.maxId },
        caseCount: cases.length,
        corpusCount: corpus.length,
        codeStride: DIMS / 8 + DIMS + 4,
      },
      caseNames: cases.map((c) => c.name),
    },
    null,
    1,
  ),
)

console.log(`wrote ${OUT_DIR}`)
console.log(`  cases: ${cases.length} vectors/codes`)
console.log(`  corpus: ${corpus.length} chunks from ${new Set(corpus.map((c) => c.docId)).size} documents (snapshot ${snapshotVersion})`)
console.log(`  db cross-check: ${dbMatches}/${dbChecked} sampled sign codes match the live DB`)
