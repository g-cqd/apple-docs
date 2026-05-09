import { describe, expect, test } from 'bun:test'
import { SpawnTimeoutError } from '../../src/lib/errors.js'
import { spawnWithDeadline } from '../../src/lib/spawn-with-deadline.js'

describe('spawnWithDeadline', () => {
  test('returns stdout/stderr/exitCode for a fast-exiting command', async () => {
    const result = await spawnWithDeadline(['/bin/echo', 'hello'], { deadlineMs: 2000 })
    expect(new TextDecoder().decode(result.stdout)).toContain('hello')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
  })

  test('captures non-zero exit without throwing', async () => {
    const result = await spawnWithDeadline(['/bin/sh', '-c', 'exit 7'], { deadlineMs: 2000 })
    expect(result.exitCode).toBe(7)
  })

  test('throws SpawnTimeoutError when deadline elapses', async () => {
    const start = Date.now()
    await expect(
      spawnWithDeadline(['/bin/sleep', '5'], { deadlineMs: 200 }),
    ).rejects.toBeInstanceOf(SpawnTimeoutError)
    const elapsed = Date.now() - start
    // Should kill within a few hundred ms past the deadline; tolerate CI jitter.
    expect(elapsed).toBeLessThan(2000)
  })

  test('caps captured stderr at stderrMaxBytes', async () => {
    // Emit ~10 KB of stderr; cap at 1 KB.
    const result = await spawnWithDeadline(
      ['/bin/sh', '-c', 'yes "stderr noise" | head -c 10000 1>&2; exit 0'],
      { deadlineMs: 5000, stderrMaxBytes: 1024 },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr.length).toBeLessThan(1200) // cap + truncation marker
    expect(result.stderr).toContain('truncated')
  })

  test('SpawnTimeoutError carries args and deadlineMs', async () => {
    try {
      await spawnWithDeadline(['/bin/sleep', '5'], { deadlineMs: 100 })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnTimeoutError)
      expect(err.args).toEqual(['/bin/sleep', '5'])
      expect(err.deadlineMs).toBe(100)
    }
  })
})
