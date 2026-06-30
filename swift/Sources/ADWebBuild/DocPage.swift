// The full document page — port of `renderDocumentPage` (src/web/templates/
// document.js). Stitches buildHead + header + breadcrumbs + the content renderer
// + the composed sidebar + footer + scripts into one HTMLDocument, with the
// TechArticle JSON-LD, lang-toggle detection, and the aria-hidden relationships
// rewrite. Calls ADContent's DocContentRenderer in-process (no FFI).

import ADBase
import ADJSONCore

public import ADContent

public enum DocPage {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    public static func render(
        doc: DocRecord, sections: [DocSection], config: SiteConfig,
        knownKeys: Set<String>? = nil, ancestorTitles: [String: String] = [:],
        markdownDocs: Bool = false, highlight: CodeHighlight? = nil
    ) -> String {
        let pageTitle = "\(doc.title ?? "Untitled") — \(config.siteName)"

        var content = DocContentRenderer.render(
            title: doc.title, sections: sections, knownKeys: knownKeys, highlight: highlight)
        let hasLangToggle = content.contains("data-languages=")

        let breadcrumbs =
            doc.key.map {
                Breadcrumbs.buildBreadcrumbs(
                    $0, title: doc.title, framework: doc.frameworkDisplay ?? doc.framework,
                    ancestorTitles: ancestorTitles, knownKeys: knownKeys)
            } ?? ""

        let ordered = sections.enumerated().sorted {
            $0.element.sortOrder == $1.element.sortOrder
                ? $0.offset < $1.offset : $0.element.sortOrder < $1.element.sortOrder
        }.map(\.element)
        let tocItems = DocSidebar.buildPageToc(ordered)
        let relationshipSection = ordered.first { ($0.sectionKind ?? "") == "relationships" }
        let hasSidebar = tocItems.count >= 2

        if hasSidebar {
            content = replaceFirst(
                content, "<section id=\"relationships\">", "<section id=\"relationships\" aria-hidden=\"true\">")
        }

        let docMeta = DocMeta.buildDocMeta(doc)

        var sidebarParts: [String] = []
        let originalBlock = DocMeta.buildOriginalResourceBlock(doc.url)
        if !originalBlock.isEmpty { sidebarParts.append(originalBlock) }
        if !docMeta.isEmpty { sidebarParts.append("<div class=\"sidebar-block sidebar-meta\">\(docMeta)</div>") }
        if hasLangToggle {
            sidebarParts.append(
                "<div class=\"sidebar-block\">\n  <div class=\"lang-toggle\" role=\"group\" aria-label=\"Language\">\n    <button class=\"lang-btn active\" data-lang=\"swift\" aria-pressed=\"true\">Swift</button>\n    <button class=\"lang-btn\" data-lang=\"occ\" aria-pressed=\"false\">ObjC</button>\n  </div>\n</div>"
            )
        }
        if hasSidebar {
            sidebarParts.append("<div class=\"sidebar-block\">\(DocSidebar.renderTocHtml(tocItems, mobile: false))</div>")
        }
        if let rel = relationshipSection, DocSidebar.hasRenderableItems(rel.contentJson ?? "") {
            sidebarParts.append("<div class=\"sidebar-block\">\(DocSidebar.buildRelationshipContent(rel))</div>")
        }
        let hasSidebarFinal = !sidebarParts.isEmpty
        let sidebar = hasSidebarFinal ? "<aside class=\"doc-sidebar\">\(sidebarParts.joined(separator: "\n"))</aside>" : ""
        let mobileToc = hasSidebar ? DocSidebar.renderTocHtml(tocItems, mobile: true) : ""

        let webKey = doc.key.map { SafePath.safeWebDocKey($0) }
        let canonical = webKey.map { "\(config.baseUrl)/docs/\($0)/" }
        let mdAlternate: String? =
            (markdownDocs && webKey != nil)
            ? "<link rel=\"alternate\" type=\"text/markdown\" href=\"\(esc(config.baseUrl))/docs/\(esc(webKey!)).md\">"
            : nil
        let docDescription = description(doc.abstractText, "\(doc.title ?? "") — Apple developer documentation")

        var platformDisplayNames: [String] = []
        if let platforms = DocMeta.parsePlatformsJson(doc.platformsJson), platforms.isObject {
            platforms.forEachMember { slug, version in
                let v = version.isNull ? "" : (version.string ?? version.jsString)
                if v.isEmpty { return }
                platformDisplayNames.append(DocMeta.platformNames[slug] ?? slug)
            }
        }
        let programmingLanguage = (doc.language == "occ" || doc.language == "objc") ? "Objective-C" : "Swift"

        let breadcrumbJsonLd =
            doc.key.flatMap {
                Breadcrumbs.buildBreadcrumbListJsonLd(
                    $0, baseUrl: config.baseUrl, title: doc.title,
                    framework: doc.frameworkDisplay ?? doc.framework, ancestorTitles: ancestorTitles)
            }

        var jsonLdPairs: [(String, JsonLd)] = [
            ("@context", .string("https://schema.org")),
            ("@type", .string("TechArticle")),
            ("headline", .string(doc.title ?? "Untitled")),
            ("inLanguage", .string("en")),
            ("isAccessibleForFree", .bool(true)),
            ("mainEntityOfPage", canonical.map { JsonLd.string($0) } ?? .null),
            (
                "publisher",
                .object([
                    ("@type", .string("Organization")), ("name", .string(config.siteName)),
                    ("url", .string("\(config.baseUrl)/")),
                ])
            ),
        ]
        if !docDescription.isEmpty { jsonLdPairs.append(("description", .string(docDescription))) }
        if let bd = config.buildDate, !bd.isEmpty { jsonLdPairs.append(("dateModified", .string(bd))) }
        if let url = doc.url, !url.isEmpty { jsonLdPairs.append(("isBasedOn", .string(url))) }
        jsonLdPairs.append(("programmingLanguage", .string(programmingLanguage)))
        if !platformDisplayNames.isEmpty {
            jsonLdPairs.append(
                ("audience", .object([("@type", .string("Audience")), ("audienceType", .string("Developers"))])))
            jsonLdPairs.append(("applicationSuite", .string(platformDisplayNames.joined(separator: ", "))))
        }
        if let bcl = breadcrumbJsonLd { jsonLdPairs.append(("breadcrumb", bcl)) }

        let head = PageShell.buildHead(
            config: config, title: pageTitle, description: doc.abstractText, canonical: canonical,
            alternate: doc.url, ogType: "article", ogTitle: doc.title ?? pageTitle, ogDesc: docDescription,
            jsonLd: JsonLd.object(jsonLdPairs).serialized(), headExtra: mdAlternate)

        let sidebarClass = hasSidebarFinal ? " has-sidebar" : ""
        return
            "<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">\n\(head)\n<body>\n<a href=\"#main-content\" class=\"skip-link\">Skip to main content</a>\n\(PageShell.buildHeader(config))\n<main id=\"main-content\" class=\"main-content\(sidebarClass)\">\n  \(breadcrumbs)\n  \(mobileToc)\n  <article class=\"doc-article\">\n    \(content)\n  </article>\n  \(sidebar)\n</main>\n\(PageShell.buildFooter(config))\n\(PageShell.buildScripts(config, hasLangToggle ? ["core", "lang-toggle"] : ["core"]))\n</body>\n</html>"
    }

    // MARK: - helpers

    /// `String.prototype.replace(str, str)` — first occurrence only. Foundation-free.
    private static func replaceFirst(_ s: String, _ target: String, _ replacement: String) -> String {
        let sc = Array(s)
        let tc = Array(target)
        guard !tc.isEmpty, tc.count <= sc.count else { return s }
        var i = 0
        while i + tc.count <= sc.count {
            if Array(sc[i ..< i + tc.count]) == tc {
                return String(sc[0 ..< i]) + replacement + String(sc[(i + tc.count)...])
            }
            i += 1
        }
        return s
    }

    /// `doc.abstract_text || \`<title> — Apple developer documentation\`.trim()`.
    private static func description(_ abstract: String?, _ fallback: String) -> String {
        if let abstract, !abstract.isEmpty { return abstract }
        var sub = Substring(fallback)
        while let f = sub.first, f.isWhitespace { sub = sub.dropFirst() }
        while let l = sub.last, l.isWhitespace { sub = sub.dropLast() }
        return String(sub)
    }
}
