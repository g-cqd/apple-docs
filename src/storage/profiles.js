/**
 * Storage profile definitions and accessors.
 *
 * Profiles control how documents are materialized on disk:
 * - raw-only: Minimal disk. Only raw JSON + SQLite. Renders on demand.
 * - balanced: Default. Caches markdown on first read (7-day TTL).
 * - prebuilt: Full materialization. Markdown + HTML persisted during sync.
 */

const PROFILES = {
  'raw-only': {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: false,
    cacheMaxAge: 0,
    description: 'Minimal disk usage. Renders on demand from raw JSON.',
  },
  'balanced': {
    persistMarkdown: false,
    persistHtml: false,
    cacheOnRead: true,
    cacheMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    description: 'Default. Caches rendered markdown on first read, evicts after 7 days.',
  },
  'prebuilt': {
    persistMarkdown: true,
    persistHtml: true,
    cacheOnRead: false,
    cacheMaxAge: 0,
    description: 'Full materialization during sync. Largest disk usage.',
  },
}

const DEFAULT_PROFILE = 'balanced'

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
 * @param {string} name - Profile name (raw-only, balanced, prebuilt)
 * @throws {Error} if name is not a valid profile
 */
export function setProfile(db, name) {
  if (!PROFILES[name]) {
    throw new Error(
      `Unknown storage profile: "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}`,
    )
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
    throw new Error(
      `Unknown storage profile: "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}`,
    )
  }
  return { ...PROFILES[name] }
}

/**
 * List all available profiles with their configs.
 * @returns {Array<{ name: string, persistMarkdown: boolean, persistHtml: boolean, cacheOnRead: boolean, cacheMaxAge: number, description: string }>}
 */
export function listProfiles() {
  return PROFILE_NAMES.map(name => ({ name, ...PROFILES[name] }))
}
