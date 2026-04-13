import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { recordBenchmark, readHistory, compareToPrevious } from '../benchmarks/history.js'

let tmpDir

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-bench-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Benchmark History (P8-H)', () => {
  test('record and read roundtrip', () => {
    recordBenchmark('test-metric', { value: 1.5, unit: 'ms' }, { historyDir: tmpDir })

    const history = readHistory('test-metric', { historyDir: tmpDir })
    expect(history.length).toBe(1)
    expect(history[0].name).toBe('test-metric')
    expect(history[0].value).toBe(1.5)
    expect(history[0].unit).toBe('ms')
    expect(history[0].timestamp).toBeTruthy()
  })

  test('read with limit returns last N entries', () => {
    for (let i = 0; i < 5; i++) {
      recordBenchmark('multi', { value: i, unit: 'ms' }, { historyDir: tmpDir })
    }

    const last2 = readHistory('multi', { limit: 2, historyDir: tmpDir })
    expect(last2.length).toBe(2)
    expect(last2[0].value).toBe(3)
    expect(last2[1].value).toBe(4)
  })

  test('read empty history returns []', () => {
    const history = readHistory('nonexistent', { historyDir: tmpDir })
    expect(history).toEqual([])
  })

  test('compareToPrevious detects regression (>20% slower)', () => {
    recordBenchmark('perf', { value: 1.0, unit: 'ms' }, { historyDir: tmpDir })

    const result = compareToPrevious('perf', 1.5, { historyDir: tmpDir })
    expect(result.regressed).toBe(true)
    expect(result.changePercent).toBe(50)
  })

  test('compareToPrevious no regression when within 20%', () => {
    recordBenchmark('perf', { value: 1.0, unit: 'ms' }, { historyDir: tmpDir })

    const result = compareToPrevious('perf', 1.1, { historyDir: tmpDir })
    expect(result.regressed).toBe(false)
    expect(result.changePercent).toBe(10)
  })

  test('compareToPrevious with no history returns no regression', () => {
    const result = compareToPrevious('new-metric', 1.0, { historyDir: tmpDir })
    expect(result.regressed).toBe(false)
    expect(result.previousValue).toBeUndefined()
  })

  test('filters by name', () => {
    recordBenchmark('a', { value: 1, unit: 'ms' }, { historyDir: tmpDir })
    recordBenchmark('b', { value: 2, unit: 'ms' }, { historyDir: tmpDir })

    expect(readHistory('a', { historyDir: tmpDir }).length).toBe(1)
    expect(readHistory('b', { historyDir: tmpDir }).length).toBe(1)
  })
})
