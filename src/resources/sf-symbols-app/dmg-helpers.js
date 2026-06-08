/**
 * Pure (no-spawn) helpers for SF Symbols .dmg provisioning, split out of
 * install.js to keep that file under the 400-line ceiling and to make the
 * volume/app/pkg discovery logic unit-testable without a real disk image.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const SF_SYMBOLS_APP = 'SF Symbols.app'

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

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** First mounted volume that holds a loose `SF Symbols.app` at its root. */
export function findAppInVolumes(mountPoints) {
  for (const mp of mountPoints) {
    const candidate = join(mp, SF_SYMBOLS_APP)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** First `.pkg` installer found at a mounted volume root. */
export function findPkgInVolumes(mountPoints) {
  for (const mp of mountPoints) {
    for (const name of safeReaddir(mp)) {
      if (name.toLowerCase().endsWith('.pkg')) return join(mp, name)
    }
  }
  return null
}

/**
 * Recursively locate the `SF Symbols.app` bundle under `root`, bounded to
 * `maxDepth` directory levels so a pathological tree can't spin. Returns the
 * absolute path or null. Used to pull the app out of an expanded `.pkg`
 * Payload — SF Symbols 7.x ships an installer package, not a loose .app, so
 * the bundle lands at `<expanded>/Payload/<install-location>/SF Symbols.app`.
 *
 * @param {string} root
 * @param {number} [maxDepth]
 * @returns {string | null}
 */
export function findAppInTree(root, maxDepth = 8) {
  const stack = [[root, 0]]
  while (stack.length > 0) {
    const [dir, depth] = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === SF_SYMBOLS_APP) return join(dir, e.name)
      if (depth < maxDepth) stack.push([join(dir, e.name), depth + 1])
    }
  }
  return null
}
