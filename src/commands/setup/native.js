// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Optional native-bundle install (`apple-docs setup --native`).
 *
 * Fetches the host-matching `apple-docs-native-<target>.tar.zst` from the
 * SAME release the corpus came from, sha256-verifies it against its
 * sidecar, and unpacks into REPO_ROOT/dist/native/<platform>-<arch>/ — the
 * loader's install-tree candidate. Never DATA_DIR: the corpus must not be
 * able to carry code (p0/security.md). Every failure degrades to a warning
 * — an absent or broken bundle means the JS implementations serve (D5).
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from '../../lib/hash.js'
import { extractTarZst } from './helpers.js'

// Both Mac architectures resolve to the one universal-dylib asset; the
// Swift runtime ships in macOS, so it travels alone.
export const NATIVE_TARGET = process.platform === 'darwin' ? 'darwin-universal' : `linux-${process.arch === 'x64' ? 'x64' : process.arch}`

const HEX64 = /\b[a-f0-9]{64}\b/i

/** The checkout root, or null when running from a compiled binary. */
export function nativeInstallRoot() {
  const root = new URL('../../../', import.meta.url).pathname
  if (root.includes('$bunfs') || !existsSync(join(root, 'package.json'))) return null
  return root
}

/**
 * @param {{ tag: string, assets: Array<{name: string, downloadUrl: string}> }} release
 * @param {{ logger: { info?: Function, warn?: Function } }} io
 * @returns {Promise<{ status: 'installed'|'absent'|'skipped'|'failed', dir?: string, message?: string }>}
 */
export async function installNativeBundle(release, { logger }) {
  const root = nativeInstallRoot()
  if (!root) {
    logger.info?.('Native bundle skipped: no repo checkout to install into (compiled binary?)')
    return { status: 'skipped' }
  }
  const assetName = `apple-docs-native-${NATIVE_TARGET}.tar.zst`
  const asset = release.assets.find((a) => a.name === assetName)
  const checksum = release.assets.find((a) => a.name === `${assetName}.sha256`)
  if (!asset || !checksum) {
    logger.info?.(`Native bundle skipped: release ${release.tag} carries no ${assetName}`)
    return { status: 'absent' }
  }

  const hostDir = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
  const targetDir = join(root, 'dist', 'native', hostDir)
  const staging = join(root, 'dist', 'native', `.staging-${process.pid}`)
  const tmpArchive = join(root, 'dist', 'native', `.download-${process.pid}.tar.zst`)
  try {
    mkdirSync(join(root, 'dist', 'native'), { recursive: true })
    logger.info?.(`Downloading ${assetName} (${release.tag})…`)

    const res = await fetch(asset.downloadUrl, { redirect: 'follow' })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    await Bun.write(tmpArchive, res)

    const sumRes = await fetch(checksum.downloadUrl, { redirect: 'follow' })
    if (!sumRes.ok) throw new Error(`checksum download failed: HTTP ${sumRes.status}`)
    const expected = (await sumRes.text()).match(HEX64)?.[0]?.toLowerCase()
    if (!expected) throw new Error('checksum sidecar carries no sha256')
    const actual = await sha256File(tmpArchive)
    if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`)

    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    await extractTarZst(tmpArchive, staging)
    const extracted = join(staging, `apple-docs-native-${NATIVE_TARGET}`)
    if (!existsSync(extracted)) throw new Error('bundle layout unexpected (missing top-level directory)')

    rmSync(targetDir, { recursive: true, force: true })
    renameSync(extracted, targetDir)
    logger.info?.(`Native bundle installed: ${targetDir}`)
    return { status: 'installed', dir: targetDir }
  } catch (error) {
    logger.warn?.(`Native bundle install failed (JS implementations serve): ${error.message}`)
    return { status: 'failed', message: error.message }
  } finally {
    rmSync(tmpArchive, { force: true })
    rmSync(staging, { recursive: true, force: true })
  }
}
