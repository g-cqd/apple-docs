import { promptChoice } from '../../cli/prompts.js'
import { ValidationError } from '../../lib/errors.js'
import { DEFAULT_PROFILE, PROFILE_NAMES } from '../../storage/profiles.js'

/**
 * Resolve the storage profile to apply to a freshly-installed corpus:
 *   1. An explicit, valid `--profile` wins.
 *   2. On an interactive TTY (without `--yes`), prompt for the choice.
 *   3. Otherwise fall back to the default profile.
 *
 * setup applies the result explicitly on every install: a snapshot embeds
 * whatever `storage_profile` the build host had in snapshot_meta, so the
 * installer must override it rather than silently inherit the build's value.
 *
 * @param {{ profile?: string|null, yes?: boolean }} opts
 * @returns {Promise<string>} a name in PROFILE_NAMES
 */
export async function resolveStorageProfile({ profile, yes }) {
  if (profile != null) {
    if (!PROFILE_NAMES.includes(profile)) {
      throw new ValidationError(`Unknown --profile "${profile}". Valid profiles: ${PROFILE_NAMES.join(', ')}`, { field: 'profile', value: profile })
    }
    return profile
  }
  if (!yes && process.stdin.isTTY) {
    return promptChoice(
      'Choose a storage profile for this install:',
      [
        { label: 'Compact', value: 'compact', hint: 'smallest disk; fully compacted now, renders on demand' },
        { label: 'Balanced', value: 'balanced', hint: 'default; snapshot as-is, caches Markdown on first read' },
        { label: 'Prebuilt', value: 'prebuilt', hint: 'fastest; materializes Markdown + HTML now (largest disk)' },
      ],
      { defaultIndex: 1 },
    )
  }
  return DEFAULT_PROFILE
}
