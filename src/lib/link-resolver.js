/**
 * Global link resolver — maps every external URL pattern we know about to its
 * corresponding corpus storage key, and packages the rules into a callback
 * shape compatible with `htmlToMarkdown`'s `linkResolver` opt and the audit
 * command's classifier.
 *
 * URL→key rules live in one place so adding a new source means adding one
 * pattern instead of editing per-adapter resolvers.
 */

/** Pure mapping rules: URL → candidate corpus key, no DB access. */
const RULES = [
  // developer.apple.com/documentation/<framework>/<rest>  → <framework>/<rest>
  // The framework slug is Apple's lowercase-no-hyphen form (`swiftui`, `appkit`).
  // Strip trailing slashes; keep the rest of the path verbatim and lowercase.
  {
    test: (u) => u.hostname === 'developer.apple.com' && /^\/documentation\//.test(u.pathname),
    map: (u) => {
      const path = u.pathname.replace(/^\/documentation\//, '').replace(/\/+$/, '')
      return path ? path.toLowerCase() : null
    },
  },

  // developer.apple.com/design/human-interface-guidelines/<rest>
  //   → design/human-interface-guidelines/<rest>
  {
    test: (u) => u.hostname === 'developer.apple.com' && u.pathname.startsWith('/design/'),
    map: (u) => {
      const path = u.pathname.replace(/^\//, '').replace(/\/+$/, '')
      return path ? path.toLowerCase() : null
    },
  },

  // developer.apple.com/library/archive/<archive-path>  → apple-archive/<archive-path>
  // Archive keys preserve original case ("AppleApplications/Conceptual/...").
  {
    test: (u) => u.hostname === 'developer.apple.com' && u.pathname.startsWith('/library/archive/'),
    map: (u) => {
      const path = u.pathname.replace(/^\/library\/archive\//, '').replace(/\/+$/, '')
      if (!path) return null
      // The catalog applies an index/match collapse to terminal HTML files
      // ("…/Foo.html" with parent "Foo" maps to "…/Foo"). Mirror that here so
      // the candidate key matches the stored format.
      const match = path.match(/^(.*)\/([^/]+)\.(html|htm)$/i)
      if (match) {
        const [, dir, base, ext] = match
        const parent = dir.split('/').pop() ?? ''
        if (base.toLowerCase() === 'index' || base.toLowerCase() === parent.toLowerCase()) {
          return `apple-archive/${dir}`
        }
        return `apple-archive/${dir}/${base}.${ext.toLowerCase()}`
      }
      return `apple-archive/${path}`
    },
  },

  // developer.apple.com/videos/play/wwdc<year>/<id>/  → wwdc/wwdc<year>-<id>
  {
    test: (u) => u.hostname === 'developer.apple.com' && /^\/videos\/play\/wwdc\d{4}\/\d+\/?$/.test(u.pathname),
    map: (u) => {
      const m = u.pathname.match(/^\/videos\/play\/(wwdc\d{4})\/(\d+)/)
      return m ? `wwdc/${m[1]}-${m[2]}` : null
    },
  },

  // docs.swift.org/swift-book/documentation/the-swift-programming-language/<chapter>
  //   → swift-book/<chapter>
  // The corpus key uses CamelCase chapter names ("LanguageGuide/TheBasics");
  // the URL uses lowercase ("languageguide/thebasics"). Without a chapter
  // index we can only return the lowercased rest and let the caller's
  // knownKeys.has() pass it through after lower-cased comparison.
  {
    test: (u) => u.hostname === 'docs.swift.org' && u.pathname.startsWith('/swift-book/'),
    map: (u) => {
      const rest = u.pathname.replace(/^\/swift-book\//, '').replace(/\/+$/, '')
      return rest ? `swift-book/${rest}` : 'swift-book'
    },
  },

  // docs.swift.org/compiler/<rest>  → swift-compiler/<rest>
  {
    test: (u) => u.hostname === 'docs.swift.org' && u.pathname.startsWith('/compiler/'),
    map: (u) => {
      const rest = u.pathname.replace(/^\/compiler\//, '').replace(/\/+$/, '')
      return rest ? `swift-compiler/${rest}` : 'swift-compiler'
    },
  },

  // docs.swift.org/swiftpm/<rest>  → swift-package-manager/<rest>
  {
    test: (u) => u.hostname === 'docs.swift.org' && u.pathname.startsWith('/swiftpm/'),
    map: (u) => {
      const rest = u.pathname.replace(/^\/swiftpm\//, '').replace(/\/+$/, '')
      return rest ? `swift-package-manager/${rest}` : 'swift-package-manager'
    },
  },

  // swift.org/migration/<rest>  → swift-migration-guide/<rest>
  {
    test: (u) => isSwiftOrg(u) && u.pathname.startsWith('/migration/'),
    map: (u) => {
      const rest = u.pathname.replace(/^\/migration\//, '').replace(/\/+$/, '')
      return rest ? `swift-migration-guide/${rest}` : 'swift-migration-guide'
    },
  },

  // swift.org/swift-evolution/proposals/<NNNN-name>.html  → swift-evolution/<NNNN-name>
  // Some proposals are also linked as github.com/apple/swift-evolution/blob/main/proposals/...
  {
    test: (u) => isSwiftOrg(u) && /^\/swift-evolution\/proposals\/\d{4}-/.test(u.pathname),
    map: (u) => {
      const m = u.pathname.match(/\/proposals\/(\d{4}-[^/]+?)(?:\.md|\.html)?\/?$/)
      return m ? `swift-evolution/${m[1]}` : null
    },
  },
  {
    test: (u) => u.hostname === 'github.com' && /^\/(?:apple|swiftlang)\/swift-evolution\/(?:blob|tree)\//.test(u.pathname),
    map: (u) => {
      const m = u.pathname.match(/\/proposals\/(\d{4}-[^/]+?)(?:\.md|\.html)?\/?$/)
      return m ? `swift-evolution/${m[1]}` : null
    },
  },

  // NB: there is intentionally no generic `swift.org/<anything> → swift-org/`
  // rule. The set of swift-org pages we publish is curated; mapping every
  // swift.org URL would internalize blog posts, marketing pages, and
  // unrelated docs. The swift-org adapter passes its CURATED_PATHS set to
  // `createLinkResolver` via `opts.swiftOrgPaths` so only listed paths are
  // claimed (see createLinkResolver implementation below).
]

const SWIFT_ORG_REDIRECTS = {
  'documentation/concurrency':       'swift-migration-guide/documentation/migrationguide',
  'documentation/package-manager':   'swift-package-manager/documentation/packagemanagerdocs',
  'documentation/tspl':              'swift-book/The-Swift-Programming-Language',
}

function isSwiftOrg(u) {
  return u.hostname === 'swift.org' || u.hostname === 'www.swift.org'
}

/**
 * Try every URL→key rule in order and return the first non-null match.
 * Pure (no I/O); safe to call on any URL string.
 *
 * @param {string} url
 * @returns {string|null} candidate corpus key
 */
export function mapUrlToKey(url) {
  if (typeof url !== 'string' || !url) return null
  let parsed
  try { parsed = new URL(url) } catch { return null }

  // Apply known swift.org redirect aliases before hostname rules so they
  // win over the generic swift-org fallback.
  if (isSwiftOrg(parsed)) {
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    if (path in SWIFT_ORG_REDIRECTS) return SWIFT_ORG_REDIRECTS[path]
  }

  for (const rule of RULES) {
    if (rule.test(parsed)) {
      const key = rule.map(parsed)
      if (key) return key
    }
  }
  return null
}

/**
 * Build a link-resolver callback compatible with `htmlToMarkdown`'s
 * `linkResolver` opt: returns the rewritten href string, or `null` to
 * unwrap the anchor (keep the inner text only). The original href is
 * returned when no rewrite applies.
 *
 * @param {object} opts
 * @param {Set<string>} [opts.knownKeys] Set of corpus keys that exist.
 *   When supplied, every pattern match is verified before internalization.
 *   Without it, the strict pattern-based rules are trusted.
 * @param {Set<string>} [opts.swiftOrgPaths] Curated swift.org paths. When
 *   present, swift.org URLs whose path-without-trailing-slash is in this
 *   set are internalized to `/docs/swift-org/<path>/`.
 * @param {string} [opts.sourceUrl] Absolute URL of the page being parsed,
 *   used to resolve relative links.
 * @param {string} [opts.docsBase] Internal route prefix (default `/docs`).
 *   The returned hrefs are `${docsBase}/<key>/`.
 * @returns {(href: string) => string}
 */
export function createLinkResolver(opts = {}) {
  const knownKeys = opts.knownKeys ?? null
  const swiftOrgPaths = opts.swiftOrgPaths ?? null
  const docsBase = opts.docsBase ?? '/docs'
  const baseUrl = opts.sourceUrl
  let base
  try { base = baseUrl ? new URL(baseUrl) : null } catch { base = null }

  return (rawHref) => {
    if (typeof rawHref !== 'string' || !rawHref) return rawHref
    // Bail on schemes we never want to rewrite.
    if (/^(?:mailto:|tel:|javascript:|data:|#)/i.test(rawHref)) return rawHref

    let abs
    try {
      abs = base ? new URL(rawHref, base) : new URL(rawHref)
    } catch {
      return rawHref
    }

    // 1. Already an internal /docs/<key>/ route — leave alone.
    if (abs.origin === (base?.origin ?? abs.origin) && abs.pathname.startsWith(`${docsBase}/`)) {
      return rawHref
    }

    // 2. Try to internalize against the structured-pattern rules. With
    //    `knownKeys` we verify the key exists; without it we trust every
    //    pattern match.
    const candidate = mapUrlToKey(abs.toString())
    if (candidate && (knownKeys === null || knownKeys.has(candidate))) {
      const fragment = abs.hash || ''
      return `${docsBase}/${candidate}/${fragment}`
    }

    // 3. swift.org generic-path opt-in: internalize only when the path is
    //    in the caller's curated-path set. Avoids capturing /blog, /jobs,
    //    /support, etc.
    if (swiftOrgPaths && isSwiftOrg(abs)) {
      const path = abs.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
      const variants = [path, `${path}.html`]
      for (const v of variants) {
        if (swiftOrgPaths.has(v)) {
          const fragment = abs.hash || ''
          return `${docsBase}/swift-org/${v}/${fragment}`
        }
      }
    }

    // 4. Otherwise return the absolute URL — at least the link works as
    //    external content and doesn't dangle on our host.
    return abs.toString()
  }
}

/**
 * Classify a single URL for audit purposes.
 *
 * @param {string} url
 * @param {object} opts
 * @param {Set<string>} opts.knownKeys
 * @param {string} [opts.docsBase] internal route prefix (default `/docs`)
 * @returns {{ category: string, internalKey?: string, normalized?: string }}
 *   category ∈ {fragment, internal_ok, internal_broken,
 *               external_resolvable, external, relative_broken}
 */
export function classifyLink(url, opts) {
  const knownKeys = opts.knownKeys
  const docsBase = opts.docsBase ?? '/docs'

  if (typeof url !== 'string' || !url) {
    return { category: 'relative_broken' }
  }

  // Fragment-only links are always page-local.
  if (url.startsWith('#')) return { category: 'fragment' }

  // Non-http schemes are external by definition.
  if (/^(?:mailto:|tel:|javascript:|data:)/i.test(url)) {
    return { category: 'external', normalized: url }
  }

  // Internal /docs/<key>/ links — verify the key resolves.
  if (url.startsWith(`${docsBase}/`)) {
    // Strip trailing slash + fragment + querystring to get the key.
    const m = url.slice(docsBase.length + 1).match(/^([^?#]+?)\/?(?:[?#].*)?$/)
    const key = m ? decodeURIComponent(m[1]) : null
    if (key && knownKeys.has(key)) {
      return { category: 'internal_ok', internalKey: key }
    }
    return { category: 'internal_broken', internalKey: key ?? url }
  }

  // Any other relative path — flag as broken (it would resolve against the
  // current host, which is rarely what we want).
  if (url.startsWith('/')) {
    return { category: 'relative_broken', normalized: url }
  }

  // Absolute URL: try to internalize, otherwise mark external.
  let abs
  try { abs = new URL(url) } catch { return { category: 'relative_broken', normalized: url } }
  const candidate = mapUrlToKey(abs.toString())
  if (candidate && knownKeys.has(candidate)) {
    return { category: 'external_resolvable', internalKey: candidate, normalized: url }
  }
  return { category: 'external', normalized: url }
}
