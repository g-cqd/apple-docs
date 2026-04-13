import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import {
  getProfile,
  setProfile,
  getProfileConfig,
  listProfiles,
  PROFILE_NAMES,
} from '../../src/storage/profiles.js'

const REQUIRED_CONFIG_FIELDS = ['persistMarkdown', 'persistHtml', 'cacheOnRead', 'cacheMaxAge', 'description']

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('PROFILE_NAMES', () => {
  test('contains the three canonical profile names in declaration order', () => {
    expect(PROFILE_NAMES).toEqual(['raw-only', 'balanced', 'prebuilt'])
  })
})

describe('getProfile', () => {
  test('returns balanced by default when no profile has been stored', () => {
    expect(getProfile(db)).toBe('balanced')
  })

  test('ignores an invalid stored value and returns the default', () => {
    db.setSnapshotMeta('storage_profile', 'nonexistent')
    expect(getProfile(db)).toBe('balanced')
  })

  test('ignores an empty stored value and returns the default', () => {
    db.setSnapshotMeta('storage_profile', '')
    expect(getProfile(db)).toBe('balanced')
  })
})

describe('setProfile / getProfile roundtrip', () => {
  for (const name of ['raw-only', 'balanced', 'prebuilt']) {
    test(`roundtrips profile "${name}"`, () => {
      setProfile(db, name)
      expect(getProfile(db)).toBe(name)
    })
  }

  test('setProfile raw-only persists and getProfile returns raw-only', () => {
    setProfile(db, 'raw-only')
    expect(getProfile(db)).toBe('raw-only')
  })

  test('setProfile prebuilt persists and getProfile returns prebuilt', () => {
    setProfile(db, 'prebuilt')
    expect(getProfile(db)).toBe('prebuilt')
  })
})

describe('setProfile error handling', () => {
  test('throws for an unknown profile name', () => {
    expect(() => setProfile(db, 'invalid')).toThrow('Unknown storage profile')
  })

  test('throws for an empty string', () => {
    expect(() => setProfile(db, '')).toThrow('Unknown storage profile')
  })

  test('error message contains "Unknown storage profile"', () => {
    expect(() => setProfile(db, 'turbo')).toThrow('Unknown storage profile')
  })
})

describe('getProfileConfig', () => {
  test('balanced has persistMarkdown false and cacheOnRead true', () => {
    const config = getProfileConfig('balanced')
    expect(config.persistMarkdown).toBe(false)
    expect(config.cacheOnRead).toBe(true)
  })

  test('raw-only has persistMarkdown false and cacheOnRead false', () => {
    const config = getProfileConfig('raw-only')
    expect(config.persistMarkdown).toBe(false)
    expect(config.cacheOnRead).toBe(false)
  })

  test('prebuilt has persistMarkdown true and persistHtml true', () => {
    const config = getProfileConfig('prebuilt')
    expect(config.persistMarkdown).toBe(true)
    expect(config.persistHtml).toBe(true)
  })

  test('throws for an unknown profile name', () => {
    expect(() => getProfileConfig('invalid')).toThrow('Unknown storage profile')
  })

  test('returns a copy — mutations do not affect subsequent calls', () => {
    const first = getProfileConfig('balanced')
    first.cacheOnRead = false
    const second = getProfileConfig('balanced')
    expect(second.cacheOnRead).toBe(true)
  })

  test.each(PROFILE_NAMES)('profile "%s" config contains all required fields', name => {
    const config = getProfileConfig(name)
    for (const field of REQUIRED_CONFIG_FIELDS) {
      expect(config).toHaveProperty(field)
    }
  })
})

describe('listProfiles', () => {
  test('returns an array of exactly 3 profiles', () => {
    expect(listProfiles()).toHaveLength(3)
  })

  test('each entry contains a name and all required config fields', () => {
    for (const entry of listProfiles()) {
      expect(typeof entry.name).toBe('string')
      for (const field of REQUIRED_CONFIG_FIELDS) {
        expect(entry).toHaveProperty(field)
      }
    }
  })

  test('profile names in the list match PROFILE_NAMES', () => {
    const names = listProfiles().map(p => p.name)
    expect(names).toEqual(PROFILE_NAMES)
  })
})
