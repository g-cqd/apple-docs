import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fuzzyMatchTitles } from '../lib/fuzzy.js'
import { runMigrations } from './migrations/index.js'
import { applyPragmas, enableForeignKeys } from './pragmas.js'
import { createAssetsFontsRepo } from './repos/assets-fonts.js'
import { createAssetsSymbolsRepo } from './repos/assets-symbols.js'
import { createCrawlRepo } from './repos/crawl.js'
import { createOperationsRepo } from './repos/operations.js'
import { createRefsRepo } from './repos/refs.js'
import { createRootsRepo } from './repos/roots.js'
function serializePlatforms(value) {
  if (value == null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

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
    this.refs = createRefsRepo(this.db)
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
   * Return the snapshot tier (lite/standard/full) or null for non-snapshot databases.
   * Reads from snapshot_meta, falls back to capability probing.
   * @returns {string|null}
   */
  getTier() {
    if (this._tier !== undefined) return this._tier
    try {
      const row = this.db.query("SELECT value FROM snapshot_meta WHERE key='snapshot_tier'").get()
      if (row) { this._tier = row.value; return this._tier }
    } catch {}
    // Capability probing fallback: lite tier drops document_sections entirely
    if (this.hasTable('document_sections')) {
      this._tier = 'standard'
    } else if (this.hasTable('documents')) {
      this._tier = 'lite'
    } else {
      this._tier = null
    }
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
    this._deleteDocumentSections = this.db.query('DELETE FROM document_sections WHERE document_id = ?')
    this._insertDocumentSection = this.db.query(`
      INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
      VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
      ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
        heading = $heading,
        content_text = $content_text,
        content_json = $content_json
    `)
  }

  _prepareStatements() {
    // Detect available tier-optional tables once
    const hasSections = this.hasTable('document_sections')
    const hasTrigram = this.hasTable('documents_trigram')
    const hasBodyFts = this.hasTable('documents_body_fts')

    this._upsertPage = this.db.query(`
      INSERT INTO pages (
        root_id, path, url, title, role, role_heading, abstract, platforms, declaration,
        etag, last_modified, content_hash, downloaded_at, status,
        source_type, language, is_release_notes, url_depth, doc_kind, source_metadata,
        min_ios, min_macos, min_watchos, min_tvos, min_visionos
      )
      VALUES (
        $root_id, $path, $url, $title, $role, $role_heading, $abstract, $platforms, $declaration,
        $etag, $last_modified, $content_hash, $downloaded_at, 'active',
        $source_type, $language, $is_release_notes, $url_depth, $doc_kind, $source_metadata,
        $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos
      )
      ON CONFLICT(path) DO UPDATE SET
        title = COALESCE($title, pages.title),
        role = COALESCE($role, pages.role),
        role_heading = COALESCE($role_heading, pages.role_heading),
        abstract = COALESCE($abstract, pages.abstract),
        platforms = COALESCE($platforms, pages.platforms),
        declaration = COALESCE($declaration, pages.declaration),
        etag = COALESCE($etag, pages.etag),
        last_modified = COALESCE($last_modified, pages.last_modified),
        content_hash = COALESCE($content_hash, pages.content_hash),
        downloaded_at = COALESCE($downloaded_at, pages.downloaded_at),
        source_type = COALESCE($source_type, pages.source_type),
        language = COALESCE($language, pages.language),
        is_release_notes = COALESCE($is_release_notes, pages.is_release_notes),
        url_depth = COALESCE($url_depth, pages.url_depth),
        doc_kind = COALESCE($doc_kind, pages.doc_kind),
        source_metadata = COALESCE($source_metadata, pages.source_metadata),
        min_ios = COALESCE($min_ios, pages.min_ios),
        min_macos = COALESCE($min_macos, pages.min_macos),
        min_watchos = COALESCE($min_watchos, pages.min_watchos),
        min_tvos = COALESCE($min_tvos, pages.min_tvos),
        min_visionos = COALESCE($min_visionos, pages.min_visionos),
        status = 'active'
      RETURNING id
    `)

    this._getPage = this.db.query('SELECT p.*, r.slug as root_slug, r.display_name as framework FROM pages p JOIN roots r ON p.root_id = r.id WHERE p.path = ? AND p.status = ?')

    this._getDocumentsByRoot = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract
      FROM documents d
      JOIN pages p ON p.path = d.key
      JOIN roots r ON p.root_id = r.id
      WHERE r.slug = ? AND p.status = 'active'
      ORDER BY d.key
    `)

    this._upsertDocument = this.db.query(`
      INSERT INTO documents (
        source_type, key, title, kind, role, role_heading, framework, url, language,
        abstract_text, declaration_text, headings, platforms_json,
        min_ios, min_macos, min_watchos, min_tvos, min_visionos,
        is_deprecated, is_beta, is_release_notes, url_depth,
        source_metadata, content_hash, raw_payload_hash, created_at, updated_at
      )
      VALUES (
        $source_type, $key, $title, $kind, $role, $role_heading, $framework, $url, $language,
        $abstract_text, $declaration_text, $headings, $platforms_json,
        $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos,
        $is_deprecated, $is_beta, $is_release_notes, $url_depth,
        $source_metadata, $content_hash, $raw_payload_hash, $now, $now
      )
      ON CONFLICT(key) DO UPDATE SET
        source_type = COALESCE($source_type, documents.source_type),
        title = COALESCE($title, documents.title),
        kind = COALESCE($kind, documents.kind),
        role = COALESCE($role, documents.role),
        role_heading = COALESCE($role_heading, documents.role_heading),
        framework = COALESCE($framework, documents.framework),
        url = COALESCE($url, documents.url),
        language = COALESCE($language, documents.language),
        abstract_text = COALESCE($abstract_text, documents.abstract_text),
        declaration_text = COALESCE($declaration_text, documents.declaration_text),
        headings = COALESCE($headings, documents.headings),
        platforms_json = COALESCE($platforms_json, documents.platforms_json),
        min_ios = COALESCE($min_ios, documents.min_ios),
        min_macos = COALESCE($min_macos, documents.min_macos),
        min_watchos = COALESCE($min_watchos, documents.min_watchos),
        min_tvos = COALESCE($min_tvos, documents.min_tvos),
        min_visionos = COALESCE($min_visionos, documents.min_visionos),
        is_deprecated = COALESCE($is_deprecated, documents.is_deprecated),
        is_beta = COALESCE($is_beta, documents.is_beta),
        is_release_notes = COALESCE($is_release_notes, documents.is_release_notes),
        url_depth = COALESCE($url_depth, documents.url_depth),
        source_metadata = COALESCE($source_metadata, documents.source_metadata),
        content_hash = COALESCE($content_hash, documents.content_hash),
        raw_payload_hash = COALESCE($raw_payload_hash, documents.raw_payload_hash),
        updated_at = $now
      RETURNING id
    `)
    this._getDocument = this.db.query(`
      SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework_display
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.key = ?
    `)
    this._getDocumentSections = hasSections ? this.db.query(`
      SELECT section_kind, heading, content_text, content_json, sort_order
      FROM document_sections
      WHERE document_id = ?
      ORDER BY sort_order, id
    `) : null
    this._getDocumentIdByKey = this.db.query('SELECT id FROM documents WHERE key = ?')
    this._getDocumentRelationshipsBySource = this.db.query(`
      SELECT dr.to_key as target_path,
             COALESCE(td.title, dr.to_key) as anchor_text,
             COALESCE(dr.section, dr.relation_type) as section
      FROM document_relationships dr
      LEFT JOIN documents td ON td.key = dr.to_key
      WHERE dr.from_key = ?
      ORDER BY dr.sort_order, dr.to_key
    `)
    this._deleteDocumentSections = hasSections ? this.db.query('DELETE FROM document_sections WHERE document_id = ?') : null
    this._insertDocumentSection = hasSections ? this.db.query(`
      INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
      VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
      ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
        heading = $heading,
        content_text = $content_text,
        content_json = $content_json
    `) : null
    this._deleteDocumentRelationships = this.db.query('DELETE FROM document_relationships WHERE from_key = ?')
    this._deleteDocumentRelationshipsByKey = this.db.query('DELETE FROM document_relationships WHERE from_key = ? OR to_key = ?')
    this._insertDocumentRelationship = this.db.query(`
      INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
      VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
      ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
        section = $section,
        sort_order = $sort_order
    `)
    this._searchDocuments = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
             bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) as rank,
             CASE
               WHEN LOWER(d.title) = LOWER($raw) THEN 0
               WHEN LOWER(d.key) = LOWER($raw) THEN 0
               WHEN LOWER(d.title) LIKE LOWER($raw) || '%' THEN 1
               WHEN INSTR(LOWER(d.title), LOWER($raw)) > 0 THEN 2
               ELSE 3
             END as tier
      FROM documents_fts
      JOIN documents d ON documents_fts.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_fts MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($source_type IS NULL OR d.source_type = $source_type)
        AND (
          $kind IS NULL
          OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
        )
        AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
        AND ($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)
        AND ($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)
        AND ($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)
        AND ($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)
        AND ($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)
      ORDER BY tier, rank
      LIMIT $limit
    `)
    this._searchDocumentsTitleExact = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
             0 as rank,
             0 as tier
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.title = $raw COLLATE NOCASE
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($source_type IS NULL OR d.source_type = $source_type)
        AND (
          $kind IS NULL
          OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
        )
        AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
        AND ($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)
        AND ($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)
        AND ($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)
        AND ($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)
        AND ($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)
      ORDER BY tier, CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
      LIMIT $limit
    `)
    this._searchDocumentsTrigram = hasTrigram ? this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_trigram MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($source_type IS NULL OR d.source_type = $source_type)
        AND (
          $kind IS NULL
          OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
        )
        AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
        AND ($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)
        AND ($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)
        AND ($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)
        AND ($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)
        AND ($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)
      LIMIT $limit
    `) : null
    this._searchDocumentsBody = hasBodyFts ? this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
             bm25(documents_body_fts, 1.0) as rank
      FROM documents_body_fts
      JOIN documents d ON documents_body_fts.rowid = d.id
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE documents_body_fts MATCH $query
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($source_type IS NULL OR d.source_type = $source_type)
        AND (
          $kind IS NULL
          OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
        )
        AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
        AND ($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)
        AND ($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)
        AND ($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)
        AND ($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)
        AND ($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)
      ORDER BY rank
      LIMIT $limit
    `) : null
    this._documentsBodyIndexCount = hasBodyFts ? this.db.query('SELECT COUNT(*) as c FROM documents_body_fts') : null
    this._insertDocumentBody = hasBodyFts ? this.db.query('INSERT OR REPLACE INTO documents_body_fts(rowid, body) VALUES ($id, $body)') : null
    this._clearDocumentBody = hasBodyFts ? this.db.query("DELETE FROM documents_body_fts") : null
    this._deleteDocumentBody = hasBodyFts ? this.db.query('DELETE FROM documents_body_fts WHERE rowid = ?') : null
    this._documentTrigramCandidates = hasTrigram ? this.db.query(`
      SELECT d.id, d.title
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      WHERE documents_trigram MATCH $trigram
    `) : null
    this._searchDocumentByTitle = this.db.query(`
      SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.title = $title COLLATE NOCASE
        AND ($framework IS NULL OR d.framework = $framework)
      ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
      LIMIT 1
    `)
    this._getDocumentsByRole = this.db.query(`
      SELECT d.key, d.key as path, d.title, d.role,
             COALESCE(r.slug, d.framework) as root_slug, d.source_type as source_type
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.role = ?
      ORDER BY d.key
    `)
    this._getDocumentSearchRecordById = this.db.query(`
      SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
             d.declaration_text as declaration, d.platforms_json as platforms,
             COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
             d.source_type as source_type, d.source_metadata as source_metadata,
             d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
             d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos
      FROM documents d
      LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.id = ?
    `)
    this._deleteDocumentByKey = this.db.query('DELETE FROM documents WHERE key = ?')
    this._getAllTitlesForFuzzy = this.db.query('SELECT id, title FROM documents WHERE title IS NOT NULL')

    this._getFrameworkSynonyms = this.db.query(`
      SELECT alias FROM framework_synonyms WHERE canonical = ?
      UNION
      SELECT canonical FROM framework_synonyms WHERE alias = ?
    `)


    this._updatePageConverted = this.db.query("UPDATE pages SET converted_at = ? WHERE path = ?")
    this._getUnconvertedPages = this.db.query(`
      SELECT p.path, r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.converted_at IS NULL
        AND p.downloaded_at IS NOT NULL
        AND p.status = 'active'
    `)
    this._getAllPagesWithEtag = this.db.query("SELECT path, etag FROM pages WHERE etag IS NOT NULL AND status = 'active'")
    this._getPagesBySourceType = this.db.query(`
      SELECT p.path, p.root_id, p.etag, p.last_modified, p.content_hash,
             r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
      FROM pages p
      JOIN roots r ON p.root_id = r.id
      WHERE p.status = 'active'
        AND COALESCE(p.source_type, r.source_type) = ?
      ORDER BY p.path
    `)
    this._markPageDeleted = this.db.query("UPDATE pages SET status = 'deleted' WHERE path = ?")
    this._updatePageEtag = this.db.query("UPDATE pages SET etag = $etag, last_modified = $last_modified, content_hash = $content_hash, downloaded_at = $downloaded_at WHERE path = $path")

  }

  upsertRoot(slug, displayName, kind, source, seedPath = null, sourceType = null) {
    return this.roots.upsertRoot(slug, displayName, kind, source, seedPath, sourceType)
  }

  upsertPage(params) {
    const root = params.rootId ? this.roots.getRootById(params.rootId) : null
    const sourceType = params.sourceType ?? root?.source_type ?? 'apple-docc'
    const urlDepth = params.urlDepth ?? Math.max(0, (params.path?.split('/').length ?? 1) - 1)

    const page = this._upsertPage.get({
      $root_id: params.rootId,
      $path: params.path,
      $url: params.url,
      $title: params.title ?? null,
      $role: params.role ?? null,
      $role_heading: params.roleHeading ?? null,
      $abstract: params.abstract ?? null,
      $platforms: serializePlatforms(params.platforms),
      $declaration: params.declaration ?? null,
      $etag: params.etag ?? null,
      $last_modified: params.lastModified ?? null,
      $content_hash: params.contentHash ?? null,
      $downloaded_at: params.downloadedAt ?? null,
      $source_type: sourceType,
      $language: params.language ?? null,
      $is_release_notes: params.isReleaseNotes == null ? 0 : (params.isReleaseNotes ? 1 : 0),
      $url_depth: urlDepth,
      $doc_kind: params.docKind ?? params.role ?? null,
      $source_metadata: params.sourceMetadata == null ? null : (typeof params.sourceMetadata === 'string' ? params.sourceMetadata : JSON.stringify(params.sourceMetadata)),
      $min_ios: params.minIos ?? null,
      $min_macos: params.minMacos ?? null,
      $min_watchos: params.minWatchos ?? null,
      $min_tvos: params.minTvos ?? null,
      $min_visionos: params.minVisionos ?? null,
    })

    if (params.skipDocumentSync !== true) {
      this.upsertDocument({
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
        platformsJson: serializePlatforms(params.platforms),
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

  upsertDocument(params) {
    const now = new Date().toISOString()
    return this._upsertDocument.get({
      $source_type: params.sourceType ?? 'apple-docc',
      $key: params.key,
      $title: params.title ?? params.key,
      $kind: params.kind ?? null,
      $role: params.role ?? null,
      $role_heading: params.roleHeading ?? null,
      $framework: params.framework ?? deriveFrameworkFromPath(params.key),
      $url: params.url ?? null,
      $language: params.language ?? null,
      $abstract_text: params.abstractText ?? null,
      $declaration_text: params.declarationText ?? null,
      $headings: params.headings ?? null,
      $platforms_json: serializePlatforms(params.platformsJson),
      $min_ios: params.minIos ?? null,
      $min_macos: params.minMacos ?? null,
      $min_watchos: params.minWatchos ?? null,
      $min_tvos: params.minTvos ?? null,
      $min_visionos: params.minVisionos ?? null,
      $is_deprecated: params.isDeprecated == null ? null : (params.isDeprecated ? 1 : 0),
      $is_beta: params.isBeta == null ? null : (params.isBeta ? 1 : 0),
      $is_release_notes: params.isReleaseNotes == null ? null : (params.isReleaseNotes ? 1 : 0),
      $url_depth: params.urlDepth ?? null,
      $source_metadata: params.sourceMetadata == null ? null : (typeof params.sourceMetadata === 'string' ? params.sourceMetadata : JSON.stringify(params.sourceMetadata)),
      $content_hash: params.contentHash ?? null,
      $raw_payload_hash: params.rawPayloadHash ?? null,
      $now: now,
    })
  }

  replaceDocumentSections(documentId, sections) {
    if (!this._deleteDocumentSections || !this._insertDocumentSection) return
    this._deleteDocumentSections.run(documentId)
    for (const section of sections ?? []) {
      this._insertDocumentSection.run({
        $document_id: documentId,
        $section_kind: section.sectionKind ?? section.section_kind,
        $heading: section.heading ?? null,
        $content_text: section.contentText ?? section.content_text ?? '',
        $content_json: section.contentJson ?? section.content_json ?? null,
        $sort_order: section.sortOrder ?? section.sort_order ?? 0,
      })
    }
  }

  replaceDocumentRelationships(fromKey, relationships) {
    this._deleteDocumentRelationships.run(fromKey)
    for (const relationship of relationships ?? []) {
      this._insertDocumentRelationship.run({
        $from_key: relationship.fromKey ?? relationship.from_key ?? fromKey,
        $to_key: relationship.toKey ?? relationship.to_key,
        $relation_type: relationship.relationType ?? relationship.relation_type,
        $section: relationship.section ?? null,
        $sort_order: relationship.sortOrder ?? relationship.sort_order ?? 0,
      })
    }
  }

  upsertNormalizedDocument(normalized, hashes = {}) {
    const documentId = this.upsertDocument({
      ...normalized.document,
      contentHash: hashes.contentHash ?? null,
      rawPayloadHash: hashes.rawPayloadHash ?? null,
    }).id

    this.replaceDocumentSections(documentId, normalized.sections)
    this.replaceDocumentRelationships(normalized.document.key, normalized.relationships)
    return documentId
  }

  getPage(path) {
    const document = this._getDocument.get(path)
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
    return this._getPage.get(path, 'active')
  }

  getPageByPath(path) {
    return this._getPage.get(path, 'active')
  }

  getActivePathsIn(keys) {
    if (!keys || keys.length === 0) return new Set()

    const activePaths = new Set()
    const chunkSize = 900

    for (let index = 0; index < keys.length; index += chunkSize) {
      const chunk = keys.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db.query(`
        SELECT path
        FROM pages
        WHERE status = 'active'
          AND path IN (${placeholders})
      `).all(...chunk)

      for (const row of rows) {
        activePaths.add(row.path)
      }
    }

    return activePaths
  }

  getDocumentSections(key) {
    if (!this._getDocumentSections) return []
    const document = this._getDocument.get(key)
    if (!document) return []
    return this._getDocumentSections.all(document.id).map(section => ({
      sectionKind: section.section_kind,
      heading: section.heading,
      contentText: section.content_text,
      contentJson: section.content_json,
      sortOrder: section.sort_order,
    }))
  }

  getDocumentRelationships(key) {
    return this._getDocumentRelationshipsBySource.all(key)
  }

  getPagesByRoot(rootSlug) {
    return this._getDocumentsByRoot.all(rootSlug)
  }

  searchPages(ftsQuery, rawQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    return this._searchDocuments.all({ $query: ftsQuery, $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
  }

  searchTitleExact(rawQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    return this._searchDocumentsTitleExact.all({ $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
  }

  searchTrigram(query, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    if (!this._searchDocumentsTrigram) return []
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    try {
      return this._searchDocumentsTrigram.all({ $query: query, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
    } catch { return [] }
  }

  searchBody(ftsQuery, { framework = null, kind = null, limit = 100, language = null, sourceType = null, minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null } = {}) {
    if (!this._searchDocumentsBody) return []
    const filterParams = { $language: language, $source_type: sourceType, $min_ios: minIos, $min_macos: minMacos, $min_watchos: minWatchos, $min_tvos: minTvos, $min_visionos: minVisionos }
    try {
      return this._searchDocumentsBody.all({ $query: ftsQuery, $framework: framework, $kind: kind, $limit: limit, ...filterParams })
    } catch { return [] }
  }

  getFrameworkSynonyms(slug) {
    if (!slug) return []
    const normalized = slug.toLowerCase()
    return this._getFrameworkSynonyms.all(normalized, normalized).map(r => r.alias ?? r.canonical)
  }

  getDocumentSnippetData(keys) {
    if (!keys || keys.length === 0) return new Map()
    const placeholders = keys.map(() => '?').join(',')
    const docs = this.db.query(`
      SELECT id, key, title, abstract_text, declaration_text, headings
      FROM documents WHERE key IN (${placeholders})
    `).all(...keys)
    const docMap = new Map()
    const idToKey = new Map()
    for (const d of docs) {
      idToKey.set(d.id, d.key)
      docMap.set(d.key, { document: d, sections: [] })
    }
    if (idToKey.size > 0 && this.hasTable('document_sections')) {
      const ids = [...idToKey.keys()]
      const sPlaceholders = ids.map(() => '?').join(',')
      const sections = this.db.query(`
        SELECT document_id, section_kind, heading, content_text, sort_order
        FROM document_sections WHERE document_id IN (${sPlaceholders})
        ORDER BY sort_order
      `).all(...ids)
      for (const s of sections) {
        const key = idToKey.get(s.document_id)
        if (key && docMap.has(key)) {
          docMap.get(key).sections.push(s)
        }
      }
    }
    return docMap
  }

  getRelatedDocCounts(keys) {
    if (!keys || keys.length === 0) return new Map()
    const placeholders = keys.map(() => '?').join(',')
    const rows = this.db.query(`
      SELECT from_key, COUNT(*) as count
      FROM document_relationships WHERE from_key IN (${placeholders})
      GROUP BY from_key
    `).all(...keys)
    const map = new Map()
    for (const r of rows) map.set(r.from_key, r.count)
    return map
  }

  getBodyIndexCount() {
    if (!this._documentsBodyIndexCount) return 0
    try { return this._documentsBodyIndexCount.get().c } catch { return 0 }
  }

  insertBody(documentId, body) {
    if (!this._insertDocumentBody) return
    this._insertDocumentBody.run({ $id: documentId, $body: body })
  }

  clearBodyIndex() {
    if (!this._clearDocumentBody) return
    this._clearDocumentBody.run()
  }

  getTrigramCandidates(trigram) {
    if (!this._documentTrigramCandidates) return []
    try {
      return this._documentTrigramCandidates.all({ $trigram: trigram })
    } catch { return [] }
  }

  getAllTitlesForFuzzy() {
    return this._getAllTitlesForFuzzy.all()
  }

  /**
   * Thin wrapper so the reader-pool can route fuzzy matching through a worker
   * by op name. Keeps the trigram/Levenshtein routine identical — only the
   * call surface changes. Off the main thread, this lets a long fuzzy scan
   * run in parallel with other search tiers rather than blocking the event
   * loop. The `_trigramCache` lives in the lib module, so each worker builds
   * its own cache once per process lifetime (cost: O(titles × avg_trigrams)).
   */
  fuzzyMatchTitles(query, opts = {}) {
    return fuzzyMatchTitles(query, this, opts)
  }

  searchByTitle(title, framework = null) {
    return this._searchDocumentByTitle.get({ $title: title, $framework: framework })
  }

  getSearchRecordById(id) {
    return this._getDocumentSearchRecordById.get(id)
  }

  getRoots(kind = null) { return this.roots.getRoots(kind) }
  getRootBySlug(slug) { return this.roots.getRootBySlug(slug) }
  resolveRoot(input) { return this.roots.resolveRoot(input) }

  addRef(sourceId, targetPath, anchorText, section) { this.refs.addRef(sourceId, targetPath, anchorText, section) }
  deleteRefsBySource(sourceId) { this.refs.deleteRefsBySource(sourceId) }
  getRefsBySource(sourceId) { return this.refs.getRefsBySource(sourceId) }

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

  markConverted(path) {
    this._updatePageConverted.run(new Date().toISOString(), path)
  }

  getUnconvertedPages() {
    return this._getUnconvertedPages.all()
  }

  updateRootPageCount(slug) { this.roots.updateRootPageCount(slug) }

  getAllPagesWithEtag() {
    return this._getAllPagesWithEtag.all()
  }

  getPagesBySourceType(sourceType) {
    return this._getPagesBySourceType.all(sourceType)
  }

  getPagesByRole(role) {
    return this._getDocumentsByRole.all(role)
  }

  markPageDeleted(path) {
    this._markPageDeleted.run(path)
    this.deleteNormalizedDocument(path)
  }

  deleteNormalizedDocument(key) {
    const document = this._getDocumentIdByKey.get(key)
    if (!document) return false

    if (this._deleteDocumentBody) this._deleteDocumentBody.run(document.id)
    if (this._deleteDocumentSections) this._deleteDocumentSections.run(document.id)
    this._deleteDocumentRelationshipsByKey.run(key, key)
    this._deleteDocumentByKey.run(key)
    return true
  }

  updatePageAfterDownload(path, etag, lastModified, contentHash) {
    this._updatePageEtag.run({
      $path: path,
      $etag: etag,
      $last_modified: lastModified,
      $content_hash: contentHash,
      $downloaded_at: new Date().toISOString(),
    })
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
    if (!this.hasTable('document_relationships')) return []
    return this.db.query(`
      SELECT dr.from_key, dr.to_key
      FROM document_relationships dr
      JOIN documents d ON d.key = dr.from_key
      WHERE d.framework = ? AND dr.relation_type = 'child'
      ORDER BY dr.sort_order
    `).all(framework)
  }

  upsertAppleFontFamily(params) { this.assetsFonts.upsertFontFamily(params) }
  upsertAppleFontFile(params) { this.assetsFonts.upsertFontFile(params) }
  listAppleFonts() { return this.assetsFonts.listFonts() }
  getAppleFontFile(id) { return this.assetsFonts.getFontFile(id) }

  upsertSfSymbol(params) { this.assetsSymbols.upsertSymbol(params) }
  getSfSymbol(scope, name) { return this.assetsSymbols.getSymbol(scope, name) }
  listSfSymbolsCatalog() { return this.assetsSymbols.listCatalog() }
  searchSfSymbols(query = '', opts = {}) { return this.assetsSymbols.searchSymbols(query, opts) }
  upsertSfSymbolRender(params) { this.assetsSymbols.upsertRender(params) }
  getSfSymbolRender(cacheKey) { return this.assetsSymbols.getRender(cacheKey) }

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

