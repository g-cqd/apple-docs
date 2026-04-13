import { Database } from 'bun:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA_VERSION = 4

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  display_name TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'unknown',
  status       TEXT    NOT NULL DEFAULT 'active',
  source       TEXT    NOT NULL,
  page_count   INTEGER NOT NULL DEFAULT 0,
  seed_path    TEXT,
  first_seen   TEXT    NOT NULL,
  last_seen    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  root_id       INTEGER NOT NULL REFERENCES roots(id),
  path          TEXT    NOT NULL UNIQUE,
  url           TEXT    NOT NULL,
  title         TEXT,
  role          TEXT,
  role_heading  TEXT,
  abstract      TEXT,
  platforms     TEXT,
  declaration   TEXT,
  etag          TEXT,
  last_modified TEXT,
  content_hash  TEXT,
  downloaded_at TEXT,
  converted_at  TEXT,
  status        TEXT    NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_pages_root   ON pages(root_id);
CREATE INDEX IF NOT EXISTS idx_pages_role   ON pages(role);
CREATE INDEX IF NOT EXISTS idx_pages_title  ON pages(title);
CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  role_heading,
  abstract,
  path,
  declaration,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
  VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
END;

CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
  VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
END;

CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
  VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
  INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
  VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
END;

CREATE TABLE IF NOT EXISTS refs (
  source_id   INTEGER NOT NULL REFERENCES pages(id),
  target_path TEXT    NOT NULL,
  anchor_text TEXT,
  section     TEXT
);

CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_id);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_path);

CREATE TABLE IF NOT EXISTS crawl_state (
  path      TEXT    PRIMARY KEY,
  status    TEXT    NOT NULL DEFAULT 'pending',
  root_slug TEXT    NOT NULL,
  depth     INTEGER NOT NULL DEFAULT 0,
  error     TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  action     TEXT    NOT NULL,
  started_at TEXT    NOT NULL,
  pid        INTEGER NOT NULL,
  roots      TEXT
);

CREATE TABLE IF NOT EXISTS update_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT    NOT NULL,
  root_slug   TEXT,
  action      TEXT    NOT NULL,
  new_count   INTEGER NOT NULL DEFAULT 0,
  mod_count   INTEGER NOT NULL DEFAULT 0,
  del_count   INTEGER NOT NULL DEFAULT 0,
  err_count   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
`

export class DocsDatabase {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(dbPath)
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA cache_size = -64000')
    this.db.run('PRAGMA temp_store = MEMORY')
    this.db.run('PRAGMA busy_timeout = 5000')
    this._migrate()
    this._prepareStatements()
  }

  _migrate() {
    // Check existing version before starting
    this.db.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const row = this.db.query('SELECT value FROM schema_meta WHERE key = ?').get('schema_version')
    const current = row ? parseInt(row.value, 10) : 0

    // Refuse to open a database from a newer version (downgrade protection)
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}. ` +
        `Update apple-docs to a newer version.`
      )
    }

    // Nothing to do if already current
    if (current === SCHEMA_VERSION) return

    // Run migrations in a transaction
    this.db.run('BEGIN')
    try {
      if (current < 1) {
        this.db.exec(SCHEMA_SQL)
      }
      if (current < 2) {
        this.db.run(`CREATE TABLE IF NOT EXISTS activity (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          action     TEXT    NOT NULL,
          started_at TEXT    NOT NULL,
          pid        INTEGER NOT NULL,
          roots      TEXT
        )`)
      }
      if (current < 3) {
        try { this.db.run('ALTER TABLE roots ADD COLUMN seed_path TEXT') } catch {}
      }
      if (current < 4) {
        // Trigram FTS5 table for fuzzy title matching
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS titles_trigram USING fts5(
          title, content='pages', content_rowid='id',
          tokenize='trigram case_sensitive 0'
        )`)
        // Full-body FTS5 table (opt-in, populated by index command)
        this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_body_fts USING fts5(
          body, tokenize='porter unicode61'
        )`)
        // Replace triggers to also sync titles_trigram
        this.db.run('DROP TRIGGER IF EXISTS pages_ai')
        this.db.run('DROP TRIGGER IF EXISTS pages_ad')
        this.db.run('DROP TRIGGER IF EXISTS pages_au')
        this.db.run(`CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN
          INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
          VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
          INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
        END`)
        this.db.run(`CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
          VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
          INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
        END`)
        this.db.run(`CREATE TRIGGER pages_au AFTER UPDATE ON pages BEGIN
          INSERT INTO pages_fts(pages_fts, rowid, title, role_heading, abstract, path, declaration)
          VALUES ('delete', old.id, old.title, old.role_heading, old.abstract, old.path, old.declaration);
          INSERT INTO pages_fts(rowid, title, role_heading, abstract, path, declaration)
          VALUES (new.id, new.title, new.role_heading, new.abstract, new.path, new.declaration);
          INSERT INTO titles_trigram(titles_trigram, rowid, title) VALUES ('delete', old.id, old.title);
          INSERT INTO titles_trigram(rowid, title) VALUES (new.id, new.title);
        END`)
        // Backfill trigram table from existing pages
        this.db.run('INSERT INTO titles_trigram(rowid, title) SELECT id, title FROM pages WHERE title IS NOT NULL')
      }
      this.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
      this.db.run('COMMIT')
    } catch (e) {
      this.db.run('ROLLBACK')
      throw new Error(`Migration from v${current} to v${SCHEMA_VERSION} failed: ${e.message}`)
    }
  }

  _prepareStatements() {
    this._upsertRoot = this.db.query(`
      INSERT INTO roots (slug, display_name, kind, status, source, seed_path, first_seen, last_seen)
      VALUES ($slug, $display_name, $kind, 'active', $source, $seed_path, $now, $now)
      ON CONFLICT(slug) DO UPDATE SET
        display_name = $display_name,
        kind = CASE WHEN excluded.kind != 'unknown' THEN excluded.kind ELSE roots.kind END,
        seed_path = COALESCE($seed_path, roots.seed_path),
        last_seen = $now,
        source = $source
      RETURNING id
    `)

    this._upsertPage = this.db.query(`
      INSERT INTO pages (root_id, path, url, title, role, role_heading, abstract, platforms, declaration, etag, last_modified, content_hash, downloaded_at, status)
      VALUES ($root_id, $path, $url, $title, $role, $role_heading, $abstract, $platforms, $declaration, $etag, $last_modified, $content_hash, $downloaded_at, 'active')
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
        status = 'active'
      RETURNING id
    `)

    this._getPage = this.db.query('SELECT p.*, r.slug as root_slug, r.display_name as framework FROM pages p JOIN roots r ON p.root_id = r.id WHERE p.path = ? AND p.status = ?')

    this._getPagesByRoot = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract
      FROM pages p JOIN roots r ON p.root_id = r.id
      WHERE r.slug = ? AND p.status = 'active'
      ORDER BY p.path
    `)

    this._searchPages = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             bm25(pages_fts, 10.0, 5.0, 3.0, 2.0, 1.0) as rank,
             CASE
               WHEN LOWER(p.title) = LOWER($raw) THEN 0
               WHEN LOWER(p.title) LIKE LOWER($raw) || '%' THEN 1
               WHEN INSTR(LOWER(p.title), LOWER($raw)) > 0 THEN 2
               ELSE 3
             END as tier
      FROM pages_fts
      JOIN pages p ON pages_fts.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE pages_fts MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      ORDER BY tier, rank
      LIMIT $limit
    `)

    // Trigram substring search on titles
    this._searchTrigram = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug
      FROM titles_trigram
      JOIN pages p ON titles_trigram.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE titles_trigram MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      LIMIT $limit
    `)

    // Full-body search
    this._searchBody = this.db.query(`
      SELECT p.path, p.title, p.role, p.role_heading, p.abstract,
             p.declaration, p.platforms, r.display_name as framework, r.slug as root_slug,
             bm25(pages_body_fts, 1.0) as rank
      FROM pages_body_fts
      JOIN pages p ON pages_body_fts.rowid = p.id
      JOIN roots r ON p.root_id = r.id
      WHERE pages_body_fts MATCH $query
        AND ($framework IS NULL OR r.slug = $framework)
        AND ($kind IS NULL OR p.role = $kind)
        AND p.status = 'active'
      ORDER BY rank
      LIMIT $limit
    `)

    this._bodyIndexCount = this.db.query('SELECT COUNT(*) as c FROM pages_body_fts')
    this._insertBody = this.db.query('INSERT OR REPLACE INTO pages_body_fts(rowid, body) VALUES ($id, $body)')
    this._clearBody = this.db.query("DELETE FROM pages_body_fts")

    // Trigram candidates for fuzzy (returns id + title for JS-side Levenshtein)
    this._trigramCandidates = this.db.query(`
      SELECT p.id, p.title FROM titles_trigram
      JOIN pages p ON titles_trigram.rowid = p.id
      WHERE titles_trigram MATCH $trigram AND p.status = 'active'
    `)

    this._searchByTitle = this.db.query(`
      SELECT p.*, r.slug as root_slug, r.display_name as framework
      FROM pages p JOIN roots r ON p.root_id = r.id
      WHERE p.title = $title AND p.status = 'active'
        AND ($framework IS NULL OR r.slug = $framework)
      ORDER BY CASE WHEN p.role = 'symbol' THEN 0 ELSE 1 END, length(p.path)
      LIMIT 1
    `)

    this._getRoots = this.db.query('SELECT * FROM roots ORDER BY slug')
    this._getRootsByKind = this.db.query('SELECT * FROM roots WHERE kind = ? ORDER BY slug')
    this._getRootBySlug = this.db.query('SELECT * FROM roots WHERE slug = ?')

    this._addRef = this.db.query('INSERT INTO refs (source_id, target_path, anchor_text, section) VALUES (?, ?, ?, ?)')
    this._getRefsBySource = this.db.query('SELECT target_path, anchor_text, section FROM refs WHERE source_id = ? ORDER BY section, anchor_text')
    this._deleteRefsBySource = this.db.query('DELETE FROM refs WHERE source_id = ?')

    this._setCrawlState = this.db.query(`
      INSERT INTO crawl_state (path, status, root_slug, depth, error)
      VALUES ($path, $status, $root_slug, $depth, $error)
      ON CONFLICT(path) DO UPDATE SET status = $status, error = $error
    `)
    this._getPendingCrawl = this.db.query("SELECT path, depth FROM crawl_state WHERE status = 'pending' AND root_slug = ? LIMIT ?")
    this._resetFailedCrawl = this.db.query("UPDATE crawl_state SET status = 'pending', error = NULL WHERE status = 'failed' AND root_slug = ?")
    this._countFailed = this.db.query("SELECT COUNT(*) as count FROM crawl_state WHERE status = 'failed' AND root_slug = ?")
    this._countCrawlState = this.db.query('SELECT status, COUNT(*) as count FROM crawl_state WHERE root_slug = ? GROUP BY status')
    this._clearCrawlState = this.db.query('DELETE FROM crawl_state WHERE root_slug = ?')

    this._addUpdateLog = this.db.query(`
      INSERT INTO update_log (timestamp, root_slug, action, new_count, mod_count, del_count, err_count, duration_ms)
      VALUES ($timestamp, $root_slug, $action, $new_count, $mod_count, $del_count, $err_count, $duration_ms)
    `)
    this._getLastUpdateLog = this.db.query("SELECT * FROM update_log ORDER BY id DESC LIMIT 1")

    this._updatePageConverted = this.db.query("UPDATE pages SET converted_at = ? WHERE path = ?")
    this._getUnconvertedPages = this.db.query("SELECT p.path FROM pages p WHERE p.converted_at IS NULL AND p.downloaded_at IS NOT NULL AND p.status = 'active'")
    this._updateRootPageCount = this.db.query("UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages WHERE root_id = roots.id AND status = 'active') WHERE slug = ?")
    this._getAllPagesWithEtag = this.db.query("SELECT path, etag FROM pages WHERE etag IS NOT NULL AND status = 'active'")
    this._markPageDeleted = this.db.query("UPDATE pages SET status = 'deleted' WHERE path = ?")
    this._updatePageEtag = this.db.query("UPDATE pages SET etag = $etag, last_modified = $last_modified, content_hash = $content_hash, downloaded_at = $downloaded_at WHERE path = $path")

    // Activity tracking
    this._setActivity = this.db.query("INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) VALUES (1, $action, $started_at, $pid, $roots)")
    this._clearActivity = this.db.query("DELETE FROM activity WHERE id = 1")
    this._getActivity = this.db.query("SELECT * FROM activity WHERE id = 1")

    // Per-root crawl progress
    this._crawlProgressByRoot = this.db.query(`
      SELECT root_slug,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM crawl_state
      GROUP BY root_slug
      ORDER BY root_slug
    `)
    this._crawlProgressAll = this.db.query(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
      FROM crawl_state
    `)
  }

  upsertRoot(slug, displayName, kind, source, seedPath = null) {
    const now = new Date().toISOString()
    return this._upsertRoot.get({ $slug: slug, $display_name: displayName, $kind: kind, $source: source, $seed_path: seedPath, $now: now })
  }

  upsertPage(params) {
    return this._upsertPage.get({
      $root_id: params.rootId,
      $path: params.path,
      $url: params.url,
      $title: params.title ?? null,
      $role: params.role ?? null,
      $role_heading: params.roleHeading ?? null,
      $abstract: params.abstract ?? null,
      $platforms: params.platforms ? JSON.stringify(params.platforms) : null,
      $declaration: params.declaration ?? null,
      $etag: params.etag ?? null,
      $last_modified: params.lastModified ?? null,
      $content_hash: params.contentHash ?? null,
      $downloaded_at: params.downloadedAt ?? null,
    })
  }

  getPage(path) {
    return this._getPage.get(path, 'active')
  }

  getPagesByRoot(rootSlug) {
    return this._getPagesByRoot.all(rootSlug)
  }

  searchPages(ftsQuery, rawQuery, { framework = null, kind = null, limit = 100 } = {}) {
    return this._searchPages.all({ $query: ftsQuery, $raw: rawQuery, $framework: framework, $kind: kind, $limit: limit })
  }

  searchTrigram(query, { framework = null, kind = null, limit = 100 } = {}) {
    try {
      return this._searchTrigram.all({ $query: query, $framework: framework, $kind: kind, $limit: limit })
    } catch { return [] }
  }

  searchBody(ftsQuery, { framework = null, kind = null, limit = 100 } = {}) {
    try {
      return this._searchBody.all({ $query: ftsQuery, $framework: framework, $kind: kind, $limit: limit })
    } catch { return [] }
  }

  getBodyIndexCount() {
    try { return this._bodyIndexCount.get().c } catch { return 0 }
  }

  insertBody(pageId, body) {
    this._insertBody.run({ $id: pageId, $body: body })
  }

  clearBodyIndex() {
    this._clearBody.run()
  }

  getTrigramCandidates(trigram) {
    try { return this._trigramCandidates.all({ $trigram: trigram }) } catch { return [] }
  }

  searchByTitle(title, framework = null) {
    return this._searchByTitle.get({ $title: title, $framework: framework })
  }

  getRoots(kind = null) {
    return kind ? this._getRootsByKind.all(kind) : this._getRoots.all()
  }

  getRootBySlug(slug) {
    return this._getRootBySlug.get(slug)
  }

  /**
   * Resolve a root by exact slug, then by case-insensitive slug/display_name substring.
   * Returns the best match or null.
   */
  resolveRoot(input) {
    // Exact match first
    const exact = this._getRootBySlug.get(input)
    if (exact) return exact

    // Fuzzy: case-insensitive match on slug or display_name
    const lower = input.toLowerCase()
    const all = this._getRoots.all()
    return all.find(r => r.slug.toLowerCase() === lower)
      ?? all.find(r => r.display_name.toLowerCase().includes(lower))
      ?? all.find(r => r.slug.includes(lower))
      ?? null
  }

  addRef(sourceId, targetPath, anchorText, section) {
    this._addRef.run(sourceId, targetPath, anchorText, section)
  }

  deleteRefsBySource(sourceId) {
    this._deleteRefsBySource.run(sourceId)
  }

  getRefsBySource(sourceId) {
    return this._getRefsBySource.all(sourceId)
  }

  setCrawlState(path, status, rootSlug, depth = 0, error = null) {
    this._setCrawlState.run({ $path: path, $status: status, $root_slug: rootSlug, $depth: depth, $error: error })
  }

  seedCrawlIfNew(path, rootSlug, depth = 0) {
    // Only insert if not already known
    const existing = this.db.query('SELECT 1 FROM crawl_state WHERE path = ?').get(path)
    if (!existing) {
      this.setCrawlState(path, 'pending', rootSlug, depth)
      return true
    }
    return false
  }

  getPendingCrawl(rootSlug, limit = 10) {
    return this._getPendingCrawl.all(rootSlug, limit)
  }

  resetFailedCrawl(rootSlug) {
    return this._resetFailedCrawl.run(rootSlug)
  }

  countFailed(rootSlug) {
    return this._countFailed.get(rootSlug).count
  }

  getCrawlStats(rootSlug) {
    const rows = this._countCrawlState.all(rootSlug)
    const stats = { pending: 0, processed: 0, failed: 0 }
    for (const row of rows) stats[row.status] = row.count
    return stats
  }

  clearCrawlState(rootSlug) {
    this._clearCrawlState.run(rootSlug)
  }

  addUpdateLog(params) {
    this._addUpdateLog.run({
      $timestamp: new Date().toISOString(),
      $root_slug: params.rootSlug ?? null,
      $action: params.action,
      $new_count: params.newCount ?? 0,
      $mod_count: params.modCount ?? 0,
      $del_count: params.delCount ?? 0,
      $err_count: params.errCount ?? 0,
      $duration_ms: params.durationMs ?? null,
    })
  }

  getLastUpdateLog() {
    return this._getLastUpdateLog.get()
  }

  markConverted(path) {
    this._updatePageConverted.run(new Date().toISOString(), path)
  }

  getUnconvertedPages() {
    return this._getUnconvertedPages.all()
  }

  updateRootPageCount(slug) {
    this._updateRootPageCount.run(slug)
  }

  getAllPagesWithEtag() {
    return this._getAllPagesWithEtag.all()
  }

  markPageDeleted(path) {
    this._markPageDeleted.run(path)
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

  setActivity(action, roots = null) {
    this._setActivity.run({
      $action: action,
      $started_at: new Date().toISOString(),
      $pid: process.pid,
      $roots: roots ? JSON.stringify(roots) : null,
    })
  }

  clearActivity() {
    this._clearActivity.run()
  }

  getActivity() {
    const row = this._getActivity.get()
    if (!row) return null

    // Check if the process is still alive
    try {
      process.kill(row.pid, 0) // signal 0 = existence check
      return { ...row, alive: true, roots: row.roots ? JSON.parse(row.roots) : null }
    } catch {
      // Process is dead — stale activity from a killed run
      return { ...row, alive: false, roots: row.roots ? JSON.parse(row.roots) : null }
    }
  }

  getCrawlProgressByRoot() {
    return this._crawlProgressByRoot.all()
  }

  getCrawlProgressAll() {
    return this._crawlProgressAll.get() ?? { pending: 0, processed: 0, failed: 0, total: 0 }
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
