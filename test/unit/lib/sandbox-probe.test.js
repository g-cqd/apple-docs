import { describe, expect, test } from 'bun:test'
import { detectSandbox, isSandboxed } from '../../../src/lib/sandbox-probe.js'

const failing = (code) => () => { throw Object.assign(new Error(code ?? 'boom'), code ? { code } : {}) }

describe('detectSandbox', () => {
  test('reports unconfined when the home directory can be listed', () => {
    expect(detectSandbox({ readdir: () => ['a'], home: '/h' })).toBe(false)
  })

  test.each(['EPERM', 'EACCES'])('reports confined when listing fails with %s', (code) => {
    expect(detectSandbox({ readdir: failing(code), home: '/h' })).toBe(true)
  })

  test.each([['ENOENT'], ['ENOTDIR'], [undefined]])('reports unknown (null) for error %p, which says nothing about confinement', (code) => {
    expect(detectSandbox({ readdir: failing(code), home: '/h' })).toBeNull()
  })

  test('lists exactly the directory it was given', () => {
    const seen = []
    detectSandbox({ readdir: (p) => { seen.push(p); return [] }, home: '/some/home' })
    expect(seen).toEqual(['/some/home'])
  })
})

describe('isSandboxed', () => {
  test('is false for this unconfined test process and stable across calls', () => {
    expect(isSandboxed()).toBe(false)
    expect(isSandboxed()).toBe(false)
  })
})
