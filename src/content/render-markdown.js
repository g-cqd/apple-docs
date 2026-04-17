import { toFrontMatter } from '../lib/yaml.js'
import { renderContentNodesToText } from './normalize.js'
import { safeJson } from './safe-json.js'

const LINK_SECTION_TITLES = {
  topics: 'Topics',
  relationships: 'Relationships',
  see_also: 'See Also',
}

export function renderMarkdown(document, sections = [], opts = {}) {
  const {
    includeFrontMatter = true,
    includeTitle = true,
  } = opts
  const doc = coerceDocument(document)
  const orderedSections = sections
    .map(coerceSection)
    .sort((a, b) => a.sortOrder - b.sortOrder)

  const parts = []
  if (includeFrontMatter) {
    parts.push(toFrontMatter(compactObject({
      title: doc.title,
      framework: doc.frameworkDisplay ?? doc.framework,
      role: doc.role,
      role_heading: doc.roleHeading,
      platforms: formatPlatforms(doc.platformsJson),
      path: doc.key,
    })))
    parts.push('')
  }

  if (includeTitle && doc.title) {
    parts.push(`# ${doc.title}`)
    parts.push('')
  }

  for (const section of orderedSections) {
    const rendered = renderSectionMarkdown(section)
    if (rendered) {
      parts.push(rendered)
      parts.push('')
    }
  }

  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

function renderSectionMarkdown(section) {
  switch (section.sectionKind) {
    case 'abstract':
      return section.contentText?.trim() ?? ''
    case 'declaration':
      return renderDeclarationMarkdown(section)
    case 'parameters':
      return renderParametersMarkdown(section)
    case 'discussion':
      return renderTitledSection(section.heading ?? 'Overview', normalizeParagraphs(section.contentText))
    case 'topics':
    case 'relationships':
    case 'see_also':
      return renderLinkSectionMarkdown(LINK_SECTION_TITLES[section.sectionKind] ?? section.heading ?? 'Related', section)
    default:
      if (!section.contentText?.trim()) return ''
      return renderTitledSection(section.heading ?? humanize(section.sectionKind), normalizeParagraphs(section.contentText))
  }
}

function renderDeclarationMarkdown(section) {
  const declarations = safeJson(section.contentJson)
  const blocks = Array.isArray(declarations) ? declarations : []
  const renderedBlocks = blocks
    .map(declaration => {
      const code = (declaration?.tokens ?? []).map(token => token.text ?? '').join('')
      const language = declaration?.languages?.[0] ?? 'swift'
      if (!code.trim()) return null
      return [`\`\`\`${language}`, code, '```'].join('\n')
    })
    .filter(Boolean)

  if (renderedBlocks.length > 0) {
    return ['## Declaration', '', renderedBlocks.join('\n\n')].join('\n')
  }

  if (!section.contentText?.trim()) return ''
  return ['## Declaration', '', '```swift', section.contentText.trim(), '```'].join('\n')
}

function renderParametersMarkdown(section) {
  const parameters = safeJson(section.contentJson)
  const lines = ['## Parameters', '']

  if (Array.isArray(parameters) && parameters.length > 0) {
    for (const parameter of parameters) {
      const description = renderContentNodesToText(parameter?.content ?? [], {})
        .replace(/\s+/g, ' ')
        .trim()
      lines.push(`- \`${parameter?.name ?? 'Value'}\`: ${description}`.trim())
    }
  } else if (section.contentText?.trim()) {
    lines.push(...section.contentText.trim().split('\n').filter(Boolean).map(line => `- ${line}`))
  }

  return lines.join('\n').trim()
}

function renderLinkSectionMarkdown(title, section) {
  const lines = [`## ${title}`, '']
  const groups = safeJson(section.contentJson)

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        lines.push(`### ${group.title}`)
        lines.push('')
      }
      for (const item of group?.items ?? []) {
        if (item?.key) {
          lines.push(`- [${item.title ?? item.key}](${item.key}.md)`)
        } else {
          lines.push(`- ${item?.title ?? item?.identifier ?? ''}`.trim())
        }
      }
      lines.push('')
    }
    return lines.join('\n').trim()
  }

  if (section.contentText?.trim()) {
    lines.push(...section.contentText.trim().split('\n').filter(Boolean).map(line => `- ${line}`))
  }

  return lines.join('\n').trim()
}

function renderTitledSection(title, body) {
  if (!body) return ''
  return [`## ${title}`, '', body].join('\n')
}

function normalizeParagraphs(text) {
  if (!text?.trim()) return ''
  return text
    .trim()
    .split(/\n{2,}/)
    .map(paragraph => paragraph.replace(/\n+/g, ' ').trim())
    .join('\n\n')
}

function formatPlatforms(platformsJson) {
  const parsed = typeof platformsJson === 'string' ? safeJson(platformsJson) : platformsJson
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return undefined

  return Object.entries(parsed)
    .map(([platform, version]) => version ? `${prettyPlatform(platform)} ${version}+` : prettyPlatform(platform))
}

function prettyPlatform(platform) {
  const map = {
    ios: 'iOS',
    macos: 'macOS',
    watchos: 'watchOS',
    tvos: 'tvOS',
    visionos: 'visionOS',
    maccatalyst: 'Mac Catalyst',
    ipados: 'iPadOS',
  }
  return map[platform] ?? platform
}

function coerceDocument(document) {
  return {
    key: document?.key ?? document?.path ?? null,
    title: document?.title ?? null,
    framework: document?.framework ?? null,
    frameworkDisplay: document?.frameworkDisplay ?? document?.framework_display ?? null,
    role: document?.role ?? null,
    roleHeading: document?.roleHeading ?? document?.role_heading ?? null,
    platformsJson: document?.platformsJson ?? document?.platforms_json ?? null,
  }
}

function coerceSection(section) {
  return {
    sectionKind: section?.sectionKind ?? section?.section_kind ?? null,
    heading: section?.heading ?? null,
    contentText: section?.contentText ?? section?.content_text ?? '',
    contentJson: section?.contentJson ?? section?.content_json ?? null,
    sortOrder: section?.sortOrder ?? section?.sort_order ?? 0,
  }
}

function compactObject(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null))
}

function humanize(value) {
  return String(value ?? 'Section')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}
