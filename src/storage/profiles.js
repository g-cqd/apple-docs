// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Storage profile definitions and accessors.
 *
 * Profiles are the headline install choice — they trade disk for serving
 * speed:
 * - compact:  smallest disk. Fully compacted at install (compressed
 *             sections, contentless body index, raw payloads dropped).
 *             Renders on demand.
 * - balanced: default. Ships the snapshot as-is; caches rendered Markdown
 *             on first read (7-day TTL).
 * - prebuilt: fastest. Materializes Markdown + HTML at install. Largest disk.
 */

import { NotFoundError } from '../lib/errors.js'

const PROFILES = {
  compact: {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: false,
    cacheMaxAge: 0,
    description: 'Smallest disk. Fully compacted at install (compressed sections, contentless body index, raw payloads dropped). Renders on demand.',
  },
  balanced: {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: true,
    cacheMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    description: 'Default. Ships the snapshot as-is and caches rendered Markdown on first read, evicting after 7 days.',
  },
  prebuilt: {
    persistMarkdown: true,
    persistHtml: true,
    cacheOnRead: false,
    cacheMaxAge: 0,
    description: 'Fastest. Materializes Markdown + HTML at install. Largest disk.',
  },
}

export const DEFAULT_PROFILE = 'balanced'

export const PROFILE_NAMES = Object.keys(PROFILES)

/**
 * Get the active storage profile name.
 * Falls back to the default profile if no profile is stored or the stored
 * value does not correspond to a known profile.
 * @param {import('./database.js').DocsDatabase} db
 * @returns {string}
 */
export function getProfile(db) {
  const stored = db.getSnapshotMeta('storage_profile')
  return stored && PROFILES[stored] ? stored : DEFAULT_PROFILE
}

/**
 * Set the active storage profile.
 * @param {import('./database.js').DocsDatabase} db
 * @param {string} name - Profile name (compact, balanced, prebuilt)
 * @throws {Error} if name is not a valid profile
 */
export function setProfile(db, name) {
  if (!PROFILES[name]) {
    throw new NotFoundError(`storage-profile/${name}`, `Unknown storage profile: "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}`)
  }
  db.setSnapshotMeta('storage_profile', name)
}

/**
 * Get the configuration for a named profile.
 * Returns a shallow copy so callers cannot mutate the internal definition.
 * @param {string} name - Profile name
 * @returns {{ persistMarkdown: boolean, persistHtml: boolean, cacheOnRead: boolean, cacheMaxAge: number, description: string }}
 * @throws {Error} if name is not a valid profile
 */
export function getProfileConfig(name) {
  if (!PROFILES[name]) {
    throw new NotFoundError(`storage-profile/${name}`, `Unknown storage profile: "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}`)
  }
  return { ...PROFILES[name] }
}

/**
 * List all available profiles with their configs.
 * @returns {Array<{ name: string, persistMarkdown: boolean, persistHtml: boolean, cacheOnRead: boolean, cacheMaxAge: number, description: string }>}
 */
export function listProfiles() {
  return PROFILE_NAMES.map((name) => ({ name, ...PROFILES[name] }))
}
