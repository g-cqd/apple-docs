import { describe, expect, test } from 'bun:test'
import {
  projectFrameworks,
  projectReadDoc,
  projectRenderSfSymbol,
  projectSearchResult,
  projectStatus,
} from '../../../src/output/projection.js'

describe('per-call debug option short-circuits projection', () => {
  test('projectSearchResult returns raw envelope when debug:true', () => {
    const raw = {
      query: 'x', total: 0, results: [],
      tier: 'full', relaxed: true, relaxationTier: 'pruned',
      trigramAvailable: true, partial: true,
    }
    expect(projectSearchResult(raw, { debug: true })).toBe(raw)
  })

  test('projectReadDoc returns raw envelope when debug:true', () => {
    const raw = { found: true, metadata: { tier: 'full' }, sections: [], tierLimitation: { x: 1 } }
    expect(projectReadDoc(raw, { debug: true })).toBe(raw)
  })

  test('projectFrameworks returns raw envelope when debug:true', () => {
    const raw = { roots: [{ slug: 's', name: 'S', lastSeen: '2026' }], total: 1 }
    expect(projectFrameworks(raw, { debug: true })).toBe(raw)
  })

  test('projectRenderSfSymbol returns raw envelope when debug:true', () => {
    const raw = { name: 'x', scope: 'public', format: 'svg', file_path: '/internal' }
    expect(projectRenderSfSymbol(raw, { debug: true })).toBe(raw)
  })

  test('projectStatus advanced opt preserves raw envelope', () => {
    const raw = { tier: 'full', capabilities: { searchBody: true } }
    expect(projectStatus(raw, { advanced: true })).toBe(raw)
  })
})

describe('DEBUG_PASSTHROUGH default behaviour', () => {
  // The module-init value reflects the env var at import time. We can't
  // mutate it after the fact, so this test just verifies the public
  // boolean export documents the expected default.
  test('DEBUG_PASSTHROUGH is exported as a boolean', async () => {
    const mod = await import('../../../src/output/projection.js')
    expect(typeof mod.DEBUG_PASSTHROUGH).toBe('boolean')
  })
})
