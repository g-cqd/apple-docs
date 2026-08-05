/**
 * Regression cover for the snapshot extraction disk preflight.
 *
 * The bug this pins: `statfsSync` under Bun on macOS x86_64 returns a
 * misaligned struct (bsize: 0), so `bavail * bsize` was 0 and the guard
 * rejected every install on that platform — after `setup --force` had
 * already wiped the corpus. A guard that cannot read free space must fail
 * OPEN, never closed.
 */

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertEnoughDiskForExtract,
  availableBytes,
  requiredBytesForArchive,
} from '../../../src/commands/setup/disk-space.js'

const GB = 1e9

describe('availableBytes', () => {
  test('reports a positive figure for a real directory', () => {
    const available = availableBytes(tmpdir())
    expect(available).not.toBeNull()
    expect(available).toBeGreaterThan(0)
  })

  test('returns null rather than 0 for a path that does not exist', () => {
    // Must be null (unknown → caller proceeds), not 0 (→ caller blocks).
    expect(availableBytes(join(tmpdir(), 'apple-docs-nope-does-not-exist-xyz'))).toBeNull()
  })
})

describe('assertEnoughDiskForExtract', () => {
  const archive = '/tmp/whatever.tar.zst'

  test('passes when the probe reports more room than needed', () => {
    const result = assertEnoughDiskForExtract(archive, '/tmp', {
      env: {}, required: 10 * GB, probe: () => 50 * GB,
    })
    expect(result.checked).toBe(true)
    expect(result.available).toBe(50 * GB)
  })

  test('throws when the probe reports demonstrably too little room', () => {
    expect(() => assertEnoughDiskForExtract(archive, '/tmp', {
      env: {}, required: 23 * GB, probe: () => 2 * GB,
    })).toThrow(/Not enough disk space/)
  })

  test('fails OPEN when free space cannot be determined', () => {
    // The production incident: probe yields nothing usable. Proceeding and
    // letting tar surface a real ENOSPC beats blocking a valid install.
    const result = assertEnoughDiskForExtract(archive, '/tmp', {
      env: {}, required: 23 * GB, probe: () => null,
    })
    expect(result.checked).toBe(false)
    expect(result.available).toBeNull()
  })

  test('fails OPEN on the misaligned-statfs reading that broke the host', () => {
    // { bsize: 0, bavail: 61202533, … } — bavail * bsize === 0. The probe
    // must reject that reading as junk instead of reporting "0 bytes free".
    const probe = () => {
      const bsize = 0
      const bavail = 61202533
      const bytes = bavail * bsize
      return bytes > 0 ? bytes : null
    }
    const result = assertEnoughDiskForExtract(archive, '/tmp', {
      env: {}, required: 23 * GB, probe,
    })
    expect(result.checked).toBe(false)
  })

  test('APPLE_DOCS_SKIP_DISK_CHECK=1 bypasses the guard entirely', () => {
    let probed = false
    const result = assertEnoughDiskForExtract(archive, '/tmp', {
      env: { APPLE_DOCS_SKIP_DISK_CHECK: '1' },
      required: 23 * GB,
      probe: () => { probed = true; return 1 },
    })
    expect(result.checked).toBe(false)
    expect(probed).toBe(false)
  })
})

describe('requiredBytesForArchive', () => {
  test('falls back to a compression-ratio estimate without a zstd header', async () => {
    const path = join(tmpdir(), `apple-docs-not-zstd-${process.pid}.tar.zst`)
    await Bun.write(path, 'not a zstd frame')
    try {
      expect(requiredBytesForArchive(path)).toBe(Bun.file(path).size * 12)
    } finally {
      await Bun.file(path).unlink().catch(() => {})
    }
  })
})
