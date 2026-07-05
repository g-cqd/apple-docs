// Queries for the CLI `status` verb (mirrors database.getStats + the helpers it
// composes: operations.getLastUpdateLog / getActivity / getSnapshotMeta, and
// crawl.getCrawlProgressAll / getCrawlProgressByRoot). Read-only, same query
// style as ReadDoc/Taxonomy/Browse (conn.prepareUncached + PreparedStatement
// step/int/text). The verb (ADCLI/Status.swift) assembles these into the status
// envelope; the projection + key order live there, matching projection.js.

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// `{ kind, count }` row from `SELECT kind, COUNT(*) FROM roots GROUP BY kind`,
/// in row order (mirrors getStats `rootsByKind`).
public struct RootKindCount: Sendable {
    public let kind: String?
    public let count: Int64
}

/// The last `update_log` row's `{ timestamp, action }` — getStats `lastLog`
/// (`getLastUpdateLog` returns the whole row; status.js reads these two fields).
public struct LastUpdateLog: Sendable {
    public let timestamp: String?
    public let action: String?
}

/// The `activity` singleton (id = 1) as status.js consumes it: action,
/// startedAt, pid, the raw `roots` JSON column, and the `alive` flag derived
/// from `kill(pid, 0)` (operations.getActivity). nil when no row is recorded.
public struct ActivityRow: Sendable {
    public let action: String?
    public let startedAt: String?
    public let pid: Int64?
    /// Raw `roots` TEXT column (a JSON array of strings, or NULL). The caller
    /// `JSON.parse`s it — kept verbatim here so ADStorage stays Foundation-free
    /// (same boundary as ReadDoc's `platformsJSON`).
    public let rootsJSON: String?
    /// `process.kill(pid, 0)` succeeds — the recorded process is still running.
    public let alive: Bool
}

/// Overall crawl progress — getCrawlProgressAll. All-zero on a snapshot corpus
/// (empty crawl_state); COALESCE/COUNT(*) make the sums total ints.
public struct CrawlProgressTotals: Sendable {
    public let pending: Int64
    public let processed: Int64
    public let failed: Int64
    public let total: Int64
}

/// Per-root crawl progress — getCrawlProgressByRoot row `{ root_slug, pending,
/// processed, failed }`, in `ORDER BY root_slug`. Empty on a snapshot corpus.
public struct CrawlProgressRoot: Sendable {
    public let rootSlug: String?
    public let pending: Int64
    public let processed: Int64
    public let failed: Int64
}

/// The corpus stats getStats() returns, in the same composition. The status
/// verb derives the envelope (active/deleted pages, roots + byKind, last log,
/// activity, crawl progress) from this.
public struct CorpusStats: Sendable {
    public let totalPages: Int64
    public let totalDeleted: Int64
    public let totalRoots: Int64
    public let rootsByKind: [RootKindCount]
    public let lastLog: LastUpdateLog?
    public let activity: ActivityRow?
    public let crawlProgress: CrawlProgressTotals
    public let crawlByRoot: [CrawlProgressRoot]
}

extension StorageConnection {
    /// database.getStats(): the corpus counters + activity + crawl progress, in
    /// the same shape. Mirrors the exact SQL of each composed helper.
    public func corpusStats() -> CorpusStats {
        CorpusStats(
            totalPages: scalarCount("SELECT COUNT(*) AS count FROM pages WHERE status = 'active'"),
            totalDeleted: scalarCount("SELECT COUNT(*) AS count FROM pages WHERE status = 'deleted'"),
            totalRoots: scalarCount("SELECT COUNT(*) AS count FROM roots"),
            rootsByKind: rootsByKind(),
            lastLog: lastUpdateLog(),
            activity: activityRow(),
            crawlProgress: crawlProgressAll(),
            crawlByRoot: crawlProgressByRoot())
    }

    /// `SELECT kind, COUNT(*) FROM roots GROUP BY kind` — getStats `rootsByKind`,
    /// in the engine's natural GROUP BY row order (matches the JS row order, which
    /// the caller turns into the `byKind` object via insertion order).
    func rootsByKind() -> [RootKindCount] {
        guard let stmt = conn.prepareUncached("SELECT kind, COUNT(*) AS count FROM roots GROUP BY kind") else {
            return []
        }
        var out: [RootKindCount] = []
        while stmt.step() == SQLite.row {
            out.append(RootKindCount(kind: stmt.text(0), count: stmt.int(1) ?? 0))
        }
        return out
    }

    /// getLastUpdateLog: `SELECT * FROM update_log ORDER BY id DESC LIMIT 1`,
    /// reduced to the two fields status.js reads. nil when the table is empty.
    /// Public: freshnessCheck (ADCLI) re-queries it independently, mirroring the
    /// JS where getStats and freshnessCheck both read the last update_log row.
    public func lastUpdateLog() -> LastUpdateLog? {
        guard
            let stmt = conn.prepareUncached(
                "SELECT timestamp, action FROM update_log ORDER BY id DESC LIMIT 1"),
            stmt.step() == SQLite.row
        else { return nil }
        return LastUpdateLog(timestamp: stmt.text(0), action: stmt.text(1))
    }

    /// getActivity: the singleton `activity` row (id = 1) + the `alive` flag from
    /// `kill(pid, 0)` and the parsed `roots` array. nil when no row exists.
    func activityRow() -> ActivityRow? {
        guard
            let stmt = conn.prepareUncached(
                "SELECT action, started_at, pid, roots FROM activity WHERE id = 1"),
            stmt.step() == SQLite.row
        else { return nil }
        let pid = stmt.int(2)
        return ActivityRow(
            action: stmt.text(0), startedAt: stmt.text(1), pid: pid,
            rootsJSON: stmt.text(3), alive: pid.map(processAlive) ?? false)
    }

    /// getCrawlProgressAll: COALESCE'd status sums + COUNT(*) over crawl_state.
    /// Always one row (aggregate); all-zero on an empty (snapshot) table.
    func crawlProgressAll() -> CrawlProgressTotals {
        let sql = """
            SELECT
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END), 0) AS processed,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
              COUNT(*) AS total
            FROM crawl_state
            """
        guard let stmt = conn.prepareUncached(sql), stmt.step() == SQLite.row else {
            return CrawlProgressTotals(pending: 0, processed: 0, failed: 0, total: 0)
        }
        return CrawlProgressTotals(
            pending: stmt.int(0) ?? 0, processed: stmt.int(1) ?? 0, failed: stmt.int(2) ?? 0,
            total: stmt.int(3) ?? 0)
    }

    /// getCrawlProgressByRoot: per-root status sums, `GROUP BY root_slug ORDER BY
    /// root_slug`. Empty on a snapshot corpus.
    func crawlProgressByRoot() -> [CrawlProgressRoot] {
        let sql = """
            SELECT root_slug,
                   SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                   SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM crawl_state
            GROUP BY root_slug
            ORDER BY root_slug
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        var out: [CrawlProgressRoot] = []
        while stmt.step() == SQLite.row {
            out.append(
                CrawlProgressRoot(
                    rootSlug: stmt.text(0), pending: stmt.int(1) ?? 0, processed: stmt.int(2) ?? 0,
                    failed: stmt.int(3) ?? 0))
        }
        return out
    }

    /// freshnessCheck's per-root rows: `SELECT root_slug, MAX(timestamp) FROM
    /// update_log WHERE root_slug IS NOT NULL GROUP BY root_slug`. Returns the raw
    /// `(slug, lastUpdate)` pairs (drops a NULL slug / NULL max); the caller does
    /// the daysSince math (Foundation-side). Empty on a snapshot corpus.
    public func staleRootRows() -> [(slug: String, lastUpdate: String)] {
        let sql = """
            SELECT root_slug, MAX(timestamp) AS last_update FROM update_log
            WHERE root_slug IS NOT NULL GROUP BY root_slug
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        var out: [(slug: String, lastUpdate: String)] = []
        while stmt.step() == SQLite.row {
            if let slug = stmt.text(0), let lastUpdate = stmt.text(1) {
                out.append((slug: slug, lastUpdate: lastUpdate))
            }
        }
        return out
    }

    /// getSnapshotMeta(key): `SELECT value FROM snapshot_meta WHERE key = ?`, or
    /// nil. Used for snapshot provenance (tag / build_macos) and the update check.
    public func getSnapshotMeta(_ key: String) -> String? {
        guard let stmt = conn.prepareUncached("SELECT value FROM snapshot_meta WHERE key = ?") else {
            return nil
        }
        stmt.bindText(1, key)
        guard stmt.step() == SQLite.row else { return nil }
        return stmt.text(0)
    }

    /// `setSnapshotMeta(key, value)` — INSERT OR REPLACE into snapshot_meta.
    /// Requires a writable connection (`StorageConnection(path:, writable: true)`);
    /// mirrors the JS `db.setSnapshotMeta` used by `storage profile` + install.
    @discardableResult
    public func setSnapshotMeta(_ key: String, _ value: String) -> Bool {
        guard let stmt = conn.prepareUncached("INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)")
        else { return false }
        stmt.bindText(1, key)
        stmt.bindText(2, value)
        return stmt.step() == SQLite.done
    }

    /// database.hasTable: a `sqlite_master` table-existence probe. Delegates to
    /// the connection's existing probe (used by the capabilities block).
    public func hasTable(_ name: String) -> Bool {
        conn.tableExists(name)
    }

    /// search.hasBodyIndex: false when `documents_body_fts` is absent, otherwise
    /// true iff it holds at least one row (`SELECT 1 ... LIMIT 1`). Mirrors the JS
    /// `bodyExistsStmt.get() != null` check (table-gated).
    public func hasBodyIndex() -> Bool {
        guard conn.tableExists("documents_body_fts") else { return false }
        guard let stmt = conn.prepareUncached("SELECT 1 FROM documents_body_fts LIMIT 1") else {
            return false
        }
        return stmt.step() == SQLite.row
    }

    // MARK: - private helpers

    /// Runs a single-column COUNT(*) aggregate, returning the integer (0 on a
    /// prepare/step error — an aggregate always yields one row otherwise).
    private func scalarCount(_ sql: String) -> Int64 {
        guard let stmt = conn.prepareUncached(sql), stmt.step() == SQLite.row else { return 0 }
        return stmt.int(0) ?? 0
    }
}

/// `process.kill(pid, 0)` — Node throws on ESRCH (dead pid) AND on EPERM (alive
/// but unsignalable), and the JS `try/catch` treats ANY throw as alive=false. So
/// "alive" is only a clean signal-0 probe (rc == 0); EPERM and ESRCH both map to
/// false, matching the JS exactly.
private func processAlive(_ pid: Int64) -> Bool {
    guard pid > 0, pid <= Int64(pid_t.max) else { return false }
    return kill(pid_t(pid), 0) == 0
}
