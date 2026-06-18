// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'

// Capture console.log output to inspect help text.
function capture(fn) {
  const original = console.log
  const lines = []
  console.log = (msg) => lines.push(String(msg))
  try {
    fn()
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

async function showHelp(command) {
  const { showHelp } = await import('../../../src/cli/help.js')
  return capture(() => showHelp(command))
}

describe('global help groups commands', () => {
  test.each([
    ['Query', 'search '],
    ['Setup & Sync', 'setup '],
    ['Hosting', 'mcp start'],
    ['Maintenance & Build', 'snapshot build'],
  ])('section %s contains expected command', async (section, command) => {
    const help = await showHelp(null)
    expect(help).toContain(section)
    expect(help).toContain(command)
  })

  test('global help mentions APPLE_DOCS_DEBUG', async () => {
    const help = await showHelp(null)
    expect(help).toContain('APPLE_DOCS_DEBUG')
  })
})

describe('per-command Advanced subsections', () => {
  test('search help groups --no-deep/--no-eager/--no-fuzzy under Advanced', async () => {
    const help = await showHelp('search')
    expect(help).toContain('Advanced')
    const advancedIndex = help.indexOf('Advanced')
    expect(help.indexOf('--no-deep')).toBeGreaterThan(advancedIndex)
    expect(help.indexOf('--no-eager')).toBeGreaterThan(advancedIndex)
    expect(help.indexOf('--no-fuzzy')).toBeGreaterThan(advancedIndex)
  })

  test('sync help groups --aggressive and --use-git-auth under Advanced', async () => {
    const help = await showHelp('sync')
    expect(help).toContain('Advanced')
    const advancedIndex = help.indexOf('Advanced')
    expect(help.indexOf('--aggressive')).toBeGreaterThan(advancedIndex)
    expect(help.indexOf('--use-git-auth')).toBeGreaterThan(advancedIndex)
  })

  test('snapshot help groups --allow-incomplete-symbols under Advanced', async () => {
    const help = await showHelp('snapshot')
    const advancedIndex = help.toLowerCase().indexOf('advanced')
    expect(advancedIndex).toBeGreaterThan(-1)
    expect(help.indexOf('--allow-incomplete-symbols')).toBeGreaterThan(advancedIndex)
  })

  test('mcp help groups --concurrency/--queue/--metrics-port under Advanced', async () => {
    const help = await showHelp('mcp')
    expect(help).toContain('advanced') // section name case-insensitive
    expect(help).toContain('--concurrency')
    expect(help).toContain('--queue')
    expect(help).toContain('--metrics-port')
  })

  test('storage help groups --no-vacuum under Advanced', async () => {
    const help = await showHelp('storage')
    const advancedIndex = help.toLowerCase().indexOf('advanced')
    expect(advancedIndex).toBeGreaterThan(-1)
    expect(help.indexOf('--no-vacuum')).toBeGreaterThan(advancedIndex)
  })

  test('status help advertises --advanced flag', async () => {
    const help = await showHelp('status')
    expect(help).toContain('--advanced')
  })

  test('web help groups --metrics-port under Advanced', async () => {
    const help = await showHelp('web')
    expect(help).toContain('advanced')
    expect(help).toContain('--metrics-port')
  })

  test('consolidate help groups --dry-run/--minify under Advanced', async () => {
    const help = await showHelp('consolidate')
    const advancedIndex = help.toLowerCase().indexOf('advanced')
    expect(advancedIndex).toBeGreaterThan(-1)
    expect(help.indexOf('--dry-run')).toBeGreaterThan(advancedIndex)
    expect(help.indexOf('--minify')).toBeGreaterThan(advancedIndex)
  })
})
