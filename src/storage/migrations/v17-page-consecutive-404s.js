/**
 * v17 — `pages.consecutive_404_count` for the N=3 tombstone gate.
 *
 * Audit 5 §4.3 flagged that a single upstream 404 immediately marks a
 * page deleted. That's wrong for transient outages (Apple CDN blip,
 * region-specific routing) and there's no way to distinguish a real
 * removal from a flap. Fix is to require N=3 consecutive 404s before
 * tombstoning, with the counter reset on any successful check.
 *
 * The counter lives on `pages` because that's the row the gate
 * decides to delete; storing it elsewhere would force a join on the
 * hot crawl path.
 */
export function up(db) {
  try {
    db.run('ALTER TABLE pages ADD COLUMN consecutive_404_count INTEGER NOT NULL DEFAULT 0')
  } catch (e) {
    // Idempotent re-run.
    if (!/duplicate column name/i.test(e.message ?? '')) throw e
  }
}
