import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { ensureNormalizedDocument } from '../content/hydrate.js'
import { renderPlainText } from '../content/render-text.js'

/**
 * Index all markdown page bodies into pages_body_fts.
 * Clears existing index and rebuilds from scratch.
 */
export async function indexBodyFull(db, dataDir, logger, onProgress) {
  if (db.hasNormalizedDocuments()) {
    return indexNormalizedBody(db, dataDir, logger, null, onProgress)
  }

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
  if (db.hasNormalizedDocuments()) {
    const lastIndexed = db.db.query("SELECT value FROM schema_meta WHERE key = 'body_indexed_at'").get()?.value ?? null
    return indexNormalizedBody(db, dataDir, logger, lastIndexed, onProgress)
  }

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

async function indexNormalizedBody(db, dataDir, logger, since, onProgress) {
  const documents = since
    ? db.db.query(`
      SELECT id, key, title, abstract_text, declaration_text, headings, source_type
      FROM documents
      WHERE updated_at > ?
      ORDER BY id
    `).all(since)
    : db.db.query(`
      SELECT id, key, title, abstract_text, declaration_text, headings, source_type
      FROM documents
      ORDER BY id
    `).all()

  if (documents.length === 0) {
    logger.info(since ? 'Body index is up to date' : 'No normalized documents to index')
    return { indexed: 0, total: 0, errors: 0 }
  }

  logger.info(`${since ? 'Updating' : 'Building'} normalized body index for ${documents.length} documents...`)
  if (!since) {
    db.clearBodyIndex()
  }

  let indexed = 0
  let errors = 0

  db.db.run('BEGIN')
  try {
    for (const document of documents) {
      try {
        let sections = db.db.query(`
          SELECT section_kind, heading, content_text, content_json, sort_order
          FROM document_sections
          WHERE document_id = ?
          ORDER BY sort_order, id
        `).all(document.id).map(section => ({
          sectionKind: section.section_kind,
          heading: section.heading,
          contentText: section.content_text,
          contentJson: section.content_json,
          sortOrder: section.sort_order,
        }))

        if (sections.length === 0) {
          await ensureNormalizedDocument(db, dataDir, document.key, document.source_type ?? 'apple-docc')
          sections = db.getDocumentSections(document.key)
        }

        const body = renderPlainText(document, sections)
        if (body.length > 0) {
          db.insertBody(document.id, body)
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
        onProgress?.({ indexed, total: documents.length, errors })
        logger.info(`Indexed ${indexed}/${documents.length} documents...`)
      }
    }
    db.db.run('COMMIT')
  } catch (error) {
    db.db.run('ROLLBACK')
    throw error
  }

  db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', ?)", [new Date().toISOString()])
  logger.info(`Body index complete: ${indexed} documents indexed, ${errors} errors`)
  return { indexed, total: documents.length, errors }
}
