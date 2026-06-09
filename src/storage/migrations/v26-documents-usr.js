/**
 * v26 — `documents.usr`: the symbol's precise identifier (Swift / Clang USR,
 * e.g. `s:7SwiftUI4ViewP`), sourced from Xcode's offline Developer
 * Documentation MobileAsset (sources/mobileasset-docs.js). The USR is stable
 * across releases and shared by the Swift/Obj-C variants of one symbol, so it
 * gives cross-referencing an exact join key the crawled RenderJSON never
 * exposes. Nullable — only docs matched against a local Xcode documentation
 * asset carry it. ALTER guarded for re-run safety.
 */
export function up(db) {
  try {
    db.run('ALTER TABLE documents ADD COLUMN usr TEXT')
  } catch { /* column already exists */ }
  db.run('CREATE INDEX IF NOT EXISTS idx_documents_usr ON documents(usr)')
}
