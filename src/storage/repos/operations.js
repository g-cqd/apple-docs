/**
 * Operations repository: activity tracking, snapshot metadata, sync
 * checkpoints, the update log, and the per-document render-index.
 *
 * Extracted from database.js as part of the P2.3 facade refactor. The
 * statements all run against tables created by migrations v2 / v8 / v9
 * and the snapshot_meta + activity definitions in v6.
 */

export function createOperationsRepo(db) {
  // Activity tracking — singleton row keyed (id = 1) so `setActivity`
  // overwrites a stale entry left behind by a killed run.
  const setActivityStmt = db.query(
    'INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) VALUES (1, $action, $started_at, $pid, $roots)',
  )
  const clearActivityStmt = db.query('DELETE FROM activity WHERE id = 1')
  const getActivityStmt = db.query('SELECT * FROM activity WHERE id = 1')

  // Snapshot meta + sync checkpoints
  const getSnapshotMetaStmt = db.query('SELECT value FROM snapshot_meta WHERE key = ?')
  const setSnapshotMetaStmt = db.query('INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)')
  const getSyncCheckpointStmt = db.query('SELECT value FROM sync_checkpoint WHERE key = ?')
  const setSyncCheckpointStmt = db.query(
    'INSERT OR REPLACE INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, ?)',
  )
  const clearSyncCheckpointStmt = db.query('DELETE FROM sync_checkpoint WHERE key = ?')

  // Update log
  const addUpdateLogStmt = db.query(`
    INSERT INTO update_log (timestamp, root_slug, action, new_count, mod_count, del_count, err_count, duration_ms)
    VALUES ($timestamp, $root_slug, $action, $new_count, $mod_count, $del_count, $err_count, $duration_ms)
  `)
  const getLastUpdateLogStmt = db.query('SELECT * FROM update_log ORDER BY id DESC LIMIT 1')

  // Per-document render-index (web build incremental cache)
  const getRenderIndexStmt = db.query(
    'SELECT doc_id, sections_digest, template_version, html_hash, updated_at FROM document_render_index WHERE doc_id = ?',
  )
  const upsertRenderIndexStmt = db.query(
    'INSERT OR REPLACE INTO document_render_index (doc_id, sections_digest, template_version, html_hash, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  const clearRenderIndexStmt = db.query('DELETE FROM document_render_index')

  return {
    setActivity(action, roots = null) {
      setActivityStmt.run({
        $action: action,
        $started_at: new Date().toISOString(),
        $pid: process.pid,
        $roots: roots ? JSON.stringify(roots) : null,
      })
    },
    clearActivity() {
      clearActivityStmt.run()
    },
    /** Returns null when no activity is recorded. Otherwise the row plus an
     *  `alive` flag derived from `process.kill(pid, 0)` so callers can tell
     *  a stuck-from-crash entry from a live one. */
    getActivity() {
      const row = getActivityStmt.get()
      if (!row) return null
      const roots = row.roots ? JSON.parse(row.roots) : null
      try {
        process.kill(row.pid, 0)
        return { ...row, alive: true, roots }
      } catch {
        return { ...row, alive: false, roots }
      }
    },

    getSnapshotMeta(key) {
      const row = getSnapshotMetaStmt.get(key)
      return row ? row.value : null
    },
    setSnapshotMeta(key, value) {
      setSnapshotMetaStmt.run(key, String(value))
    },

    getSyncCheckpoint(key) {
      const row = getSyncCheckpointStmt.get(key)
      if (!row) return null
      try {
        return JSON.parse(row.value)
      } catch {
        return row.value
      }
    },
    setSyncCheckpoint(key, value) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value)
      setSyncCheckpointStmt.run(key, serialized, new Date().toISOString())
    },
    clearSyncCheckpoint(key) {
      clearSyncCheckpointStmt.run(key)
    },

    addUpdateLog(params) {
      addUpdateLogStmt.run({
        $timestamp: new Date().toISOString(),
        $root_slug: params.rootSlug ?? null,
        $action: params.action,
        $new_count: params.newCount ?? 0,
        $mod_count: params.modCount ?? 0,
        $del_count: params.delCount ?? 0,
        $err_count: params.errCount ?? 0,
        $duration_ms: params.durationMs ?? null,
      })
    },
    getLastUpdateLog() {
      return getLastUpdateLogStmt.get()
    },

    getRenderIndexEntry(docId) {
      return getRenderIndexStmt.get(docId) ?? null
    },
    upsertRenderIndexEntry({ docId, sectionsDigest, templateVersion, htmlHash }) {
      upsertRenderIndexStmt.run(
        docId,
        sectionsDigest,
        templateVersion,
        htmlHash,
        Math.floor(Date.now() / 1000),
      )
    },
    clearRenderIndex() {
      clearRenderIndexStmt.run()
    },
  }
}
