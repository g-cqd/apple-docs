import { describe, expect, test } from 'bun:test'
import { parseDoccArchiveUrl } from '../../../src/sources/docc-url.js'

describe('parseDoccArchiveUrl', () => {
  test('detects the three external DocC archives Apple references', () => {
    // CareKit — GitHub Pages project site with a `/CareKit` path prefix.
    expect(parseDoccArchiveUrl('https://carekit-apple.github.io/CareKit/documentation/carekit')).toEqual({
      slug: 'carekit',
      baseUrl: 'https://carekit-apple.github.io/CareKit',
      entryKey: 'carekit',
    })
    // Private Cloud Compute — root-hosted on security.apple.com, trailing slash.
    expect(parseDoccArchiveUrl('https://security.apple.com/documentation/private-cloud-compute/')).toEqual({
      slug: 'private-cloud-compute',
      baseUrl: 'https://security.apple.com',
      entryKey: 'private-cloud-compute',
    })
    // DocC — root-hosted on swift.org.
    expect(parseDoccArchiveUrl('https://www.swift.org/documentation/docc')).toEqual({
      slug: 'docc',
      baseUrl: 'https://www.swift.org',
      entryKey: 'docc',
    })
  })

  test('derives the data-JSON base by inserting /data before /documentation', () => {
    const parsed = parseDoccArchiveUrl('https://carekit-apple.github.io/CareKit/documentation/carekit')
    // The adapter builds `${baseUrl}/data/documentation/${entryKey}.json`.
    expect(`${parsed.baseUrl}/data/documentation/${parsed.entryKey}.json`).toBe('https://carekit-apple.github.io/CareKit/data/documentation/carekit.json')
  })

  test('keeps a deep entry path but slugs the first segment', () => {
    expect(parseDoccArchiveUrl('https://security.apple.com/documentation/private-cloud-compute/corerequirements')).toEqual({
      slug: 'private-cloud-compute',
      baseUrl: 'https://security.apple.com',
      entryKey: 'private-cloud-compute/corerequirements',
    })
  })

  test('rejects external links that are not DocC archives', () => {
    // No /documentation/ segment.
    expect(parseDoccArchiveUrl('https://github.com/ResearchKit')).toBeNull()
    expect(parseDoccArchiveUrl('https://developer.apple.com/musickit/web/')).toBeNull()
  })

  test('never treats developer.apple.com as an external archive', () => {
    expect(parseDoccArchiveUrl('https://developer.apple.com/documentation/swiftui/view')).toBeNull()
  })

  test('rejects non-https and malformed URLs', () => {
    expect(parseDoccArchiveUrl('http://security.apple.com/documentation/private-cloud-compute')).toBeNull()
    expect(parseDoccArchiveUrl('file:///documentation/secrets')).toBeNull()
    expect(parseDoccArchiveUrl('not a url')).toBeNull()
    expect(parseDoccArchiveUrl(null)).toBeNull()
    expect(parseDoccArchiveUrl(undefined)).toBeNull()
  })

  test('rejects an empty documentation path', () => {
    expect(parseDoccArchiveUrl('https://example.com/documentation/')).toBeNull()
  })

  test('rejects operator-only doc path segments', () => {
    expect(parseDoccArchiveUrl('https://example.com/documentation/swiftui/.==')).toBeNull()
  })
})
