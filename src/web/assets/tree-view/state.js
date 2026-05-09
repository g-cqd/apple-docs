// Tree-view state derivation: builds the parent → children adjacency map,
// the root list, and memoised descendant counts from the wire-format JSON.
// All helpers below take this state object as their first argument so the
// render layer doesn't reach into module-level globals.

export function buildTreeState(data) {
  const docs = data.docs
  const edges = data.edges
  const children = new Map()
  const childSet = new Set()
  for (const { from_key, to_key } of edges) {
    let kids = children.get(from_key)
    if (!kids) {
      kids = []
      children.set(from_key, kids)
    }
    kids.push(to_key)
    childSet.add(to_key)
  }

  // Root nodes appear as parent but never as child.
  const allParents = [...children.keys()]
  const rootKeys = allParents.filter(k => !childSet.has(k))

  // Sort children alphabetically within each parent by title.
  const titleOf = (k) => (docs[k]?.title ?? k).toLowerCase()
  for (const [, kids] of children) {
    kids.sort((a, b) => {
      const ta = titleOf(a)
      const tb = titleOf(b)
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })
  }
  rootKeys.sort((a, b) => {
    const ta = titleOf(a)
    const tb = titleOf(b)
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })

  // Memoised descendant counts for the badges next to each tree node.
  const descendantCounts = new Map()
  const visited = new Set()
  function count(key) {
    if (visited.has(key)) return 0
    visited.add(key)
    const kids = children.get(key)
    if (!kids) { descendantCounts.set(key, 0); return 0 }
    let total = kids.length
    for (const k of kids) total += count(k)
    descendantCounts.set(key, total)
    return total
  }
  for (const key of rootKeys) count(key)
  for (const key of children.keys()) if (!visited.has(key)) count(key)

  return { docs, children, rootKeys, descendantCounts }
}

// Disambiguate sibling overloads: items sharing a title get a parent prefix
// like `View.body` so the user can tell two `body`s apart.
export function disambiguateChildren(state, parentKey, childKeys) {
  const { docs } = state
  const titleCounts = new Map()
  for (const key of childKeys) {
    const t = docs[key]?.title ?? key
    titleCounts.set(t, (titleCounts.get(t) || 0) + 1)
  }
  const parentTitle = docs[parentKey]?.title ?? parentKey
  const result = new Map()
  for (const key of childKeys) {
    const t = docs[key]?.title ?? key
    if (titleCounts.get(t) > 1) {
      result.set(key, `${parentTitle}.${t}`)
    }
  }
  return result
}

// Walk down a single-child chain, accumulating titles into one label.
// `View > Body > Modifier` collapses to a single `View.Body.Modifier`
// row when each parent has exactly one child.
export function compactChain(state, key) {
  const { docs, children } = state
  const parts = [docs[key]?.title || key]
  const seen = new Set([key])
  let cur = key
  while (true) {
    const kids = children.get(cur)
    if (!kids || kids.length !== 1) break
    const onlyChild = kids[0]
    if (seen.has(onlyChild)) break
    const childKids = children.get(onlyChild)
    if (!childKids || childKids.length === 0) break
    parts.push(docs[onlyChild]?.title || onlyChild)
    seen.add(onlyChild)
    cur = onlyChild
  }
  return { label: parts.join('.'), terminalKey: cur }
}
