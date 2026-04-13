/**
 * Rebuild optional search indexes from existing data.
 * Useful for lower-tier snapshots that ship without trigram/body indexes
 * but have enough data in the database to reconstruct them.
 */

/**
 * Rebuild the trigram FTS5 index from existing document titles.
 * The trigram table enables substring/fuzzy matching and can be rebuilt
 * on any tier since titles are always present in the documents table.
 *
 * @param {object} _opts - unused
 * @param {{ db, logger }} ctx
 */
export async function rebuildTrigram(_opts, ctx) {
  const { db, logger } = ctx

  // Create table if it doesn't exist
  if (!db.hasTable('documents_trigram')) {
    logger.info('Creating documents_trigram table...')
    db.db.run(`CREATE VIRTUAL TABLE documents_trigram USING fts5(
      title,
      tokenize='trigram case_sensitive 0'
    )`)
  } else {
    logger.info('Clearing existing trigram index...')
    db.db.run("DELETE FROM documents_trigram")
  }

  // Populate from existing titles
  const count = db.db.query('SELECT COUNT(*) as c FROM documents').get().c
  logger.info(`Indexing ${count} document titles...`)

  db.db.run('INSERT INTO documents_trigram(rowid, title) SELECT id, title FROM documents')

  // Recreate triggers to keep index in sync
  ensureTrigramTriggers(db)

  // Re-prepare statements now that the table exists
  db._prepareStatements()
  db._tier = undefined // Reset cached tier

  logger.info(`Trigram index rebuilt: ${count} titles indexed.`)
  return { status: 'ok', indexed: count }
}

/**
 * Rebuild the body FTS5 index from document_sections.
 * Requires document_sections table (standard tier or above).
 *
 * @param {object} opts - { full?: boolean }
 * @param {{ db, dataDir, logger }} ctx
 */
export async function rebuildBody(opts, ctx) {
  const { db, dataDir, logger } = ctx

  if (!db.hasTable('document_sections')) {
    return {
      status: 'error',
      message: 'Cannot rebuild body index: document_sections table not available (lite tier). Upgrade to standard tier first.',
    }
  }

  const sectionCount = db.db.query('SELECT COUNT(*) as c FROM document_sections').get().c
  if (sectionCount === 0) {
    return {
      status: 'error',
      message: 'No document sections found. Run apple-docs sync first to populate content.',
    }
  }

  // Create table if missing
  if (!db.hasTable('documents_body_fts')) {
    logger.info('Creating documents_body_fts table...')
    db.db.run(`CREATE VIRTUAL TABLE documents_body_fts USING fts5(
      body,
      tokenize='porter unicode61'
    )`)
    // Re-prepare statements now that the table exists
    db._prepareStatements()
    db._tier = undefined
  }

  // Delegate to existing full index builder
  const { indexBodyFull } = await import('../pipeline/index-body.js')
  return indexBodyFull(db, dataDir, logger)
}

/**
 * Ensure triggers keep trigram index in sync with documents table.
 * Existing triggers reference both documents_fts and documents_trigram,
 * so we recreate them to include trigram operations.
 */
function ensureTrigramTriggers(db) {
  // Check if triggers already include trigram operations
  const aiTrigger = db.db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='documents_ai'").get()
  if (aiTrigger?.sql?.includes('documents_trigram')) return // Already has trigram

  db.db.run('DROP TRIGGER IF EXISTS documents_ai')
  db.db.run('DROP TRIGGER IF EXISTS documents_ad')
  db.db.run('DROP TRIGGER IF EXISTS documents_au')

  db.db.run(`CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
  END`)
  db.db.run(`CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    DELETE FROM documents_trigram WHERE rowid = old.id;
  END`)
  db.db.run(`CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id;
    INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
    VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
    DELETE FROM documents_trigram WHERE rowid = old.id;
    INSERT INTO documents_trigram(rowid, title) VALUES (new.id, new.title);
  END`)
}
