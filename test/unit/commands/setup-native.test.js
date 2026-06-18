// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { installNativeBundle, NATIVE_TARGET, nativeInstallRoot } from '../../../src/commands/setup/native.js'

function mockLogger() {
  const calls = { info: [], warn: [] }
  return { info: (m) => calls.info.push(m), warn: (m) => calls.warn.push(m), _calls: calls }
}

describe('setup --native', () => {
  test('NATIVE_TARGET maps darwin to the universal asset', () => {
    if (process.platform === 'darwin') expect(NATIVE_TARGET).toBe('darwin-universal')
    else expect(NATIVE_TARGET).toMatch(/^linux-(x64|arm64)$/)
  })

  test('nativeInstallRoot finds the checkout', () => {
    const root = nativeInstallRoot()
    expect(root).not.toBeNull()
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })

  test('release without the host asset → absent, never a failure', async () => {
    const logger = mockLogger()
    const result = await installNativeBundle({ tag: 'snapshot-test', assets: [] }, { logger })
    expect(result.status).toBe('absent')
    expect(logger._calls.info.some((m) => m.includes('carries no'))).toBe(true)
  })

  test('asset present but unreachable → failed + warn, staging cleaned', async () => {
    const logger = mockLogger()
    const name = `apple-docs-native-${NATIVE_TARGET}.tar.zst`
    const release = {
      tag: 'snapshot-test',
      assets: [
        { name, downloadUrl: 'http://127.0.0.1:1/nope.tar.zst' },
        { name: `${name}.sha256`, downloadUrl: 'http://127.0.0.1:1/nope.sha256' },
      ],
    }
    const result = await installNativeBundle(release, { logger })
    expect(result.status).toBe('failed')
    expect(logger._calls.warn.length).toBe(1)
    const nativeDir = join(nativeInstallRoot(), 'dist', 'native')
    if (existsSync(nativeDir)) {
      expect(readdirSync(nativeDir).filter((n) => n.startsWith('.staging') || n.startsWith('.download'))).toEqual([])
    }
  })
})
