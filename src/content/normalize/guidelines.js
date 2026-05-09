// App Store Review Guidelines normalizer.
//
// Pulled out of content/normalize.js as part of Phase B. The guidelines
// adapter delivers a pre-parsed payload (title + markdown + children),
// so this normalizer is much simpler than the DocC one — just project
// onto the document/section/relationship shape.

export function normalizeGuidelines(payload, key) {
  // payload: { title, role, roleHeading, path, markdown, abstract, id, children: [childPath...] }
  const title = payload?.title ?? null
  const role = payload?.role ?? null
  const roleHeading = payload?.roleHeading ?? null
  const path = payload?.path ?? key ?? null

  const url = path
    ? `https://developer.apple.com/app-store/review/guidelines/#${payload?.id ?? ''}`
    : null

  const document = {
    sourceType: 'guidelines',
    key: key ?? path,
    title,
    kind: role ?? 'article',
    role,
    roleHeading,
    framework: 'app-store-review',
    url,
    language: null,
    abstractText: payload?.abstract ?? null,
    declarationText: null,
    platformsJson: null,
    minIos: null,
    minMacos: null,
    minWatchos: null,
    minTvos: null,
    minVisionos: null,
    isDeprecated: false,
    isBeta: false,
    isReleaseNotes: false,
    urlDepth: path ? path.split('/').length - 1 : 0,
    headings: null,
    sourceMetadata: null,
  }

  const sections = []
  let order = 0

  if (payload?.abstract) {
    sections.push({
      sectionKind: 'abstract',
      heading: null,
      contentText: payload.abstract,
      contentJson: null,
      sortOrder: order++,
    })
  }

  if (payload?.markdown) {
    sections.push({
      sectionKind: 'discussion',
      heading: 'Overview',
      contentText: payload.markdown,
      contentJson: null,
      sortOrder: order++,
    })
  }

  const relationships = []
  let relOrder = 0
  for (const childPath of payload?.children ?? []) {
    if (childPath) {
      relationships.push({
        fromKey: key ?? path,
        toKey: childPath,
        relationType: 'child',
        section: 'Topics',
        sortOrder: relOrder++,
      })
    }
  }

  return { document, sections, relationships }
}
