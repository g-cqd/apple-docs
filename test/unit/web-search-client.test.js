import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Bun.Transpiler accepts ESM (export/import) and async syntax; `new Function`
// rejects ESM because the constructed function is a non-module body. Use
// the transpiler to validate the file parses; module syntax-only files
// (the Phase 2 ES module conversions) would otherwise fail the legacy
// `new Function(code)` check even though they're valid JS.
const transpiler = new Bun.Transpiler({ loader: 'js' })
function expectParses(code) {
  expect(() => transpiler.scan(code)).not.toThrow()
}

describe('Client-Side Search Assets', () => {
  const assetsDir = join(import.meta.dir, '../../src/web/assets')
  const workerDir = join(import.meta.dir, '../../src/web/worker')

  describe('search.js', () => {
    test('is valid JavaScript', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code.length).toBeGreaterThan(100)
      expectParses(code)
    })

    test('contains debounce implementation', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code).toContain('debounce')
      expect(code).toContain('setTimeout')
    })

    test('handles keyboard navigation', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code).toContain('ArrowDown')
      expect(code).toContain('ArrowUp')
      expect(code).toContain('Escape')
      expect(code).toContain('Enter')
    })

    test('uses /api/search endpoint', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code).toContain('/api/search')
      expect(code).toContain('AbortController')
    })

    test('escapes HTML in output', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code).toContain('&amp;')
      expect(code).toContain('&lt;')
    })

    test('supports / shortcut for search focus', () => {
      const code = readFileSync(join(assetsDir, 'search.js'), 'utf8')
      expect(code).toContain("'/'")
    })
  })

  describe('search-page.js', () => {
    test('is valid JavaScript', () => {
      const code = readFileSync(join(assetsDir, 'search-page.js'), 'utf8')
      expect(code.length).toBeGreaterThan(100)
      expectParses(code)
    })

    test('preserves results while showing a loading state', () => {
      const code = readFileSync(join(assetsDir, 'search-page.js'), 'utf8')
      expect(code).toContain('AbortController')
      expect(code).toContain('search-result-placeholder')
      expect(code).toContain('Searching…')
      expect(code).toContain('aria-busy')
    })
  })

  describe('search-worker.js', () => {
    test('is valid JavaScript', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code.length).toBeGreaterThan(100)
      expectParses(code)
    })

    test('contains search scoring logic', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code).toContain('score')
      expect(code).toContain('tokenize')
    })

    test('handles title index loading', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code).toContain('title-index.json')
      expect(code).toContain('aliases.json')
    })

    test('supports init and search message types', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code).toContain("type === 'init'")
      expect(code).toContain("type === 'search'")
    })

    test('implements exact, prefix, and fuzzy matching', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code).toContain('startsWith')
      expect(code).toContain('includes')
    })

    test('applies depth penalty', () => {
      const code = readFileSync(join(workerDir, 'search-worker.js'), 'utf8')
      expect(code).toContain('depth')
    })
  })
})
