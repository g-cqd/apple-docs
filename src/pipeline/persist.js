import { join } from 'node:path'
import { extractReferences } from '../apple/extractor.js'
import { renderPage } from '../apple/renderer.js'
import { normalize } from '../content/normalize.js'
import { renderMarkdown } from '../content/render-markdown.js'
import { sha256 } from '../lib/hash.js'
import { stableStringify, writeJSON, writeText } from '../storage/files.js'

/**
 * Persist a fetched DocC JSON payload into raw storage, legacy page rows,
 * and the normalized document model.
 */
export async function persistFetchedDocPage({
  db,
  dataDir,
  rootId,
  path,
  sourceType = 'apple-docc',
  json,
  etag = null,
  lastModified = null,
}) {
  const jsonStr = await writeJSON(join(dataDir, 'raw-json', `${path}.json`), json)
  const rawPayloadHash = sha256(jsonStr)
  const normalized = normalize(json, path, sourceType)
  const normalizedHash = sha256(stableStringify(normalized))
  const doc = normalized.document
  const downloadedAt = new Date().toISOString()

  const page = upsertPageFromDocument(db, rootId, path, doc, {
    etag,
    lastModified,
    rawPayloadHash,
    downloadedAt,
    defaultUrl: defaultDoccUrl(path),
  })

  db.upsertNormalizedDocument(normalized, {
    contentHash: normalizedHash,
    rawPayloadHash,
  })

  const markdown = renderPage(json, path)
  await writeText(join(dataDir, 'markdown', `${path}.md`), markdown)
  db.markConverted(path)

  return {
    page,
    normalized,
    rawPayloadHash,
    normalizedHash,
    references: extractReferences(json),
  }
}

/**
 * Persist a pre-normalized document from any adapter (flat sync mode).
 * Unlike persistFetchedDocPage, this accepts already-normalized data
 * and uses the generic renderMarkdown instead of DocC-specific renderPage.
 */
export async function persistNormalizedPage({
  db,
  dataDir,
  rootId,
  path,
  sourceType,
  rawPayload,
  normalized,
  etag = null,
  lastModified = null,
}) {
  // Always store as valid JSON so downstream tools (minify, readJSON) work uniformly.
  // String payloads (Markdown, HTML) from flat sources are wrapped in a JSON envelope.
  const isStringPayload = typeof rawPayload === 'string'
  const rawObj = isStringPayload ? { _raw: rawPayload, _format: 'text' } : rawPayload
  const rawStr = stableStringify(rawObj)
  await writeJSON(join(dataDir, 'raw-json', `${path}.json`), rawObj)
  const rawPayloadHash = sha256(rawStr)
  const normalizedHash = sha256(stableStringify(normalized))
  const doc = normalized.document
  const downloadedAt = new Date().toISOString()

  const page = upsertPageFromDocument(db, rootId, path, doc, {
    etag,
    lastModified,
    rawPayloadHash,
    downloadedAt,
    sourceTypeFallback: sourceType,
  })

  db.upsertNormalizedDocument(normalized, {
    contentHash: normalizedHash,
    rawPayloadHash,
  })

  const markdown = renderMarkdown(doc, normalized.sections)
  await writeText(join(dataDir, 'markdown', `${path}.md`), markdown)
  db.markConverted(path)

  return { page, normalized, rawPayloadHash, normalizedHash }
}

function upsertPageFromDocument(db, rootId, path, doc, meta) {
  return db.upsertPage({
    rootId,
    path,
    url: doc.url ?? meta.defaultUrl ?? null,
    title: doc.title,
    role: doc.role,
    roleHeading: doc.roleHeading,
    abstract: doc.abstractText,
    platforms: doc.platformsJson,
    declaration: doc.declarationText,
    etag: meta.etag,
    lastModified: meta.lastModified,
    contentHash: meta.rawPayloadHash,
    downloadedAt: meta.downloadedAt,
    sourceType: doc.sourceType ?? meta.sourceTypeFallback ?? null,
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
}

function defaultDoccUrl(path) {
  if (path.startsWith('design/')) {
    return `https://developer.apple.com/${path}`
  }
  return `https://developer.apple.com/documentation/${path}`
}
