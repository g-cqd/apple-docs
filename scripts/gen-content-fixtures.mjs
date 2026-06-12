/**
 * Generate test/fixtures/content-parity/fixtures.json — committed byte
 * goldens for the content renderers (RFC 0004 phases 1-2).
 *
 * The goldens are produced by the JS implementation (normative until the
 * phase-5 kill); the parity test then pins BOTH implementations to these
 * bytes, so an unintended change on either side alarms.
 *
 * Sampling: per source_type, the lowest-id documents preferring ones with
 * ≥ 3 sections (doc-markdown + plaintext legs), plus up to 3 raw-json
 * pages ≤ 100 KB (page-markdown leg). Deterministic for a given corpus.
 *
 * Requires a populated $APPLE_DOCS_HOME (dev machine).
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from '../src/content/render-markdown.js'
import { renderPlainText } from '../src/content/render-text.js'
import { renderPage } from '../src/apple/renderer.js'
import { keyPath } from '../src/lib/safe-path.js'
import { readJSON } from '../src/storage/files.js'
import { DocsDatabase } from '../src/storage/database.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'test', 'fixtures', 'content-parity')
const DOCS_PER_TYPE = 8
const PAGES_PER_TYPE = 3
const MAX_RAW_BYTES = 100 * 1024

const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const db = new DocsDatabase(join(home, 'apple-docs.db'))

const sourceTypes = db.db
  .query('SELECT DISTINCT source_type FROM documents ORDER BY source_type')
  .all()
  .map((row) => row.source_type)

const docCases = []
const pageCases = []

for (const sourceType of sourceTypes) {
  // Prefer docs with sections (the interesting renders), lowest ids first.
  const rows = db.db
    .query(`
      SELECT d.id, d.key, d.title, d.framework, d.role, d.role_heading, d.platforms_json,
             d.abstract_text, d.declaration_text, d.headings,
             (SELECT COUNT(*) FROM document_sections s WHERE s.document_id = d.id) AS section_count
      FROM documents d
      WHERE d.source_type = ?
      ORDER BY (section_count >= 3) DESC, d.id
      LIMIT ?
    `)
    .all(sourceType, DOCS_PER_TYPE)

  for (const row of rows) {
    const document = {
      key: row.key,
      title: row.title,
      framework: row.framework,
      role: row.role,
      role_heading: row.role_heading,
      platforms_json: row.platforms_json,
    }
    const sections = db.getDocumentSections(row.key)
    const plainDocument = {
      title: row.title,
      abstract_text: row.abstract_text,
      declaration_text: row.declaration_text,
      headings: row.headings,
    }
    docCases.push({
      name: `${sourceType}:${row.key}`,
      document,
      sections,
      plainDocument,
      markdown: renderMarkdown(document, sections),
      markdownBare: renderMarkdown(document, sections, { includeFrontMatter: false, includeTitle: false }),
      plaintext: renderPlainText(plainDocument, sections),
    })
  }

  // Page leg: raw-json files for this type's sampled keys, small ones only.
  let taken = 0
  for (const row of rows) {
    if (taken >= PAGES_PER_TYPE) break
    const jsonPath = keyPath(home, 'raw-json', row.key, '.json')
    if (!existsSync(jsonPath)) continue
    if (statSync(jsonPath).size > MAX_RAW_BYTES) continue
    const json = await readJSON(jsonPath)
    if (!json) continue
    pageCases.push({
      name: `${sourceType}:${row.key}`,
      path: row.key,
      rawJson: JSON.stringify(json),
      markdown: renderPage(json, row.key),
    })
    taken++
  }
}

const meta = {
  reference: 'js (src/content + src/apple/renderer.js — normative until the RFC 0004 phase-5 kill)',
  snapshotVersion: db.getSnapshotMeta('snapshot_version') ?? null,
  documentCount: db.db.query('SELECT COUNT(*) AS c FROM documents').get().c,
  sourceTypes,
  docCaseCount: docCases.length,
  pageCaseCount: pageCases.length,
}
db.close?.()

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'fixtures.json'), JSON.stringify({ meta, docCases, pageCases }, null, 1))
console.log(`wrote ${OUT_DIR}/fixtures.json`)
console.log(`  docCases: ${docCases.length} across ${sourceTypes.length} source types`)
console.log(`  pageCases: ${pageCases.length}`)
