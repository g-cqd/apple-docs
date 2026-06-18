import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTarZst } from '../../../src/commands/setup/helpers.js'
import { countTarMembers, createTarZstArchive } from '../../../src/lib/archive-zstd.js'

let workDir

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'apple-docs-zst-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/**
 * Stage a tiny fixture tree with stable contents. Source mtimes are clamped
 * to a fixed epoch so tar (and therefore the zstd output) is bit-identical
 * across runs — the same invariant the snapshot determinism gate relies on.
 */
function stageFixture(name) {
  const root = join(workDir, name)
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'alpha.txt'), 'aaaaaaaaaa')
  writeFileSync(join(root, 'beta.txt'), 'bbbbbbbbbbbb')
  writeFileSync(join(root, 'sub', 'gamma.bin'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
  const stableMtime = 1_700_000_000
  for (const rel of ['alpha.txt', 'beta.txt', 'sub', 'sub/gamma.bin']) {
    utimesSync(join(root, rel), stableMtime, stableMtime)
  }
  return root
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('createTarZstArchive', () => {
  test('produces a zstd frame (28 B5 2F FD magic) and reports the right file count', async () => {
    const src = stageFixture('basic')
    const out = join(workDir, 'out.tar.zst')

    const result = await createTarZstArchive({ sourceDir: src, outputPath: out })

    expect(existsSync(out)).toBe(true)
    expect(result.fileCount).toBe(3)
    expect(result.size).toBeGreaterThan(0)

    const bytes = readFileSync(out)
    // zstd frame magic number, little-endian 0xFD2FB528 (RFC 8878 §3.1.1).
    expect(bytes[0]).toBe(0x28)
    expect(bytes[1]).toBe(0xb5)
    expect(bytes[2]).toBe(0x2f)
    expect(bytes[3]).toBe(0xfd)
  })

  test('produces byte-identical output across two consecutive runs', async () => {
    const src = stageFixture('determinism')
    const outA = join(workDir, 'a.tar.zst')
    const outB = join(workDir, 'b.tar.zst')

    await createTarZstArchive({ sourceDir: src, outputPath: outA })
    await createTarZstArchive({ sourceDir: src, outputPath: outB })

    expect(sha256OfFile(outA)).toBe(sha256OfFile(outB))
  })

  test('round-trips through the Bun consumer (create -> stream-decompress -> extract -> verify)', async () => {
    const src = stageFixture('roundtrip')
    const out = join(workDir, 'rt.tar.zst')
    await createTarZstArchive({ sourceDir: src, outputPath: out })

    const dest = join(workDir, 'extracted')
    mkdirSync(dest, { recursive: true })
    // extractTarZst uses Bun's native DecompressionStream("zstd") piped to
    // `tar -xf -` — the exact path stock-macOS consumers take (no system zstd).
    await extractTarZst(out, dest)

    expect(readFileSync(join(dest, 'alpha.txt'), 'utf8')).toBe('aaaaaaaaaa')
    expect(readFileSync(join(dest, 'beta.txt'), 'utf8')).toBe('bbbbbbbbbbbb')
    expect([...readFileSync(join(dest, 'sub', 'gamma.bin'))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test('member-count integrity check detects a truncated tar', async () => {
    // The producer counts members of the uncompressed tar before compressing;
    // a short count (truncated tar) is the corruption that slipped past the old
    // gzip path. Build a probe tar and confirm truncation is caught.
    const src = stageFixture('integrity')
    const tarPath = join(workDir, 'probe.tar')
    Bun.spawnSync(['tar', '-cf', tarPath, '--no-recursion', 'alpha.txt', 'beta.txt', 'sub/gamma.bin'], { cwd: src })
    expect(await countTarMembers(tarPath)).toBe(3)

    const bytes = readFileSync(tarPath)
    writeFileSync(tarPath, bytes.subarray(0, 200)) // partial first header
    let threw = false
    let count = -1
    try {
      count = await countTarMembers(tarPath)
    } catch {
      threw = true
    }
    expect(threw || count !== 3).toBe(true)
  })

  test('refuses to archive an empty source dir', async () => {
    const src = join(workDir, 'empty')
    mkdirSync(src)
    await expect(createTarZstArchive({ sourceDir: src, outputPath: join(workDir, 'empty.tar.zst') })).rejects.toThrow(/no files under/)
  })

  test('excludes macOS Finder junk (.DS_Store / ._*) so they cannot break determinism', async () => {
    const src = stageFixture('junk')
    // These carry non-deterministic bytes across builds; they must never ship.
    writeFileSync(join(src, '.DS_Store'), new Uint8Array([1, 2, 3, 4]))
    writeFileSync(join(src, 'sub', '.DS_Store'), new Uint8Array([5, 6, 7, 8]))
    writeFileSync(join(src, '._beta.txt'), new Uint8Array([9, 9, 9]))
    const out = join(workDir, 'junk.tar.zst')

    const result = await createTarZstArchive({ sourceDir: src, outputPath: out })
    expect(result.fileCount).toBe(3) // only alpha/beta/gamma — junk dropped

    const dest = join(workDir, 'extracted')
    mkdirSync(dest)
    await extractTarZst(out, dest)
    expect(existsSync(join(dest, '.DS_Store'))).toBe(false)
    expect(existsSync(join(dest, 'sub', '.DS_Store'))).toBe(false)
    expect(existsSync(join(dest, '._beta.txt'))).toBe(false)
    expect(existsSync(join(dest, 'alpha.txt'))).toBe(true)
  })
})
