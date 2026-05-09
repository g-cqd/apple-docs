/**
 * Pages repository: the legacy page table (still used as the crawler's
 * working set; killed in v14 / Phase 4). The methods here cover pure
 * page-row operations. Cross-cluster orchestration (upsertPage syncing
 * a documents row when the page is normalized) lives on the
 * DocsDatabase facade so it can pull in the documents repo too.
 */

import { serializePlatforms } from './documents.js'

export function createPagesRepo(db) {
  const upsertStmt = db.query(`
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
  const getByPathStmt = db.query(
    'SELECT p.*, r.slug as root_slug, r.display_name as framework FROM pages p JOIN roots r ON p.root_id = r.id WHERE p.path = ? AND p.status = ?',
  )
  const markDeletedStmt = db.query("UPDATE pages SET status = 'deleted' WHERE path = ?")
  const updateEtagStmt = db.query(
    'UPDATE pages SET etag = $etag, last_modified = $last_modified, content_hash = $content_hash, downloaded_at = $downloaded_at WHERE path = $path',
  )
  const updateConvertedStmt = db.query(
    'UPDATE pages SET converted_at = ? WHERE path = ?',
  )
  const getUnconvertedStmt = db.query(`
    SELECT p.path, r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
    FROM pages p
    JOIN roots r ON p.root_id = r.id
    WHERE p.converted_at IS NULL
      AND p.downloaded_at IS NOT NULL
      AND p.status = 'active'
  `)
  const getAllWithEtagStmt = db.query(
    "SELECT path, etag FROM pages WHERE etag IS NOT NULL AND status = 'active'",
  )
  const getBySourceTypeStmt = db.query(`
    SELECT p.path, p.root_id, p.etag, p.last_modified, p.content_hash,
           r.slug as root_slug, COALESCE(p.source_type, r.source_type) as source_type
    FROM pages p
    JOIN roots r ON p.root_id = r.id
    WHERE p.status = 'active'
      AND COALESCE(p.source_type, r.source_type) = ?
    ORDER BY p.path
  `)

  return {
    upsertPageRow(params) {
      return upsertStmt.get({
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
        $source_type: params.sourceType,
        $language: params.language ?? null,
        $is_release_notes: params.isReleaseNotes == null ? 0 : (params.isReleaseNotes ? 1 : 0),
        $url_depth: params.urlDepth,
        $doc_kind: params.docKind ?? params.role ?? null,
        $source_metadata: params.sourceMetadata == null
          ? null
          : (typeof params.sourceMetadata === 'string'
            ? params.sourceMetadata
            : JSON.stringify(params.sourceMetadata)),
        $min_ios: params.minIos ?? null,
        $min_macos: params.minMacos ?? null,
        $min_watchos: params.minWatchos ?? null,
        $min_tvos: params.minTvos ?? null,
        $min_visionos: params.minVisionos ?? null,
      })
    },
    getActivePage(path) {
      return getByPathStmt.get(path, 'active')
    },
    /** O(N) chunked existence test against the pages table. SQLite caps
     *  bound parameters at 999, so we batch in chunks of 900 to stay
     *  comfortably under that limit. */
    getActivePathsIn(keys) {
      if (!keys || keys.length === 0) return new Set()
      const activePaths = new Set()
      const chunkSize = 900
      for (let index = 0; index < keys.length; index += chunkSize) {
        const chunk = keys.slice(index, index + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        const rows = db.query(
          `SELECT path FROM pages WHERE status = 'active' AND path IN (${placeholders})`,
        ).all(...chunk)
        for (const row of rows) activePaths.add(row.path)
      }
      return activePaths
    },
    markPageDeleted(path) {
      markDeletedStmt.run(path)
    },
    updatePageAfterDownload(path, etag, lastModified, contentHash) {
      updateEtagStmt.run({
        $path: path,
        $etag: etag,
        $last_modified: lastModified,
        $content_hash: contentHash,
        $downloaded_at: new Date().toISOString(),
      })
    },
    markConverted(path) {
      updateConvertedStmt.run(new Date().toISOString(), path)
    },
    getUnconvertedPages() {
      return getUnconvertedStmt.all()
    },
    getAllPagesWithEtag() {
      return getAllWithEtagStmt.all()
    },
    getPagesBySourceType(sourceType) {
      return getBySourceTypeStmt.all(sourceType)
    },
  }
}
