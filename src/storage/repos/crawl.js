/**
 * Crawl-state repository: the working set the discoverer + downloader
 * pull from. Each row tracks one path's status (pending / processed /
 * failed), the root it belongs to, and the most recent error message
 * if a fetch failed. Schema lives in v1 (see migrations/v1-initial-schema.js).
 *
 * Per-root counters stay reasonably fresh because every state mutation
 * goes through this repo.
 */

export function createCrawlRepo(db) {
  const setStmt = db.query(`
    INSERT INTO crawl_state (path, status, root_slug, depth, error)
    VALUES ($path, $status, $root_slug, $depth, $error)
    ON CONFLICT(path) DO UPDATE SET status = $status, error = $error
  `)
  const existsStmt = db.query('SELECT 1 FROM crawl_state WHERE path = ?')
  const getPendingStmt = db.query(
    "SELECT path, depth FROM crawl_state WHERE status = 'pending' AND root_slug = ? LIMIT ?",
  )
  const resetFailedStmt = db.query(
    "UPDATE crawl_state SET status = 'pending', error = NULL WHERE status = 'failed' AND root_slug = ?",
  )
  const countFailedStmt = db.query(
    "SELECT COUNT(*) as count FROM crawl_state WHERE status = 'failed' AND root_slug = ?",
  )
  const countByStatusStmt = db.query(
    'SELECT status, COUNT(*) as count FROM crawl_state WHERE root_slug = ? GROUP BY status',
  )
  const clearStmt = db.query('DELETE FROM crawl_state WHERE root_slug = ?')

  const progressByRootStmt = db.query(`
    SELECT root_slug,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM crawl_state
    GROUP BY root_slug
    ORDER BY root_slug
  `)
  const progressAllStmt = db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END), 0) as processed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
      COUNT(*) as total
    FROM crawl_state
  `)

  return {
    setCrawlState(path, status, rootSlug, depth = 0, error = null) {
      setStmt.run({
        $path: path,
        $status: status,
        $root_slug: rootSlug,
        $depth: depth,
        $error: error,
      })
    },
    /** Insert a path only if not already tracked. Returns true on insert. */
    seedCrawlIfNew(path, rootSlug, depth = 0) {
      if (existsStmt.get(path)) return false
      this.setCrawlState(path, 'pending', rootSlug, depth)
      return true
    },
    getPendingCrawl(rootSlug, limit = 10) {
      return getPendingStmt.all(rootSlug, limit)
    },
    resetFailedCrawl(rootSlug) {
      return resetFailedStmt.run(rootSlug)
    },
    countFailed(rootSlug) {
      return countFailedStmt.get(rootSlug).count
    },
    getCrawlStats(rootSlug) {
      const stats = { pending: 0, processed: 0, failed: 0 }
      for (const row of countByStatusStmt.all(rootSlug)) stats[row.status] = row.count
      return stats
    },
    clearCrawlState(rootSlug) {
      clearStmt.run(rootSlug)
    },
    getCrawlProgressByRoot() {
      return progressByRootStmt.all()
    },
    getCrawlProgressAll() {
      return progressAllStmt.get() ?? { pending: 0, processed: 0, failed: 0, total: 0 }
    },
  }
}
