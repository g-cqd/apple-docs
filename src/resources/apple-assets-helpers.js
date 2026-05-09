/**
 * Pure formatting / normalization helpers shared across the apple-fonts and
 * apple-symbols decomposition. Pulled out of apple-assets.js so the
 * extracted modules don't pull in the full file just for one helper.
 */

export function sanitizeFileName(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'asset'
}

export function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return min
  return Math.min(Math.max(parsed, min), max)
}

export function normalizeColor(value) {
  const raw = String(value ?? '#000000').trim()
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw) ? raw : '#000000'
}

export function normalizeBackground(value) {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw || raw === 'transparent' || raw === 'none') return null
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(raw) ? raw : null
}

export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
