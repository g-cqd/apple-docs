// Port of src/content/render-markdown.js — document + sections → markdown
// (normative JS until the phase-5 kill; byte-parity gated by the committed
// goldens and the full-corpus A/B).

import ADBase

/// Pre-coerced document fields (the JS packer applies render-markdown.js's
/// coerceDocument camel/snake fallbacks before crossing the FFI).
public struct ContentDocument: Sendable {
  public var key: String?
  public var title: String?
  public var framework: String?
  public var frameworkDisplay: String?
  public var role: String?
  public var roleHeading: String?
  public var platformsJson: String?

  public init(
    key: String? = nil, title: String? = nil, framework: String? = nil,
    frameworkDisplay: String? = nil, role: String? = nil, roleHeading: String? = nil,
    platformsJson: String? = nil
  ) {
    self.key = key
    self.title = title
    self.framework = framework
    self.frameworkDisplay = frameworkDisplay
    self.role = role
    self.roleHeading = roleHeading
    self.platformsJson = platformsJson
  }
}

public struct ContentSection: Sendable {
  public var sectionKind: String?
  public var heading: String?
  public var contentText: String
  public var contentJson: String?
  public var sortOrder: Double

  public init(
    sectionKind: String? = nil, heading: String? = nil, contentText: String = "",
    contentJson: String? = nil, sortOrder: Double = 0
  ) {
    self.sectionKind = sectionKind
    self.heading = heading
    self.contentText = contentText
    self.contentJson = contentJson
    self.sortOrder = sortOrder
  }
}

public enum DocMarkdown {
  static let linkSectionTitles: [String: String] = [
    "topics": "Topics",
    "relationships": "Relationships",
    "see_also": "See Also",
  ]

  public static func render(
    document: ContentDocument,
    sections: [ContentSection],
    includeFrontMatter: Bool = true,
    includeTitle: Bool = true
  ) -> String {
    // JS Array.sort is stable; sections arrive in caller order.
    let ordered = sections.enumerated().sorted {
      $0.element.sortOrder != $1.element.sortOrder
        ? $0.element.sortOrder < $1.element.sortOrder
        : $0.offset < $1.offset
    }.map(\.element)

    var parts: [String] = []
    if includeFrontMatter {
      parts.append(frontMatter(document))
      parts.append("")
    }
    if includeTitle, let title = document.title, !title.isEmpty {
      parts.append("# \(title)")
      parts.append("")
    }
    for section in ordered {
      let rendered = renderSection(section)
      if !rendered.isEmpty {
        parts.append(rendered)
        parts.append("")
      }
    }
    return JsString.trim(JsString.collapseBlankRuns(parts.joined(separator: "\n"))) + "\n"
  }

  static func frontMatter(_ doc: ContentDocument) -> String {
    var fields: [(String, FrontMatter.Value?)] = []
    fields.append(("title", doc.title.map(FrontMatter.Value.scalar)))
    let framework = doc.frameworkDisplay ?? doc.framework
    fields.append(("framework", framework.map(FrontMatter.Value.scalar)))
    fields.append(("role", doc.role.map(FrontMatter.Value.scalar)))
    fields.append(("role_heading", doc.roleHeading.map(FrontMatter.Value.scalar)))
    fields.append(("platforms", formatPlatforms(doc.platformsJson)))
    fields.append(("path", doc.key.map(FrontMatter.Value.scalar)))
    return FrontMatter.render(fields)
  }

  /// formatPlatforms: array → element coercions; object → "Name version+"
  /// per entry in insertion order; anything else → nil (dropped).
  static func formatPlatforms(_ platformsJson: String?) -> FrontMatter.Value? {
    guard let json = platformsJson, let parsed = Json.safeJson(Array(json.utf8)) else { return nil }
    if let array = parsed.asArray {
      return .list(array.map(\.jsStringCoercion))
    }
    guard let object = parsed.asObject else { return nil }
    let items = object.entries.map { entry -> String in
      let platform = prettyPlatform(entry.key)
      if entry.value.isTruthy {
        return "\(platform) \(entry.value.jsStringCoercion)+"
      }
      return platform
    }
    return .list(items)
  }

  static func prettyPlatform(_ platform: String) -> String {
    let map: [String: String] = [
      "ios": "iOS",
      "macos": "macOS",
      "watchos": "watchOS",
      "tvos": "tvOS",
      "visionos": "visionOS",
      "maccatalyst": "Mac Catalyst",
      "ipados": "iPadOS",
    ]
    return map[platform] ?? platform
  }

  static func renderSection(_ section: ContentSection) -> String {
    switch section.sectionKind {
    case "abstract":
      return JsString.trim(section.contentText)
    case "declaration":
      return renderDeclaration(section)
    case "parameters":
      return renderParameters(section)
    case "discussion":
      return titledSection(
        section.heading ?? "Overview", JsString.normalizeParagraphs(section.contentText))
    case "topics", "relationships", "see_also":
      let title = linkSectionTitles[section.sectionKind!] ?? section.heading ?? "Related"
      return renderLinkSection(title: title, section: section)
    default:
      if JsString.trim(section.contentText).isEmpty { return "" }
      let title = section.heading ?? JsString.humanize(section.sectionKind ?? "Section")
      return titledSection(title, JsString.normalizeParagraphs(section.contentText))
    }
  }

  static func renderDeclaration(_ section: ContentSection) -> String {
    let declarations = section.contentJson.flatMap { Json.safeJson(Array($0.utf8)) }
    let blocks = declarations?.asArray ?? []
    var rendered: [String] = []
    for declaration in blocks {
      let obj = declaration.asObject
      let tokens = obj?["tokens"]?.asArray ?? []
      let code = tokens.map { token -> String in
        guard let t = token.asObject?["text"]?.nullish else { return "" }
        return t.jsStringCoercion
      }.joined()
      let language = obj?["languages"]?.asArray?.first?.nullish?.jsStringCoercion ?? "swift"
      if JsString.trim(code).isEmpty { continue }
      rendered.append(["```\(language)", code, "```"].joined(separator: "\n"))
    }
    if !rendered.isEmpty {
      return ["## Declaration", "", rendered.joined(separator: "\n\n")].joined(separator: "\n")
    }
    let fallback = JsString.trim(section.contentText)
    if fallback.isEmpty { return "" }
    return ["## Declaration", "", "```swift", fallback, "```"].joined(separator: "\n")
  }

  static func renderParameters(_ section: ContentSection) -> String {
    var lines = ["## Parameters", ""]
    let parameters = section.contentJson.flatMap { Json.safeJson(Array($0.utf8)) }
    if let items = parameters?.asArray, !items.isEmpty {
      for parameter in items {
        let obj = parameter.asObject
        let description = JsString.trim(
          JsString.collapseWhitespaceRuns(
            ContentText.renderNodes(obj?["content"] ?? .array([]), refs: JsonObject())))
        let name = obj?["name"]?.nullish?.jsStringCoercion ?? "Value"
        lines.append(JsString.trim("- `\(name)`: \(description)"))
      }
    } else {
      let fallback = JsString.trim(section.contentText)
      if !fallback.isEmpty {
        for line in fallback.split(separator: "\n", omittingEmptySubsequences: false)
        where !line.isEmpty {
          lines.append("- \(line)")
        }
      }
    }
    return JsString.trim(lines.joined(separator: "\n"))
  }

  static func renderLinkSection(title: String, section: ContentSection) -> String {
    var lines = ["## \(title)", ""]
    let groups = section.contentJson.flatMap { Json.safeJson(Array($0.utf8)) }
    if let groupArray = groups?.asArray, !groupArray.isEmpty {
      for group in groupArray {
        let obj = group.asObject
        if let groupTitle = obj?["title"], groupTitle.isTruthy {
          lines.append("### \(groupTitle.jsStringCoercion)")
          lines.append("")
        }
        for item in obj?["items"]?.asArray ?? [] {
          let itemObj = item.asObject
          if let key = itemObj?["key"], key.isTruthy {
            let itemTitle = itemObj?["title"]?.nullish ?? key
            lines.append("- [\(itemTitle.jsStringCoercion)](\(key.jsStringCoercion).md)")
          } else {
            let label =
              itemObj?["title"]?.nullish?.jsStringCoercion
              ?? itemObj?["identifier"]?.nullish?.jsStringCoercion ?? ""
            lines.append(JsString.trim("- \(label)"))
          }
        }
        lines.append("")
      }
      return JsString.trim(lines.joined(separator: "\n"))
    }
    let fallback = JsString.trim(section.contentText)
    if !fallback.isEmpty {
      for line in fallback.split(separator: "\n", omittingEmptySubsequences: false)
      where !line.isEmpty {
        lines.append("- \(line)")
      }
    }
    return JsString.trim(lines.joined(separator: "\n"))
  }

  static func titledSection(_ title: String, _ body: String) -> String {
    if body.isEmpty { return "" }
    return ["## \(title)", "", body].joined(separator: "\n")
  }
}
