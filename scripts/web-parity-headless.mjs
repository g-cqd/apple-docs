// Web-build parity gate — chrome-headless DOM assertion.
//
// Compares two static-site output trees (the JS/`bun cli.js web build` oracle vs
// the native `ad-cli web build`) by rendering each HTML page in headless Chrome
// (JavaScript DISABLED, so the DOM reflects the static markup, not script side
// effects) and diffing a CANONICAL DOM serialization — element structure +
// attributes sorted by name + whitespace-collapsed text. Cosmetic byte
// differences (attribute order, insignificant whitespace, void-element style)
// are ignored; real gaps (missing sections, wrong data, absent pages) surface.
//
// Non-HTML artifacts are compared structurally too: JSON deep-equal (order-
// insensitive), other text exact after trailing-whitespace trim.
//
//   bun scripts/web-parity-headless.mjs --bun dist/web-bun --swift dist/web-swift
//   [--show-diff] [--limit N]
//
// Drives the system Google Chrome via Playwright's `channel: 'chrome'` (no
// `playwright install` needed). Exits non-zero when any page/artifact diverges.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, extname } from 'node:path'
import { chromium } from 'playwright'

// ---- args ----
const args = process.argv.slice(2)
function opt(name, fallback = null) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const bunDir = opt('--bun') ?? args[0]
const swiftDir = opt('--swift') ?? args[1]
const showDiff = args.includes('--show-diff')
const limit = Number(opt('--limit', '0')) || Infinity
if (!bunDir || !swiftDir) {
  console.error('usage: web-parity-headless.mjs --bun <dir> --swift <dir> [--show-diff] [--limit N]')
  process.exit(2)
}

// ---- file walk ----
async function walk(dir) {
  const out = []
  async function rec(d) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) await rec(p)
      else if (e.isFile()) out.push(relative(dir, p))
    }
  }
  await rec(dir)
  return out.sort()
}

// ---- canonical DOM (injected into the page; JS is disabled in the context) ----
const CANONICALIZE = `(() => {
  function canon(node, depth, out) {
    if (node.nodeType === 3) {
      const t = node.textContent.replace(/\\s+/g, ' ').trim()
      if (t) out.push('  '.repeat(depth) + '#' + t)
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()
    const attrs = Array.from(node.attributes, (a) => a.name + '="' + a.value + '"').sort().join(' ')
    out.push('  '.repeat(depth) + '<' + tag + (attrs ? ' ' + attrs : '') + '>')
    for (const c of node.childNodes) canon(c, depth + 1, out)
  }
  const out = []
  canon(document.documentElement, 0, out)
  return out.join('\\n')
})()`

async function canonicalDom(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' })
  return page.evaluate(CANONICALIZE)
}

// ---- structural compare for non-HTML ----
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k])
    return out
  }
  return value
}
function compareNonHtml(ext, a, b, rel) {
  if (ext === '.json' || a.startsWith('{') || a.startsWith('[')) {
    try {
      const pa = JSON.parse(a)
      const pb = JSON.parse(b)
      // search-manifest.json embeds `generatedAt` = new Date().toISOString() —
      // run-varying by definition, so the two builds can never agree on it.
      // Compare the field's PRESENCE + shape (ISO string), not its value.
      if (rel?.endsWith('search-manifest.json')) {
        const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
        if (!iso.test(pa.generatedAt ?? '') || !iso.test(pb.generatedAt ?? '')) {
          return { a: `generatedAt=${pa.generatedAt}`, b: `generatedAt=${pb.generatedAt}` }
        }
        pa.generatedAt = pb.generatedAt = '<generatedAt>'
      }
      const ca = JSON.stringify(canonicalJson(pa))
      const cb = JSON.stringify(canonicalJson(pb))
      return ca === cb ? null : { a: ca, b: cb }
    } catch {
      /* fall through to text */
    }
  }
  const ta = a.replace(/\s+$/gm, '')
  const tb = b.replace(/\s+$/gm, '')
  return ta === tb ? null : { a: ta, b: tb }
}

function firstDiffLine(a, b) {
  const la = a.split('\n')
  const lb = b.split('\n')
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return { line: i + 1, bun: la[i] ?? '<missing>', swift: lb[i] ?? '<missing>' }
  }
  return null
}

// ---- main ----
const bunFiles = new Set(await walk(bunDir))
const swiftFiles = new Set(await walk(swiftDir))
const all = [...new Set([...bunFiles, ...swiftFiles])].sort()

// System Google Chrome by default; WEB_PARITY_CHROME overrides with any
// Chromium-engine executable (e.g. /Applications/Chromium.app/Contents/MacOS/
// Chromium) for hosts without the branded install. The gate renders with
// JavaScript DISABLED, so any Chromium build serializes the same static DOM.
const executablePath = process.env.WEB_PARITY_CHROME
const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: 'chrome', headless: true })
const context = await browser.newContext({ javaScriptEnabled: false })
const page = await context.newPage()

let matched = 0
const diffs = []
const onlyBun = []
const onlySwift = []

let checked = 0
for (const rel of all) {
  if (checked >= limit) break
  if (!swiftFiles.has(rel)) {
    onlyBun.push(rel)
    continue
  }
  if (!bunFiles.has(rel)) {
    onlySwift.push(rel)
    continue
  }
  checked++
  // *.gz artifacts (sitemaps): bun's vendored deflate (zlib-ng lineage) emits a
  // DIFFERENT bitstream than classic zlib at identical settings (verified:
  // same header + length at level 6, different Huffman bytes; levels 1-9 all
  // differ) — both valid gzip. Compare the gunzipped CONTENT instead.
  if (rel.endsWith('.gz')) {
    const { gunzipSync } = await import('node:zlib')
    const ga = gunzipSync(await readFile(join(bunDir, rel))).toString('utf8')
    const gb = gunzipSync(await readFile(join(swiftDir, rel))).toString('utf8')
    if (ga === gb) matched++
    else diffs.push({ rel, kind: 'gunzip', diff: firstDiffLine(ga, gb) })
    continue
  }
  const a = await readFile(join(bunDir, rel), 'utf8')
  const b = await readFile(join(swiftDir, rel), 'utf8')
  const ext = extname(rel)
  if (ext === '.html' || a.includes('<!DOCTYPE html>')) {
    const da = await canonicalDom(page, a)
    const db = await canonicalDom(page, b)
    if (da === db) matched++
    else diffs.push({ rel, kind: 'dom', diff: firstDiffLine(da, db) })
  } else {
    const d = compareNonHtml(ext, a, b, rel)
    if (!d) matched++
    else diffs.push({ rel, kind: 'data', diff: firstDiffLine(d.a, d.b) })
  }
}

await browser.close()

// ---- report ----
console.log(`\nWeb-build parity (chrome-headless DOM):`)
console.log(`  bun:   ${bunDir}`)
console.log(`  swift: ${swiftDir}`)
console.log(`  ✓ matched: ${matched}`)
console.log(`  ✗ differ:  ${diffs.length}`)
console.log(`  ⊘ only in bun:   ${onlyBun.length}`)
console.log(`  ⊘ only in swift: ${onlySwift.length}`)

for (const f of onlyBun) console.log(`    [only-bun]   ${f}`)
for (const f of onlySwift) console.log(`    [only-swift] ${f}`)
for (const d of diffs) {
  console.log(`    [${d.kind}-diff] ${d.rel}`)
  if (showDiff && d.diff) {
    console.log(`        line ${d.diff.line}:`)
    console.log(`        bun  : ${d.diff.bun.slice(0, 200)}`)
    console.log(`        swift: ${d.diff.swift.slice(0, 200)}`)
  }
}

const failed = diffs.length + onlyBun.length + onlySwift.length
console.log(failed === 0 ? '\nPARITY OK\n' : `\nPARITY FAILED (${failed} divergences)\n`)
process.exit(failed === 0 ? 0 : 1)
