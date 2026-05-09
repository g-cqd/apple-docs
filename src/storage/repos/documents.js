/**
 * Documents repository: the canonical document graph (introduced in v6),
 * its sections, relationships, and the small lookup helpers
 * (getDocumentSnippetData, getRelatedDocCounts, getFrameworkTree).
 *
 * Section-related statements are guarded against the lite snapshot tier
 * which ships without `document_sections`; tier-optional methods return
 * empty/no-op when the table is absent.
 */

import { parseJsonValue } from '../_helpers.js'

function deriveFrameworkFromPath(path) {
  if (!path) return null
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'documentation') return parts[1] ?? null
  return parts[0] ?? null
}

function serializePlatforms(value) {
  if (value == null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function createDocumentsRepo(db, { hasSectionsTable = false } = {}) {
  const upsertStmt = db.query(`
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
  const getByKeyStmt = db.query(`
    SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework_display
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.key = ?
  `)
  const getIdByKeyStmt = db.query('SELECT id FROM documents WHERE key = ?')
  const getByRootSlugStmt = db.query(`
    SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract
    FROM documents d
    JOIN pages p ON p.path = d.key
    JOIN roots r ON p.root_id = r.id
    WHERE r.slug = ? AND p.status = 'active'
    ORDER BY d.key
  `)
  const getByRoleStmt = db.query(`
    SELECT d.key, d.key as path, d.title, d.role,
           COALESCE(r.slug, d.framework) as root_slug, d.source_type as source_type
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.role = ?
    ORDER BY d.key
  `)
  const deleteByKeyStmt = db.query('DELETE FROM documents WHERE key = ?')
  const getRelationshipsBySourceStmt = db.query(`
    SELECT dr.to_key as target_path,
           COALESCE(td.title, dr.to_key) as anchor_text,
           COALESCE(dr.section, dr.relation_type) as section
    FROM document_relationships dr
    LEFT JOIN documents td ON td.key = dr.to_key
    WHERE dr.from_key = ?
    ORDER BY dr.sort_order, dr.to_key
  `)
  const deleteRelationshipsByFromStmt = db.query(
    'DELETE FROM document_relationships WHERE from_key = ?',
  )
  const deleteRelationshipsByKeyStmt = db.query(
    'DELETE FROM document_relationships WHERE from_key = ? OR to_key = ?',
  )
  const insertRelationshipStmt = db.query(`
    INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
    VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
    ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
      section = $section,
      sort_order = $sort_order
  `)
  const getFrameworkTreeStmt = db.query(`
    SELECT dr.from_key, dr.to_key
    FROM document_relationships dr
    JOIN documents d ON d.key = dr.from_key
    WHERE d.framework = ? AND dr.relation_type = 'child'
    ORDER BY dr.sort_order
  `)
  // Section statements are tier-optional: lite snapshots ship without
  // document_sections.
  const getSectionsStmt = hasSectionsTable
    ? db.query(`
        SELECT section_kind, heading, content_text, content_json, sort_order
        FROM document_sections
        WHERE document_id = ?
        ORDER BY sort_order, id
      `)
    : null
  const deleteSectionsStmt = hasSectionsTable
    ? db.query('DELETE FROM document_sections WHERE document_id = ?')
    : null
  const insertSectionStmt = hasSectionsTable
    ? db.query(`
        INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
        VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
        ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
          heading = $heading,
          content_text = $content_text,
          content_json = $content_json
      `)
    : null

  return {
    hasSectionsTable,
    upsertDocument(params) {
      const now = new Date().toISOString()
      return upsertStmt.get({
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
        $source_metadata: params.sourceMetadata == null
          ? null
          : (typeof params.sourceMetadata === 'string'
            ? params.sourceMetadata
            : JSON.stringify(params.sourceMetadata)),
        $content_hash: params.contentHash ?? null,
        $raw_payload_hash: params.rawPayloadHash ?? null,
        $now: now,
      })
    },
    getDocumentByKey(key) {
      return getByKeyStmt.get(key)
    },
    getDocumentIdByKey(key) {
      return getIdByKeyStmt.get(key)
    },
    getDocumentsByRoot(rootSlug) {
      return getByRootSlugStmt.all(rootSlug)
    },
    getDocumentsByRole(role) {
      return getByRoleStmt.all(role)
    },
    /** Used by deleteNormalizedDocument on the facade — drops the row plus
     *  any relationships that name it as either endpoint. The body row
     *  (if any) is dropped through a separate body-clearing path. */
    deleteDocumentByKey(key) {
      deleteRelationshipsByKeyStmt.run(key, key)
      deleteByKeyStmt.run(key)
    },
    replaceSections(documentId, sections) {
      if (!deleteSectionsStmt || !insertSectionStmt) return
      deleteSectionsStmt.run(documentId)
      for (const section of sections ?? []) {
        insertSectionStmt.run({
          $document_id: documentId,
          $section_kind: section.sectionKind ?? section.section_kind,
          $heading: section.heading ?? null,
          $content_text: section.contentText ?? section.content_text ?? '',
          $content_json: section.contentJson ?? section.content_json ?? null,
          $sort_order: section.sortOrder ?? section.sort_order ?? 0,
        })
      }
    },
    deleteSectionsByDocId(documentId) {
      deleteSectionsStmt?.run(documentId)
    },
    replaceRelationships(fromKey, relationships) {
      deleteRelationshipsByFromStmt.run(fromKey)
      for (const relationship of relationships ?? []) {
        insertRelationshipStmt.run({
          $from_key: relationship.fromKey ?? relationship.from_key ?? fromKey,
          $to_key: relationship.toKey ?? relationship.to_key,
          $relation_type: relationship.relationType ?? relationship.relation_type,
          $section: relationship.section ?? null,
          $sort_order: relationship.sortOrder ?? relationship.sort_order ?? 0,
        })
      }
    },
    getSections(key) {
      if (!getSectionsStmt) return []
      const document = getByKeyStmt.get(key)
      if (!document) return []
      return getSectionsStmt.all(document.id).map(section => ({
        sectionKind: section.section_kind,
        heading: section.heading,
        contentText: section.content_text,
        contentJson: section.content_json,
        sortOrder: section.sort_order,
      }))
    },
    getRelationships(key) {
      return getRelationshipsBySourceStmt.all(key)
    },
    /** Parent→child edges for a framework's document tree. Powers the
     *  static-build framework tree and the breadcrumb resolver. */
    getFrameworkTree(framework, { hasRelationshipsTable }) {
      if (!hasRelationshipsTable) return []
      return getFrameworkTreeStmt.all(framework)
    },
    /** Lookup helper used by the search formatter. Returns a Map keyed by
     *  doc key, each value holding the document row plus the section list
     *  pulled in batched IN(...) chunks. */
    getDocumentSnippetData(keys) {
      if (!keys || keys.length === 0) return new Map()
      const placeholders = keys.map(() => '?').join(',')
      const docs = db.query(`
        SELECT id, key, title, abstract_text, declaration_text, headings
        FROM documents WHERE key IN (${placeholders})
      `).all(...keys)
      const docMap = new Map()
      const idToKey = new Map()
      for (const d of docs) {
        idToKey.set(d.id, d.key)
        docMap.set(d.key, { document: d, sections: [] })
      }
      if (idToKey.size > 0 && hasSectionsTable) {
        const ids = [...idToKey.keys()]
        const sPlaceholders = ids.map(() => '?').join(',')
        const sections = db.query(`
          SELECT document_id, section_kind, heading, content_text, sort_order
          FROM document_sections WHERE document_id IN (${sPlaceholders})
          ORDER BY sort_order
        `).all(...ids)
        for (const s of sections) {
          const key = idToKey.get(s.document_id)
          if (key && docMap.has(key)) docMap.get(key).sections.push(s)
        }
      }
      return docMap
    },
    /** Counts of relationships originating from each given doc key. */
    getRelatedDocCounts(keys) {
      if (!keys || keys.length === 0) return new Map()
      const placeholders = keys.map(() => '?').join(',')
      const rows = db.query(`
        SELECT from_key, COUNT(*) as count
        FROM document_relationships WHERE from_key IN (${placeholders})
        GROUP BY from_key
      `).all(...keys)
      const map = new Map()
      for (const r of rows) map.set(r.from_key, r.count)
      return map
    },
  }
}

// Re-export the helpers that the pages repo needs to share with us
// without round-tripping through database.js.
export { deriveFrameworkFromPath, parseJsonValue, serializePlatforms }
