#!/usr/bin/env bun
/**
 * check-file-size.js
 *
 * Enforces the 200-400 LOC ceiling per source file. See
 * docs/plans/phase-3-quality-and-audit-remediation.md for the policy.
 *
 * Reads .file-size-budget.json. Two failure modes:
 *   1. Any non-exempt file exceeds max_lines → fail.
 *   2. Any exempt file's current LOC exceeds the recorded baseline → fail.
 * Existing exempt files at or below their baseline emit a warning summary.
 *
 * Counts physical lines (matches `wc -l` semantics).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const DEFAULT_ROOT = resolve(import.meta.dir, '..')
const DEFAULT_SOURCE_ROOTS = ['src', 'cli.js', 'index.js']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.stryker-tmp', 'reports'])
const SOURCE_EXTS = ['.js', '.mjs', '.cjs']

export function countLines(filePath) {
  const text = readFileSync(filePath, 'utf8')
  if (text.length === 0) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  if (text.charCodeAt(text.length - 1) !== 10) count++
  return count
}

function* walkSourceFiles(rootDir, rootEntry) {
  const fullPath = join(rootDir, rootEntry)
  let stat
  try {
    stat = statSync(fullPath)
  } catch {
    return
  }
  if (stat.isFile()) {
    if (SOURCE_EXTS.some((ext) => fullPath.endsWith(ext))) yield fullPath
    return
  }
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(fullPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkSourceFiles(rootDir, join(rootEntry, entry.name))
    } else if (entry.isFile() && SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      yield join(fullPath, entry.name)
    }
  }
}

export function loadBudget(budgetPath) {
  let raw
  try {
    raw = readFileSync(budgetPath, 'utf8')
  } catch (err) {
    throw new Error(`cannot read ${budgetPath}: ${err.message}`)
  }
  const budget = JSON.parse(raw)
  if (typeof budget.max_lines !== 'number') {
    throw new Error(`${budgetPath}: max_lines must be a number`)
  }
  if (!Array.isArray(budget.exempt)) {
    throw new Error(`${budgetPath}: exempt must be an array`)
  }
  const exempt = new Map()
  for (const entry of budget.exempt) {
    if (typeof entry?.path !== 'string' || typeof entry?.lines !== 'number') {
      throw new Error(`${budgetPath}: exempt entries must be { path, lines }`)
    }
    exempt.set(entry.path, entry.lines)
  }
  return { maxLines: budget.max_lines, softTarget: budget.soft_target ?? 300, exempt }
}

export function checkFileSizes({
  rootDir = DEFAULT_ROOT,
  budgetPath = join(rootDir, '.file-size-budget.json'),
  sourceRoots = DEFAULT_SOURCE_ROOTS,
} = {}) {
  const { maxLines, softTarget, exempt } = loadBudget(budgetPath)

  const violations = []
  const warnings = []
  const grownExempt = []

  for (const root of sourceRoots) {
    for (const fullPath of walkSourceFiles(rootDir, root)) {
      const rel = relative(rootDir, fullPath)
      const lines = countLines(fullPath)
      const baseline = exempt.get(rel)
      if (baseline === undefined) {
        if (lines > maxLines) {
          violations.push({ path: rel, lines, max: maxLines })
        } else if (lines > softTarget) {
          warnings.push({ path: rel, lines })
        }
      } else if (lines > baseline) {
        grownExempt.push({ path: rel, lines, baseline })
      }
    }
  }

  return { violations, warnings, grownExempt, maxLines, softTarget }
}

export function formatReport(result) {
  const out = []
  if (result.violations.length > 0) {
    out.push(`✗ ${result.violations.length} file(s) exceed the ${result.maxLines}-line ceiling:`)
    for (const v of result.violations) out.push(`    ${v.path}  ${v.lines} lines (max ${v.max})`)
  }
  if (result.grownExempt.length > 0) {
    out.push(`✗ ${result.grownExempt.length} exempt file(s) grew past their baseline:`)
    for (const g of result.grownExempt) {
      out.push(`    ${g.path}  ${g.lines} lines (baseline ${g.baseline}, +${g.lines - g.baseline})`)
    }
  }
  if (result.warnings.length > 0) {
    out.push(`⚠ ${result.warnings.length} file(s) above soft target ${result.softTarget}:`)
    for (const w of result.warnings) out.push(`    ${w.path}  ${w.lines} lines`)
  }
  return out.join('\n')
}

if (import.meta.main) {
  const result = checkFileSizes()
  const report = formatReport(result)
  if (report) console.log(report)
  const failed = result.violations.length > 0 || result.grownExempt.length > 0
  if (!failed) console.log(`✓ file-size check passed (max=${result.maxLines}, soft=${result.softTarget})`)
  process.exit(failed ? 1 : 0)
}
