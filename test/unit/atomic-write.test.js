import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJSONAtomic, writeTextAtomic } from '../../src/lib/atomic-write.js'

let tempDir

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('atomic-write', () => {
  test('writeTextAtomic creates parent directories and writes the file', async () => {
    const filePath = join(tempDir, 'nested', 'file.txt')

    await writeTextAtomic(filePath, 'hello world')

    expect(readFileSync(filePath, 'utf8')).toBe('hello world')
  })

  test('writeJSONAtomic writes stable sorted JSON', async () => {
    const filePath = join(tempDir, 'data.json')

    const serialized = await writeJSONAtomic(filePath, { zebra: 1, apple: 2 })

    expect(serialized).toBe('{"apple":2,"zebra":1}')
    expect(readFileSync(filePath, 'utf8')).toBe('{"apple":2,"zebra":1}')
  })

  test('successful writes do not leave temp files behind', async () => {
    const filePath = join(tempDir, 'output.txt')

    await writeTextAtomic(filePath, 'first')
    await writeTextAtomic(filePath, 'second')

    expect(readFileSync(filePath, 'utf8')).toBe('second')
    expect(readdirSync(tempDir)).toEqual(['output.txt'])
  })

  test('write failures do not create the target file', async () => {
    const blockerPath = join(tempDir, 'blocker')
    writeFileSync(blockerPath, 'not a directory')
    const filePath = join(blockerPath, 'output.txt')

    await expect(writeTextAtomic(filePath, 'nope')).rejects.toBeDefined()
    expect(existsSync(filePath)).toBe(false)
  })
})
