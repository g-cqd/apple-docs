// Seed a synthetic corpus for the chrome-headless web parity gate
// (scripts/web-parity-headless.mjs). No corpus.db ships in the repo, so the
// gate builds both sites from this deterministic fixture:
//
//   bun scripts/web-parity-seed.mjs /tmp/webgate
//   swift/.build/debug/ad-cli web build --db /tmp/webgate/apple-docs.db \
//     --out /tmp/webgate/dist-swift --site-name "Apple Developer Docs" \
//     --app-version 1.0.0 --skip-docs
//   bun cli.js web build --home /tmp/webgate --out /tmp/webgate/dist-bun \
//     --site-name "Apple Developer Docs" --skip-docs
//   bun scripts/web-parity-headless.mjs --bun /tmp/webgate/dist-bun \
//     --swift /tmp/webgate/dist-swift --show-diff
//
// Uses the project's own migrations (DocsDatabase auto-migrates), then inserts
// the minimum rows each surface reads: roots (page_count >= 2 so the homepage
// self-page filter keeps them), pages (root membership), documents + sections +
// relationships (the S5 render loop), sf_symbols (the /symbols page),
// snapshot_meta (footer stamps). Fonts are seeded only with --fonts — the
// Swift fonts-JSON adapter is an S5 follow-up, so the S6 gate runs fontless
// (both sides emit an EMPTY api/fonts/faces.css).

import { existsSync, mkdirSync } from 'node:fs'
import { DocsDatabase } from '../src/storage/database.js'

const dir = process.argv[2]
const withFonts = process.argv.includes('--fonts')
if (!dir) {
  console.error('usage: bun scripts/web-parity-seed.mjs <dir> [--fonts]')
  process.exit(1)
}
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
if (existsSync(`${dir}/apple-docs.db`)) {
  console.error(`refusing to seed over an existing ${dir}/apple-docs.db`)
  process.exit(1)
}

const d = new DocsDatabase(`${dir}/apple-docs.db`)
const db = /** @type {any} */ (d).db
const now = '2026-01-01T00:00:00.000Z'

/** @param {string} sql @param {...any} args */
const run = (sql, ...args) => db.query(sql).run(...args)

// --- roots (page_count kept == active page count == document count) ---------
run(
  `INSERT INTO roots (slug, display_name, source, first_seen, last_seen, kind, page_count) VALUES (?,?,?,?,?,?,?)`,
  'swiftui', 'SwiftUI', 'https://developer.apple.com/documentation/swiftui', now, now, 'framework', 3,
)
run(
  `INSERT INTO roots (slug, display_name, source, first_seen, last_seen, kind, page_count) VALUES (?,?,?,?,?,?,?)`,
  'foundation', 'Foundation', 'https://developer.apple.com/documentation/foundation', now, now, 'framework', 2,
)

// --- pages -------------------------------------------------------------------
/** @param {number} rootId @param {string} path */
const page = (rootId, path) => run(`INSERT INTO pages (root_id, path, url) VALUES (?,?,?)`, rootId, path, `https://developer.apple.com/documentation/${path}`)
page(1, 'swiftui')
page(1, 'swiftui/view')
page(1, 'swiftui/state')
page(2, 'foundation')
page(2, 'foundation/urlsession')

// --- documents ---------------------------------------------------------------
/** @param {string} key @param {string} title @param {string} fw @param {Record<string, any>} extra */
const doc = (key, title, fw, extra = {}) =>
  run(
    `INSERT INTO documents (key, title, framework, kind, role, role_heading, abstract_text, url, language, platforms_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    key, title, fw,
    extra.kind ?? 'symbol', extra.role ?? 'symbol', extra.roleHeading ?? null,
    extra.abstract ?? null, `https://developer.apple.com/documentation/${key}`,
    extra.language ?? 'swift', extra.platforms ?? null,
  )
doc('swiftui', 'SwiftUI', 'swiftui', { kind: 'framework', role: 'collection', abstract: 'Declarative UI for every Apple platform.' })
doc('swiftui/view', 'View', 'swiftui', {
  roleHeading: 'Protocol',
  abstract: 'A type that represents part of your app’s <user> interface & "chrome".',
  platforms: '[{"name":"iOS","introducedAt":"13.0"},{"name":"macOS","introducedAt":"10.15"}]',
})
doc('swiftui/state', 'State', 'swiftui', { roleHeading: 'Structure', abstract: 'A property wrapper that reads and writes a value.' })
doc('foundation', 'Foundation', 'foundation', { kind: 'framework', role: 'collection', abstract: 'Essential data types & collections.' })
doc('foundation/urlsession', 'URLSession', 'foundation', { roleHeading: 'Class', abstract: 'Coordinates network data-transfer tasks.' })

// --- sections ----------------------------------------------------------------
/** @param {number} docId @param {string} kind @param {string} text @param {number} order @param {string|null} heading */
const section = (docId, kind, text, order, heading = null) =>
  run(`INSERT INTO document_sections (document_id, section_kind, content_text, sort_order, heading) VALUES (?,?,?,?,?)`, docId, kind, text, order, heading)
section(2, 'declaration', 'protocol View', 0)
section(2, 'content', 'Views are the building blocks of SwiftUI interfaces.', 1, 'Overview')
section(3, 'declaration', '@propertyWrapper struct State<Value>', 0)
section(5, 'content', 'URLSession coordinates a group of related network tasks.', 0, 'Overview')

// --- relationships (the framework tree) ---------------------------------------
run(`INSERT INTO document_relationships (from_key, to_key, relation_type) VALUES (?,?,?)`, 'swiftui', 'swiftui/view', 'child')
run(`INSERT INTO document_relationships (from_key, to_key, relation_type) VALUES (?,?,?)`, 'swiftui', 'swiftui/state', 'child')
run(`INSERT INTO document_relationships (from_key, to_key, relation_type) VALUES (?,?,?)`, 'foundation', 'foundation/urlsession', 'child')

// --- sf_symbols ---------------------------------------------------------------
run(`INSERT INTO sf_symbols (name, scope, updated_at) VALUES (?,?,?)`, 'star.fill', 'public', now)
run(`INSERT INTO sf_symbols (name, scope, updated_at) VALUES (?,?,?)`, 'heart', 'public', now)
run(`INSERT INTO sf_symbols (name, scope, updated_at) VALUES (?,?,?)`, 'internal.badge', 'private', now)

// --- snapshot provenance (footer stamps) ---------------------------------------
run(`INSERT INTO snapshot_meta (key, value) VALUES (?,?)`, 'snapshot_tag', 'snapshot-20260101')
run(`INSERT INTO snapshot_meta (key, value) VALUES (?,?)`, 'build_macos', '26.1')

// --- fonts (S5 fonts-JSON parity; off by default) ------------------------------
if (withFonts) {
  run(
    `INSERT INTO apple_font_families (id, display_name, status, updated_at) VALUES (?,?,?,?)`,
    'sf-pro', 'SF Pro', 'available', now,
  )
  run(
    `INSERT INTO apple_font_files (id, family_id, file_name, file_path, format, source, is_variable, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    'sf-pro-regular', 'sf-pro', 'SF-Pro.ttf', 'fonts/SF-Pro.ttf', 'ttf', 'remote', 1, now,
  )
}

d.close?.()
console.log(`seeded ${dir}/apple-docs.db${withFonts ? ' (with fonts)' : ''}`)
