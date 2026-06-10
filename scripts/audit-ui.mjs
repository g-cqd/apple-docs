#!/usr/bin/env bun
/**
 * Browser-driven layout audit for every page carrying filters, sorting,
 * or view-tuning controls. Renders each page across viewports and font
 * scales and reports:
 *
 *   - horizontal document overflow (page wider than the viewport)
 *   - elements spilling past the right viewport edge
 *   - overlapping interactive controls (buttons, inputs, chips, navs)
 *
 * Usage:
 *   bun scripts/audit-ui.mjs                  # chromium, all pages/viewports
 *   bun scripts/audit-ui.mjs --browser webkit # safari engine
 *   bun scripts/audit-ui.mjs --base-url http://127.0.0.1:3000   # reuse a server
 *
 * Without --base-url the script starts `web serve` itself on PORT (43210)
 * against $APPLE_DOCS_HOME. Findings + screenshots land in
 * reports/ui-audit/. Exit 1 when any issue is found.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'reports', 'ui-audit')
const PORT = 43210

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next && !next.startsWith('--')) { args.set(a.slice(2), next); i++ } else args.set(a.slice(2), true)
}

const BROWSER = String(args.get('browser') ?? 'chromium')
const BASE = args.get('base-url') ? String(args.get('base-url')) : null

const PAGES = [
  { id: 'home', path: '/' },
  { id: 'framework-tree', path: '/docs/swiftui/' },
  { id: 'scope-hig', path: '/docs/design/' },
  { id: 'scope-wwdc', path: '/docs/wwdc/' },
  { id: 'scope-guidelines', path: '/docs/app-store-review/' },
  { id: 'treeless-list', path: '/docs/technotes/' },
  { id: 'search', path: '/search?q=NavigationStack' },
  { id: 'symbols', path: '/symbols' },
  { id: 'fonts', path: '/fonts' },
]

const VIEWPORTS = [
  { id: 'phone', width: 375, height: 667 },
  { id: 'tablet', width: 768, height: 1024 },
  { id: 'laptop', width: 1280, height: 800 },
  { id: 'wide', width: 1920, height: 1080 },
]

const FONT_SCALES = [
  { id: 'fs100', rootPx: null },
  { id: 'fs200', rootPx: 32 },
]

const CONTROL_SELECTOR = [
  'button', 'input', 'select', 'textarea', 'a.filter-chip',
  '.view-toggle button', '.scope-jump-nav a', '.theme-option',
  '.collection-filter-bar button', 'summary',
].join(', ')

/** Runs inside the page; returns layout findings. */
function inspectPage(controlSelector) {
  const issues = []
  const vw = window.innerWidth
  const doc = document.documentElement

  if (doc.scrollWidth > vw + 1) {
    issues.push({ type: 'document-overflow-x', detail: `scrollWidth ${doc.scrollWidth} > viewport ${vw}` })
  }

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : ''
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? `«${text}»` : ''}`
  }

  const isVisible = (el) => {
    // checkVisibility handles display/visibility/content-visibility —
    // including children of a closed <details>, which Chromium renders
    // via content-visibility and which still report stale layout rects.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false
    } else {
      const s = getComputedStyle(el)
      if (s.display === 'none' || s.visibility === 'hidden') return false
    }
    if (el.closest('[hidden]')) return false
    const closedDetails = el.closest('details:not([open])')
    if (closedDetails && !el.closest('summary')) return false
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1
  }

  // Right-edge spill (only elements that start inside the viewport — a
  // transformed offscreen drawer is fine).
  for (const el of document.querySelectorAll('body *')) {
    if (!isVisible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.left < vw && r.right > vw + 1 && r.width <= doc.scrollWidth) {
      issues.push({ type: 'viewport-spill', el: describe(el), detail: `right=${Math.round(r.right)} vw=${vw}` })
      if (issues.length > 40) break
    }
  }

  // Overlapping interactive controls (ignore ancestor/descendant pairs).
  const controls = [...document.querySelectorAll(controlSelector)].filter(isVisible)
  const rects = controls.map(el => ({ el, r: el.getBoundingClientRect() }))
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (x > 2 && y > 2) {
        issues.push({ type: 'control-overlap', el: `${describe(a.el)} × ${describe(b.el)}`, detail: `${Math.round(x)}×${Math.round(y)}px` })
      }
    }
  }

  return issues
}

async function waitHealthy(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return
    } catch {}
    await Bun.sleep(400)
  }
  throw new Error(`server not healthy: ${url}`)
}

mkdirSync(OUT, { recursive: true })

let serverProc = null
let baseUrl = BASE
if (!baseUrl) {
  baseUrl = `http://127.0.0.1:${PORT}`
  serverProc = Bun.spawn(['bun', join(ROOT, 'cli.js'), 'web', 'serve', '--port', String(PORT)], {
    cwd: ROOT, stdout: 'ignore', stderr: 'ignore',
  })
  await waitHealthy(baseUrl)
}

const { chromium, webkit } = await import('playwright')
const engine = BROWSER === 'webkit' ? webkit : chromium
const browser = await engine.launch()

const findings = []
let combos = 0
try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    for (const scale of FONT_SCALES) {
      for (const pageDef of PAGES) {
        combos++
        const page = await context.newPage()
        try {
          await page.goto(`${baseUrl}${pageDef.path}`, { waitUntil: 'networkidle', timeout: 30000 })
          if (scale.rootPx) {
            await page.evaluate((px) => { document.documentElement.style.fontSize = `${px}px` }, scale.rootPx)
            await page.waitForTimeout(250)
          }
          const issues = await page.evaluate(inspectPage, CONTROL_SELECTOR)
          if (issues.length > 0) {
            const shot = `${pageDef.id}-${vp.id}-${scale.id}-${BROWSER}.png`
            await page.screenshot({ path: join(OUT, shot), fullPage: false })
            findings.push({ page: pageDef.id, path: pageDef.path, viewport: vp.id, scale: scale.id, browser: BROWSER, issues, screenshot: shot })
          }
        } catch (err) {
          findings.push({ page: pageDef.id, path: pageDef.path, viewport: vp.id, scale: scale.id, browser: BROWSER, issues: [{ type: 'navigation-error', detail: String(err?.message ?? err) }] })
        } finally {
          await page.close()
        }
      }
    }
    await context.close()
  }
} finally {
  await browser.close()
  if (serverProc) { try { serverProc.kill() } catch {} }
}

writeFileSync(join(OUT, `findings-${BROWSER}.json`), JSON.stringify(findings, null, 2))

console.log(`\nUI audit (${BROWSER}): ${combos} page×viewport×scale combos`)
if (findings.length === 0) {
  console.log('No layout issues found.')
} else {
  for (const f of findings) {
    console.log(`\n${f.page} @ ${f.viewport}/${f.scale} (${f.path})`)
    const seen = new Set()
    for (const i of f.issues) {
      const line = `  [${i.type}] ${i.el ?? ''} ${i.detail ?? ''}`.trimEnd()
      if (seen.has(line)) continue
      seen.add(line)
      console.log(line)
    }
    if (f.screenshot) console.log(`  → reports/ui-audit/${f.screenshot}`)
  }
}
process.exit(findings.length > 0 ? 1 : 0)
