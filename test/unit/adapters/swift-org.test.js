import { afterEach, describe, expect, test } from 'bun:test'
import { SwiftOrgAdapter } from '../../../src/sources/swift-org.js'
// Side-effect: register cross-source entry points used by the cross-link tests.
import '../../../src/sources/swift-docc.js'
import '../../../src/sources/swift-book.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Minimal HTML fixture representative of a swift.org documentation page
// ---------------------------------------------------------------------------

const HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head>
  <title>Concurrency | Swift.org</title>
  <meta name="description" content="Learn how Swift supports concurrent code using async/await and actors.">
</head>
<body>
  <header><nav>Navigation</nav></header>
  <main>
    <h1>Concurrency</h1>
    <p>Swift has built-in support for writing asynchronous and parallel code.</p>
    <h2>Asynchronous Functions</h2>
    <p>An asynchronous function can be suspended while it is partway through execution.</p>
    <h2>Actors</h2>
    <p>Actors allow only one task to access their mutable state at a time.</p>
  </main>
  <footer>Footer</footer>
</body>
</html>`

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwiftOrgAdapter', () => {
  test('static metadata is correct', () => {
    expect(SwiftOrgAdapter.type).toBe('swift-org')
    expect(SwiftOrgAdapter.displayName).toBe('Swift.org Documentation')
    expect(SwiftOrgAdapter.syncMode).toBe('flat')
  })

  describe('discover', () => {
    test('returns curated keys prefixed with swift-org', async () => {
      let root = null
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() {
            return root
          },
          upsertRoot(slug, displayName, kind, source) {
            root = { slug, display_name: displayName, kind, source, source_type: 'swift-org' }
            return root
          },
        },
      }

      const result = await adapter.discover(ctx)

      expect(Array.isArray(result.keys)).toBe(true)
      expect(result.keys.length).toBeGreaterThan(0)
      for (const key of result.keys) {
        expect(key.startsWith('swift-org/')).toBe(true)
      }
    })

    test('includes expected curated documentation paths', async () => {
      let root = null
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() { return root },
          upsertRoot(slug, displayName, kind, source) {
            root = { slug, display_name: displayName, kind, source }
            return root
          },
        },
      }

      const result = await adapter.discover(ctx)

      expect(result.keys).toContain('swift-org/documentation/api-design-guidelines')
      expect(result.keys).toContain('swift-org/getting-started')
      expect(result.keys).toContain('swift-org/documentation/articles/value-and-reference-types.html')
      expect(result.keys).toContain('swift-org/documentation/core-libraries')
      expect(result.keys).toContain('swift-org/documentation/docc')
      // New coverage from the audit
      expect(result.keys).toContain('swift-org/documentation/swift-compiler')
      expect(result.keys).toContain('swift-org/documentation/lldb')
      expect(result.keys).toContain('swift-org/documentation/server/guides/passkeys.html')
      expect(result.keys).toContain('swift-org/documentation/articles/wasm-getting-started.html')
      expect(result.keys).toContain('swift-org/install/macos')
      expect(result.keys).toContain('swift-org/getting-started/swiftui')
      expect(result.keys).toContain('swift-org/sswg')
      expect(result.keys).toContain('swift-org/code-of-conduct')
    })

    test('drops paths now handled by the swift-docc adapter', async () => {
      let root = null
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() { return root },
          upsertRoot(slug, displayName, kind, source) {
            root = { slug, display_name: displayName, kind, source }
            return root
          },
        },
      }

      const result = await adapter.discover(ctx)

      // Both URLs are now redirects to DocC archives — handled by swift-docc, not swift-org.
      expect(result.keys).not.toContain('swift-org/documentation/concurrency')
      expect(result.keys).not.toContain('swift-org/documentation/package-manager')
    })

    test('registers root in DB when not present', async () => {
      let upsertCalled = false
      let root = null
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() { return root },
          upsertRoot(slug, displayName, kind, source) {
            upsertCalled = true
            root = { slug, display_name: displayName, kind, source }
            return root
          },
        },
      }

      await adapter.discover(ctx)

      expect(upsertCalled).toBe(true)
      expect(root?.slug).toBe('swift-org')
    })

    test('does not re-register root when already present', async () => {
      let upsertCallCount = 0
      const existingRoot = { slug: 'swift-org', display_name: 'Swift.org Documentation' }
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() { return existingRoot },
          upsertRoot() {
            upsertCallCount++
            return existingRoot
          },
        },
      }

      await adapter.discover(ctx)

      expect(upsertCallCount).toBe(0)
    })

    test('exposes root in result', async () => {
      let root = null
      const adapter = new SwiftOrgAdapter()
      const ctx = {
        db: {
          getRootBySlug() { return root },
          upsertRoot(slug, displayName, kind, source) {
            root = { slug, display_name: displayName, kind, source }
            return root
          },
        },
      }

      const result = await adapter.discover(ctx)

      expect(result.roots?.[0]?.slug).toBe('swift-org')
    })
  })

  describe('normalize', () => {
    test('produces a valid normalized document from an HTML fixture', () => {
      const adapter = new SwiftOrgAdapter()
      const key = 'swift-org/documentation/concurrency'

      const result = adapter.normalize(key, HTML_FIXTURE)

      expect(result.document).toBeDefined()
      expect(result.sections).toBeDefined()
      expect(result.relationships).toEqual([])
      expect(Array.isArray(result.sections)).toBe(true)
    })

    test('sets sourceType to swift-org', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.sourceType).toBe('swift-org')
    })

    test('sets framework to swift-org', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.framework).toBe('swift-org')
    })

    test('sets kind to article', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.kind).toBe('article')
    })

    test('extracts title from HTML', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.title).toContain('Concurrency')
    })

    test('strips the " | Swift.org" suffix from the title', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.title).toBe('Concurrency')
      expect(result.document.title).not.toContain('Swift.org')
    })

    test('preserves inline structure (preserveStructure: true)', () => {
      const html = `<!DOCTYPE html><html><head><title>Demo | Swift.org</title></head><body><main>
        <h1>Demo</h1>
        <h2>Section</h2>
        <p>Use <code>swift --version</code> to check.</p>
        <pre><code class="language-swift">let x = 1</code></pre>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/getting-started/cli-swiftpm', html)
      const sec = result.sections.find(s => s.heading === 'Section')
      expect(sec.contentText).toContain('`swift --version`')
      expect(sec.contentText).toContain('```')
      expect(sec.contentText).toContain('let x = 1')
    })

    test('injects a "Related Documentation" topics section on /documentation', () => {
      const html = `<html><body><main><h1>Documentation</h1><p>Welcome.</p></main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation', html)

      const topics = result.sections.find(s => s.sectionKind === 'topics' && s.heading === 'Related Documentation')
      expect(topics).toBeDefined()
      const items = JSON.parse(topics.contentJson)[0].items
      const keys = items.map(i => i.key)
      expect(keys).toContain('swift-compiler/documentation/diagnostics')
      expect(keys).toContain('swift-package-manager/documentation/packagemanagerdocs')
      expect(keys).toContain('swift-migration-guide/documentation/migrationguide')
      expect(keys).toContain('swift-book/The-Swift-Programming-Language')
    })

    test('emits see_also relationships for archive cross-links', () => {
      const html = `<html><body><main><h1>Documentation</h1></main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation', html)
      const seeAlso = result.relationships.filter(r => r.relationType === 'see_also')
      expect(seeAlso.length).toBeGreaterThanOrEqual(4)
      expect(seeAlso.map(r => r.toKey)).toContain('swift-compiler/documentation/diagnostics')
    })

    test('does not inject cross-links on unrelated pages', () => {
      const html = `<html><body><main><h1>Concurrency</h1></main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/about', html)
      const topics = result.sections.find(s => s.heading === 'Related Documentation')
      expect(topics).toBeUndefined()
    })
  })

  describe('link rewriting', () => {
    test('rewrites curated swift.org paths to internal /docs/swift-org/...', () => {
      const html = `<html><body><main>
        <h1>Getting started</h1>
        <h2>Section</h2>
        <p>See <a href="/install">install</a> and <a href="/getting-started/cli-swiftpm">the CLI guide</a>.</p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/getting-started', html)
      const sec = result.sections.find(s => s.heading === 'Section')
      expect(sec.contentText).toContain('](/docs/swift-org/install/)')
      expect(sec.contentText).toContain('](/docs/swift-org/getting-started/cli-swiftpm/)')
      expect(sec.contentText).not.toMatch(/]\(\/install\)/)
    })

    test('rewrites swift.org redirect paths to their swift-docc archive home', () => {
      const html = `<html><body><main>
        <h1>Docs</h1>
        <h2>Section</h2>
        <p>Use <a href="/documentation/package-manager/">SwiftPM</a> and <a href="/documentation/concurrency">migrate</a>.</p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation', html)
      const sec = result.sections.find(s => s.heading === 'Section')
      expect(sec.contentText).toContain('/docs/swift-package-manager/documentation/packagemanagerdocs/')
      expect(sec.contentText).toContain('/docs/swift-migration-guide/documentation/migrationguide/')
    })

    test('rewrites docs.swift.org/swift-book/* → /docs/swift-book/*', () => {
      const html = `<html><body><main>
        <h1>X</h1>
        <h2>S</h2>
        <p><a href="https://docs.swift.org/swift-book/documentation/the-swift-programming-language/guidedtour/">Guided tour</a></p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/getting-started', html)
      const sec = result.sections.find(s => s.heading === 'S')
      expect(sec.contentText).toContain('/docs/swift-book/documentation/the-swift-programming-language/guidedtour/')
    })

    test('absolutizes non-curated relative paths against swift.org', () => {
      const html = `<html><body><main>
        <h1>X</h1>
        <h2>S</h2>
        <p><a href="/LICENSE.txt">LICENSE</a> | <a href="/blog/something">blog</a></p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/about', html)
      const sec = result.sections.find(s => s.heading === 'S')
      expect(sec.contentText).toContain('](https://swift.org/LICENSE.txt)')
      expect(sec.contentText).toContain('](https://swift.org/blog/something)')
    })

    test('leaves external https URLs untouched', () => {
      const html = `<html><body><main>
        <h1>X</h1>
        <h2>S</h2>
        <p><a href="https://github.com/apple/swift">repo</a></p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/about', html)
      const sec = result.sections.find(s => s.heading === 'S')
      expect(sec.contentText).toContain('](https://github.com/apple/swift)')
    })

    test('preserves URL fragments on rewritten links', () => {
      const html = `<html><body><main>
        <h1>X</h1>
        <h2>S</h2>
        <p><a href="/contributing/#reporting-bugs">report</a></p>
      </main></body></html>`
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/about', html)
      const sec = result.sections.find(s => s.heading === 'S')
      expect(sec.contentText).toContain('/docs/swift-org/contributing/#reporting-bugs')
    })

    test('extracts abstract from meta description', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.abstractText).toContain('async/await')
    })

    test('derives URL from key', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      expect(result.document.url).toBe('https://swift.org/documentation/concurrency')
    })

    test('sets document key to the input key', () => {
      const adapter = new SwiftOrgAdapter()
      const key = 'swift-org/documentation/concurrency'
      const result = adapter.normalize(key, HTML_FIXTURE)

      expect(result.document.key).toBe(key)
    })

    test('creates sections from HTML headings', () => {
      const adapter = new SwiftOrgAdapter()
      const result = adapter.normalize('swift-org/documentation/concurrency', HTML_FIXTURE)

      // Should have at least the abstract and discussion sections
      expect(result.sections.length).toBeGreaterThan(0)
    })

    test('handles non-string payload by coercing to string', () => {
      const adapter = new SwiftOrgAdapter()

      // Should not throw; invalid payload coerced via String()
      expect(() => {
        adapter.normalize('swift-org/about', 42)
      }).not.toThrow()
    })
  })

  describe('check', () => {
    test('returns unchanged when server responds 304', async () => {
      globalThis.fetch = async () => ({ status: 304, ok: false, headers: { get: () => null } })

      const adapter = new SwiftOrgAdapter()
      const result = await adapter.check(
        'swift-org/documentation/concurrency',
        { etag: '"abc123"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('unchanged')
      expect(result.changed).toBe(false)
    })

    test('returns modified when server responds 200', async () => {
      globalThis.fetch = async () => ({
        status: 200,
        ok: true,
        headers: { get: (h) => h === 'etag' ? '"new-etag"' : null },
      })

      const adapter = new SwiftOrgAdapter()
      const result = await adapter.check(
        'swift-org/documentation/concurrency',
        { etag: '"old-etag"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('modified')
      expect(result.changed).toBe(true)
    })

    test('returns deleted when server responds 404', async () => {
      globalThis.fetch = async () => ({ status: 404, ok: false, headers: { get: () => null } })

      const adapter = new SwiftOrgAdapter()
      const result = await adapter.check(
        'swift-org/documentation/concurrency',
        { etag: '"abc123"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('deleted')
      expect(result.deleted).toBe(true)
      expect(result.changed).toBe(false)
    })

    test('returns error when network request throws', async () => {
      globalThis.fetch = async () => {
        throw new Error('network failure')
      }

      const adapter = new SwiftOrgAdapter()
      const result = await adapter.check(
        'swift-org/documentation/concurrency',
        { etag: '"abc123"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('error')
      expect(result.changed).toBe(false)
    })

    test('preserves previous etag when server returns no new etag', async () => {
      globalThis.fetch = async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
      })

      const adapter = new SwiftOrgAdapter()
      const result = await adapter.check(
        'swift-org/documentation/concurrency',
        { etag: '"old-etag"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.newState?.etag).toBe('"old-etag"')
    })

    test('constructs the correct URL from the key', async () => {
      let capturedUrl = null
      globalThis.fetch = async (url) => {
        capturedUrl = url
        return { status: 304, ok: false, headers: { get: () => null } }
      }

      const adapter = new SwiftOrgAdapter()
      await adapter.check(
        'swift-org/getting-started/cli-swiftpm',
        null,
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(capturedUrl).toBe('https://swift.org/getting-started/cli-swiftpm')
    })
  })
})
