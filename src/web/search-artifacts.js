import { join } from 'node:path'
import { ensureDir } from '../storage/files.js'

/**
 * Build a compact title index for browser-side search.
 *
 * Returns `{ frameworks, entries }` where:
 * - `frameworks` is a sorted array of all framework names (deduped)
 * - `entries` is an array of compact arrays per document:
 *   `[key, title, abstractSnippet, frameworkIndex, kind, roleHeading]`
 *
 * Framework index is `-1` when the document has no framework.
 * Abstract snippets are truncated to 80 characters.
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @returns {{ frameworks: string[], entries: Array<[string, string, string, number, string, string]> }}
 */
export function buildTitleIndex(db) {
  const docs = db.db.query(`
    SELECT key, title, abstract_text, framework, kind, role_heading
    FROM documents
    ORDER BY key
  `).all()

  const frameworks = [...new Set(docs.map(d => d.framework).filter(Boolean))].sort()
  const fwIndex = Object.fromEntries(frameworks.map((f, i) => [f, i]))

  return {
    frameworks,
    entries: docs.map(d => [
      d.key,
      d.title,
      (d.abstract_text || '').slice(0, 80),
      fwIndex[d.framework] ?? -1,
      d.kind || '',
      d.role_heading || '',
    ]),
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
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} outputDir
 * @returns {Promise<number>} Number of shard files written
 */
export async function buildBodyShards(db, outputDir) {
  const rows = db.db.query(`
    SELECT
      d.key,
      d.framework,
      group_concat(ds.content_text, ' ') AS body_text
    FROM documents d
    LEFT JOIN document_sections ds ON ds.document_id = d.id
    GROUP BY d.id
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
  for (const [letter, shard] of shards) {
    const filePath = join(shardsDir, `${letter}.json`)
    writeOps.push(Bun.write(filePath, JSON.stringify(shard)))
  }

  await Promise.all(writeOps)

  return shards.size
}

/**
 * Write the search manifest file containing metadata about generated artifacts.
 *
 * @param {string} outputDir
 * @param {{ titleCount: number, aliasCount: number, shardCount: number }} stats
 * @returns {Promise<void>}
 */
export async function writeSearchManifest(outputDir, stats) {
  const manifest = {
    version: 1,
    titleCount: stats.titleCount,
    aliasCount: stats.aliasCount,
    shardCount: stats.shardCount,
    generatedAt: new Date().toISOString(),
  }
  await Bun.write(join(outputDir, 'search-manifest.json'), JSON.stringify(manifest))
}

/**
 * Orchestrate the generation of all search artifact files.
 *
 * Writes:
 * - `${outputDir}/title-index.json`
 * - `${outputDir}/aliases.json`
 * - `${outputDir}/shards/<letter>.json` (one per first-letter bucket)
 * - `${outputDir}/search-manifest.json`
 *
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {string} outputDir
 * @returns {Promise<{ titleCount: number, aliasCount: number, shardCount: number }>}
 */
export async function generateSearchArtifacts(db, outputDir) {
  ensureDir(outputDir)

  const titleIndex = buildTitleIndex(db)
  const aliasMap = buildAliasMap(db)

  const [shardCount] = await Promise.all([
    buildBodyShards(db, outputDir),
    Bun.write(join(outputDir, 'title-index.json'), JSON.stringify(titleIndex)),
    Bun.write(join(outputDir, 'aliases.json'), JSON.stringify(aliasMap)),
  ])

  const titleCount = titleIndex.entries.length
  const aliasCount = Object.keys(aliasMap).length

  await writeSearchManifest(outputDir, { titleCount, aliasCount, shardCount })

  return { titleCount, aliasCount, shardCount }
}
