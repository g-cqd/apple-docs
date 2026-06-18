// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'

let dataDir

const CLI = new URL('../../../cli.js', import.meta.url).pathname

const INFRA_BLACKLIST = new Set([
  'matchQuality',
  'distance',
  'score',
  'tier',
  'tierLimitation',
  'trigramAvailable',
  'bodyIndexAvailable',
  'relaxed',
  'relaxationTier',
  'partial',
  'partialReasons',
  'urlDepth',
  'sourceMetadata',
  'intent',
  'sectionKind',
  'sortOrder',
  'file_path',
  'lastSeen',
])

function assertNoBlacklistedDeep(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoBlacklistedDeep(value[i], `${path}[${i}]`)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (INFRA_BLACKLIST.has(key)) {
        throw new Error(`CLI --json leak: "${key}" at ${path}`)
      }
      assertNoBlacklistedDeep(value[key], `${path}.${key}`)
    }
  }
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args, '--home', dataDir, '--json'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-leak-'))
  // Seed a minimal DB at the data-dir path the CLI will use.
  const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  // frameworks lists roots by live page count — the root needs a page row.
  db.upsertPage({
    rootId: root.id,
    url: 'https://example.com/swiftui/view',
    path: 'swiftui/view',
    title: 'View',
    role: 'symbol',
    abstract: "A type that represents part of your app's user interface.",
  })
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: "A type that represents part of your app's user interface.",
    },
    sections: [{ sectionKind: 'abstract', contentText: 'abstract text', sortOrder: 0 }],
    relationships: [],
  })
  db.close()
})

afterAll(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

function parseJsonOrFail(stdout, label) {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${label}: stdout not valid JSON: ${stdout.slice(0, 200)}`)
  }
}

describe('apple-docs --json output respects public allowlist', () => {
  test('search', () => {
    const r = runCli(['search', 'View'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'search')
    assertNoBlacklistedDeep(out)
    expect(out).toHaveProperty('query')
    expect(out).toHaveProperty('total')
    expect(out).toHaveProperty('results')
    for (const hit of out.results ?? []) {
      expect(['exact', 'partial', 'approximate']).toContain(hit.confidence)
    }
  })

  test('read', () => {
    const r = runCli(['read', 'swiftui/view'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'read')
    assertNoBlacklistedDeep(out)
    expect(out.found).toBe(true)
    expect(out.metadata.title).toBe('View')
  })

  test('frameworks', () => {
    const r = runCli(['frameworks'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'frameworks')
    assertNoBlacklistedDeep(out)
    expect(out.total).toBeGreaterThan(0)
  })

  test('browse', () => {
    const r = runCli(['browse', 'swiftui'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'browse')
    assertNoBlacklistedDeep(out)
    expect(out.framework).toBe('SwiftUI')
  })

  test('kinds (taxonomy)', () => {
    const r = runCli(['kinds'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'kinds')
    assertNoBlacklistedDeep(out)
  })

  test('status default (no --advanced)', () => {
    const r = runCli(['status'])
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'status')
    assertNoBlacklistedDeep(out)
    expect(out.tier).toBeUndefined()
    expect(out.capabilities).toBeUndefined()
  })

  test('APPLE_DOCS_DEBUG=1 re-enables passthrough', () => {
    const r = runCli(['search', 'View'], { APPLE_DOCS_DEBUG: '1' })
    expect(r.status).toBe(0)
    const out = parseJsonOrFail(r.stdout, 'search-debug')
    // Debug mode: at least one of these infrastructural fields is back.
    const hasAnyInfra =
      out.tier !== undefined ||
      out.trigramAvailable !== undefined ||
      out.bodyIndexAvailable !== undefined ||
      out.intent !== undefined ||
      (out.results ?? []).some((r) => r.matchQuality !== undefined || r.urlDepth !== undefined)
    expect(hasAnyInfra).toBe(true)
  })
})
