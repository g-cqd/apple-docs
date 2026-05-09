/**
 * Apple plist (Property List) reader.
 *
 * Two paths:
 *   - readPlist(path) — primary entry. Tries `plutil -convert json` first
 *     (fast, canonical, handles binary plists). On hosts without plutil
 *     (Linux CI) falls back to an in-process XML parser.
 *   - parseXmlPlist(text) — pure-JS XML parser. Handles the dialect
 *     Apple ships under CoreGlyphs.bundle and the fixtures in
 *     test/unit/symbols.test.js: <dict>, <array>, <key>, <string>,
 *     <integer>, <real>, <true/>, <false/>, <data>, <date>.
 *
 * Extracted from src/resources/apple-assets.js as part of P3.7 — keeps
 * the asset module focused on rendering and lets the plist parser be
 * tested independently.
 */

import { existsSync } from 'node:fs'

export async function readPlist(path) {
  if (!existsSync(path)) return null
  // plutil is the fast/canonical converter on macOS and is the only thing
  // that handles binary plists. On Linux CI runners (and any host that
  // hasn't installed Apple's developer tools) the binary is missing — we
  // fall back to an in-process XML parser that covers every fixture in
  // the test suite plus the actual XML plists Apple ships under
  // CoreGlyphs.bundle (symbol_search, symbol_categories, …).
  try {
    const proc = Bun.spawn(['plutil', '-convert', 'json', '-o', '-', path], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code === 0) return JSON.parse(stdout)
    // Distinguish "binary not on PATH" from "plutil ran but rejected the
    // input". For the former we try the JS fallback; for the latter we
    // surface the original error so the caller can see what plutil saw.
    if (code !== 127) throw new Error(`plutil failed for ${path}: ${stderr.trim()}`)
  } catch (error) {
    // Bun.spawn throws ENOENT when the binary isn't on PATH.
    const message = String(error?.message ?? '')
    if (!/ENOENT|spawn|not found|No such file/i.test(message)) throw error
  }
  const xml = await Bun.file(path).text()
  return parseXmlPlist(xml)
}

export function parseXmlPlist(text) {
  if (text.startsWith('bplist')) {
    throw new Error('parseXmlPlist: binary plists require plutil; install Apple developer tools')
  }
  const decode = (s) => s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

  let i = 0
  const len = text.length

  function skipMisc() {
    while (i < len) {
      // whitespace
      while (i < len && /\s/.test(text[i])) i++
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        i = end < 0 ? len : end + 3
        continue
      }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9)
        i = end < 0 ? len : end + 3
        continue
      }
      if (text.startsWith('<!', i) || text.startsWith('<?', i)) {
        const end = text.indexOf('>', i + 2)
        i = end < 0 ? len : end + 1
        continue
      }
      break
    }
  }

  function readTag() {
    skipMisc()
    if (i >= len || text[i] !== '<') return null
    const close = text.indexOf('>', i)
    if (close < 0) throw new Error('parseXmlPlist: unterminated tag')
    const raw = text.slice(i + 1, close)
    i = close + 1
    const isClose = raw.startsWith('/')
    const isSelf = raw.endsWith('/')
    const name = (isClose ? raw.slice(1) : isSelf ? raw.slice(0, -1) : raw).trim().split(/\s+/)[0]
    return { name, isClose, isSelf, raw }
  }

  function readText(untilTag) {
    const closeTag = `</${untilTag}>`
    const end = text.indexOf(closeTag, i)
    if (end < 0) throw new Error(`parseXmlPlist: missing </${untilTag}>`)
    const value = text.slice(i, end)
    i = end + closeTag.length
    return decode(value)
  }

  function readDict(tag) {
    if (tag.isSelf) return {}
    const out = {}
    while (true) {
      const next = readTag()
      if (!next) throw new Error('parseXmlPlist: unterminated <dict>')
      if (next.isClose && next.name === 'dict') return out
      if (next.name !== 'key') throw new Error(`parseXmlPlist: expected <key>, got <${next.name}>`)
      const key = readText('key')
      const valueTag = readTag()
      if (!valueTag || valueTag.isClose) throw new Error(`parseXmlPlist: missing value for key ${key}`)
      out[key] = readValue(valueTag)
    }
  }
  function readArray(tag) {
    if (tag.isSelf) return []
    const out = []
    while (true) {
      const next = readTag()
      if (!next) throw new Error('parseXmlPlist: unterminated <array>')
      if (next.isClose && next.name === 'array') return out
      out.push(readValue(next))
    }
  }

  function readValue(tag) {
    if (tag.name === 'dict') return readDict(tag)
    if (tag.name === 'array') return readArray(tag)
    if (tag.name === 'string') return tag.isSelf ? '' : readText('string')
    if (tag.name === 'integer') return tag.isSelf ? 0 : parseInt(readText('integer').trim(), 10)
    if (tag.name === 'real') return tag.isSelf ? 0 : parseFloat(readText('real').trim())
    if (tag.name === 'true') return true
    if (tag.name === 'false') return false
    if (tag.name === 'data') return tag.isSelf ? '' : readText('data').replace(/\s+/g, '')
    if (tag.name === 'date') return tag.isSelf ? null : readText('date')
    // Skip unknown tag bodies without losing position.
    if (!tag.isSelf) readText(tag.name)
    return null
  }

  // Walk to the <plist> root and return the first child value.
  while (i < len) {
    const tag = readTag()
    if (!tag) break
    if (tag.name === 'plist' && !tag.isClose) {
      const value = readTag()
      if (!value || value.isClose) return null
      return readValue(value)
    }
  }
  throw new Error('parseXmlPlist: no <plist> root found')
}

