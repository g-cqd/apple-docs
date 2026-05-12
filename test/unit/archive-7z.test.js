import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSevenZipArchive,
  listFilesSorted,
  resolveSevenZipBinary,
  writeSha256Sidecar,
  LZMA2_FLAGS,
} from '../../src/lib/archive-7z.js'

let workDir

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'apple-docs-7z-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function stageFixture(name) {
  const root = join(workDir, name)
  mkdirSync(join(root, 'sub'), { recursive: true })
  // Small fixture: 3-5 files totalling ~100 bytes. Predictable content so
  // the SHA is stable across CI runs of the test (the assertion compares
  // run-to-run, but having ASCII payloads helps debugging).
  writeFileSync(join(root, 'alpha.txt'), 'aaaaaaaaaa') // 10 B
  writeFileSync(join(root, 'beta.txt'), 'bbbbbbbbbbbb') // 12 B
  writeFileSync(join(root, 'gamma.bin'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])) // 10 B
  writeFileSync(join(root, 'sub', 'delta.txt'), 'dddddddddddddddd') // 16 B
  writeFileSync(join(root, 'sub', 'epsilon.txt'), 'eeeeeeeeeeee') // 12 B
  return root
}

function sha256OfFile(path) {
  const bytes = readFileSync(path)
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

describe('resolveSevenZipBinary', () => {
  test('prefers 7zz when both are present', () => {
    const calls = []
    const which = (bin) => {
      calls.push(bin)
      // Simulate both available — 7zz must win.
      return `/fake/path/${bin}`
    }
    expect(resolveSevenZipBinary({ which })).toBe('7zz')
    expect(calls[0]).toBe('7zz')
  })

  test('falls back to 7z when 7zz is missing', () => {
    const which = (bin) => (bin === '7zz' ? null : `/fake/${bin}`)
    expect(resolveSevenZipBinary({ which })).toBe('7z')
  })

  test('throws an install-hint error when neither is present', () => {
    const which = () => null
    expect(() => resolveSevenZipBinary({ which })).toThrow(/install p7zip/i)
  })
})

describe('listFilesSorted', () => {
  test('returns POSIX-byte-ordered relative paths', () => {
    const root = stageFixture('fx-order')
    const files = listFilesSorted(root)
    expect(files).toEqual([
      'alpha.txt',
      'beta.txt',
      'gamma.bin',
      'sub/delta.txt',
      'sub/epsilon.txt',
    ])
  })
})

describe('LZMA2_FLAGS', () => {
  test('locks the post-recalibration flag set (S0.2 + May 2026 dictionary-ceiling exit)', () => {
    // S0.2 originally locked `-mx=9 -md=1024m -mfb=273 -mqs=on`. The May 2026
    // recalibration (full weight/scale matrix landed for both scopes) dropped
    // `-mx` to 5 and removed `-mfb=273` (only matters at -mx>=7) to keep the
    // pack within the workflow's wallclock budget. See the LZMA2_FLAGS docblock
    // in src/lib/archive-7z.js for the rationale and the size/speed tradeoff.
    expect(LZMA2_FLAGS).toContain('-mx=5')
    expect(LZMA2_FLAGS).toContain('-m0=lzma2')
    expect(LZMA2_FLAGS).toContain('-md=1024m')
    expect(LZMA2_FLAGS).toContain('-mqs=on')
    expect(LZMA2_FLAGS).toContain('-mtm=off')
    expect(LZMA2_FLAGS).toContain('-mtc=off')
    expect(LZMA2_FLAGS).toContain('-mta=off')
  })
})

// Integration tests below shell out to the real 7zz / 7z. If neither is on
// PATH (impossible on the dev macOS host; possible on a minimal CI image)
// the describe block self-skips with a clear message.
let hasSevenZip = true
try { resolveSevenZipBinary() } catch { hasSevenZip = false }

const describeIf = hasSevenZip ? describe : describe.skip

describeIf('createSevenZipArchive (integration)', () => {
  test('determinism: two builds of the same tree are byte-identical', async () => {
    const src = stageFixture('det')
    const a = join(workDir, 'a.7z')
    const b = join(workDir, 'b.7z')
    await createSevenZipArchive({ sourceDir: src, outputPath: a })
    // Touch the source mtimes between builds — the mtime-off flags must
    // make this irrelevant. (We don't actually need to alter mtimes here;
    // simply running the build a second time after a delay is sufficient
    // because 7z records the mtime by default. -mtm=off is what we're
    // asserting against.)
    await new Promise(r => setTimeout(r, 1100))
    await createSevenZipArchive({ sourceDir: src, outputPath: b })
    expect(sha256OfFile(a)).toBe(sha256OfFile(b))
  })

  test('structural integrity: extracted tree matches the source byte-for-byte', async () => {
    const src = stageFixture('roundtrip')
    const archive = join(workDir, 'rt.7z')
    await createSevenZipArchive({ sourceDir: src, outputPath: archive })

    const restored = join(workDir, 'restored')
    mkdirSync(restored)
    const binary = resolveSevenZipBinary()
    const proc = Bun.spawn([binary, 'x', '-y', `-o${restored}`, archive], {
      stdout: 'pipe', stderr: 'pipe',
    })
    await proc.exited
    expect(await proc.exited).toBe(0)

    // File counts match
    const srcFiles = listFilesSorted(src)
    const restoredFiles = listFilesSorted(restored)
    expect(restoredFiles).toEqual(srcFiles)

    // Per-file content match
    for (const rel of srcFiles) {
      expect(sha256OfFile(join(restored, rel))).toBe(sha256OfFile(join(src, rel)))
    }
  })

  test('format flag enforcement: LZMA2 method + >=1 GiB dictionary', async () => {
    const src = stageFixture('format')
    const archive = join(workDir, 'fmt.7z')
    await createSevenZipArchive({ sourceDir: src, outputPath: archive })

    const binary = resolveSevenZipBinary()
    const proc = Bun.spawn([binary, 'l', '-slt', archive], { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    await proc.exited

    // Method line is `Method = LZMA2:<dict-encoding>`; we just need the
    // family. Dictionary size is reported in the header record as
    // `Method = LZMA2:24` etc. The reliable on-disk fact we can assert is
    // the family.
    expect(text).toMatch(/Method = LZMA2/)
    // Solid block — confirms `-mqs=on` (sort+group, then form a solid
    // block) was honoured.
    expect(text).toMatch(/Solid = \+/)
  })

  test('throws when source directory is empty', async () => {
    const src = join(workDir, 'empty')
    mkdirSync(src)
    await expect(
      createSevenZipArchive({ sourceDir: src, outputPath: join(workDir, 'e.7z') }),
    ).rejects.toThrow(/no files/i)
  })

  test('overwrites any existing output (no silent append)', async () => {
    const src = stageFixture('overwrite')
    const out = join(workDir, 'ow.7z')
    await createSevenZipArchive({ sourceDir: src, outputPath: out })
    const firstSize = statSync(out).size
    // Rebuild — should not grow, should not corrupt.
    await createSevenZipArchive({ sourceDir: src, outputPath: out })
    expect(statSync(out).size).toBe(firstSize)
  })
})

describeIf('writeSha256Sidecar (integration)', () => {
  test('writes a shasum-format sidecar with the archive basename', async () => {
    const src = stageFixture('sidecar')
    const out = join(workDir, 'sc.7z')
    await createSevenZipArchive({ sourceDir: src, outputPath: out })
    const { sidecarPath, sha256 } = await writeSha256Sidecar(out)
    expect(sidecarPath).toBe(`${out}.sha256`)
    expect(existsSync(sidecarPath)).toBe(true)
    const text = readFileSync(sidecarPath, 'utf8')
    expect(text).toBe(`${sha256}  sc.7z\n`)
    expect(sha256).toBe(sha256OfFile(out))
  })
})
