/**
 * Archive A/B parity. Byte equality with the bsdtar-built JS archive is
 * impossible (synthesized vs host headers), so the gates are: native
 * rebuild-twice byte-identical; extracted trees identical across
 * implementations; the native archive decodes via Bun's zstd and extracts
 * via the system tar (the consumer contract); member counts match; size in
 * the same ballpark. Skips when no dylib (with archive export) is present.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetNativeLoader, getNativeLib } from '../../../src/native/loader.js'
import { _forceImpl, createTarZstArchive } from '../../../src/lib/archive-native.js'
import { createTarZstArchive as jsCreateTarZstArchive } from '../../../src/lib/archive-zstd.js'
import { sha256File } from '../../../src/lib/hash.js'

_resetNativeLoader()
const lib = getNativeLib()
const nativeReady = !!lib // dylib present AND carries ad_archive_tar_zst

function stageTree(root) {
  const put = (rel, content) => {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    utimesSync(path, 1700000000, 1700000000)
  }
  put('alpha.txt', 'first file\n')
  put('empty.bin', '')
  put('nested/deep/dir/beta.svg', `<svg>${'x'.repeat(4000)}</svg>`)
  put(`long/${'segment-'.repeat(10)}/leaf-${'y'.repeat(60)}.txt`, 'long path member\n')
  put('binary.dat', Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256)))
}

async function extractTree(archivePath, dest) {
  const tarPath = join(dest, '.x.tar')
  const sink = Bun.file(tarPath).writer()
  for await (const chunk of Bun.file(archivePath).stream().pipeThrough(new DecompressionStream('zstd'))) {
    sink.write(chunk)
  }
  await sink.end()
  const proc = Bun.spawn(['tar', '--no-same-owner', '--no-same-permissions', '-xf', tarPath, '-C', dest], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  rmSync(tarPath, { force: true })
}

function treeManifest(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, childRel)
      else out.push(`${childRel}:${Bun.hash(readFileSync(abs))}`)
    }
  }
  walk(root, '')
  return out
}

describe.skipIf(!nativeReady)('archive native/js parity', () => {
  let work
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'apple-docs-archive-parity-'))
    stageTree(join(work, 'src'))
  })
  afterAll(() => {
    _forceImpl(null)
    rmSync(work, { recursive: true, force: true })
  })
  afterEach(() => _forceImpl(null))

  test('native rebuild-twice is byte-identical and decodes everywhere', async () => {
    _forceImpl('native')
    const out1 = join(work, 'n1.tar.zst')
    const out2 = join(work, 'n2.tar.zst')
    const r1 = await createTarZstArchive({ sourceDir: join(work, 'src'), outputPath: out1 })
    const r2 = await createTarZstArchive({ sourceDir: join(work, 'src'), outputPath: out2 })
    expect(r1.fileCount).toBe(5)
    expect(await sha256File(out1)).toBe(await sha256File(out2))

    const dest = join(work, 'extract-native')
    mkdirSync(dest, { recursive: true })
    await extractTree(out1, dest)
    expect(treeManifest(dest)).toEqual(treeManifest(join(work, 'src')))
  })

  test('extracted tree identical to the JS implementation archive', async () => {
    const jsOut = join(work, 'js.tar.zst')
    const jsResult = await jsCreateTarZstArchive({ sourceDir: join(work, 'src'), outputPath: jsOut })

    _forceImpl('native')
    const nativeOut = join(work, 'native.tar.zst')
    const nativeResult = await createTarZstArchive({ sourceDir: join(work, 'src'), outputPath: nativeOut })

    expect(nativeResult.fileCount).toBe(jsResult.fileCount)
    const jsDest = join(work, 'extract-js')
    const nativeDest = join(work, 'extract-cmp')
    mkdirSync(jsDest, { recursive: true })
    mkdirSync(nativeDest, { recursive: true })
    await extractTree(jsOut, jsDest)
    await extractTree(nativeOut, nativeDest)
    expect(treeManifest(nativeDest)).toEqual(treeManifest(jsDest))

    // Size sanity band: same level/threads/content → same ballpark.
    expect(nativeResult.size).toBeGreaterThan(jsResult.size * 0.5)
    expect(nativeResult.size).toBeLessThan(jsResult.size * 1.5)
  })

  test('native actually serves when forced (status.json provenance shape)', async () => {
    _forceImpl('native')
    const messages = []
    const logger = { info: (m) => messages.push(m), warn: (m) => messages.push(m), debug: () => {} }
    await createTarZstArchive({ sourceDir: join(work, 'src'), outputPath: join(work, 'p.tar.zst'), logger })
    expect(messages.some((m) => m.includes('native zstd'))).toBe(true)
  })

  test('forced js path still serves the same contract', async () => {
    _forceImpl('js')
    const out = join(work, 'forced-js.tar.zst')
    const result = await createTarZstArchive({ sourceDir: join(work, 'src'), outputPath: out })
    expect(result.fileCount).toBe(5)
    expect(statSync(out).size).toBe(result.size)
  })
})
