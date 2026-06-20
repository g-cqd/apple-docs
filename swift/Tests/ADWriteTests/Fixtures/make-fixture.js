#!/usr/bin/env bun
// make-fixture.js — deterministic fixture generator for the native crawl-persist
// PARITY gate. Produces, from a handful of REAL apple-docs documents in the test
// corpus, the TWO inputs the gate compares:
//
//   (a) <out>/normalized.json — an array of the EXACT JS `normalize()` output
//       objects ({ document, sections, relationships }) plus the persist meta
//       (root args, path, sourceType, contentHash, rawPayloadHash). This is the
//       NATIVE writer's input (decoded into ADWrite.NormalizedDoc).
//
//   (b) <out>/reference.sqlite — a FRESH SQLite DB written by the JS writer
//       (`new DocsDatabase` → `upsertRoot` + the SAME `db.tx` body persist.js
//       runs: upsertPage{skipDocumentSync} + upsertNormalizedDocument +
//       markConverted) over those same normalized objects. This is the REFERENCE
//       the ADDB importer ingests for the swap-gate comparison.
//
// Why reconstruct from the normalized corpus rows (not re-run normalize on raw
// payloads): the corpus `document_raw` table is empty (payloads not retained), so
// the canonical normalized rows (documents + document_sections +
// document_relationships) ARE the `normalize()` output of record. We read them
// back, inflating the zstd-compacted section content via the storage codec, and
// rebuild the camelCase `normalize()` object shape verbatim. Deterministic: fixed
// keys, fixed ordering, no clocks in the compared columns.
//
// Usage:  bun make-fixture.js <corpus.db> <outDir>

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { decodeSectionContent } from '../../../../src/storage/section-codec.js'
import { DocsDatabase } from '../../../../src/storage/database.js'

const corpusPath = process.argv[2]
const outDir = process.argv[3]
if (!corpusPath || !outDir) {
  console.error('usage: bun make-fixture.js <corpus.db> <outDir>')
  process.exit(2)
}

// The deterministic, diverse fixture key set (module / class-with-many-rels /
// release-notes article / enum / function). Each has BOTH a documents row and a
// pages row in the corpus, varied kinds/roles, and non-trivial sections +
// relationships — so the gate exercises every persisted table.
const FIXTURE_KEYS = [
  'accelerate', // module / collection, 91 relationships
  'kernel/applemacio', // class symbol, 14 relationships
  'applepayontheweb/apple-pay-on-the-web-version-1-release-notes', // release-notes article
  'accelerate/acceleratematrixorder', // enum symbol
  'accelerate/blasgetthreading()', // function symbol
]

const corpus = new Database(corpusPath, { readonly: true })

/** Rebuild the camelCase `normalize()` document object from a corpus documents row. */
function reconstructDocument(row) {
  // Mirror normalize/docc.js field set EXACTLY (the keys upsertDocument reads).
  // Booleans are stored 0/1 in SQLite → JS booleans; null stays null.
  return {
    sourceType: row.source_type,
    key: row.key,
    title: row.title,
    kind: row.kind,
    role: row.role,
    roleHeading: row.role_heading,
    framework: row.framework,
    url: row.url,
    language: row.language,
    abstractText: row.abstract_text,
    declarationText: row.declaration_text,
    platformsJson: row.platforms_json,
    minIos: row.min_ios,
    minMacos: row.min_macos,
    minWatchos: row.min_watchos,
    minTvos: row.min_tvos,
    minVisionos: row.min_visionos,
    isDeprecated: row.is_deprecated === 1,
    isBeta: row.is_beta === 1,
    isReleaseNotes: row.is_release_notes === 1,
    urlDepth: row.url_depth,
    headings: row.headings,
    sourceMetadata: row.source_metadata, // normalize emits null; corpus keeps it
  }
}

/** Rebuild the sections array (decoding zstd-compacted content) for a doc id. */
function reconstructSections(docId) {
  const rows = corpus
    .query(
      `SELECT section_kind, heading, content_text, content_json, sort_order
       FROM document_sections WHERE document_id = ? ORDER BY sort_order, id`,
    )
    .all(docId)
  return rows.map((s) => {
    const text = decodeSectionContent(s.content_text)
    const json = decodeSectionContent(s.content_json)
    return {
      sectionKind: s.section_kind,
      heading: s.heading,
      // normalize emits contentText possibly null; the persist stores '' for null.
      // Preserve the decoded value (a real string here) as the normalize() shape.
      contentText: text === '' ? '' : (text ?? null),
      contentJson: json ?? null,
      sortOrder: s.sort_order,
    }
  })
}

/** Rebuild the relationships array for a from_key. */
function reconstructRelationships(fromKey) {
  const rows = corpus
    .query(
      `SELECT from_key, to_key, relation_type, section, sort_order
       FROM document_relationships WHERE from_key = ? ORDER BY sort_order, id`,
    )
    .all(fromKey)
  return rows.map((r) => ({
    fromKey: r.from_key,
    toKey: r.to_key,
    relationType: r.relation_type,
    section: r.section,
    sortOrder: r.sort_order,
  }))
}

/** The owning root for a path (via the pages → roots join in the corpus). */
function rootForPath(path) {
  return corpus
    .query(
      `SELECT r.slug, r.display_name, r.kind, r.source, r.source_type
       FROM pages p JOIN roots r ON p.root_id = r.id WHERE p.path = ?`,
    )
    .get(path)
}

// ── Assemble the fixture records ───────────────────────────────────────────────
const records = []
for (const key of FIXTURE_KEYS) {
  const docRow = corpus.query('SELECT * FROM documents WHERE key = ?').get(key)
  if (!docRow) throw new Error(`fixture key not found in corpus: ${key}`)
  const root = rootForPath(key)
  if (!root) throw new Error(`no pages/roots row for fixture key: ${key}`)

  const normalized = {
    document: reconstructDocument(docRow),
    sections: reconstructSections(docRow.id),
    relationships: reconstructRelationships(key),
  }

  records.push({
    // Root upsert args (roots.js upsertRoot signature: slug, displayName, kind,
    // source, seedPath, sourceType).
    root: {
      slug: root.slug,
      displayName: root.display_name,
      kind: root.kind,
      source: root.source,
      seedPath: null,
      sourceType: root.source_type,
    },
    path: key,
    sourceType: docRow.source_type,
    // Hashes flow into pages.content_hash + documents.content_hash/raw_payload_hash.
    // Reuse the corpus's stored hashes so they are realistic + stable.
    contentHash: docRow.content_hash ?? 'deadbeef',
    rawPayloadHash: docRow.raw_payload_hash ?? 'cafebabe',
    normalized,
  })
}

// ── (a) Emit the native input JSON ────────────────────────────────────────────
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
const normalizedJsonPath = `${outDir}/normalized.json`
writeFileSync(normalizedJsonPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')

// ── (b) Build the reference SQLite via the REAL JS writer ──────────────────────
const referencePath = `${outDir}/reference.sqlite`
for (const suffix of ['', '-wal', '-shm']) {
  const p = referencePath + suffix
  if (existsSync(p)) rmSync(p)
}

const refDb = new DocsDatabase(referencePath)
try {
  for (const rec of records) {
    // 1. Upsert the root (persist.js callers do this before persisting pages).
    const rootRow = refDb.upsertRoot(
      rec.root.slug,
      rec.root.displayName,
      rec.root.kind,
      rec.root.source,
      rec.root.seedPath,
      rec.root.sourceType,
    )
    const rootId = rootRow.id

    // 2. The EXACT persist.js `db.tx` body for the normalized (flat) path.
    refDb.tx(() => {
      const doc = rec.normalized.document
      // upsertPageFromDocument → db.upsertPage({ …, skipDocumentSync: true }).
      refDb.upsertPage({
        rootId,
        path: rec.path,
        url: doc.url ?? null,
        title: doc.title,
        role: doc.role,
        roleHeading: doc.roleHeading,
        abstract: doc.abstractText,
        platforms: doc.platformsJson,
        declaration: doc.declarationText,
        etag: null,
        lastModified: null,
        contentHash: rec.rawPayloadHash, // meta.rawPayloadHash (persist.js)
        downloadedAt: new Date().toISOString(),
        sourceType: doc.sourceType ?? rec.sourceType ?? null,
        language: doc.language,
        isReleaseNotes: doc.isReleaseNotes,
        urlDepth: doc.urlDepth,
        docKind: doc.kind,
        sourceMetadata: doc.sourceMetadata,
        minIos: doc.minIos,
        minMacos: doc.minMacos,
        minWatchos: doc.minWatchos,
        minTvos: doc.minTvos,
        minVisionos: doc.minVisionos,
        skipDocumentSync: true,
      })

      refDb.upsertNormalizedDocument(rec.normalized, {
        contentHash: rec.contentHash,
        rawPayloadHash: rec.rawPayloadHash,
      })

      refDb.markConverted(rec.path)
    })
  }
} finally {
  refDb.close()
}

console.error(
  `make-fixture: wrote ${records.length} records → ${normalizedJsonPath} + ${referencePath}`,
)
