// Shared constants for the WWDC source. Keys, year ranges, and the
// upstream endpoints.

export const ROOT_SLUG = 'wwdc'
export const APPLE_VIDEOS_INDEX = 'https://developer.apple.com/videos'
export const APPLE_BASE = 'https://developer.apple.com/videos/play'
export const ASCIIWWDC_OWNER = 'ASCIIwwdc'
export const ASCIIWWDC_REPO = 'wwdc-session-transcripts'
export const ASCIIWWDC_BRANCH = 'master'
export const ASCIIWWDC_LANGUAGE = 'en'
export const USER_AGENT = 'apple-docs/2.0'
export const DEFAULT_TIMEOUT = 30_000

/** Years served by Apple's WWDC videos pages (HTML scraping). */
export const APPLE_YEARS = Array.from(
  { length: new Date().getFullYear() - 2020 + 1 },
  (_, i) => 2020 + i,
)

/** Years served by ASCIIwwdc community transcripts. */
export const ASCIIWWDC_YEAR_MIN = 1997
export const ASCIIWWDC_YEAR_MAX = 2019
export const VTT_TIMESTAMP_RE = /^(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}(?:\s+.*)?$/

/**
 * Parse a WWDC key like `wwdc/wwdc2024-10001` into its components.
 * Returns null if the key does not match the expected shape.
 */
export function parseWwdcKey(key) {
  const match = key.match(/^wwdc\/wwdc(\d{4})-(\d+)$/)
  if (!match) return null
  return { year: Number.parseInt(match[1], 10), sessionId: match[2] }
}

/** Build the canonical key for a WWDC session. */
export function buildKey(year, sessionId) {
  return `${ROOT_SLUG}/wwdc${year}-${sessionId}`
}

export function buildAsciiwwdcPath(year, sessionId) {
  return `${ASCIIWWDC_LANGUAGE}/${year}/${sessionId}.vtt`
}
