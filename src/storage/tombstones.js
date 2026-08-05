/**
 * Page tombstoning: marking pages deleted and tearing down the normalized
 * document rows (sections, relationships, body-FTS entry) that hang off
 * them.
 *
 * Lives outside DocsDatabase so the facade stays a thin delegation layer —
 * these are the only page-deletion operations with real logic of their own.
 * Each takes the facade so it can reach the repos plus the raw handle.
 */

/** Tombstone one page and drop its normalized document. */
export function markPageDeleted(db, path) {
  db.pages.markPageDeleted(path)
  deleteNormalizedDocument(db, path)
}

/**
 * Bulk tombstone. Deleting a document scans `document_relationships` for
 * `to_key = ?` (v21 dropped idx_rel_to as a cold-path index), which is fine
 * one-off but O(pages × 2M rows) for a batch. Build the index transiently,
 * run the batch in one transaction, drop it again — v21's space/write-amp
 * rationale keeps holding outside this call.
 */
export function markPagesDeleted(db, paths) {
  if (!paths?.length) return
  if (paths.length < 50) {
    for (const path of paths) markPageDeleted(db, path)
    return
  }
  db.db.run('BEGIN')
  try {
    db.db.run('CREATE INDEX IF NOT EXISTS idx_rel_to_bulk_delete ON document_relationships(to_key)')
    for (const path of paths) markPageDeleted(db, path)
    db.db.run('DROP INDEX IF EXISTS idx_rel_to_bulk_delete')
    db.db.run('COMMIT')
  } catch (error) {
    try { db.db.run('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

/** Drop the document row plus its sections and body-FTS entry. Returns
 *  false when no document has been normalized for `key`. */
export function deleteNormalizedDocument(db, key) {
  const document = db.documents.getDocumentIdByKey(key)
  if (!document) return false
  db.search.deleteBodyByDocId(document.id)
  db.documents.deleteSectionsByDocId(document.id)
  db.documents.deleteDocumentByKey(key)
  return true
}
