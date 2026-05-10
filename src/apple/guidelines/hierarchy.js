/**
 * Hierarchy resolution: walks the dotted section numbering
 * (1, 1.1, 1.1.2, 1.1.2(a)) to derive parent links.
 */

export function buildHierarchy(sections) {
  const byNumber = new Map()
  for (const s of sections) {
    if (s.sectionNumber) byNumber.set(s.sectionNumber, s)
  }

  for (const s of sections) {
    if (!s.sectionNumber) continue
    const parent = findParentNumber(s.sectionNumber)
    if (parent && byNumber.has(parent)) {
      byNumber.get(parent).children.push(s.path)
    }
  }
}

/**
 * Given "1.1.1", return "1.1". Given "3.1.3(a)", return "3.1.3".
 */
function findParentNumber(num) {
  // Handle parenthetical suffixes: "3.1.3(a)" → parent is "3.1.3"
  if (num.includes('(')) {
    return num.replace(/\([a-z]\)$/, '')
  }
  // Handle dotted numbers: "1.1.1" → "1.1", "1.1" → "1"
  const lastDot = num.lastIndexOf('.')
  if (lastDot === -1) return null
  return num.slice(0, lastDot)
}

