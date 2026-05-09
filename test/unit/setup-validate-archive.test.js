import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseTarVerboseLine,
  validateArchive,
} from '../../src/commands/setup/validate-archive.js'

let workDir
let dataDir

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'apple-docs-validate-arch-work-'))
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-validate-arch-data-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

async function buildArchive(name, build) {
  const stage = mkdtempSync(join(workDir, 'stage-'))
  await build(stage)
  const archivePath = join(workDir, name)
  // Build the archive with --no-recursion + an explicit file list so we can
  // include relative-traversal entries without having tar normalize them.
  // For most tests we just tar the staged contents.
  const proc = Bun.spawn(['tar', '-czf', archivePath, '-C', stage, '.'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`tar build failed: ${await new Response(proc.stderr).text()}`)
  }
  return archivePath
}

describe('parseTarVerboseLine', () => {
  test('parses a regular file entry', () => {
    const line = '-rw-r--r--  0 user staff   42 Jan  1 12:00 manifest.json'
    expect(parseTarVerboseLine(line)).toEqual({
      type: '-',
      path: 'manifest.json',
      link: null,
    })
  })

  test('parses a directory entry, stripping trailing slash', () => {
    const line = 'drwxr-xr-x  0 user staff    0 Jan  1 12:00 raw-json/'
    expect(parseTarVerboseLine(line)).toEqual({
      type: 'd',
      path: 'raw-json',
      link: null,
    })
  })

  test('parses a symlink entry with arrow target', () => {
    const line = 'lrwxr-xr-x  0 user staff    0 Jan  1 12:00 link.txt -> /etc/passwd'
    expect(parseTarVerboseLine(line)).toEqual({
      type: 'l',
      path: 'link.txt',
      link: '/etc/passwd',
    })
  })

  test('returns null for malformed lines', () => {
    expect(parseTarVerboseLine('hello world')).toBeNull()
    expect(parseTarVerboseLine('')).toBeNull()
  })
})

describe('validateArchive', () => {
  test('accepts a clean archive with regular files and directories', async () => {
    const archivePath = await buildArchive('clean.tar.gz', (stage) => {
      mkdirSync(join(stage, 'raw-json'), { recursive: true })
      writeFileSync(join(stage, 'manifest.json'), '{}')
      writeFileSync(join(stage, 'raw-json', 'a.json'), '{}')
    })
    const result = await validateArchive(archivePath, dataDir)
    expect(result.entries.length).toBeGreaterThan(0)
    const types = new Set(result.entries.map((e) => e.type))
    for (const t of types) expect(['-', 'd']).toContain(t)
  })

  test('rejects a symlink entry', async () => {
    const archivePath = await buildArchive('symlink.tar.gz', (stage) => {
      writeFileSync(join(stage, 'real.txt'), 'real')
      symlinkSync('/etc/passwd', join(stage, 'evil-link'))
    })
    await expect(validateArchive(archivePath, dataDir)).rejects.toThrow(/disallowed entry type/)
  })

  test('rejects an absolute-path entry', async () => {
    // Build an archive that contains an absolute path. GNU tar normalizes
    // away leading slashes by default, so use a manually crafted listing.
    // We build a clean archive then poke at its contents only via
    // validateArchive's tar listing — we can't easily inject absolute paths
    // without bypassing tar's own sanitization. Instead, verify the parse
    // path rejects directly.
    const archivePath = await buildArchive('clean-for-abs.tar.gz', (stage) => {
      writeFileSync(join(stage, 'a.json'), '{}')
    })
    // The clean archive itself should pass…
    await expect(validateArchive(archivePath, dataDir)).resolves.toBeDefined()

    // …but feed validateArchive a fake spawn that emits an absolute-path
    // listing line, and the validator must reject.
    const fakeSpawn = () => ({
      exited: Promise.resolve(0),
      stdout: new Response('-rw-r--r-- 0 user staff 0 Jan 1 12:00 /etc/escape.txt\n').body,
      stderr: new Response('').body,
    })
    await expect(
      validateArchive(archivePath, dataDir, { spawn: fakeSpawn })
    ).rejects.toThrow(/absolute path/)
  })

  test('rejects a relative-traversal entry that escapes destDir', async () => {
    const archivePath = await buildArchive('clean-for-traverse.tar.gz', (stage) => {
      writeFileSync(join(stage, 'a.json'), '{}')
    })
    const fakeSpawn = () => ({
      exited: Promise.resolve(0),
      stdout: new Response('-rw-r--r-- 0 user staff 0 Jan 1 12:00 ../../etc/escape.txt\n').body,
      stderr: new Response('').body,
    })
    await expect(
      validateArchive(archivePath, dataDir, { spawn: fakeSpawn })
    ).rejects.toThrow(/escapes destDir/)
  })

  test('rejects a hardlink entry', async () => {
    const archivePath = await buildArchive('clean-for-hardlink.tar.gz', (stage) => {
      writeFileSync(join(stage, 'a.json'), '{}')
    })
    const fakeSpawn = () => ({
      exited: Promise.resolve(0),
      stdout: new Response('hrwxr-xr-x 0 user staff 0 Jan 1 12:00 evil link to /etc/passwd\n').body,
      stderr: new Response('').body,
    })
    await expect(
      validateArchive(archivePath, dataDir, { spawn: fakeSpawn })
    ).rejects.toThrow(/disallowed entry type/)
  })

  test('throws when tar listing itself fails', async () => {
    const fakeSpawn = () => ({
      exited: Promise.resolve(1),
      stdout: new Response('').body,
      stderr: new Response('not a gzip file\n').body,
    })
    await expect(
      validateArchive('/nonexistent/path.tar.gz', dataDir, { spawn: fakeSpawn })
    ).rejects.toThrow(/archive listing failed/)
  })
})
