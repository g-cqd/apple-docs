import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { minifyJs } from '../../src/web/asset-bundler.js'

let tmp
function makeFile(name, contents) {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'asset-bundler-'))
  const p = join(tmp, name)
  writeFileSync(p, contents)
  return p
}

describe('minifyJs', () => {
  test('emits a self-executing IIFE wrapper from a plain JS file', async () => {
    const path = makeFile('plain.js', "function init(){console.log('hi')}\ninit()\n")
    const out = await minifyJs(path)
    expect(out).toMatch(/^\(\(\)=>\{/)
    expect(out.trimEnd()).toMatch(/\}\)\(\);$/)
    // Minifier renames `init` to a single character but the call survives.
    expect(out).not.toContain('__esModule')
  })

  test('inlines side-effect imports into the same IIFE', async () => {
    const dep = makeFile('dep.js', "globalThis.__test_dep = 'set'\n")
    const entry = makeFile('entry.js', `import './${dep.split('/').pop()}'\nconsole.log('entry')\n`)
    const out = await minifyJs(entry)
    expect(out).toContain('__test_dep')
  })

  test('inlines named-export imports without an __esModule shim', async () => {
    const lib = makeFile('lib.js', 'export function ping(){return 1}\n')
    const entry = makeFile('entry.js', `import {ping} from './${lib.split('/').pop()}'\nping()\n`)
    const out = await minifyJs(entry)
    expect(out).toMatch(/^\(\(\)=>\{/)
    expect(out).not.toContain('__esModule')
  })

  test('throws a descriptive error for a missing entrypoint', async () => {
    const missing = '/tmp/this-file-does-not-exist-xyz.js'
    await expect(minifyJs(missing)).rejects.toThrow(/Bun\.build/)
  })

  test('throws when an import inside the entrypoint cannot be resolved', async () => {
    const broken = makeFile('broken.js', "import './does-not-exist.js'\n")
    await expect(minifyJs(broken)).rejects.toThrow(/Bun\.build/)
  })
})

// Best-effort cleanup. Bun spins up a process per --isolate test file so the
// per-suite tmp dir is short-lived; this keeps it from accumulating in
// /tmp on dev hosts that don't auto-vacuum.
process.on('exit', () => {
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
