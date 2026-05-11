import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Long-lived pool of Python `pyftsubset` workers.
 *
 * Each worker is a child process running `python-worker.py` on stdin/stdout.
 * Workers stay alive forever; per-call cost is just the subset itself plus
 * one tempfile read on the JS side. The worker also keeps the kernel
 * page-cache warm for the source font, so the second call against the
 * same family takes a fraction of the first.
 *
 * Job framing: newline-delimited JSON (request line → reply line). Replies
 * are correlated by an `id` minted on the JS side.
 *
 * Failure model:
 *   - Spawn failure (no `python3` on PATH, fontTools missing): `pool.run`
 *     rejects with `PoolUnavailableError`; the route returns 503 with a
 *     setup hint.
 *   - Worker crash mid-job: the job rejects with that worker's last
 *     stderr text. The worker is replaced lazily on the next request.
 *   - Spawn rate limiting: a worker that crashes inside its first 5 s of
 *     life is marked degraded; if the next spawn also crashes within 5 s
 *     the pool flips to `degraded` and `run()` keeps rejecting with
 *     `PoolUnavailableError` until the operator restarts.
 */

const WORKER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'python-worker.py')
const DEFAULT_PYTHON = process.env.APPLE_DOCS_FONT_SUBSET_PYTHON || 'python3'

export class PoolUnavailableError extends Error {
  constructor(message, { setupHint } = {}) {
    super(message)
    this.name = 'PoolUnavailableError'
    if (setupHint) this.setupHint = setupHint
  }
}

/**
 * @param {{ size?: number, tempDir?: string, python?: string, logger?: object, scriptPath?: string }} opts
 */
export function createPyftsubsetPool(opts = {}) {
  const size = Math.max(1, Math.min(opts.size ?? autoSize(), 8))
  const python = opts.python ?? DEFAULT_PYTHON
  const tempDir = opts.tempDir ?? join(tmpdir(), 'apple-docs-font-subset')
  const scriptPath = opts.scriptPath ?? WORKER_SCRIPT
  const logger = opts.logger ?? null

  /** @type {Array<Worker>} */
  const workers = []
  /** @type {Array<{ canonical: object, fontPath: string, resolve: (b:Uint8Array)=>void, reject:(e:Error)=>void }>} */
  const queue = []
  let nextJobId = 1
  let closed = false
  let degraded = false
  let degradeReason = null

  async function ensureTempDir() {
    if (!existsSync(tempDir)) await mkdir(tempDir, { recursive: true })
  }

  function autoSize() {
    const hw = typeof globalThis.navigator !== 'undefined' && typeof globalThis.navigator.hardwareConcurrency === 'number'
      ? globalThis.navigator.hardwareConcurrency
      : 4
    return Math.min(hw, 4)
  }

  function spawnWorker() {
    if (closed) return null
    let child
    try {
      child = spawn(python, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      })
    } catch (err) {
      degraded = true
      degradeReason = err?.message ?? String(err)
      logger?.warn?.(`font-subset pool: spawn failed: ${degradeReason}`)
      return null
    }
    /** @type {Worker} */
    const w = {
      child,
      busy: false,
      buffer: '',
      pending: null,
      spawnedAt: Date.now(),
      stderr: '',
      crashed: false,
    }
    child.on('error', (err) => {
      w.crashed = true
      w.stderr += `[spawn error] ${err?.message ?? err}\n`
      handleWorkerExit(w)
    })
    child.on('exit', () => {
      w.crashed = true
      handleWorkerExit(w)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      // Cap to keep memory bounded — the worker is chatty about
      // "table NOT subset" notices that aren't errors.
      if (w.stderr.length < 8192) w.stderr += String(chunk)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      w.buffer += chunk
      drainStdout(w)
    })
    return w
  }

  function handleWorkerExit(w) {
    if (w.pending) {
      const pending = w.pending
      w.pending = null
      pending.reject(new Error(`pyftsubset worker exited mid-job: ${w.stderr.slice(-512)}`))
    }
    const idx = workers.indexOf(w)
    if (idx >= 0) workers.splice(idx, 1)
    if (!closed) {
      // Degrade only if the worker died inside its first 5 s — a fast
      // crash means setup is broken (Python missing, script syntax error).
      const lifespanMs = Date.now() - w.spawnedAt
      if (lifespanMs < 5_000) {
        degraded = true
        degradeReason = w.stderr.slice(-512) || 'worker crashed before responding'
        logger?.error?.(`font-subset pool: worker died after ${lifespanMs} ms — pool degraded`)
        // Fail every pending queued job; otherwise they'd hang forever.
        while (queue.length > 0) {
          const j = queue.shift()
          j.reject(new PoolUnavailableError(
            `font subsetting unavailable: ${degradeReason}`,
            { setupHint: 'install Python 3 + fontTools: python3 -m pip install fonttools brotli' },
          ))
        }
      } else {
        // Healthy worker died after long uptime — replace it.
        const replacement = spawnWorker()
        if (replacement) workers.push(replacement)
      }
    }
    pump()
  }

  function drainStdout(w) {
    let idx
    while ((idx = w.buffer.indexOf('\n')) >= 0) {
      const line = w.buffer.slice(0, idx).trim()
      w.buffer = w.buffer.slice(idx + 1)
      if (!line) continue
      let reply
      try { reply = JSON.parse(line) } catch {
        // Unexpected non-JSON output — surface to logger but don't crash.
        logger?.warn?.(`font-subset pool: non-JSON stdout: ${line.slice(0, 256)}`)
        continue
      }
      const pending = w.pending
      if (!pending || pending.id !== reply.id) {
        logger?.warn?.(`font-subset pool: orphan reply id=${reply?.id}`)
        continue
      }
      w.pending = null
      w.busy = false
      if (reply.ok) {
        pending.resolveOk(reply)
      } else {
        pending.reject(new Error(`pyftsubset error: ${reply.error ?? 'unknown'}`))
      }
      pump()
    }
  }

  function pump() {
    if (closed) return
    while (queue.length > 0) {
      const idle = workers.find(w => !w.busy && !w.crashed && w.child.stdin.writable)
      if (!idle) return
      const job = queue.shift()
      dispatch(idle, job)
    }
  }

  function dispatch(w, job) {
    const id = String(nextJobId++)
    const outPath = join(tempDir, `subset-${process.pid}-${id}.bin`)
    const req = {
      id,
      font_path: job.fontPath,
      codepoints: job.canonical.codepoints,
      format: job.canonical.format,
      out_path: outPath,
    }
    w.busy = true
    w.pending = {
      id,
      resolveOk: async (_reply) => {
        try {
          const bytes = new Uint8Array(await readFile(outPath))
          // Best-effort cleanup; the bytes are already in memory and
          // cached on disk by the route's own cache file.
          unlink(outPath).catch(() => {})
          job.resolve(bytes)
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(String(err)))
        }
      },
      reject: (err) => {
        unlink(outPath).catch(() => {})
        job.reject(err)
      },
    }
    try {
      w.child.stdin.write(`${JSON.stringify(req)}\n`)
    } catch (err) {
      w.busy = false
      w.pending = null
      job.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  async function init() {
    await ensureTempDir()
    for (let i = 0; i < size; i++) {
      const w = spawnWorker()
      if (w) workers.push(w)
    }
    if (workers.length === 0) {
      degraded = true
      degradeReason = degradeReason || `failed to spawn ${python}`
    }
  }

  /**
   * Submit a subset job. Resolves with the subset bytes.
   * @param {{ canonical: { font: string, codepoints: number[], format: string }, fontPath: string }} job
   * @returns {Promise<Uint8Array>}
   */
  function run(job) {
    if (closed) return Promise.reject(new Error('font-subset pool: closed'))
    if (degraded) {
      return Promise.reject(new PoolUnavailableError(
        `font subsetting unavailable: ${degradeReason}`,
        { setupHint: 'install Python 3 + fontTools: python3 -m pip install fonttools brotli' },
      ))
    }
    return new Promise((resolve, reject) => {
      queue.push({ canonical: job.canonical, fontPath: job.fontPath, resolve, reject })
      pump()
    })
  }

  async function close() {
    closed = true
    while (queue.length > 0) {
      const j = queue.shift()
      j.reject(new Error('font-subset pool: closed'))
    }
    for (const w of workers) {
      try { w.child.stdin.end() } catch {}
      try { w.child.kill() } catch {}
    }
    workers.length = 0
  }

  function stats() {
    return {
      size: workers.length,
      busy: workers.filter(w => w.busy).length,
      queueDepth: queue.length,
      degraded,
      degradeReason,
    }
  }

  function isDegraded() { return degraded }

  return { init, run, close, stats, isDegraded }
}

/** @typedef {{ child: any, busy: boolean, buffer: string, pending: any, spawnedAt: number, stderr: string, crashed: boolean }} Worker */
