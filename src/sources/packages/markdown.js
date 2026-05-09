/**
 * Markdown synthesis + section helpers for repo metadata.
 * Produces a doc-shaped Markdown for repos whose README we can pull,
 * and a metadata section the renderer surfaces alongside the README.
 */

export function synthesizeMarkdown(repo) {
  const title = repo?.full_name ?? repo?.name ?? 'Swift Package'
  const description = repo?.description?.trim() || 'Package metadata imported from GitHub.'
  return `# ${title}\n\n${description}\n`
}

export function normalizeLicense(license) {
  if (!license) return null
  if (license.spdx_id && license.spdx_id !== 'NOASSERTION') return license.spdx_id
  return license.name ?? null
}

export function normalizeLanguage(language) {
  return typeof language === 'string' && language.trim() ? language.trim().toLowerCase() : null
}

export function reindexSections(sections) {
  return sections.map((section, index) => ({
    ...section,
    sortOrder: index,
  }))
}

export function ensureAbstractSection(sections, abstractText) {
  if (!abstractText) return sections
  const next = sections.map(section => ({ ...section }))
  const index = next.findIndex(section => section.sectionKind === 'abstract')
  if (index >= 0) {
    next[index].contentText = abstractText
    next[index].contentJson = null
  } else {
    next.unshift({
      sectionKind: 'abstract',
      heading: null,
      contentText: abstractText,
      contentJson: null,
      sortOrder: 0,
    })
  }
  return reindexSections(next)
}

export function appendMetadataSection(sections, repo, readme) {
  const fields = []
  fields.push(`Repository: ${repo?.full_name ?? repo?.name ?? 'unknown'}`)

  if (repo?.homepage) fields.push(`Homepage: ${repo.homepage}`)
  if (repo?.stargazers_count != null) fields.push(`Stars: ${repo.stargazers_count}`)
  if (repo?.forks_count != null) fields.push(`Forks: ${repo.forks_count}`)
  if (repo?.open_issues_count != null) fields.push(`Open issues: ${repo.open_issues_count}`)
  if (repo?.default_branch) fields.push(`Default branch: ${repo.default_branch}`)

  const language = normalizeLanguage(repo?.language)
  if (language) fields.push(`Primary language: ${language}`)

  const license = normalizeLicense(repo?.license)
  if (license) fields.push(`License: ${license}`)

  if (Array.isArray(repo?.topics) && repo.topics.length > 0) {
    fields.push(`Topics: ${repo.topics.join(', ')}`)
  }

  if (readme?.path) fields.push(`README: ${readme.path}`)
  if (repo?.archived) fields.push('Archived: yes')
  if (repo?.fork) fields.push('Fork: yes')

  if (fields.length === 0) return sections

  return reindexSections([
    ...sections.map(section => ({ ...section })),
    {
      sectionKind: 'discussion',
      heading: 'Package Metadata',
      contentText: fields.join('\n\n'),
      contentJson: null,
      sortOrder: sections.length,
    },
  ])
}

/**
 * Try README filename variants on raw.githubusercontent.com against a given
 * branch, stopping at the first 200. Returns the README shaped like the GitHub
 * /readme API payload, or `null` if all variants 404.
 */

export function synthesizeRepoShape({ owner, repo }, { branch, description }) {
  return {
    name: repo,
    full_name: `${owner}/${repo}`,
    html_url: `https://github.com/${owner}/${repo}`,
    description: description ?? null,
    language: null,
    stargazers_count: null,
    forks_count: null,
    open_issues_count: null,
    topics: [],
    homepage: null,
    default_branch: branch ?? 'main',
    archived: false,
    fork: false,
    owner: { login: owner },
    license: null,
    pushed_at: null,
    updated_at: null,
  }
}

