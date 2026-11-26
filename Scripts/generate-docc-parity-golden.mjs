#!/usr/bin/env bun
// Regenerates the DocC normalization golden files used by AppleDocsContentTests from the Bun reference
// implementation: for every manifest entry, `<name>.input.json` (raw DocC render JSON) is normalized by
// Bun's `normalize()` and written to `<name>.bun.json` as { document, sections, relationships }, with each
// section's `contentJson` parsed so Swift can compare it structurally.
//
// Usage: bun Scripts/generate-docc-parity-golden.mjs <path-to-bun-apple-docs-repo> [fixtures-dir]
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const bunRepo = resolve(process.argv[2] ?? '../apple-docs')
const fixtures = resolve(process.argv[3] ?? 'Tests/AppleDocsContentTests/Fixtures/DocCParity')
const { normalize } = await import(join(bunRepo, 'src/content/normalize.js'))

const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'))
for (const entry of manifest) {
  const input = JSON.parse(readFileSync(join(fixtures, `${entry.name}.input.json`), 'utf8'))
  const result = normalize(input, entry.key, entry.sourceType)
  const sections = result.sections.map(section => ({
    ...section,
    contentJson: section.contentJson == null ? null : JSON.parse(section.contentJson),
  }))
  const golden = { document: result.document, sections, relationships: result.relationships }
  writeFileSync(join(fixtures, `${entry.name}.bun.json`), `${JSON.stringify(golden, null, 1)}\n`)
  console.log(`${entry.name}: ${sections.length} sections, ${result.relationships.length} relationships`)
}
