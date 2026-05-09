import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFileSizes, countLines } from '../../scripts/check-file-size.js'

let rootDir
let budgetPath

function writeFile(rel, lines) {
  const full = join(rootDir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n') + '\n')
}

function writeBudget(budget) {
  writeFileSync(budgetPath, JSON.stringify(budget))
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'file-size-test-'))
  budgetPath = join(rootDir, '.file-size-budget.json')
  mkdirSync(join(rootDir, 'src'))
})

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('checkFileSizes', () => {
  test('passes when all files are under max', () => {
    writeFile('src/a.js', 100)
    writeFile('src/b.js', 200)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toEqual([])
    expect(result.grownExempt).toEqual([])
  })

  test('flags non-exempt file exceeding max', () => {
    writeFile('src/big.js', 401)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].path).toBe('src/big.js')
    expect(result.violations[0].lines).toBe(401)
  })

  test('exempt file at baseline is ignored', () => {
    writeFile('src/legacy.js', 1000)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [{ path: 'src/legacy.js', lines: 1000 }] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toEqual([])
    expect(result.grownExempt).toEqual([])
  })

  test('flags exempt file that grew past baseline', () => {
    writeFile('src/legacy.js', 1010)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [{ path: 'src/legacy.js', lines: 1000 }] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.grownExempt).toHaveLength(1)
    expect(result.grownExempt[0]).toMatchObject({ path: 'src/legacy.js', lines: 1010, baseline: 1000 })
  })

  test('exempt file shrunk below baseline still passes', () => {
    writeFile('src/legacy.js', 800)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [{ path: 'src/legacy.js', lines: 1000 }] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.grownExempt).toEqual([])
  })

  test('warns on files above soft target but under max', () => {
    writeFile('src/medium.js', 350)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].path).toBe('src/medium.js')
  })

  test('skips node_modules, dist, coverage', () => {
    writeFile('src/node_modules/big.js', 500)
    writeFile('src/dist/big.js', 500)
    writeFile('src/coverage/big.js', 500)
    writeFile('src/keep.js', 100)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toEqual([])
  })

  test('walks nested directories', () => {
    writeFile('src/deep/nested/big.js', 401)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].path).toBe('src/deep/nested/big.js')
  })

  test('handles single-file source roots', () => {
    writeFile('cli.js', 401)
    writeBudget({ max_lines: 400, soft_target: 300, exempt: [] })
    const result = checkFileSizes({ rootDir, budgetPath, sourceRoots: ['cli.js'] })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].path).toBe('cli.js')
  })

  test('rejects malformed budget', () => {
    writeBudget({ max_lines: 'oops', exempt: [] })
    expect(() => checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })).toThrow(/max_lines/)
  })

  test('rejects malformed exempt entry', () => {
    writeBudget({ max_lines: 400, exempt: ['plain-string'] })
    expect(() => checkFileSizes({ rootDir, budgetPath, sourceRoots: ['src'] })).toThrow(/exempt entries/)
  })
})

describe('countLines', () => {
  test('counts lines matching wc -l semantics', () => {
    const path = join(rootDir, 'a.js')
    writeFileSync(path, 'a\nb\nc\n')
    expect(countLines(path)).toBe(3)
  })

  test('handles file without trailing newline', () => {
    const path = join(rootDir, 'a.js')
    writeFileSync(path, 'a\nb\nc')
    expect(countLines(path)).toBe(3)
  })

  test('empty file is 0 lines', () => {
    const path = join(rootDir, 'a.js')
    writeFileSync(path, '')
    expect(countLines(path)).toBe(0)
  })
})
