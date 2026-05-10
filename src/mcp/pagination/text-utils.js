// Text-shaping helpers used by both the array and text-window paginators.
// All exports are pure functions so each is independently testable.

export function splitText(text) {
  const paragraphs = text.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
  if (paragraphs.length > 1) return paragraphs

  const lines = text.split('\n').map(part => part.trim()).filter(Boolean)
  if (lines.length > 1) return lines

  return [text.trim()]
}

export function groupChunks(chunks, targetChars) {
  const groups = []
  let buffer = []
  let bufferLength = 0

  for (const chunk of chunks) {
    const separator = buffer.length > 0 ? 2 : 0
    if (bufferLength + separator + chunk.length <= targetChars || buffer.length === 0) {
      buffer.push(chunk)
      bufferLength += separator + chunk.length
      continue
    }

    groups.push(buffer.join('\n\n'))
    buffer = [chunk]
    bufferLength = chunk.length
  }

  if (buffer.length > 0) groups.push(buffer.join('\n\n'))
  return groups
}

export function splitByCharacterWindow(text, targetChars) {
  const parts = []
  let start = 0
  while (start < text.length) {
    start = skipWhitespace(text, start)
    if (start >= text.length) break
    const end = Math.min(text.length, start + targetChars)
    const slice = sliceTextAtBoundary(text, start, end)
    parts.push(slice.text)
    start = slice.end
  }
  return parts.filter(Boolean)
}

export function sliceTextAtBoundary(text, start, end) {
  if (end >= text.length) {
    return {
      text: text.slice(start).trim(),
      end: text.length,
    }
  }

  const slice = text.slice(start, end)
  const boundary = Math.max(
    slice.lastIndexOf('\n\n'),
    slice.lastIndexOf('\n'),
    slice.lastIndexOf(' '),
  )

  if (boundary <= Math.min(24, Math.floor(slice.length / 4))) {
    return { text: slice.trim(), end }
  }

  return {
    text: slice.slice(0, boundary).trim(),
    end: start + boundary,
  }
}

export function excerptAroundMatch(text, index, matchLength, contextChars) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(text.length, index + matchLength + contextChars)
  const excerpt = text.slice(start, end).trim()
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return `${prefix}${excerpt}${suffix}`
}

export function serializePayload(payload) {
  return JSON.stringify(payload, null, 2)
}

export function skipWhitespace(text, start) {
  let index = start
  while (index < text.length && /\s/.test(text[index])) index++
  return index
}
