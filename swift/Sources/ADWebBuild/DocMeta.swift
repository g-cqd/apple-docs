// The doc-page input record + the meta badges / original-resource sidebar block
// — port of the badge helpers in `src/web/templates.js` (buildDocMeta,
// buildPlatformBadges, parsePlatformsJson, buildOriginalResourceBlock).

import ADJSONCore

/// The document fields the doc page reads (the build maps an ADStorage row into this).
public struct DocRecord: Sendable {
    public let key: String?
    public let title: String?
    public let framework: String?
    public let frameworkDisplay: String?
    public let roleHeading: String?
    public let isDeprecated: Bool
    public let isBeta: Bool
    public let platformsJson: String?
    public let url: String?
    public let abstractText: String?
    public let language: String?

    public init(
        key: String? = nil, title: String? = nil, framework: String? = nil,
        frameworkDisplay: String? = nil, roleHeading: String? = nil, isDeprecated: Bool = false,
        isBeta: Bool = false, platformsJson: String? = nil, url: String? = nil,
        abstractText: String? = nil, language: String? = nil
    ) {
        self.key = key
        self.title = title
        self.framework = framework
        self.frameworkDisplay = frameworkDisplay
        self.roleHeading = roleHeading
        self.isDeprecated = isDeprecated
        self.isBeta = isBeta
        self.platformsJson = platformsJson
        self.url = url
        self.abstractText = abstractText
        self.language = language
    }
}

enum DocMeta {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    static let platformNames: [String: String] = [
        "ios": "iOS", "macos": "macOS", "watchos": "watchOS", "tvos": "tvOS",
        "visionos": "visionOS", "maccatalyst": "Mac Catalyst", "ipados": "iPadOS"
    ]

    /// buildDocMeta(doc) — framework/role/deprecated/beta badges + platform
    /// availability, joined with `\n  `.
    static func buildDocMeta(_ doc: DocRecord) -> String {
        var badges = ""
        if let label = doc.frameworkDisplay ?? doc.framework, !label.isEmpty {
            badges += "<span class=\"badge badge-framework\">\(esc(label))</span>"
        }
        if let role = doc.roleHeading, !role.isEmpty {
            badges += "<span class=\"badge badge-role\">\(esc(role))</span>"
        }
        if doc.isDeprecated { badges += "<span class=\"badge badge-deprecated\">Deprecated</span>" }
        if doc.isBeta { badges += "<span class=\"badge badge-beta\">Beta</span>" }

        let platformBadges = buildPlatformBadges(parsePlatformsJson(doc.platformsJson))

        var parts: [String] = []
        if !badges.isEmpty { parts.append("<div class=\"doc-meta\">\(badges)</div>") }
        if !platformBadges.isEmpty { parts.append(platformBadges) }
        return parts.joined(separator: "\n  ")
    }

    /// buildPlatformBadges(platforms) — `Object.entries` over WHATEVER parsed
    /// (an object gives slug keys; an ARRAY gives index keys, whose object
    /// values template-coerce to "[object Object]" — the JS quirk, faithfully
    /// kept), values filtered by JS truthiness. "" when there are none.
    static func buildPlatformBadges(_ platforms: JSON?) -> String {
        guard let platforms, platforms.isObject || platforms.isArray else { return "" }
        var items = ""
        func badge(_ slug: String, _ version: JSON) {
            guard version.isTruthy else { return }  // `if (!version) continue`
            let name = platformNames[slug] ?? slug
            items += "<span class=\"badge badge-platform\">\(esc(name)) \(esc(version.jsString))+</span>"
        }
        if platforms.isObject {
            platforms.forEachMember { badge($0, $1) }
        } else {
            var index = 0
            platforms.forEachElement { element in
                badge(String(index), element)
                index += 1
            }
        }
        if items.isEmpty { return "" }
        return "<div class=\"doc-availability\">\(items)</div>"
    }

    /// parsePlatformsJson(platforms_json) — the stored JSON, nil on empty/error.
    static func parsePlatformsJson(_ s: String?) -> JSON? {
        guard let s, !s.isEmpty else { return nil }
        return try? ADJSON.parse(s, options: .init(maxDepth: 512)).root
    }

    /// buildOriginalResourceBlock(url) — the "Open on <host>" sidebar link, "" when absent.
    static func buildOriginalResourceBlock(_ url: String?) -> String {
        guard let url, !url.isEmpty else { return "" }
        let host = PageShell.urlHost(url)
        let label = host.isEmpty ? "source" : host
        return
            "<div class=\"sidebar-block sidebar-source\">\n  <a href=\"\(esc(url))\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"sidebar-source-link\">Open on \(esc(label))</a>\n</div>"
    }

    private static func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }
}
