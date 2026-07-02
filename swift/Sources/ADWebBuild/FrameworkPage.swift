// The framework listing page — port of `src/web/templates/framework.js`
// (`renderFrameworkPage` + `buildFrameworkTreeData`). Documents group by DocC
// role (ROLE_LABELS); the tree view toggles in when edges exist. Byte-exact
// against the JS html DSL.
//
// NOTE: `scopeGroups` (the scope-specific grouping for non-framework roots —
// WWDC by year, Swift Evolution by status, …) is a STUB returning nil until the
// scope-groups slice (framework-groups.js + scope-groups-extra.js) lands. nil is
// the JS fallback (`renderFrameworkPage` role-groups when `buildScopeGroups`
// returns null), so every normal framework renders correctly today; only the
// special roots role-group instead of scope-group until the follow-up.

import ADBase
import ADContent

public import ADJSONCore

/// A framework/root record for the listing page. Mirrors the JS `{ slug, name,
/// display_name, kind, source_type, url }` shape.
public struct FrameworkRecord: Sendable {
    public var slug: String?
    public var name: String?
    public var displayName: String?
    public var kind: String?
    public var sourceType: String?
    public var url: String?

    public init(
        slug: String? = nil, name: String? = nil, displayName: String? = nil, kind: String? = nil,
        sourceType: String? = nil, url: String? = nil
    ) {
        self.slug = slug
        self.name = name
        self.displayName = displayName
        self.kind = kind
        self.sourceType = sourceType
        self.url = url
    }
}

/// `buildFrameworkTreeData`'s result: `json` is the plain (un-escaped) tree
/// payload for the externally-cached `tree.<hash>.json`, empty when no edges.
public struct FrameworkTreeData: Sendable {
    public let json: String
    public let hasTree: Bool
}

public enum FrameworkPage {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    /// Human-readable labels for DocC roles (ROLE_LABELS in framework.js).
    static let roleLabels: [String: String] = [
        "symbol": "Symbols", "collection": "Collections", "collectionGroup": "Collection Groups",
        "sampleCode": "Sample Code", "article": "Articles", "dictionarySymbol": "Dictionary Symbols",
        "overview": "Overview", "pseudoSymbol": "Pseudo Symbols", "restRequestSymbol": "REST Requests",
        "link": "Links",
    ]

    private static let symbolRoles: Set<String> = ["symbol", "dictionarySymbol", "pseudoSymbol", "restRequestSymbol"]

    // MARK: - Tree data

    /// buildFrameworkTreeData(framework, documents, treeEdges, siteConfig) — the
    /// `tree.<hash>.json` payload (key→{title, role_heading, href} lookup + the
    /// raw edges). `json` is empty + `hasTree` false when there are no edges.
    public static func buildFrameworkTreeData(
        documents: [JSON], treeEdges: [(fromKey: String, toKey: String)], config: SiteConfig
    ) -> FrameworkTreeData {
        if treeEdges.isEmpty { return FrameworkTreeData(json: "", hasTree: false) }
        return FrameworkTreeData(
            json: treeDataObject(documents: documents, treeEdges: treeEdges, config: config).serialized(),
            hasTree: true)
    }

    // MARK: - Page

    public static func render(
        framework: FrameworkRecord, documents: [JSON], config: SiteConfig,
        treeEdges: [(fromKey: String, toKey: String)] = [], treeDataUrl: String? = nil,
        scopeExtras: ScopeExtras = ScopeExtras()
    ) -> String {
        let fwName = framework.displayName ?? framework.name ?? framework.slug ?? "Framework"
        let pageTitle = "\(fwName) — \(config.siteName)"
        let hasTree = !treeEdges.isEmpty

        // Group documents by role.
        var roleOrder: [String] = []
        var byRole: [String: [JSON]] = [:]
        for doc in documents {
            let rawRole = coerceOr(doc.member("role"), coerceOr(doc.member("role_heading"), "Other"))
            let role = roleLabels[rawRole] ?? rawRole
            if byRole[role] == nil { roleOrder.append(role); byRole[role] = [] }
            byRole[role]!.append(doc)
        }

        let scope = ScopeGroups.buildScopeGroups(
            framework: framework, documents: documents, extras: scopeExtras)
        let listIsDefault = scope != nil
        let showList = !hasTree || listIsDefault

        let listSections: [ScopeSection] =
            showList
            ? (scope?.sections
                ?? roleOrder.map {
                    ScopeSection(id: RenderHelpers.slugify($0), label: $0, count: nil, docs: byRole[$0] ?? [])
                })
            : []

        var roleSections: [String] = []
        for section in listSections {
            let docItems = section.docs.map { renderDocItem($0, config: config) }
            let heading =
                section.count.map { "\(esc(section.label)) <span class=\"group-count\">(\($0))</span>" }
                ?? esc(section.label)
            roleSections.append(
                "<section id=\"\(esc(section.id))\" class=\"role-group\" data-filter-kind=\"\(esc(section.label))\">\n    <h2 class=\"role-heading\">\(heading)</h2>\n    <ul class=\"doc-list\">\n      \(docItems.joined(separator: "\n      "))\n    </ul>\n  </section>"
            )
        }

        var jumpNav = ""
        if let nav = scope?.nav, !nav.isEmpty {
            let items = nav.map {
                "<a href=\"\(esc($0.href))\">\(esc($0.label)) <span class=\"group-count\">(\($0.count))</span></a>"
            }.joined(separator: "\n    ")
            jumpNav = "<nav class=\"scope-jump-nav\" aria-label=\"Jump to section\">\n    \(items)\n  </nav>\n  "
        }
        let mainContent =
            roleSections.isEmpty
            ? "<p>No documents found for this framework.</p>"
            : jumpNav + roleSections.joined(separator: "\n  ")

        let breadcrumbs =
            "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><a href=\"/\">Home</a> / <span aria-current=\"page\">\(esc(fwName))</span></nav>"

        // Sidebar: original-resource block + TOC of list sections.
        let tocItems = listSections.map { DocSidebar.TocItem(id: $0.id, label: $0.label) }
        let hasSidebar = tocItems.count >= 2
        let originalUrl = WebHtml.frameworkOriginalUrl(
            sourceType: framework.sourceType, slug: framework.slug, url: framework.url)
        var sidebarBlocks: [String] = []
        let originalBlock = DocMeta.buildOriginalResourceBlock(originalUrl)
        if !originalBlock.isEmpty { sidebarBlocks.append(originalBlock) }
        if hasSidebar {
            sidebarBlocks.append("<div class=\"sidebar-block\">\(DocSidebar.renderTocHtml(tocItems, mobile: false))</div>")
        }
        let sidebar =
            sidebarBlocks.isEmpty ? "" : "<aside class=\"doc-sidebar\">\(sidebarBlocks.joined(separator: "\n"))</aside>"
        let mobileToc = hasSidebar ? DocSidebar.renderTocHtml(tocItems, mobile: true) : ""

        // Tree-data inline emission (escaped for `</script>` safety) vs external ref.
        let treeContainerAttr = treeDataUrl.map { " data-tree-src=\"\(esc($0))\"" } ?? ""
        let inlineTreeScript =
            (hasTree && treeDataUrl == nil)
            ? "<script type=\"application/json\" id=\"tree-data\">\(escapeTreeInline(treeDataObject(documents: documents, treeEdges: treeEdges, config: config).serialized()))</script>"
            : ""
        let listBlock =
            showList
            ? "<div id=\"collection-controls\"></div>\n  <div id=\"list-container\">\n  \(mainContent)\n  </div>"
            : ""

        // JSON-LD (APIReference).
        let description = "\(fwName) documentation index."
        let canonical = framework.slug.map { "\(config.baseUrl)/docs/\($0)/" }
        let breadcrumbJsonLd = framework.slug.flatMap {
            Breadcrumbs.buildBreadcrumbListJsonLd($0, baseUrl: config.baseUrl, title: fwName, framework: fwName)
        }
        var jsonLdPairs: [(String, JsonLd)] = [
            ("@context", .string("https://schema.org")),
            ("@type", .string("APIReference")),
            ("name", .string(fwName)),
            ("inLanguage", .string("en")),
            ("description", .string(description)),
            ("isAccessibleForFree", .bool(true)),
        ]
        if let canonical { jsonLdPairs.append(("mainEntityOfPage", .string(canonical))) }
        if let bd = config.buildDate, !bd.isEmpty { jsonLdPairs.append(("dateModified", .string(bd))) }
        if let originalUrl, !originalUrl.isEmpty { jsonLdPairs.append(("isBasedOn", .string(originalUrl))) }
        jsonLdPairs.append(("programmingLanguage", .string("Swift")))
        if let breadcrumbJsonLd { jsonLdPairs.append(("breadcrumb", breadcrumbJsonLd)) }

        let head = PageShell.buildHead(
            config: config, title: pageTitle, description: description, canonical: canonical,
            alternate: originalUrl, ogType: "website", ogTitle: fwName, ogDesc: description,
            jsonLd: JsonLd.object(jsonLdPairs).serialized())

        let sidebarClass = sidebar.isEmpty ? "" : " has-sidebar"
        let main =
            "<main id=\"main-content\" class=\"main-content\(sidebarClass) listing\">\n  \(breadcrumbs)\n  <h1>\(esc(fwName))</h1>\n  \(mobileToc)\n  <article class=\"doc-article\">\n  \(listBlock)\n  <div id=\"tree-container\"\(treeContainerAttr)></div>\n  \(inlineTreeScript)\n  </article>\n  \(sidebar)\n</main>"
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n\(main)\n\(PageShell.buildFooter(config))\n\(PageShell.buildScripts(config, ["core", "listing"]))\n</body>\n</html>"
    }

    // MARK: - Doc item

    /// renderDocItem(doc, siteConfig) — one `<li>` in a role/scope section.
    private static func renderDocItem(_ doc: JSON, config: SiteConfig) -> String {
        let docKey = self.docKey(doc)
        let href = "\(config.baseUrl)/docs/\(SafePath.safeWebDocKey(docKey))/"
        let filterKind = coerceOr(doc.member("role_heading"), coerceOr(doc.member("role"), "Other"))

        // meta line: doc.meta ?? doc.role_heading (NOT role).
        let metaNode = doc.member("meta")
        let metaText = (metaNode != nil && !(metaNode!.isNull)) ? coerce(metaNode) : coerce(doc.member("role_heading"))
        let meta = metaText.isEmpty ? "" : "<span class=\"doc-item-meta\">\(esc(metaText))</span>"

        let abstractText = coerceOr(doc.member("abstract_text"), coerce(doc.member("abstract")))
        let deprecatedAttr = containsDeprecatedWord(abstractText) ? " data-deprecated" : ""
        let abstract =
            abstractText.isEmpty
            ? ""
            : "<span class=\"doc-item-meta\">— \(esc(truncate80(abstractText)))</span>"

        let role = coerce(doc.member("role"))
        let isSymbol = symbolRoles.contains(role)
        let titleText = coerceOr(doc.member("title"), docKey)
        let titleContent = isSymbol ? "<code>\(esc(titleText))</code>" : esc(titleText)

        return
            "<li data-filter-kind=\"\(esc(filterKind))\"\(deprecatedAttr)><a href=\"\(esc(href))\">\(titleContent)</a>\(meta)\(abstract)</li>"
    }

    // MARK: - Scope groups (stub)

    struct ScopeSection { let id: String; let label: String; let count: Int?; let docs: [JSON] }
    struct ScopeNavItem { let href: String; let label: String; let count: Int }
    struct ScopeResult { let scope: String; let sections: [ScopeSection]; let nav: [ScopeNavItem] }

    // MARK: - helpers

    /// `{ edges: treeEdges, docs: {key→{title, role_heading, href}} }`. Keys keep
    /// first-insertion order; duplicate keys take the last-written value (JS object
    /// assignment semantics).
    private static func treeDataObject(
        documents: [JSON], treeEdges: [(fromKey: String, toKey: String)], config: SiteConfig
    ) -> JsonLd {
        var order: [String] = []
        var lookup: [String: JsonLd] = [:]
        for doc in documents {
            let key = docKey(doc)
            if lookup[key] == nil { order.append(key) }
            let title = coerceOr(doc.member("title"), key)
            let roleHeading = coerceOr(doc.member("role_heading"), coerceOr(doc.member("role"), "Other"))
            let href = "\(config.baseUrl)/docs/\(SafePath.safeWebDocKey(key))/"
            lookup[key] = .object([
                ("title", .string(title)), ("role_heading", .string(roleHeading)), ("href", .string(href)),
            ])
        }
        let docsObj = JsonLd.object(order.map { ($0, lookup[$0]!) })
        let edges = JsonLd.array(
            treeEdges.map { .object([("from_key", .string($0.fromKey)), ("to_key", .string($0.toKey))]) })
        return .object([("edges", edges), ("docs", docsObj)])
    }

    /// `.replaceAll('<','<').replaceAll('>','>').replaceAll('/','/')
    /// .replaceAll('&','&')` over the serialized JSON, for `</script>`-safe
    /// inline emission.
    private static func escapeTreeInline(_ json: String) -> String {
        var out = ""
        out.reserveCapacity(json.count)
        for ch in json {
            switch ch {
            case "<": out += "\\u003c"
            case ">": out += "\\u003e"
            case "/": out += "\\u002f"
            case "&": out += "\\u0026"
            default: out.append(ch)
            }
        }
        return out
    }

    /// `doc.key ?? doc.path ?? ''`.
    private static func docKey(_ doc: JSON) -> String {
        let key = coerce(doc.member("key"))
        if !key.isEmpty { return key }
        return coerce(doc.member("path"))
    }

    /// `/\bDeprecated\b/i.test(text)` — ASCII word boundaries, case-insensitive.
    private static func containsDeprecatedWord(_ s: String) -> Bool {
        let lower = Array(s.lowercased())
        let target = Array("deprecated")
        func isWord(_ c: Character) -> Bool { (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "_" }
        var i = 0
        while i + target.count <= lower.count {
            if Array(lower[i ..< i + target.count]) == target {
                let leftOk = i == 0 || !isWord(lower[i - 1])
                let rightOk = i + target.count == lower.count || !isWord(lower[i + target.count])
                if leftOk, rightOk { return true }
            }
            i += 1
        }
        return false
    }

    /// `s.length > 80 ? s.slice(0,80)+'...' : s` over UTF-16 units (JS string semantics).
    private static func truncate80(_ s: String) -> String {
        let units = Array(s.utf16)
        if units.count <= 80 { return s }
        return String(decoding: units.prefix(80), as: UTF16.self) + "..."
    }

    private static func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }

    private static func coerceOr(_ node: JSON?, _ fallback: String) -> String {
        guard let node, !node.isNull else { return fallback }
        return node.string ?? node.jsString
    }
}
