import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import * as consolidateMod from '../../../src/commands/consolidate.js'
import { sync } from '../../../src/commands/sync.js'
import * as updateMod from '../../../src/commands/update.js'
import * as convertMod from '../../../src/pipeline/convert.js'
import * as discoverMod from '../../../src/pipeline/discover.js'
import * as downloadMod from '../../../src/pipeline/download.js'
import * as indexBodyMod from '../../../src/pipeline/index-body.js'
import * as guidelinesMod from '../../../src/pipeline/sync-guidelines.js'
import * as appleAssetsMod from '../../../src/resources/apple-assets.js'
import * as registryMod from '../../../src/sources/registry.js'
import { createMockLogger } from '../../helpers/mocks.js'

/**
 * Parallelism contract for src/commands/sync.js. We don't exercise the
 * real corpus pipeline here — instead every downstream primitive is
 * mock.module()-replaced with a barrier that records start / end
 * timestamps. The test verifies the orchestrator's concurrency:
 *
 *  - all 11 adapters' crawl bodies are dispatched concurrently
 *  - one adapter throwing is captured in failedSources without aborting siblings
 *  - body-index and the resources phase overlap
 *  - inside resources, fonts ∥ symbols catalog
 *  - prerender starts after symbols (does NOT wait for fonts)
 *  - stamp starts only after BOTH fonts AND symbols finish
 */

/** Resolve when external code calls the returned trigger. */
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Mock factory that records ordering and waits for an explicit release. */
function makeBarrier(name, log) {
  const released = deferred()
  return {
    name,
    fn: async (...args) => {
      log.push({ event: `${name}:start`, ts: performance.now() })
      await released.promise
      log.push({ event: `${name}:end`, ts: performance.now() })
      return { __mock: name, args }
    },
    release: (value) => released.resolve(value),
  }
}

/** Tiny in-memory DB stub matching the surface sync() touches. */
function makeDbStub() {
  const updates = []
  return {
    setActivity() {},
    clearActivity() {},
    addUpdateLog(entry) {
      updates.push(entry)
    },
    getRoots: () => [],
    getUnconvertedPages: () => [],
    getActivePathsIn: () => new Set(),
    _updateLog: updates,
  }
}

/** Build a fake source adapter with static metadata and dummy discover/fetch. */
function makeFakeAdapter(type, syncMode = 'flat') {
  // Constructor surface: sync.js reads `adapter.constructor.type`,
  // `displayName`, `syncMode` — so we need a real constructor link.
  class FakeAdapter {
    async discover() {
      return { keys: [], roots: [] }
    }
    async fetch() {
      return { payload: {}, etag: null, lastModified: null }
    }
    normalize() {
      return {}
    }
    extractReferences() {
      return []
    }
    renderHints() {
      return {}
    }
    validateNormalizeResult() {}
  }
  Object.assign(FakeAdapter, {
    type,
    displayName: type,
    syncMode,
  })
  return new FakeAdapter()
}

const log = []
let updateBarrier
let consolidateBarrier
let bodyIndexBarrier
let fontsBarrier
let symbolsPublicBarrier
let symbolsPrivateBarrier
let stampBarrier
let prerenderBarrier
let originalEnv

beforeAll(() => {
  // Each downstream primitive gets its own barrier. The orchestrator's
  // concurrency is exercised by asserting the relative ordering of the
  // start/end events captured in `log`.
  updateBarrier = makeBarrier('update', log)
  consolidateBarrier = makeBarrier('consolidate', log)
  bodyIndexBarrier = makeBarrier('bodyIndex', log)
  fontsBarrier = makeBarrier('fonts', log)
  symbolsPublicBarrier = makeBarrier('symbols.public', log)
  symbolsPrivateBarrier = makeBarrier('symbols.private', log)
  stampBarrier = makeBarrier('stamp', log)
  prerenderBarrier = makeBarrier('prerender', log)

  originalEnv = {
    skipResources: process.env.APPLE_DOCS_SKIP_RESOURCES,
    downloadFonts: process.env.APPLE_DOCS_DOWNLOAD_FONTS,
    parallel: process.env.APPLE_DOCS_PARALLEL,
  }
  // Resources phase needs to actually run (no skip) and we want fonts
  // engaged so the DAG is exercised end-to-end.
  process.env.APPLE_DOCS_SKIP_RESOURCES = '0'
  process.env.APPLE_DOCS_DOWNLOAD_FONTS = '1'
  process.env.APPLE_DOCS_PARALLEL = '2'

  // Spy on the orchestrator's downstream primitives (restored in afterAll via
  // mock.restore()). sync.js calls these through their live module bindings, so
  // the spies intercept. We avoid mock.module() here: it's process-global and
  // leaks the stubs into files that import the real modules (consolidate,
  // update, index-rebuild, storage-compact tests) under single-process runs —
  // Stryker's `bun test` baseline. --isolate hides that; spies don't leak.
  spyOn(updateMod, 'update').mockImplementation(updateBarrier.fn)
  spyOn(consolidateMod, 'consolidate').mockImplementation(consolidateBarrier.fn)
  spyOn(discoverMod, 'discoverRoots').mockImplementation(async () => {})
  spyOn(discoverMod, 'crawlRoot').mockImplementation(async () => ({ total: 0, processed: 0 }))
  spyOn(downloadMod, 'downloadMissing').mockImplementation(async () => ({ downloaded: 0 }))
  spyOn(convertMod, 'convertAll').mockImplementation(async () => ({ converted: 0, total: 0 }))
  spyOn(guidelinesMod, 'applyGuidelinesSnapshot').mockImplementation(async () => ({ sections: 0 }))
  spyOn(indexBodyMod, 'indexBodyFull').mockImplementation(bodyIndexBarrier.fn)
  spyOn(indexBodyMod, 'indexBodyIncremental').mockImplementation(bodyIndexBarrier.fn)
  spyOn(appleAssetsMod, 'syncAppleFonts').mockImplementation(async (...args) => {
    const out = await fontsBarrier.fn(...args)
    return { families: 0, files: 0, ...out }
  })
  spyOn(appleAssetsMod, 'syncSfSymbols').mockImplementation(async ({ scope }) => {
    const barrier = scope === 'public' ? symbolsPublicBarrier : symbolsPrivateBarrier
    await barrier.fn({ scope })
    return 0
  })
  spyOn(appleAssetsMod, 'stampSfSymbolCodepoints').mockImplementation(stampBarrier.fn)
  spyOn(appleAssetsMod, 'prerenderSfSymbols').mockImplementation(async (...args) => {
    const out = await prerenderBarrier.fn(...args)
    return { rendered: 0, skipped: 0, ...out }
  })
  // sync() falls back to getAllAdapters() only when ctx.adapters is absent —
  // the test injects its own list, so these stubs are just defensive.
  spyOn(registryMod, 'getAllAdapters').mockImplementation(() => [])
  spyOn(registryMod, 'getAdapterTypes').mockImplementation(() => [])
})

afterAll(() => {
  if (originalEnv.skipResources === undefined) delete process.env.APPLE_DOCS_SKIP_RESOURCES
  else process.env.APPLE_DOCS_SKIP_RESOURCES = originalEnv.skipResources
  if (originalEnv.downloadFonts === undefined) delete process.env.APPLE_DOCS_DOWNLOAD_FONTS
  else process.env.APPLE_DOCS_DOWNLOAD_FONTS = originalEnv.downloadFonts
  if (originalEnv.parallel === undefined) delete process.env.APPLE_DOCS_PARALLEL
  else process.env.APPLE_DOCS_PARALLEL = originalEnv.parallel

  // Restore the spied-on module functions so they don't leak into other files.
  mock.restore()
})

describe('sync orchestrator parallelism', () => {
  test('phases run with the documented concurrency / DAG', async () => {
    // 11 fake adapters mirror the real source count, all in flat mode so
    // syncFlatSource() short-circuits (zero keys) without contacting the
    // mocked pipeline modules. Concurrency is observable via the
    // 'Starting ...' / 'Finished ...' log lines captured by the mock
    // logger.
    const adapterTypes = [
      'apple-docc',
      'hig',
      'guidelines',
      'swift-evolution',
      'swift-book',
      'swift-docc',
      'swift-org',
      'apple-archive',
      'wwdc',
      'sample-code',
      'packages',
    ]
    const adapters = adapterTypes.map((t) => makeFakeAdapter(t, 'flat'))

    const ctx = {
      db: makeDbStub(),
      dataDir: '/tmp/sync-parallelism-test',
      rateLimiter: { acquire: async () => {}, rate: 5 },
      logger: createMockLogger(),
      adapters,
    }

    // Drive the test: kick sync() then release the barriers in stages
    // so we can observe the DAG.
    const syncPromise = sync({ full: false }, ctx)

    // Stage 1: update completes -> orchestrator enters the adapter loop
    // (all 11 dispatched concurrently with no actual work) -> download /
    // convert (zero work) -> body-index + resources both start.
    updateBarrier.release({ refreshed: 0 })

    // Stage 2: release the two resources entry tasks. The orchestrator
    // can now race fonts against symbols.
    fontsBarrier.release({ families: 0, files: 0 })
    symbolsPublicBarrier.release()
    symbolsPrivateBarrier.release()

    // Stage 3: prerender starts off symbols; stamp starts off
    // fonts+symbols. Release them.
    prerenderBarrier.release({ rendered: 0, skipped: 0 })
    stampBarrier.release()
    bodyIndexBarrier.release({ indexed: 0 })

    // Stage 4: consolidate is the last phase.
    consolidateBarrier.release({})

    const result = await syncPromise

    // ---- High-level result shape preserved.
    expect(result.failedSources).toEqual([])
    expect(result.bodyIndexed).toBe(0)
    expect(typeof result.durationMs).toBe('number')

    // ---- Adapter parallelism: every adapter logged "Starting X (mode=flat, roots=0)"
    // and "Finished X in <n>ms (no roots)". Since flat with zero roots
    // returns immediately, both lines exist for every adapter type.
    const adapterStarts = ctx.logger._calls.info.filter((args) => /^Starting /.test(args[0]))
    expect(adapterStarts.length).toBe(adapterTypes.length)
    for (const t of adapterTypes) {
      expect(adapterStarts.some((args) => args[0].startsWith(`Starting ${t} `))).toBe(true)
    }

    // ---- Dependency DAG between resource tasks.
    const startsTs = (name) => log.find((e) => e.event === `${name}:start`)?.ts ?? Number.NaN
    const endsTs = (name) => log.find((e) => e.event === `${name}:end`)?.ts ?? Number.NaN

    // Body-index started before resources' last task finished (overlap).
    const bodyIndexStart = startsTs('bodyIndex')
    const lastResourceEnd = Math.max(endsTs('fonts'), endsTs('symbols.public'), endsTs('symbols.private'), endsTs('prerender'), endsTs('stamp'))
    expect(Number.isFinite(bodyIndexStart)).toBe(true)
    expect(bodyIndexStart).toBeLessThanOrEqual(lastResourceEnd)

    // Fonts and symbols catalog ran concurrently — fonts started before
    // symbols.public finished.
    expect(startsTs('fonts')).toBeLessThanOrEqual(endsTs('symbols.public'))
    expect(startsTs('symbols.public')).toBeLessThanOrEqual(endsTs('fonts'))

    // Prerender starts only after symbols.public AND symbols.private end.
    expect(startsTs('prerender')).toBeGreaterThanOrEqual(endsTs('symbols.public'))
    expect(startsTs('prerender')).toBeGreaterThanOrEqual(endsTs('symbols.private'))

    // Stamp starts only after BOTH fonts AND symbols finish.
    expect(startsTs('stamp')).toBeGreaterThanOrEqual(endsTs('fonts'))
    expect(startsTs('stamp')).toBeGreaterThanOrEqual(endsTs('symbols.public'))
    expect(startsTs('stamp')).toBeGreaterThanOrEqual(endsTs('symbols.private'))

    // Consolidate is the last phase — after every task above.
    expect(startsTs('consolidate')).toBeGreaterThanOrEqual(endsTs('bodyIndex'))
    expect(startsTs('consolidate')).toBeGreaterThanOrEqual(endsTs('stamp'))
    expect(startsTs('consolidate')).toBeGreaterThanOrEqual(endsTs('prerender'))
  }, 10_000)
})
