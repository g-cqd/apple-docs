import { describe, expect, test } from 'bun:test'
import { SourceAdapter } from '../../../src/sources/base.js'
import { getAdapter, getAdapterTypes } from '../../../src/sources/registry.js'

describe('SourceAdapter base + registry', () => {
  test('registry exposes the built-in source adapters', () => {
    const types = getAdapterTypes().sort()
    // Phase 0-2 adapters
    expect(types).toContain('apple-docc')
    expect(types).toContain('hig')
    expect(types).toContain('guidelines')
    // Phase 4 adapters
    expect(types).toContain('swift-evolution')
    expect(types).toContain('swift-book')
    expect(types).toContain('swift-org')
    expect(types).toContain('apple-archive')
    expect(types).toContain('wwdc')
    expect(types).toContain('sample-code')
    expect(types.length).toBe(9)

    expect(getAdapter('apple-docc').constructor.type).toBe('apple-docc')
    expect(getAdapter('swift-evolution').constructor.type).toBe('swift-evolution')
    expect(getAdapter('wwdc').constructor.type).toBe('wwdc')
  })

  test('registry throws for unknown source type', () => {
    expect(() => getAdapter('nonexistent')).toThrow()
  })

  test('unoverridden abstract methods throw "Not implemented"', async () => {
    class FakeAdapter extends SourceAdapter {
      static type = 'fake'
    }
    const adapter = new FakeAdapter()

    await expect(adapter.discover({})).rejects.toThrow('Not implemented')
    await expect(adapter.fetch('key', {})).rejects.toThrow('Not implemented')
    await expect(adapter.check('key', {}, {})).rejects.toThrow('Not implemented')
    expect(() => adapter.normalize('key', {})).toThrow('Not implemented')
  })

  test('validation helpers reject invalid adapter results', () => {
    class FakeAdapter extends SourceAdapter {}
    const adapter = new FakeAdapter()

    expect(() => adapter.validateDiscoveryResult({})).toThrow()
    expect(() => adapter.validateFetchResult({ key: 'x' })).toThrow()
    expect(() => adapter.validateCheckResult({ status: 'wat' })).toThrow()
    expect(() => adapter.validateNormalizeResult({ document: {}, sections: [] })).toThrow()
  })
})
