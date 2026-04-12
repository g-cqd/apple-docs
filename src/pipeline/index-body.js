import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

/**
 * Index all markdown page bodies into pages_body_fts.
 * Clears existing index and rebuilds from scratch.
 */
export async function indexBodyFull(db, dataDir, logger, onProgress) {
  const mdDir = join(dataDir, 'markdown')
  logger.info('Building full-body search index...')

  db.clearBodyIndex()

  const pages = db.db.query("SELECT id, path FROM pages WHERE converted_at IS NOT NULL AND status = 'active'").all()
  let indexed = 0
  let errors = 0

  db.db.run('BEGIN')
  try {
    for (const { id, path } of pages) {
      try {
        const mdPath = join(mdDir, path + '.md')
        const raw = readFileSync(mdPath, 'utf8')
        const body = stripFrontMatter(raw)
        if (body.length > 0) {
          db.insertBody(id, body)
          indexed++
        }
      } catch {
        errors++
      }

      if (indexed % 500 === 0 && indexed > 0) {
        db.db.run('COMMIT')
        db.db.run('BEGIN')
      }
      if (indexed % 5000 === 0 && indexed > 0) {
        onProgress?.({ indexed, total: pages.length, errors })
        logger.info(`Indexed ${indexed}/${pages.length} pages...`)
      }
    }
    db.db.run('COMMIT')
  } catch (e) {
    db.db.run('ROLLBACK')
    throw e
  }

  // Record when we last indexed
  db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [new Date().toISOString()])

  logger.info(`Body index complete: ${indexed} pages indexed, ${errors} errors`)
  return { indexed, total: pages.length, errors }
}

/**
 * Index only pages converted after the last body index build.
 */
export async function indexBodyIncremental(db, dataDir, logger, onProgress) {
  const mdDir = join(dataDir, 'markdown')
  const lastIndexed = db.db.query("SELECT value FROM schema_meta WHERE key = 'body_indexed_at'").get()?.value

  let pages
  if (lastIndexed) {
    pages = db.db.query("SELECT id, path FROM pages WHERE converted_at > ? AND status = 'active'").all(lastIndexed)
  } else {
    // No previous index — do full
    return indexBodyFull(db, dataDir, logger, onProgress)
  }

  if (pages.length === 0) {
    logger.info('Body index is up to date')
    return { indexed: 0, total: 0, errors: 0 }
  }

  logger.info(`Indexing ${pages.length} new/updated pages...`)
  let indexed = 0
  let errors = 0

  db.db.run('BEGIN')
  try {
    for (const { id, path } of pages) {
      try {
        const raw = readFileSync(join(mdDir, path + '.md'), 'utf8')
        const body = stripFrontMatter(raw)
        if (body.length > 0) {
          db.insertBody(id, body)
          indexed++
        }
      } catch {
        errors++
      }
      if (indexed % 500 === 0 && indexed > 0) {
        db.db.run('COMMIT')
        db.db.run('BEGIN')
      }
    }
    db.db.run('COMMIT')
  } catch (e) {
    db.db.run('ROLLBACK')
    throw e
  }

  db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [new Date().toISOString()])

  logger.info(`Incremental index: ${indexed} pages indexed, ${errors} errors`)
  return { indexed, total: pages.length, errors }
}

function stripFrontMatter(md) {
  const match = md.match(/^---\n[\s\S]*?\n---\n/)
  return match ? md.slice(match[0].length).trim() : md.trim()
}
