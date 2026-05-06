import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildStoreZip, crc32 } from '../../src/lib/zip.js'

describe('zip', () => {
  test('crc32 matches the well-known IEEE 802.3 reference vectors', () => {
    const encoder = new TextEncoder()
    expect(crc32(encoder.encode(''))).toBe(0)
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926)
  })

  test('buildStoreZip emits a valid zip readable by /usr/bin/unzip', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'apple-docs-zip-test-'))
    try {
      const encoder = new TextEncoder()
      const zip = buildStoreZip([
        { name: 'alpha.txt', data: encoder.encode('hello world') },
        { name: 'nested/beta.bin', data: new Uint8Array([0x00, 0xff, 0x10, 0x20]) },
      ])

      // Local file header magic
      expect(zip[0]).toBe(0x50)
      expect(zip[1]).toBe(0x4b)
      expect(zip[2]).toBe(0x03)
      expect(zip[3]).toBe(0x04)

      const archivePath = join(tmp, 'out.zip')
      await writeFile(archivePath, zip)

      const proc = Bun.spawn(['unzip', '-l', archivePath], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      expect(stdout).toContain('alpha.txt')
      expect(stdout).toContain('nested/beta.bin')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
