import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { taxonomy } from '../../src/commands/taxonomy.js'

let db
let ctx

beforeAll(() => {
  db = new DocsDatabase(':memory:')
  ctx = { db }
  db.upsertDocument({
    key: 'swiftui/view',
    title: 'View',
    framework: 'swiftui',
    role: 'symbol',
    roleHeading: 'Protocol',
    kind: 'symbol',
    sourceType: 'apple-docc',
  })
  db.upsertDocument({
    key: 'swiftui/text',
    title: 'Text',
    framework: 'swiftui',
    role: 'symbol',
    roleHeading: 'Structure',
    kind: 'symbol',
    sourceType: 'apple-docc',
  })
  db.upsertDocument({
    key: 'hig/accessibility',
    title: 'Accessibility',
    framework: 'design',
    role: 'article',
    roleHeading: 'Article',
    kind: 'article',
    sourceType: 'hig',
  })
})

afterAll(() => {
  try { db.close() } catch {}
})

describe('taxonomy', () => {
  test('returns all fields with counts when no field specified', async () => {
    const result = await taxonomy({}, ctx)
    expect(result.kind).toBeArray()
    expect(result.role).toBeArray()
    expect(result.roleHeading).toBeArray()
    expect(result.sourceType).toBeArray()
  })

  test('counts are positive and greater for the most common value', async () => {
    const result = await taxonomy({}, ctx)
    const symbolRow = result.role.find(r => r.value === 'symbol')
    const articleRow = result.role.find(r => r.value === 'article')
    expect(symbolRow.count).toBeGreaterThan(0)
    expect(articleRow.count).toBeGreaterThan(0)
    expect(symbolRow.count).toBeGreaterThanOrEqual(articleRow.count)
  })

  test('field scope returns { field, values }', async () => {
    const result = await taxonomy({ field: 'sourceType' }, ctx)
    expect(result.field).toBe('sourceType')
    expect(result.values).toBeArray()
    const slugs = result.values.map(v => v.value)
    expect(slugs).toContain('apple-docc')
    expect(slugs).toContain('hig')
  })

  test('unknown field falls back to all', async () => {
    const result = await taxonomy({ field: 'bogus' }, ctx)
    expect(result.kind).toBeArray()
  })
})
