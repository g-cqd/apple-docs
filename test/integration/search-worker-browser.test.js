/**
 * Browser-level smoke for the search Web Worker (P3.3 verification).
 *
 * Boots the dev server against the local corpus, then drives a real
 * headless Chromium instance via Playwright. The worker is exposed as
 * a public asset at `/worker/search-worker.js` for self-hosters; this
 * test instantiates it directly in the page and exchanges init/search
 * messages so the Uint32Array posting refactor is exercised end-to-end.
 *
 * Skipped automatically when:
 *   - The local corpus DB isn't present (CI without `apple-docs sync`)
 *   - Playwright's Chromium build isn't installed
 *
 * Run manually: `bun test --isolate test/integration/search-worker-browser.test.js`
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../src/storage/database.js'
import { startDevServer } from '../../src/web/serve.js'

const DB_PATH = join(homedir(), '.apple-docs', 'apple-docs.db')
const HAS_LOCAL_DB = existsSync(DB_PATH)

let server = null
let db = null
let playwright = null
let chromium = null

beforeAll(async () => {
  if (!HAS_LOCAL_DB) return
  try {
    playwright = await import('playwright')
  } catch {
    playwright = null
  }
  if (!playwright) return

  db = new DocsDatabase(DB_PATH)
  const ctx = { db, dataDir: join(homedir(), '.apple-docs'), logger: { info() {}, warn() {}, error() {} } }
  server = await startDevServer({ port: 0, host: '127.0.0.1' }, ctx)
})

afterAll(async () => {
  try { await chromium?.close?.() } catch {}
  try { await server?.close?.() } catch {}
  try { db?.close?.() } catch {}
})

describe('search worker (headless Chromium)', () => {
  test.skipIf(!HAS_LOCAL_DB)('init + search returns ranked results via Web Worker', async () => {
    if (!playwright) {
      console.warn('skipping browser smoke: playwright not available')
      return
    }
    chromium = await playwright.chromium.launch({ headless: true })
    const ctx = await chromium.newContext()
    const page = await ctx.newPage()

    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`)
    })

    // Land on any same-origin page so the Worker constructor accepts a
    // relative URL.
    await page.goto(`${server.url}/`, { waitUntil: 'domcontentloaded' })

    // Drive init + search inside the page. Returns the worker's result
    // payload plus a couple of internal sanity checks (worker boots,
    // returns a non-empty array, every result has a path + title).
    const probe = await page.evaluate(async (workerUrl) => {
      const worker = new Worker(workerUrl)
      function waitForType(type) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 45_000)
          worker.addEventListener('message', function onMsg(e) {
            if (e.data?.type === 'error') {
              clearTimeout(timer); worker.removeEventListener('message', onMsg)
              reject(new Error(`worker error: ${e.data.message}`))
            } else if (e.data?.type === type) {
              clearTimeout(timer); worker.removeEventListener('message', onMsg)
              resolve(e.data)
            }
          })
        })
      }
      const initStart = performance.now()
      worker.postMessage({ type: 'init', base: '' })
      await waitForType('ready')
      const initMs = performance.now() - initStart

      const searchStart = performance.now()
      worker.postMessage({ type: 'search', query: 'View', limit: 10, seqId: 1 })
      const r1 = await waitForType('results')
      const searchMs = performance.now() - searchStart

      // Second search reuses the warm index — should be much faster.
      const reuseStart = performance.now()
      worker.postMessage({ type: 'search', query: 'NavigationStack', limit: 10, seqId: 2 })
      const r2 = await waitForType('results')
      const reuseMs = performance.now() - reuseStart

      worker.terminate()
      return {
        initMs, searchMs, reuseMs,
        firstQuery: r1.results.map(r => ({ path: r.key, title: r.title })),
        secondQuery: r2.results.map(r => ({ path: r.key, title: r.title })),
      }
    }, '/worker/search-worker.js')

    expect(probe.firstQuery.length).toBeGreaterThan(0)
    expect(probe.firstQuery[0]).toHaveProperty('path')
    expect(probe.firstQuery[0]).toHaveProperty('title')
    expect(probe.firstQuery.every(r => typeof r.path === 'string' && r.path.length > 0)).toBe(true)
    // A query for "View" on a SwiftUI corpus should obviously hit
    // documentation/swiftui/view among the top results.
    expect(probe.firstQuery.some(r => r.path.toLowerCase().includes('swiftui/view'))).toBe(true)

    // Warm-search latency should be well under cold-init latency
    // (this is what the Uint32Array conversion buys us).
    expect(probe.reuseMs).toBeLessThan(probe.initMs)

    expect(pageErrors).toEqual([])

    console.log(
      `  worker: init=${probe.initMs.toFixed(0)}ms cold-search=${probe.searchMs.toFixed(0)}ms warm-search=${probe.reuseMs.toFixed(0)}ms`,
    )

    await ctx.close()
  }, 90_000)
})
