#!/usr/bin/env bun
/**
 * P0 probe harness — validates ABI contract v0 against the Swift dylib and
 * measures the bun:ffi boundary (experiments E0–E3 in ../benchmarks.md).
 *
 *   cd swift && swift build -c release && cd .. && bun bench.js
 *
 * AD_P0_QUICK=1 shrinks iteration counts (smoke run). AD_P0_LIB overrides the
 * dylib path. --dealloc-probe runs the risky toArrayBuffer-deallocator
 * ownership variant; the main run invokes it in a subprocess so a bad
 * assumption about Bun's deallocator argument order cannot corrupt this
 * process.
 */
import { CString, dlopen, suffix, toArrayBuffer } from 'bun:ffi'

const QUICK = process.env.AD_P0_QUICK === '1'
const LIB_PATH =
  process.env.AD_P0_LIB ?? new URL(`swift/.build/release/libP0Probe.${suffix}`, import.meta.url).pathname

const SYMBOLS = {
  ad_abi_version: { args: [], returns: 'u32' },
  ad_noop: { args: [], returns: 'void' },
  ad_add: { args: ['i32', 'i32'], returns: 'i32' },
  ad_fnv1a: { args: ['buffer', 'i64'], returns: 'u64' },
  ad_echo: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_build_info: { args: [], returns: 'ptr' },
  ad_json_roundtrip: { args: ['buffer', 'i64'], returns: 'ptr' },
  ad_get_dealloc_fn: { args: [], returns: 'ptr' },
  ad_free: { args: ['ptr'], returns: 'void' },
}

// ---------------------------------------------------------------- E0: cold load
const tStart = Bun.nanoseconds()
const lib = dlopen(LIB_PATH, SYMBOLS)
const tOpened = Bun.nanoseconds()
const abi = lib.symbols.ad_abi_version()
const tFirstCall = Bun.nanoseconds()

const MAX_LEN = 1 << 30

/** Parse a contract-v0 buffer: copy header+payload, then free exactly once. */
function readResult(p) {
  if (!p) throw new Error('ad_* returned NULL (OOM)')
  try {
    const header = new DataView(toArrayBuffer(p, 0, 16))
    const len = Number(header.getBigUint64(0, true))
    if (len > MAX_LEN) throw new Error(`corrupt payload length ${len}`)
    const status = header.getUint32(8, true)
    const formatId = header.getUint8(12)
    const bytes = new Uint8Array(len)
    if (len > 0) bytes.set(new Uint8Array(toArrayBuffer(p, 16, len)))
    return { status, formatId, bytes }
  } finally {
    lib.symbols.ad_free(p)
  }
}

function readResultCString(p) {
  if (!p) throw new Error('ad_* returned NULL (OOM)')
  try {
    const header = new DataView(toArrayBuffer(p, 0, 16))
    const len = Number(header.getBigUint64(0, true))
    if (len > MAX_LEN) throw new Error(`corrupt payload length ${len}`)
    // CString clones the bytes, so freeing in the finally block is safe.
    return { status: header.getUint32(8, true), text: new CString(p, 16, len).toString() }
  } finally {
    lib.symbols.ad_free(p)
  }
}

// ------------------------------------------------------------- JS baselines
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

function fnv1a64Big(bytes) {
  let h = FNV_OFFSET
  for (const b of bytes) h = ((h ^ BigInt(b)) * FNV_PRIME) & 0xffffffffffffffffn
  return h
}

// Number-only 64-bit FNV-1a: h is tracked as two u32 halves; h *= prime is
// decomposed as h*0x1b3 + (h << 40), exploiting the prime's sparse bits.
function fnv1a64Fast(bytes) {
  let lo = 0x84222325
  let hi = 0xcbf29ce4
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0 // ^ coerces to signed i32 — force back to u32
    const a = lo * 0x1b3
    const newLo = a % 0x100000000
    const carry = Math.floor(a / 0x100000000)
    const hi435 = (hi * 0x1b3) % 0x100000000
    const shift = (lo * 0x100) % 0x100000000
    hi = (hi435 + carry + shift) % 0x100000000
    lo = newLo
  }
  return (BigInt(hi) << 32n) | BigInt(lo >>> 0)
}

function jsAdd(a, b) {
  return (a + b) | 0
}

// Foundation-less builds (P0_NO_FOUNDATION, experiment E6) stub out
// ad_json_roundtrip with status 2 — detect once, skip JSON legs.
const hasFoundation = (() => {
  const probe = new TextEncoder().encode('{}')
  const r = readResultCString(lib.symbols.ad_json_roundtrip(probe, probe.length))
  return !(r.status === 2 && r.text.includes('without Foundation'))
})()

// ------------------------------------------------------------- correctness
let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function runCorrectness() {
  console.log('correctness:')
  check('abi version is 1', abi === 1, `got ${abi}`)

  const info = readResultCString(lib.symbols.ad_build_info())
  let parsed
  try {
    parsed = JSON.parse(info.text)
  } catch {}
  check('build_info is JSON with abi/platform/arch', info.status === 0 && parsed?.abi === 1 && !!parsed?.platform && !!parsed?.arch, info.text)
  if (parsed) console.log(`      build_info: ${info.text}`)

  check('add(2,3) = 5', lib.symbols.ad_add(2, 3) === 5)

  const vector = new TextEncoder().encode('hello, apple-docs')
  const swiftHash = lib.symbols.ad_fnv1a(vector, vector.length)
  const refHash = fnv1a64Big(vector)
  const fastHash = fnv1a64Fast(vector)
  check('fnv1a: swift == bigint reference', swiftHash === refHash, `${swiftHash} vs ${refHash}`)
  check('fnv1a: fast JS == bigint reference', fastHash === refHash, `${fastHash} vs ${refHash}`)

  const blob = crypto.getRandomValues(new Uint8Array(1024))
  const echoed = readResult(lib.symbols.ad_echo(blob, blob.length))
  check(
    'echo round-trips 1KB exactly',
    echoed.status === 0 && echoed.formatId === 0 && Buffer.compare(Buffer.from(echoed.bytes), Buffer.from(blob)) === 0,
  )

  const empty = readResult(lib.symbols.ad_echo(blob, 0))
  check('echo of length 0 returns empty ok', empty.status === 0 && empty.bytes.length === 0)

  // No-trap rule: invalid input must surface as a status, never an abort.
  const bad = readResultCString(lib.symbols.ad_echo(blob, -1))
  check('negative length → status 1 + message', bad.status === 1 && bad.text.includes('invalid length'), JSON.stringify(bad))

  if (hasFoundation) {
    const obj = { query: 'NavigationStack', results: [{ id: 1, path: 'documentation/swiftui/navigationstack', score: 0.92 }] }
    const inBytes = new TextEncoder().encode(JSON.stringify(obj))
    const rt = readResult(lib.symbols.ad_json_roundtrip(inBytes, inBytes.length))
    let rtObj
    try {
      rtObj = JSON.parse(new TextDecoder().decode(rt.bytes))
    } catch {}
    check(
      'json_roundtrip preserves structure',
      rt.status === 0 && rt.formatId === 2 && rtObj?.query === obj.query && rtObj?.results?.[0]?.path === obj.results[0].path,
    )

    const badJson = new TextEncoder().encode('{nope')
    const jerr = readResultCString(lib.symbols.ad_json_roundtrip(badJson, badJson.length))
    check('malformed json → status 1, no trap', jerr.status === 1)
  } else {
    console.log('  --  json checks skipped (P0_NO_FOUNDATION build)')
  }
}

// ---------------------------------------------------------------- timing rig
// Iterations are calibrated from a per-batch time budget so cheap (ns) and
// expensive (ms) measurements both get stable batches without minute-long runs.
const BATCH_BUDGET_NS = QUICK ? 30e6 : 250e6
const BATCHES = QUICK ? 5 : 20

function bench(fn, { budgetNs = BATCH_BUDGET_NS, batches = BATCHES } = {}) {
  fn(8) // warmup + JIT
  const probeN = 32
  const tProbe = Bun.nanoseconds()
  fn(probeN)
  const costEstimate = Math.max(1, (Bun.nanoseconds() - tProbe) / probeN)
  const iters = Math.max(1, Math.min(5_000_000, Math.round(budgetNs / costEstimate)))
  const perOp = []
  for (let b = 0; b < batches; b++) {
    const t = Bun.nanoseconds()
    fn(iters)
    perOp.push((Bun.nanoseconds() - t) / iters)
  }
  perOp.sort((a, b) => a - b)
  const mean = perOp.reduce((s, x) => s + x, 0) / perOp.length
  return {
    iters,
    mean,
    p50: perOp[Math.floor(perOp.length / 2)],
    p95: perOp[Math.min(perOp.length - 1, Math.ceil(perOp.length * 0.95) - 1)],
  }
}

const rows = []
function record(experiment, name, r) {
  rows.push({ experiment, name, ...r })
}

function fmt(ns) {
  if (ns < 1_000) return `${ns.toFixed(1)} ns`
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`
  return `${(ns / 1_000_000).toFixed(2)} ms`
}

const SIZES = [64, 4096, 65536, 1048576]
const sizeLabel = (n) => (n >= 1048576 ? `${n / 1048576}MB` : n >= 1024 ? `${n / 1024}KB` : `${n}B`)

function runBenchmarks() {
  console.log('\nbenchmarks:')
  const { symbols } = lib
  let acc = 0

  // E1 — raw call overhead
  record('E1', 'ffi ad_noop()', bench((n) => {
    for (let i = 0; i < n; i++) symbols.ad_noop()
  }))
  record('E1', 'ffi ad_add(i32,i32)', bench((n) => {
    for (let i = 0; i < n; i++) acc = symbols.ad_add(i | 0, 7)
  }))
  record('E1', 'js add baseline', bench((n) => {
    for (let i = 0; i < n; i++) acc = jsAdd(i | 0, 7)
  }))

  // E2 — buffer-in compute (hashing, the P1 candidate workload)
  for (const size of SIZES) {
    const buf = crypto.getRandomValues(new Uint8Array(size))
    let h = 0n
    record('E2', `ffi fnv1a ${sizeLabel(size)}`, bench((n) => {
      for (let i = 0; i < n; i++) h ^= symbols.ad_fnv1a(buf, size)
    }))
    record('E2', `js fnv1a ${sizeLabel(size)}`, bench((n) => {
      for (let i = 0; i < n; i++) h ^= fnv1a64Fast(buf)
    }))
    acc = Number(h & 1n)
  }

  // E3 — buffer-out round trip (alloc → header parse → copy → free)
  for (const size of SIZES) {
    const buf = crypto.getRandomValues(new Uint8Array(size))
    record('E3', `echo round-trip ${sizeLabel(size)}`, bench((n) => {
      for (let i = 0; i < n; i++) acc = readResult(symbols.ad_echo(buf, size)).bytes.length
    }))
  }

  // E3 — UTF-8 out: CString clone vs toArrayBuffer copy (4KB payload)
  {
    const text = 'apple-docs '.repeat(372) // ≈4KB ASCII
    const utf8 = new TextEncoder().encode(text)
    record('E3', 'utf8-out via toArrayBuffer+TextDecoder 4KB', bench((n) => {
      for (let i = 0; i < n; i++) {
        const r = readResult(symbols.ad_echo(utf8, utf8.length))
        acc = r.bytes[0]
      }
    }))
    record('E3', 'utf8-out via CString clone 4KB', bench((n) => {
      for (let i = 0; i < n; i++) acc = readResultCString(symbols.ad_echo(utf8, utf8.length)).text.length
    }))
  }

  // E3 — JSON across the boundary vs pure-JS equivalent work
  for (const approxSize of hasFoundation ? [4096, 65536] : []) {
    const items = []
    while (JSON.stringify(items).length < approxSize) {
      items.push({ id: items.length, title: `Symbol ${items.length}`, path: `documentation/swiftui/item${items.length}`, score: Math.random() })
    }
    record('E3', `json ffi round-trip ~${sizeLabel(approxSize)}`, bench((n) => {
      for (let i = 0; i < n; i++) {
        const bytes = new TextEncoder().encode(JSON.stringify(items))
        const r = readResult(symbols.ad_json_roundtrip(bytes, bytes.length))
        acc = JSON.parse(new TextDecoder().decode(r.bytes)).length
      }
    }))
    record('E3', `json js round-trip ~${sizeLabel(approxSize)}`, bench((n) => {
      for (let i = 0; i < n; i++) acc = JSON.parse(JSON.stringify(items)).length
    }))
  }

  return acc
}

// E3 — leak gate: RSS must stay flat across alloc/copy/free round trips.
function runLeakGate() {
  const iters = QUICK ? 100_000 : 1_000_000
  const buf = crypto.getRandomValues(new Uint8Array(4096))
  Bun.gc(true)
  const before = process.memoryUsage.rss()
  for (let i = 0; i < iters; i++) readResult(lib.symbols.ad_echo(buf, buf.length))
  Bun.gc(true)
  const after = process.memoryUsage.rss()
  const deltaMb = (after - before) / 1024 / 1024
  const pct = ((after - before) / before) * 100
  console.log(`\nleak gate (E3): ${iters} alloc/copy/free round-trips of 4KB`)
  console.log(`  rss before ${(before / 1024 / 1024).toFixed(1)} MB → after ${(after / 1024 / 1024).toFixed(1)} MB (Δ ${deltaMb.toFixed(1)} MB, ${pct.toFixed(2)}%)`)
  check('leak gate: rss delta < 5%', pct < 5, `${pct.toFixed(2)}%`)
}

// E3 ownership variant, isolated: Bun's toArrayBuffer deallocator. A wrong
// argument-order assumption frees the wrong pointer, so this only ever runs
// under --dealloc-probe in a child process.
function runDeallocProbe() {
  const fnPtr = lib.symbols.ad_get_dealloc_fn()
  const buf = crypto.getRandomValues(new Uint8Array(4096))
  const iters = 10_000
  Bun.gc(true)
  const before = process.memoryUsage.rss()
  for (let i = 0; i < iters; i++) {
    const p = lib.symbols.ad_echo(buf, buf.length)
    const header = new DataView(toArrayBuffer(p, 0, 16))
    const len = Number(header.getBigUint64(0, true))
    // Hand ownership to the GC: deallocator frees (payload - 16).
    const view = new Uint8Array(toArrayBuffer(p, 16, len, null, fnPtr))
    if (view[0] !== buf[0]) throw new Error('payload mismatch')
  }
  Bun.gc(true)
  const after = process.memoryUsage.rss()
  console.log(JSON.stringify({ ok: true, iters, rssDeltaMb: +((after - before) / 1024 / 1024).toFixed(1) }))
}

function spawnDeallocProbe() {
  const child = Bun.spawnSync([process.execPath, import.meta.path, '--dealloc-probe'], {
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString().trim()
  console.log('\ndealloc-probe (E3 ownership variant, subprocess):')
  if (child.exitCode === 0) {
    console.log(`  survived: ${out.split('\n').at(-1)}`)
  } else {
    console.log(`  unusable: exit ${child.exitCode}${child.signalCode ? ` (signal ${child.signalCode})` : ''}`)
    const err = child.stderr.toString().trim().split('\n').at(-1)
    if (err) console.log(`  stderr: ${err}`)
  }
}

function printReport() {
  console.log(`\nenvironment: bun ${Bun.version} · ${process.platform}-${process.arch} · lib ${LIB_PATH.split('/').slice(-1)[0]}`)
  console.log(`E0 cold load: dlopen ${fmt(tOpened - tStart)} · first call ${fmt(tFirstCall - tOpened)}${QUICK ? ' · QUICK MODE (numbers indicative only)' : ''}`)
  console.log('\n| exp | measurement | iters | mean | p50 | p95 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const r of rows) {
    console.log(`| ${r.experiment} | ${r.name} | ${r.iters} | ${fmt(r.mean)} | ${fmt(r.p50)} | ${fmt(r.p95)} |`)
  }
}

if (process.argv.includes('--dealloc-probe')) {
  runDeallocProbe()
} else {
  runCorrectness()
  if (failures === 0) {
    runBenchmarks()
    runLeakGate()
    spawnDeallocProbe()
    printReport()
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
}
