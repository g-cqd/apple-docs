import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  renderTemplateString,
  renderTemplate,
  ALLOWED_VARS,
} from '../../../ops/lib/render-template.js'

describe('renderTemplateString', () => {
  test('replaces allowed placeholders with env values', () => {
    const r = renderTemplateString('hello ${USER_NAME}!', { USER_NAME: 'gc' })
    expect(r.content).toBe('hello gc!')
    expect(r.unresolved).toEqual([])
    expect(r.ignored).toEqual([])
  })

  test('leaves placeholders not on the allowlist intact', () => {
    const r = renderTemplateString('${HOME}/${USER_NAME}', { USER_NAME: 'gc', HOME: '/Users/gc' })
    expect(r.content).toBe('${HOME}/gc')
    expect(r.ignored).toEqual(['HOME'])
  })

  test('reports unresolved keys (allowed but missing from env)', () => {
    const r = renderTemplateString('${BUN_BIN}', {})
    expect(r.content).toBe('${BUN_BIN}')
    expect(r.unresolved).toEqual(['BUN_BIN'])
  })

  test('handles empty-string env values as unresolved', () => {
    const r = renderTemplateString('${REPO_DIR}', { REPO_DIR: '' })
    expect(r.unresolved).toEqual(['REPO_DIR'])
  })

  test('multiple occurrences substitute consistently', () => {
    const r = renderTemplateString('${LABEL_PROXY}/${LABEL_PROXY}', { LABEL_PROXY: 'mt.test.proxy' })
    expect(r.content).toBe('mt.test.proxy/mt.test.proxy')
  })

  test('respects a custom allowlist override', () => {
    const r = renderTemplateString('${X}-${USER_NAME}', { X: '1', USER_NAME: 'gc' }, { allowed: ['X'] })
    expect(r.content).toBe('1-${USER_NAME}')
    expect(r.ignored).toEqual(['USER_NAME'])
  })

  test('ALLOWED_VARS covers the ops template surface', () => {
    expect(ALLOWED_VARS).toContain('LABEL_PREFIX')
    expect(ALLOWED_VARS).toContain('PUBLIC_WEB_HOST')
    expect(ALLOWED_VARS).toContain('CLOUDFLARED_BIN')
  })
})

describe('renderTemplate (file IO)', () => {
  test('reads template, writes rendered output to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rt-'))
    try {
      const tpl = join(dir, 'in.tpl')
      writeFileSync(tpl, 'service=${LABEL_WEB}\n')
      const out = join(dir, 'out/rendered.txt')  // exercise mkdir -p
      const result = renderTemplate(tpl, out, { LABEL_WEB: 'mt.test.web' })
      expect(result.content).toBe('service=mt.test.web\n')
      expect(existsSync(out)).toBe(true)
      expect(readFileSync(out, 'utf8')).toBe('service=mt.test.web\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('throws when template path does not exist', () => {
    expect(() => renderTemplate('/no/such.tpl', '/tmp/x', {})).toThrow(/not found/)
  })

  test('honours injected fs deps without touching the disk', () => {
    let written
    const fakeRead = () => 'hello ${USER_NAME}'
    const fakeWrite = (_p, content) => { written = content }
    const fakeEnsure = () => {}
    const result = renderTemplate('/virtual.tpl', '/virtual.out', { USER_NAME: 'gc' }, {
      deps: { readFile: fakeRead, writeFile: fakeWrite, ensureDir: fakeEnsure },
    })
    expect(written).toBe('hello gc')
    expect(result.unresolved).toEqual([])
  })
})
