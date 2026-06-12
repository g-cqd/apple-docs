#!/usr/bin/env bun
/**
 * Content renderer benchmark (RFC 0004 phases 1-2): JS vs native pages/s
 * for the three surfaces, over the real local corpus.
 *
 *   bun test/benchmarks/content-bench.js [--docs 2000] [--pages 500]
 *
 * Requires a populated $APPLE_DOCS_HOME and the dev dylib (or
 * APPLE_DOCS_NATIVE_LIB). Numbers are recorded in rfcs/0004 per phase.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { DocsDatabase } from '../../src/storage/database.js'
import { _forceImpl, nativeConvertPages } from '../../src/content/content-native.js'
import { renderMarkdown } from '../../src/content/render-markdown.js'
import { renderPlainText } from '../../src/content/render-text.js'
import { renderPage } from '../../src/apple/renderer.js'
import { keyPath } from '../../src/lib/safe-path.js'
import { readJSON } from '../../src/storage/files.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i > -1 ? Number.parseInt(args[i + 1], 10) : fallback
}
const DOCS = flag('--docs', 2000)
const PAGES = flag('--pages', 500)

const DEV_LIB = new URL(`../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
process.env.APPLE_DOCS_NATIVE_LIB ??= existsSync(DEV_LIB) ? DEV_LIB : process.env.APPLE_DOCS_NATIVE_LIB

const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const dbPath = join(home, 'apple-docs.db')
if (!existsSync(dbPath)) {
  console.error('content-bench: no local corpus DB — nothing to measure')
  process.exit(2)
}
const db = new DocsDatabase(dbPath)

// Deterministic workload: lowest-id docs with sections.
const rows = db.db
  .query(`
    SELECT d.id, d.key, d.title, d.framework, d.role, d.role_heading, d.platforms_json,
           d.abstract_text, d.declaration_text, d.headings
    FROM documents d
    WHERE EXISTS (SELECT 1 FROM document_sections s WHERE s.document_id = d.id)
    ORDER BY d.id LIMIT ?
  `)
  .all(DOCS)
const workload = rows.map((row) => ({
  document: {
    key: row.key, title: row.title, framework: row.framework, role: row.role,
    role_heading: row.role_heading, platforms_json: row.platforms_json,
  },
  plainDocument: {
    title: row.title, abstract_text: row.abstract_text,
    declaration_text: row.declaration_text, headings: row.headings,
  },
  sections: db.getDocumentSections(row.key),
}))

const pages = []
for (const row of rows) {
  if (pages.length >= PAGES) break
  const jsonPath = keyPath(home, 'raw-json', row.key, '.json')
  if (!existsSync(jsonPath)) continue
  const json = await readJSON(jsonPath)
  if (json) pages.push({ json, path: row.key })
}

function measure(label, impl, fn, count) {
  _forceImpl(impl)
  fn() // warmup
  const t0 = performance.now()
  fn()
  const seconds = (performance.now() - t0) / 1000
  const rate = (count / seconds).toFixed(0)
  console.log(`${label} ${impl}: ${count} in ${seconds.toFixed(2)}s → ${rate}/s`)
  _forceImpl(null)
  return Number(rate)
}

const runDocs = () => {
  for (const w of workload) renderMarkdown(w.document, w.sections)
}
const runText = () => {
  for (const w of workload) renderPlainText(w.plainDocument, w.sections)
}
const runPages = () => {
  for (const p of pages) renderPage(p.json, p.path)
}

console.log(`corpus: ${workload.length} docs, ${pages.length} raw pages`)
const docJs = measure('doc-markdown', 'js', runDocs, workload.length)
const docNative = measure('doc-markdown', 'native', runDocs, workload.length)
const textJs = measure('plaintext', 'js', runText, workload.length)
const textNative = measure('plaintext', 'native', runText, workload.length)
let pageJs = 0
let pageNative = 0
if (pages.length > 0) {
  pageJs = measure('page-markdown', 'js', runPages, pages.length)
  pageNative = measure('page-markdown', 'native', runPages, pages.length)
}

// The phase-2 production shape: file → markdown (read + parse + render;
// writes are identical JS on both sides and excluded). JS does
// readJSON+renderPage per page; native converts the batch in one call.
const convertEntries = []
for (const row of rows) {
  if (convertEntries.length >= PAGES) break
  const filePath = keyPath(home, 'raw-json', row.key, '.json')
  if (existsSync(filePath)) convertEntries.push({ path: row.key, filePath })
}
let convertJs = 0
let convertNative = 0
if (convertEntries.length > 0) {
  _forceImpl('js')
  const runJsConvert = async () => {
    for (const e of convertEntries) renderPage(await readJSON(e.filePath), e.path)
  }
  await runJsConvert()
  let t0 = performance.now()
  await runJsConvert()
  let seconds = (performance.now() - t0) / 1000
  convertJs = Math.round(convertEntries.length / seconds)
  console.log(`file-convert js: ${convertEntries.length} in ${seconds.toFixed(2)}s → ${convertJs}/s`)

  _forceImpl('native')
  const runNativeConvert = () => {
    for (let i = 0; i < convertEntries.length; i += 64) {
      const results = nativeConvertPages(convertEntries.slice(i, i + 64))
      if (!results) throw new Error('native convert unavailable')
    }
  }
  runNativeConvert()
  t0 = performance.now()
  runNativeConvert()
  seconds = (performance.now() - t0) / 1000
  convertNative = Math.round(convertEntries.length / seconds)
  console.log(`file-convert native: ${convertEntries.length} in ${seconds.toFixed(2)}s → ${convertNative}/s`)
  _forceImpl(null)
}
db.close?.()

const ratio = (a, b) => (b > 0 ? (a / b).toFixed(2) : 'n/a')
console.log(
  `ratios native/js: doc ${ratio(docNative, docJs)}× text ${ratio(textNative, textJs)}× page ${ratio(pageNative, pageJs)}× file-convert ${ratio(convertNative, convertJs)}×`,
)
