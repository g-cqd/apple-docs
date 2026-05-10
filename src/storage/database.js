import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fuzzyMatchTitles } from '../lib/fuzzy.js'
import { runMigrations } from './migrations/index.js'
import { applyPragmas, enableForeignKeys } from './pragmas.js'
import { createAssetsFontsRepo } from './repos/assets-fonts.js'
import { createAssetsSymbolsRepo } from './repos/assets-symbols.js'
import { createCrawlRepo } from './repos/crawl.js'
import { createDocumentsRepo } from './repos/documents.js'
import { createOperationsRepo } from './repos/operations.js'
import { createPagesRepo } from './repos/pages.js'
import { createRootsRepo } from './repos/roots.js'
import { createSearchRepo } from './repos/search.js'
function deriveFrameworkFromPath(path) {
  if (!path) return null
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'documentation') return parts[1] ?? null
  return parts[0] ?? null
}


export class DocsDatabase {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }

    this.dbPath = dbPath
    this.db = new Database(dbPath)
    this._effectiveMmapSize = applyPragmas(this.db)
    this._migrate()
    this._prepareStatements()
    this.operations = createOperationsRepo(this.db)
    this.crawl = createCrawlRepo(this.db)
    this.assetsFonts = createAssetsFontsRepo(this.db)
    this.assetsSymbols = createAssetsSymbolsRepo(this.db)
    this.roots = createRootsRepo(this.db)
    this.pages = createPagesRepo(this.db)
    this.documents = createDocumentsRepo(this.db, { hasSectionsTable: this.hasTable('document_sections') })
    this.search = createSearchRepo(this.db, {
      hasTrigramTable: this.hasTable('documents_trigram'),
      hasBodyFtsTable: this.hasTable('documents_body_fts'),
    })
    enableForeignKeys(this.db)
  }

  getEffectiveMmapSize() {
    return this._effectiveMmapSize ?? 0
  }

  _migrate() {
    runMigrations(this.db)
  }

  /**
   * Check if a table exists in the database.
   * @param {string} name
   * @returns {boolean}
   */
  hasTable(name) {
    return !!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  }

  /**
   * Run a synchronous unit of work inside a transaction.
   * Rolls back on error and returns the callback result on success.
   * @template T
   * @param {(db: DocsDatabase) => T} fn
   * @returns {T}
   */
  tx(fn) {
    this.db.run('BEGIN IMMEDIATE')
    try {
      const result = fn(this)
      if (result && typeof result.then === 'function') {
        throw new Error('DocsDatabase.tx() callback must be synchronous')
      }
      this.db.run('COMMIT')
      return result
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  /**
   * Return the snapshot tier label, or null for non-snapshot databases.
   * Lite/standard tiers were removed (G.1); the canonical value is
   * 'full'. Older snapshots whose snapshot_meta still contains 'lite'
   * or 'standard' will return that legacy value verbatim — runtime
   * capability checks (`hasTable('document_sections')`,
   * `hasTrigramTable`, etc.) decide what features are actually
   * available, the label is only metadata.
   * @returns {string|null}
   */
  getTier() {
    if (this._tier !== undefined) return this._tier
    try {
      const row = this.db.query("SELECT value FROM snapshot_meta WHERE key='snapshot_tier'").get()
      if (row) { this._tier = row.value; return this._tier }
    } catch {}
    this._tier = this.hasTable('documents') ? 'full' : null
    return this._tier
  }

  /**
   * Ensure the document_sections table exists (e.g. for lite snapshots where it was dropped).
   * Creates the table and re-prepares the affected statements.
   */
  ensureSectionsTable() {
    if (this.hasTable('document_sections')) return
    this.db.run(`CREATE TABLE IF NOT EXISTS document_sections (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      section_kind  TEXT NOT NULL,
      heading       TEXT,
      content_text  TEXT NOT NULL,
      content_json  TEXT,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(document_id, section_kind, sort_order)
    )`)
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sections_doc ON document_sections(document_id)')
    this.db.run('CREATE INDEX IF NOT EXISTS idx_sections_kind ON document_sections(section_kind)')
    // Rebuild the documents repo so its section-related prepared statements
    // pick up the freshly-created table.
    this.documents = createDocumentsRepo(this.db, { hasSectionsTable: true })
  }

  _prepareStatements() {
    // All prepared statements now live on dedicated repos. The method
    // remains as a hook for tier-conditional setup (currently none).
  }

  upsertRoot(slug, displayName, kind, source, seedPath = null, sourceType = null) {
    return this.roots.upsertRoot(slug, displayName, kind, source, seedPath, sourceType)
  }

  upsertPage(params) {
    const root = params.rootId ? this.roots.getRootById(params.rootId) : null
    const sourceType = params.sourceType ?? root?.source_type ?? 'apple-docc'
    const urlDepth = params.urlDepth ?? Math.max(0, (params.path?.split('/').length ?? 1) - 1)

    const page = this.pages.upsertPageRow({ ...params, sourceType, urlDepth })

    if (params.skipDocumentSync !== true) {
      this.documents.upsertDocument({
        sourceType,
        key: params.path,
        title: params.title ?? params.path,
        kind: params.docKind ?? params.role ?? null,
        role: params.role ?? null,
        roleHeading: params.roleHeading ?? null,
        framework: root?.slug ?? params.framework ?? deriveFrameworkFromPath(params.path),
        url: params.url ?? null,
        language: params.language ?? null,
        abstractText: params.abstract ?? null,
        declarationText: params.declaration ?? null,
        headings: params.headings ?? null,
        platformsJson: params.platforms,
        minIos: params.minIos ?? null,
        minMacos: params.minMacos ?? null,
        minWatchos: params.minWatchos ?? null,
        minTvos: params.minTvos ?? null,
        minVisionos: params.minVisionos ?? null,
        isDeprecated: params.isDeprecated ?? false,
        isBeta: params.isBeta ?? false,
        isReleaseNotes: params.isReleaseNotes ?? false,
        urlDepth,
        sourceMetadata: params.sourceMetadata ?? null,
        contentHash: params.contentHash ?? null,
        rawPayloadHash: params.contentHash ?? null,
      })
    }

    return page
  }

  upsertDocument(params) { return this.documents.upsertDocument(params) }
  replaceDocumentSections(documentId, sections) { this.documents.replaceSections(documentId, sections) }
  replaceDocumentRelationships(fromKey, relationships) { this.documents.replaceRelationships(fromKey, relationships) }

  upsertNormalizedDocument(normalized, hashes = {}) {
    const documentId = this.documents.upsertDocument({
      ...normalized.document,
      contentHash: hashes.contentHash ?? null,
      rawPayloadHash: hashes.rawPayloadHash ?? null,
    }).id
    this.documents.replaceSections(documentId, normalized.sections)
    this.documents.replaceRelationships(normalized.document.key, normalized.relationships)
    return documentId
  }

  /** Backwards-compat shape: documents-row first (with the legacy field
   *  aliases callers still expect), falling back to the pages row when no
   *  document has been normalized yet. */
  getPage(path) {
    const document = this.documents.getDocumentByKey(path)
    if (document) {
      return {
        ...document,
        path: document.key,
        framework: document.framework_display,
        abstract: document.abstract_text,
        declaration: document.declaration_text,
        platforms: document.platforms_json,
        downloaded_at: null,
        converted_at: null,
      }
    }
    return this.pages.getActivePage(path)
  }

  getPageByPath(path) { return this.pages.getActivePage(path) }
  getActivePathsIn(keys) { return this.pages.getActivePathsIn(keys) }
  getDocumentSections(key) { return this.documents.getSections(key) }
  getDocumentRelationships(key) { return this.documents.getRelationships(key) }
  getPagesByRoot(rootSlug) { return this.documents.getDocumentsByRoot(rootSlug) }

  searchPages(ftsQuery, rawQuery, opts = {}) { return this.search.searchPages(ftsQuery, rawQuery, opts) }
  searchTitleExact(rawQuery, opts = {}) { return this.search.searchTitleExact(rawQuery, opts) }
  searchTrigram(query, opts = {}) { return this.search.searchTrigram(query, opts) }
  searchBody(ftsQuery, opts = {}) { return this.search.searchBody(ftsQuery, opts) }
  getFrameworkSynonyms(slug) { return this.search.getFrameworkSynonyms(slug) }

  getDocumentSnippetData(keys) { return this.documents.getDocumentSnippetData(keys) }
  getRelatedDocCounts(keys) { return this.documents.getRelatedDocCounts(keys) }

  getBodyIndexCount() { return this.search.getBodyIndexCount() }
  insertBody(documentId, body) { this.search.insertBody(documentId, body) }
  clearBodyIndex() { this.search.clearBodyIndex() }
  getTrigramCandidates(trigram) { return this.search.getTrigramCandidates(trigram) }
  fuzzyTrigramCandidates(orQuery, limit) { return this.search.fuzzyTrigramCandidates(orQuery, limit) }
  getAllTitlesForFuzzy() { return this.search.getAllTitles() }

  /**
   * Thin wrapper so the reader-pool can route fuzzy matching through a worker
   * by op name. Keeps the trigram/Levenshtein routine identical — only the
   * call surface changes. Off the main thread, this lets a long fuzzy scan
   * run in parallel with other search tiers rather than blocking the event
   * loop.
   *
   * Since P3.2 the underlying fuzzy implementation queries the live
   * `documents_trigram` FTS5 index per call rather than building a
   * process-local Map. No warm-up cost, no staleness hazard, no
   * multi-hundred-MB per-worker memory footprint.
   */
  fuzzyMatchTitles(query, opts = {}) {
    return fuzzyMatchTitles(query, this, opts)
  }

  searchByTitle(title, framework = null) { return this.search.searchByTitle(title, framework) }
  getSearchRecordById(id) { return this.search.getSearchRecordById(id) }

  getRoots(kind = null) { return this.roots.getRoots(kind) }
  getRootBySlug(slug) { return this.roots.getRootBySlug(slug) }
  resolveRoot(input) { return this.roots.resolveRoot(input) }

  setCrawlState(path, status, rootSlug, depth = 0, error = null) {
    this.crawl.setCrawlState(path, status, rootSlug, depth, error)
  }
  seedCrawlIfNew(path, rootSlug, depth = 0) { return this.crawl.seedCrawlIfNew(path, rootSlug, depth) }
  getPendingCrawl(rootSlug, limit = 10) { return this.crawl.getPendingCrawl(rootSlug, limit) }
  resetFailedCrawl(rootSlug) { return this.crawl.resetFailedCrawl(rootSlug) }
  countFailed(rootSlug) { return this.crawl.countFailed(rootSlug) }
  getCrawlStats(rootSlug) { return this.crawl.getCrawlStats(rootSlug) }
  clearCrawlState(rootSlug) { this.crawl.clearCrawlState(rootSlug) }

  addUpdateLog(params) { this.operations.addUpdateLog(params) }
  getLastUpdateLog() { return this.operations.getLastUpdateLog() }

  markConverted(path) { this.pages.markConverted(path) }
  getUnconvertedPages() { return this.pages.getUnconvertedPages() }
  updateRootPageCount(slug) { this.roots.updateRootPageCount(slug) }
  getAllPagesWithEtag() { return this.pages.getAllPagesWithEtag() }
  getPagesBySourceType(sourceType) { return this.pages.getPagesBySourceType(sourceType) }
  getPagesByRole(role) { return this.documents.getDocumentsByRole(role) }

  markPageDeleted(path) {
    this.pages.markPageDeleted(path)
    this.deleteNormalizedDocument(path)
  }

  bumpConsecutive404(path) { return this.pages.bumpConsecutive404(path) }
  resetConsecutive404(path) { this.pages.resetConsecutive404(path) }

  deleteNormalizedDocument(key) {
    const document = this.documents.getDocumentIdByKey(key)
    if (!document) return false
    this.search.deleteBodyByDocId(document.id)
    this.documents.deleteSectionsByDocId(document.id)
    this.documents.deleteDocumentByKey(key)
    return true
  }

  updatePageAfterDownload(path, etag, lastModified, contentHash) {
    this.pages.updatePageAfterDownload(path, etag, lastModified, contentHash)
  }

  setActivity(action, roots = null) { this.operations.setActivity(action, roots) }
  clearActivity() { this.operations.clearActivity() }
  getActivity() { return this.operations.getActivity() }

  getCrawlProgressByRoot() { return this.crawl.getCrawlProgressByRoot() }
  getCrawlProgressAll() { return this.crawl.getCrawlProgressAll() }

  getSnapshotMeta(key) { return this.operations.getSnapshotMeta(key) }
  setSnapshotMeta(key, value) {
    this.operations.setSnapshotMeta(key, value)
    // Tier cache lives on the facade; invalidate when the underlying tier
    // row changes so getTier() recomputes against the new value.
    if (key === 'snapshot_tier') this._tier = undefined
  }

  getSyncCheckpoint(key) { return this.operations.getSyncCheckpoint(key) }
  setSyncCheckpoint(key, value) { this.operations.setSyncCheckpoint(key, value) }
  clearSyncCheckpoint(key) { this.operations.clearSyncCheckpoint(key) }

  /**
   * Singleton checkpoint for the static web build, stored in sync_checkpoint
   * under the key 'web_build'. Holds the run id, last persisted doc id,
   * counts (built/skipped/failed), and the resolved output directory so a
   * killed build can resume against the same target.
   * @returns {object|null}
   */
  getWebBuildCheckpoint() {
    return this.getSyncCheckpoint('web_build')
  }

  setWebBuildCheckpoint(state) {
    this.setSyncCheckpoint('web_build', state)
  }

  clearWebBuildCheckpoint() {
    this.clearSyncCheckpoint('web_build')
  }

  /**
   * Per-document render fingerprint used by the incremental build to skip
   * documents whose inputs (sections_digest) and template surface
   * (template_version) match the last successful render.
   * @param {number} docId
   * @returns {{ doc_id: number, sections_digest: string, template_version: string, html_hash: string, updated_at: number }|null}
   */
  getRenderIndexEntry(docId) { return this.operations.getRenderIndexEntry(docId) }
  upsertRenderIndexEntry(entry) { this.operations.upsertRenderIndexEntry(entry) }
  clearRenderIndex() { this.operations.clearRenderIndex() }

  /**
   * Return parent->child edges for a framework's document tree.
   * Each row has { from_key, to_key }.
   * @param {string} framework - The framework slug (e.g. 'documentation/swiftui')
   * @returns {Array<{from_key: string, to_key: string}>}
   */
  getFrameworkTree(framework) {
    return this.documents.getFrameworkTree(framework, {
      hasRelationshipsTable: this.hasTable('document_relationships'),
    })
  }

  upsertAppleFontFamily(params) { this.assetsFonts.upsertFontFamily(params) }
  upsertAppleFontFile(params) { this.assetsFonts.upsertFontFile(params) }
  listAppleFonts() { return this.assetsFonts.listFonts() }
  getAppleFontFile(id) { return this.assetsFonts.getFontFile(id) }

  upsertSfSymbol(params) { this.assetsSymbols.upsertSymbol(params) }
  getSfSymbol(scope, name) { return this.assetsSymbols.getSymbol(scope, name) }
  listSfSymbolsCatalog() { return this.assetsSymbols.listCatalog() }
  markSfSymbolBitmapOnly(scope, name) { this.assetsSymbols.markBitmapOnly(scope, name) }
  searchSfSymbols(query = '', opts = {}) { return this.assetsSymbols.searchSymbols(query, opts) }
  upsertSfSymbolRender(params) { this.assetsSymbols.upsertRender(params) }
  getSfSymbolRender(cacheKey) { return this.assetsSymbols.getRender(cacheKey) }
  sfSymbolRenderCacheStats() { return this.assetsSymbols.renderCacheStats() }
  pruneSfSymbolRendersOlderThan(cutoffIso) { return this.assetsSymbols.pruneRendersOlderThan(cutoffIso) }
  pruneSfSymbolRendersToBytesQuota(maxBytes) { return this.assetsSymbols.pruneRendersToBytesQuota(maxBytes) }

  getSchemaVersion() {
    const row = this.db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    return row ? Number.parseInt(row.value, 10) : 0
  }

  getStats() {
    const totalPages = this.db.query("SELECT COUNT(*) as count FROM pages WHERE status = 'active'").get().count
    const totalDeleted = this.db.query("SELECT COUNT(*) as count FROM pages WHERE status = 'deleted'").get().count
    const totalRoots = this.db.query('SELECT COUNT(*) as count FROM roots').get().count
    const rootsByKind = this.db.query('SELECT kind, COUNT(*) as count FROM roots GROUP BY kind').all()
    const lastLog = this.getLastUpdateLog()
    const activity = this.getActivity()
    const crawlProgress = this.getCrawlProgressAll()
    const crawlByRoot = this.getCrawlProgressByRoot()
    return { totalPages, totalDeleted, totalRoots, rootsByKind, lastLog, activity, crawlProgress, crawlByRoot }
  }

  close() {
    this.db.close()
  }
}

