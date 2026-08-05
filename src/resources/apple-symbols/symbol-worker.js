/**
 * Long-lived Swift symbol-rendering worker.
 *
 * One process per scope handles the whole prerender pass — spawning per
 * symbol would cost ~200 ms of Swift cold start each. The worker reads
 * `name\tweight\tscale\n` on stdin and writes a length-prefixed frame back
 * on stdout: an 8-byte header (uint32 status, uint32 length) followed by
 * `length` bytes of PDF payload, or the error text when status is non-zero.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValidationError } from '../../lib/errors.js'
import { SYMBOL_WORKER_SCRIPT } from '../swift-templates.js'
import { resolveSwiftBinary } from '../swift-binary.js'

export async function spawnSymbolWorker({ scope, logger }) {
  // Per-worker mkdtemp staging dir so the Swift script lives at an
  // unguessable, mode-0700 path. The dir is torn down in close().
  const stagingDir = await mkdtemp(join(tmpdir(), 'apple-docs-symbol-worker-'))
  const scriptPath = join(stagingDir, 'symbol-worker.swift')
  await Bun.write(scriptPath, SYMBOL_WORKER_SCRIPT)
  const proc = Bun.spawn([resolveSwiftBinary(), scriptPath, scope], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })
  const reader = proc.stdout.getReader()
  let buffer = new Uint8Array(0)

  // Drain stderr into the logger so worker crashes are visible.
  void (async () => {
    try {
      const text = await new Response(proc.stderr).text()
      if (text.trim()) logger?.debug?.(`symbol worker stderr: ${text.trim()}`)
    } catch {}
  })()

  async function readBytes(n) {
    while (buffer.length < n) {
      const { value, done } = await reader.read()
      if (done) throw new ValidationError('worker exited')
      const merged = new Uint8Array(buffer.length + value.length)
      merged.set(buffer, 0)
      merged.set(value, buffer.length)
      buffer = merged
    }
    const out = buffer.slice(0, n)
    buffer = buffer.slice(n)
    return out
  }

  return {
    async render(name, weight = 'regular', scale = 'medium') {
      // Per-frame deadline. The worker is long-lived (one process per scope
      // for the whole prerender), so we can't apply spawnWithDeadline here.
      // Instead: wrap the read in a Promise.race against a 30s timeout. On
      // timeout, the caller (processSymbolQueue) catches and restarts the
      // worker. Generous bound — most symbols render in <100 ms; the long
      // tail tops out around 5 s for the most complex cut-out symbols.
      proc.stdin.write(`${name}\t${weight}\t${scale}\n`)
      await proc.stdin.flush()
      return await Promise.race([
        (async () => {
          const header = await readBytes(8)
          const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
          const status = view.getUint32(0)
          const length = view.getUint32(4)
          const payload = await readBytes(length)
          if (status !== 0) {
            throw new ValidationError(new TextDecoder().decode(payload) || 'worker error')
          }
          return payload
        })(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`symbol worker frame timeout after 30s for ${scope}/${name}`)),
            30_000,
          ),
        ),
      ])
    },
    close() {
      try { proc.stdin.end?.() } catch {}
      try { proc.kill() } catch {}
      void rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}
