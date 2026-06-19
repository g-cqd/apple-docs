/**
 * Pure (no-spawn) helpers for SF Symbols .dmg provisioning, split out of
 * install.js to keep that file under the 400-line ceiling and to make the
 * volume/app/pkg discovery logic unit-testable without a real disk image.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const SF_SYMBOLS_APP = 'SF Symbols.app'

// Match any SF Symbols application bundle, whatever the release channel: the
// stable `SF Symbols.app`, the `SF Symbols Beta.app` that SF Symbols 8 ships
// inside its installer pkg, or a future `SF Symbols <x>.app`. Staying flexible
// means provisioning succeeds with whatever variant Apple publishes; the
// caller normalises the on-disk name back to SF_SYMBOLS_APP.
const SF_SYMBOLS_APP_RE = /^SF Symbols\b.*\.app$/i

export function isSfSymbolsAppName(/** @type {any} */ name) {
  return typeof name === 'string' && SF_SYMBOLS_APP_RE.test(name)
}

function isAppBundleName(/** @type {any} */ name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.app')
}

/**
 * Extract every `mount-point` path from `hdiutil attach -plist` output.
 * Whole-disk entities carry no `mount-point` key and are skipped, so the
 * result is exactly the set of mounted filesystems.
 *
 * @param {string} plistText
 * @returns {string[]}
 */
export function parseHdiutilMountPoints(plistText) {
  const out = []
  const re = /<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/g
  let m
  while ((m = re.exec(plistText)) != null) {
    const mp = decodeXmlEntities(m[1]).trim()
    if (mp) out.push(mp)
  }
  return out
}

function decodeXmlEntities(/** @type {any} */ s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function safeReaddir(/** @type {any} */ dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * First mounted volume that holds an SF Symbols app bundle at its root.
 * Prefers an `SF Symbols*.app`; falls back to any loose `.app` so a renamed
 * future bundle still provisions.
 */
export function findAppInVolumes(/** @type {any} */ mountPoints) {
  let fallback = null
  for (const mp of mountPoints) {
    for (const name of safeReaddir(mp)) {
      if (!isAppBundleName(name)) continue
      const candidate = join(mp, name)
      if (!existsSync(candidate)) continue
      if (isSfSymbolsAppName(name)) return candidate
      fallback ??= candidate
    }
  }
  return fallback
}

/** First `.pkg` installer found at a mounted volume root. */
export function findPkgInVolumes(/** @type {any} */ mountPoints) {
  for (const mp of mountPoints) {
    for (const name of safeReaddir(mp)) {
      if (name.toLowerCase().endsWith('.pkg')) return join(mp, name)
    }
  }
  return null
}

/**
 * Locate the SF Symbols app bundle under `root` (BFS, shallowest-first),
 * bounded to `maxDepth` directory levels so a pathological tree can't spin.
 * Used to pull the app out of an expanded installer pkg Payload — SF Symbols
 * 7.x+ ships a package, not a loose .app, and SF Symbols 8 names the bundle
 * `SF Symbols Beta.app` at `<expanded>/<component>.pkg/Payload/Applications/`.
 * Prefers an `SF Symbols*.app`; falls back to the shallowest `.app` found so
 * provisioning still succeeds if Apple renames the bundle. Never descends into
 * a `.app` (bundles can nest helper apps). Returns the absolute path or null.
 *
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string | null}
 */
export function findAppInTree(root, maxDepth = 8) {
  /** @type {[string, number][]} */
  const queue = [[root, 0]]
  let fallback = null
  while (queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    const [dir, depth] = item
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const full = join(dir, e.name)
      if (isSfSymbolsAppName(e.name)) return full
      if (isAppBundleName(e.name)) {
        fallback ??= full
        continue
      }
      if (depth < maxDepth) queue.push([full, depth + 1])
    }
  }
  return fallback
}
