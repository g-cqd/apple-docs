// Transcript extraction across both supported corpora:
//   - Apple JSON sessions (DocC-style render-tree, 2020+)
//   - ASCIIwwdc community transcripts (VTT-flavoured plain text, 1997-2019)
//
// The Apple-side helpers also do the title + description extraction
// since they walk the same JSON tree.

import { decodeHtmlEntities } from './apple-html.js'
import { VTT_TIMESTAMP_RE } from './constants.js'

/**
 * Walk Apple's session JSON for the first transcript-like text block.
 * Returns the joined text plus the raw nodes (when available) so callers
 * can preserve the structured layout downstream.
 */
export function extractAppleTranscript(json) {
  const candidate = deepFind(json, 'transcript')
  if (typeof candidate === 'string' && candidate.length > 0) {
    return { text: candidate, nodes: null }
  }

  const sections = json?.primaryContentSections ?? json?.sections ?? []
  const texts = []
  const allNodes = []
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section?.kind === 'content' || section?.kind === 'transcript') {
      const contentNodes = section?.content ?? []
      texts.push(...collectInlineText(contentNodes))
      allNodes.push(...contentNodes)
    }
  }
  if (texts.length === 0) return { text: null, nodes: null }
  return { text: texts.join('\n\n'), nodes: allNodes.length > 0 ? allNodes : null }
}

/** Recursively find the first value at `key` in a tree. */
function deepFind(obj, key, maxDepth = 6) {
  if (maxDepth <= 0 || obj == null || typeof obj !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key, maxDepth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Collect plain text strings from a DocC render-tree content array. */
function collectInlineText(content) {
  const texts = []
  for (const node of Array.isArray(content) ? content : []) {
    if (node?.type === 'text' && typeof node.text === 'string') {
      texts.push(node.text)
    } else if (node?.type === 'codeVoice' && typeof node.code === 'string') {
      texts.push(node.code)
    } else if (node?.type === 'codeListing') {
      texts.push((node.code ?? []).join('\n'))
    } else if (node?.type === 'paragraph') {
      texts.push(...collectInlineText(node.inlineContent ?? []))
    } else if (Array.isArray(node?.inlineContent)) {
      texts.push(...collectInlineText(node.inlineContent))
    } else if (Array.isArray(node?.content)) {
      texts.push(...collectInlineText(node.content))
    }
  }
  return texts
}

export function extractAppleDescription(json) {
  if (typeof json?.description === 'string' && json.description.length > 0) {
    return json.description
  }

  const abstractSection = (json?.primaryContentSections ?? []).find(
    s => s?.kind === 'abstract',
  )
  if (abstractSection) {
    const parts = collectInlineText(abstractSection?.content ?? [])
    if (parts.length > 0) return parts.join(' ')
  }

  if (typeof json?.metadata?.description === 'string') {
    return json.metadata.description
  }

  return null
}

export function extractAppleTitle(json, year, sessionId) {
  const candidate =
    json?.title ??
    json?.metadata?.title ??
    deepFind(json, 'title')
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return `WWDC${year} Session ${sessionId}`
}

/**
 * Derive a human-readable title from a session's text content. ASCIIwwdc
 * files occasionally start with a heading line; otherwise we fall back
 * to the session number.
 */
export function extractAsciiwwdcTitle(text, year, sessionId) {
  if (String(text).includes('WEBVTT') || VTT_TIMESTAMP_RE.test(String(text).split('\n')[0]?.trim() ?? '')) {
    return `WWDC${year} Session ${sessionId}`
  }

  const firstLine = text.split('\n').find(line => line.trim().length > 0)
  if (firstLine && !/^\[?\d{2}:\d{2}/.test(firstLine.trim())) {
    const candidate = firstLine.trim()
    if (candidate.length > 0 && candidate.length < 200) return candidate
  }
  return `WWDC${year} Session ${sessionId}`
}

export function normalizeAsciiwwdcTranscript(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const cleaned = []
  for (const rawLine of lines) {
    const line = decodeHtmlEntities(rawLine).replace(/<[^>]+>/g, '').trim()
    if (!line) continue
    if (line === 'WEBVTT') continue
    if (/^\d+$/.test(line)) continue
    if (line.startsWith('NOTE')) continue
    if (VTT_TIMESTAMP_RE.test(line)) continue
    if (cleaned[cleaned.length - 1] === line) continue
    cleaned.push(line)
  }

  return cleaned.join('\n')
}
