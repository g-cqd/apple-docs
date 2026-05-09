/**
 * Legacy refs repository — the cross-page reference table populated
 * before the documents/document_relationships pair landed in v6. Still
 * read by some callers; kept until the v14 "kill pages + refs" migration
 * deferred to Phase 4.
 */

export function createRefsRepo(db) {
  const addStmt = db.query(
    'INSERT INTO refs (source_id, target_path, anchor_text, section) VALUES (?, ?, ?, ?)',
  )
  const getBySourceStmt = db.query(
    'SELECT target_path, anchor_text, section FROM refs WHERE source_id = ? ORDER BY section, anchor_text',
  )
  const deleteBySourceStmt = db.query('DELETE FROM refs WHERE source_id = ?')

  return {
    addRef(sourceId, targetPath, anchorText, section) {
      addStmt.run(sourceId, targetPath, anchorText, section)
    },
    getRefsBySource(sourceId) {
      return getBySourceStmt.all(sourceId)
    },
    deleteRefsBySource(sourceId) {
      deleteBySourceStmt.run(sourceId)
    },
  }
}
