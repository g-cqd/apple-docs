import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const text = readFileSync(join(import.meta.dir, '../../../src/web/public/.well-known/security.txt'), 'utf8')
const fields = new Map(text.split('\n').filter(l => /^[A-Za-z-]+:/.test(l)).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))

const DAY_MS = 86_400_000

describe('/.well-known/security.txt (RFC 9116)', () => {
  test('has the required Contact and Expires fields plus Policy and Canonical', () => {
    for (const name of ['Contact', 'Expires', 'Policy', 'Canonical']) expect(fields.has(name)).toBe(true)
  })

  // Pentest F4: the live file had expired. This fails 14 days before the date
  // passes, so the weekly CI run is the reminder to renew it.
  test('Expires is at least 14 days away', () => {
    const expires = Date.parse(fields.get('Expires'))
    expect(Number.isNaN(expires)).toBe(false)
    expect(expires - Date.now()).toBeGreaterThan(14 * DAY_MS)
  })

  test('Expires is no more than one year away, as RFC 9116 recommends', () => {
    expect(Date.parse(fields.get('Expires')) - Date.now()).toBeLessThanOrEqual(366 * DAY_MS)
  })

  test('Policy and Canonical are HTTPS URLs', () => {
    expect(fields.get('Policy')).toMatch(/^https:\/\//)
    expect(fields.get('Canonical')).toMatch(/^https:\/\//)
  })
})
