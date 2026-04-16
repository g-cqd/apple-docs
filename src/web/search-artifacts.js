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

/**
 * Split document body text into alphabetical shard files and write them to
 * `${outputDir}/shards/`. Each shard is keyed by the first letter of the
 * document's framework (a–z), with `_` used for documents that have no
 * framework. Body text is truncated to 500 characters per document.
 *
 * Returns an array of `{ letter, hash }` for each shard written, so the
 * caller can build the manifest mapping.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} outputDir
 * @returns {Promise<Array<{ letter: string, hash: string }>>} Shard metadata
 */
export async function buildBodyShards(db, outputDir) {
  const hasSections = db.hasTable('document_sections')
  const rows = db.db.query(hasSections ? `
    SELECT
      d.key,
      d.framework,
      group_concat(ds.content_text, ' ') AS body_text
    FROM documents d
    LEFT JOIN document_sections ds ON ds.document_id = d.id
    GROUP BY d.id
    ORDER BY d.key
  ` : `
    SELECT d.key, d.framework, NULL AS body_text
    FROM documents d
    ORDER BY d.key
  `).all()

  /** @type {Map<string, Record<string, string>>} */
  const shards = new Map()

  for (const row of rows) {
    const letter = row.framework
      ? row.framework.charAt(0).toLowerCase().replace(/[^a-z]/, '_')
      : '_'

    if (!shards.has(letter)) shards.set(letter, {})

    const body = (row.body_text || '').trim()
    if (body.length > 0) {
      shards.get(letter)[row.key] = body.slice(0, 500)
    }
  }

  const shardsDir = join(outputDir, 'shards')
  ensureDir(shardsDir)

  const writeOps = []
  /** @type {Array<{ letter: string, hash: string }>} */
  const shardMeta = []

  for (const [letter, shard] of shards) {
    const json = JSON.stringify(shard)
    const hash = contentHash(json)
    const filePath = join(shardsDir, `${letter}.${hash}.json`)
    writeOps.push(Bun.write(filePath, json))
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
