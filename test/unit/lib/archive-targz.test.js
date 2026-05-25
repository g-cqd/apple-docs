import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createTarGzArchive } from '../../../src/lib/archive-targz.js'

let workDir

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'apple-docs-targz-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Stage a tiny fixture tree with stable, predictable contents. Source
 * mtimes are clamped to a fixed epoch so the resulting tar entries (and
 * therefore the gzipped output) are bit-identical across runs.
 */
function stageFixture(name) {
  const root = join(workDir, name)
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'alpha.txt'), 'aaaaaaaaaa')
  writeFileSync(join(root, 'beta.txt'), 'bbbbbbbbbbbb')
  writeFileSync(join(root, 'sub', 'gamma.bin'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
  // Pin mtimes to a constant so tar embeds the same bytes on every run.
  const stableMtime = 1_700_000_000
  for (const rel of ['alpha.txt', 'beta.txt', 'sub', 'sub/gamma.bin']) {
    utimesSync(join(root, rel), stableMtime, stableMtime)
  }
  return root
}

function sha256OfFile(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

describe('createTarGzArchive', () => {
  test('produces a gzip archive (1F 8B header) and reports the right file count', async () => {
    const src = stageFixture('basic')
    const out = join(workDir, 'out.tar.gz')

    const result = await createTarGzArchive({ sourceDir: src, outputPath: out })

    expect(existsSync(out)).toBe(true)
    expect(result.fileCount).toBe(3)
    expect(result.size).toBeGreaterThan(0)

    const bytes = readFileSync(out)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    expect(bytes[2]).toBe(0x08) // DEFLATE method
  })

  test('produces byte-identical output across two consecutive runs', async () => {
    const src = stageFixture('determinism')
    const outA = join(workDir, 'a.tar.gz')
    const outB = join(workDir, 'b.tar.gz')

    await createTarGzArchive({ sourceDir: src, outputPath: outA })
    await createTarGzArchive({ sourceDir: src, outputPath: outB })

    expect(sha256OfFile(outA)).toBe(sha256OfFile(outB))
  })

  test('strips FNAME / FTIME from the gzip header (equivalent to gzip -n)', async () => {
    const src = stageFixture('headers')
    const out = join(workDir, 'headers.tar.gz')
    await createTarGzArchive({ sourceDir: src, outputPath: out })

    const bytes = readFileSync(out)
    // Gzip header layout (RFC 1952):
    //   byte 0-1: magic (1f 8b)
    //   byte 2:   compression method (08 = DEFLATE)
    //   byte 3:   FLG (FTEXT, FHCRC, FEXTRA, FNAME, FCOMMENT)
    //   byte 4-7: MTIME (0 when stripped)
    //   byte 8:   XFL (extra flags — typically 02 for max compression)
    //   byte 9:   OS
    const flg = bytes[3]
    const FNAME = 0x08
    const FCOMMENT = 0x10
    expect(flg & FNAME).toBe(0)
    expect(flg & FCOMMENT).toBe(0)
    const mtimeBytes = bytes.subarray(4, 8)
    expect(mtimeBytes[0]).toBe(0)
    expect(mtimeBytes[1]).toBe(0)
    expect(mtimeBytes[2]).toBe(0)
    expect(mtimeBytes[3]).toBe(0)
  })

  test('refuses to archive an empty source dir', async () => {
    const src = join(workDir, 'empty')
    mkdirSync(src)
    await expect(
      createTarGzArchive({ sourceDir: src, outputPath: join(workDir, 'empty.tar.gz') }),
    ).rejects.toThrow(/no files under/)
  })
})
