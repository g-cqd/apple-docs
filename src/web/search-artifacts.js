import { join } from 'node:path'
import { ensureDir } from '../storage/files.js'
import { sha256 } from '../lib/hash.js'

/**
 * Compute a short content hash (first 10 hex chars of SHA-256).
 * @param {string} data
 * @returns {string}
 */
function contentHash(data) {
  return sha256(data).slice(0, 10)
}

/**
 * Build a compact columnar title index (v2) for browser-side search.
 *
 * Returns a columnar structure where each field is stored as a parallel array,
 * which compresses significantly better with gzip because similar data is
 * adjacent.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @returns {{ v: 2, frameworks: string[], keys: string[], titles: string[], abstracts: string[], fwIndices: number[], kinds: string[], roleHeadings: string[] }}
 */
export function buildTitleIndex(db) {
  const docs = db.db.query(`
    SELECT key, title, abstract_text, framework, kind, role_heading
    FROM documents
    ORDER BY key
  `).all()

  const frameworks = [...new Set(docs.map(d => d.framework).filter(Boolean))].sort()
  const fwLookup = Object.fromEntries(frameworks.map((f, i) => [f, i]))

  return {
    v: 2,
    frameworks,
    keys: docs.map(d => d.key),
    titles: docs.map(d => d.title),
    abstracts: docs.map(d => (d.abstract_text || '').slice(0, 80)),
    fwIndices: docs.map(d => fwLookup[d.framework] ?? -1),
    kinds: docs.map(d => d.kind || ''),
    roleHeadings: docs.map(d => d.role_heading || ''),
  }
}

/**
 * Build a mapping from framework alias to canonical framework name.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @returns {Record<string, string>}
 */
export function buildAliasMap(db) {
  const synonyms = db.db.query('SELECT canonical, alias FROM framework_synonyms').all()
  const aliasMap = {}
  for (const { canonical, alias } of synonyms) {
    aliasMap[alias] = canonical
  }
  return aliasMap
}

/** Body characters retained per document in the per-letter shards. */
const BODY_PREVIEW_CHARS = 500
/** Doc-id chunk size for the streaming sections fetch. */
const BODY_SHARD_BATCH = 5_000

/**
 * Split document body text into alphabetical shard files and write them to
 * `${outputDir}/shards/`. Each shard is keyed by the first letter of the
 * document's framework (a–z), with `_` used for documents that have no
 * framework. Body text is truncated to 500 characters per document.
 *
 * The previous implementation used `group_concat(ds.content_text, ' ')` over
 * the entire corpus, which forced SQLite to buffer the full per-document body
 * (often many KB) and JS to hold the full result set (hundreds of MB peak)
 * before slicing each row to 500 chars. With 346 K documents that broke the
 * memory budget on the production box.
 *
 * The streaming form fetches doc metadata once, then iterates the corpus in
 * `BODY_SHARD_BATCH`-sized doc-id windows and pulls sections only for that
 * window — accumulating in JS until each doc reaches `BODY_PREVIEW_CHARS`,
 * then short-circuiting. Peak working set is one batch of section rows.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} outputDir
 * @returns {Promise<Array<{ letter: string, hash: string }>>}
 */
export async function buildBodyShards(db, outputDir) {
  const hasSections = db.hasTable('document_sections')

  /** @type {Map<string, Record<string, string>>} */
  const shards = new Map()
  const ensureShard = (letter) => {
    let s = shards.get(letter)
    if (!s) {
      s = {}
      shards.set(letter, s)
    }
    return s
  }
  const letterFor = (framework) => (
    framework ? framework.charAt(0).toLowerCase().replace(/[^a-z]/, '_') : '_'
  )

  if (hasSections) {
    const docs = db.db.query('SELECT id, key, framework FROM documents ORDER BY id').all()

    for (let offset = 0; offset < docs.length; offset += BODY_SHARD_BATCH) {
      const batch = docs.slice(offset, offset + BODY_SHARD_BATCH)
      const ids = batch.map(d => d.id)
      const placeholders = ids.map(() => '?').join(',')

      // Pull sections for this batch, ordered so we can short-circuit per doc
      // as soon as we've accumulated BODY_PREVIEW_CHARS.
      const sectionRows = db.db.query(
        `SELECT document_id, content_text
         FROM document_sections
         WHERE document_id IN (${placeholders})
         ORDER BY document_id, sort_order, id`
      ).all(...ids)

      const bodyByDoc = new Map()
      for (const row of sectionRows) {
        const existing = bodyByDoc.get(row.document_id) ?? ''
        if (existing.length >= BODY_PREVIEW_CHARS) continue
        const piece = row.content_text ?? ''
        if (!piece) continue
        bodyByDoc.set(row.document_id, existing ? `${existing} ${piece}` : piece)
      }

      for (const doc of batch) {
        const body = (bodyByDoc.get(doc.id) ?? '').trim()
        if (body.length === 0) continue
        ensureShard(letterFor(doc.framework))[doc.key] = body.slice(0, BODY_PREVIEW_CHARS)
      }
    }
  } else {
    // Lite tier: no body text. Touch every shard letter so the manifest is
    // stable, but emit no per-doc entries.
    for (const row of db.db.query('SELECT framework FROM documents').all()) {
      ensureShard(letterFor(row.framework))
    }
  }

  const shardsDir = join(outputDir, 'shards')
  ensureDir(shardsDir)

  /** @type {Array<{ letter: string, hash: string }>} */
  const shardMeta = []
  const writeOps = []
  for (const [letter, shard] of shards) {
    const json = JSON.stringify(shard)
    const hash = contentHash(json)
    writeOps.push(Bun.write(join(shardsDir, `${letter}.${hash}.json`), json))
    shardMeta.push({ letter, hash })
  }
  await Promise.all(writeOps)

  return shardMeta
}

/**
 * Write the search manifest file containing metadata about generated artifacts
 * and the mapping from logical names to content-hashed filenames.
 *
 * The manifest itself is NOT hashed — it should be served with `Cache-Control:
 * no-cache` so clients always get the latest version, while the hashed artifact
 * files can be served with immutable caching.
 *
 * @param {string} outputDir
 * @param {{ titleCount: number, aliasCount: number, shardCount: number, files: Record<string, string> }} stats
 * @returns {Promise<void>}
 */
export async function writeSearchManifest(outputDir, stats) {
  const manifest = {
    version: 2,
    titleCount: stats.titleCount,
    aliasCount: stats.aliasCount,
    shardCount: stats.shardCount,
    files: stats.files,
    generatedAt: new Date().toISOString(),
  }
  await Bun.write(join(outputDir, 'search-manifest.json'), JSON.stringify(manifest))
}

/**
 * Write a JSON artifact with a content-hashed filename.
 *
 * @param {string} outputDir - Directory to write into
 * @param {string} baseName - Logical name without extension (e.g. "title-index")
 * @param {object} data - Object to serialize as JSON
 * @returns {Promise<{ hash: string, json: string }>}
 */
async function writeHashedJSON(outputDir, baseName, data) {
  const json = JSON.stringify(data)
  const hash = contentHash(json)
  const filePath = join(outputDir, `${baseName}.${hash}.json`)
  await Bun.write(filePath, json)
  return { hash, json }
}

/**
 * Orchestrate the generation of all search artifact files.
 *
 * Writes content-hashed files:
 * - `${outputDir}/title-index.{hash}.json`
 * - `${outputDir}/aliases.{hash}.json`
 * - `${outputDir}/shards/<letter>.{hash}.json` (one per first-letter bucket)
 * - `${outputDir}/search-manifest.json` (not hashed — always fresh)
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} outputDir
 * @returns {Promise<{ titleCount: number, aliasCount: number, shardCount: number }>}
 */
export async function generateSearchArtifacts(db, outputDir) {
  ensureDir(outputDir)

  // Build data structures (CPU-bound, synchronous)
  const titleIndex = buildTitleIndex(db)
  const aliasMap = buildAliasMap(db)

  // Write all artifacts in parallel (IO-bound)
  const [titleResult, aliasResult, shardMeta] = await Promise.all([
    writeHashedJSON(outputDir, 'title-index', titleIndex),
    writeHashedJSON(outputDir, 'aliases', aliasMap),
    buildBodyShards(db, outputDir),
  ])

  const titleCount = titleIndex.keys.length
  const aliasCount = Object.keys(aliasMap).length
  const shardCount = shardMeta.length

  // Build the file mapping for the manifest
  /** @type {Record<string, string>} */
  const files = {
    'title-index': `title-index.${titleResult.hash}.json`,
    'aliases': `aliases.${aliasResult.hash}.json`,
  }
  for (const { letter, hash } of shardMeta) {
    files[`shard-${letter}`] = `shards/${letter}.${hash}.json`
  }

  await writeSearchManifest(outputDir, { titleCount, aliasCount, shardCount, files })

  return { titleCount, aliasCount, shardCount }
}
