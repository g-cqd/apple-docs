import { join } from 'node:path'
import { parseGuidelinesHtml, ROOT_SLUG } from '../apple/guidelines-parser.js'
import { sha256 } from '../lib/hash.js'
import { readJSON, readText, stableStringify } from '../storage/files.js'
import { normalize } from './normalize.js'

/**
 * Rebuild normalized sections/relationships from stored raw payloads for legacy
 * corpora that were migrated before section backfill was added.
 */
export async function ensureNormalizedDocument(db, dataDir, key, sourceType = 'apple-docc') {
  const existingSections = db.getDocumentSections(key)
  if (existingSections.length > 0) return true

  if (sourceType === 'guidelines') {
    return hydrateGuidelines(db, dataDir, key)
  }

  const rawJson = await readJSON(join(dataDir, 'raw-json', `${key}.json`))
  if (!rawJson) return false

  const normalized = normalize(rawJson, key, sourceType)
  db.upsertNormalizedDocument(normalized, {
    contentHash: sha256(stableStringify(normalized)),
    rawPayloadHash: sha256(stableStringify(rawJson)),
  })

  return db.getDocumentSections(key).length > 0
}

async function hydrateGuidelines(db, dataDir, key) {
  const html = await readText(join(dataDir, 'raw-json', `${ROOT_SLUG}.html`))
  if (!html) return false

  const parsed = await parseGuidelinesHtml(html)
  const rawPayloadHash = sha256(html)

  for (const section of parsed.sections) {
    const normalized = normalize(section, section.path, 'guidelines')
    db.upsertNormalizedDocument(normalized, {
      contentHash: sha256(stableStringify(normalized)),
      rawPayloadHash,
    })
  }

  return db.getDocumentSections(key).length > 0
}
