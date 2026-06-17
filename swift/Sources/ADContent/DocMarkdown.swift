import ADJSONCore

/// Nullable byte spans over the request buffer (nil = JS null/undefined).
public struct DocFieldSpans {
  public var key: ByteSpan?
  public var title: ByteSpan?
  public var framework: ByteSpan?
  public var frameworkDisplay: ByteSpan?
  public var role: ByteSpan?
  public var roleHeading: ByteSpan?
  public var platformsJson: ByteSpan?

  public init(
    key: ByteSpan? = nil, title: ByteSpan? = nil, framework: ByteSpan? = nil,
    frameworkDisplay: ByteSpan? = nil, role: ByteSpan? = nil, roleHeading: ByteSpan? = nil,
    platformsJson: ByteSpan? = nil
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

public struct SectionSpans {
  public var kind: ByteSpan?
  public var heading: ByteSpan?
  public var text: ByteSpan  // contentText (coerced default '')
  public var json: ByteSpan?
  public var sortOrder: Double

  public init(
    kind: ByteSpan? = nil, heading: ByteSpan? = nil, text: ByteSpan, json: ByteSpan? = nil,
    sortOrder: Double = 0
  ) {
    self.kind = kind
    self.heading = heading
    self.text = text
    self.json = json
    self.sortOrder = sortOrder
  }
}

public enum DocMarkdown {
  /// Renders the finished document bytes into `out` (reusing `w` and
  /// `sectionW` as scratch).
  public static func render(
    document: DocFieldSpans, sections: [SectionSpans],
    includeFrontMatter: Bool, includeTitle: Bool,
    w: inout ByteWriter, sectionW: inout ByteWriter, out: inout [UInt8]
  ) {
    w.removeAll()
    var parts = PartsWriter()

    if includeFrontMatter {
      parts.begin(&w)
      frontMatter(document, &w)
      parts.begin(&w)
    }
    if includeTitle, let title = document.title, !title.isEmpty {
      parts.begin(&w)
      w.append("# ")
      w.append(span: title)
      parts.begin(&w)
    }

    // Stable sort by (sortOrder, original index) — JS Array.sort is stable.
    let order = sections.indices.sorted {
      sections[$0].sortOrder != sections[$1].sortOrder
        ? sections[$0].sortOrder < sections[$1].sortOrder
        : $0 < $1
    }
    for index in order {
      sectionW.removeAll()
      renderSection(sections[index], &sectionW)
      if sectionW.count > 0 {
        parts.begin(&w)
        w.bytes.append(contentsOf: sectionW.bytes)
        parts.begin(&w)
      }
    }

    ByteOps.finishDocument(w.bytes, into: &out, trailingNewline: true)
  }

  // MARK: - Front matter

  static func frontMatter(_ doc: DocFieldSpans, _ w: inout ByteWriter) {
    w.append("---")
    func field(_ name: StaticString, _ span: ByteSpan?) {
      guard let span else { return }
      w.append(0x0A)
      w.append(name)
      w.append(": ")
      appendQuoted(span: span, &w)
    }
    field("title", doc.title)
    field("framework", doc.frameworkDisplay ?? doc.framework)
    field("role", doc.role)
    field("role_heading", doc.roleHeading)
    appendPlatforms(doc.platformsJson, &w)
    field("path", doc.key)
    w.append("\n---")
  }

  /// formatPlatforms: array → element coercions; object → "Name version+"
  /// in insertion order; anything else → field skipped entirely.
  static func appendPlatforms(_ platformsJson: ByteSpan?, _ w: inout ByteWriter) {
    guard let json = platformsJson, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)) else { return }
    let root = doc.root
    var items = ByteWriter(capacity: 128)
    var first = true
    func appendItem(_ body: (inout ByteWriter) -> Void) {
      var item = ByteWriter(capacity: 48)
      body(&item)
      if !first { items.append(", ") }
      first = false
      appendQuotedBytes(item.bytes, &items)
    }
    if root.isArray {
      root.forEachElement { element in
        appendItem { item in item.appendCoercion(element) }
      }
    } else if root.isObject {
      root.forEachMember { key, value in
        appendItem { item in
          appendPrettyPlatform(key, &item)
          if value.isTruthy {
            item.append(0x20)
            item.appendCoercion(value)
            item.append(0x2B)
          }
        }
      }
    } else {
      return
    }
    w.append("\nplatforms: [")
    w.bytes.append(contentsOf: items.bytes)
    w.append(0x5D)
  }

  static func appendPrettyPlatform(_ key: String, _ w: inout ByteWriter) {
    let pretty: [(String, StaticString)] = [
      ("ios", "iOS"), ("macos", "macOS"), ("watchos", "watchOS"), ("tvos", "tvOS"),
      ("visionos", "visionOS"), ("maccatalyst", "Mac Catalyst"), ("ipados", "iPadOS"),
    ]
    for (raw, display) in pretty where key == raw {
      w.append(display)
      return
    }
    w.append(key)
  }

  static func appendQuoted(span: ByteSpan, _ w: inout ByteWriter) {
    let bytes = span.bindMemory(to: UInt8.self)
    if FrontMatter.needsQuotingBytes(bytes) {
      w.append(0x22)
      for byte in bytes {
        if byte == UInt8(ascii: "\\") {
          w.append("\\\\")
        } else if byte == 0x22 {
          w.append("\\\"")
        } else {
          w.append(byte)
        }
      }
      w.append(0x22)
    } else {
      w.bytes.append(contentsOf: bytes)
    }
  }

  static func appendQuotedBytes(_ bytes: [UInt8], _ w: inout ByteWriter) {
    bytes.withUnsafeBytes { appendQuoted(span: ByteSpan($0), &w) }
  }

  // MARK: - Sections

  static func renderSection(_ section: SectionSpans, _ w: inout ByteWriter) {
    let kind = section.kind
    if spanEquals(kind, "abstract") {
      w.appendTrimmed(section.text)
      return
    }
    if spanEquals(kind, "declaration") {
      renderDeclaration(section, &w)
      return
    }
    if spanEquals(kind, "parameters") {
      renderParameters(section, &w)
      return
    }
    if spanEquals(kind, "discussion") {
      renderTitled(heading: section.heading, fallback: "Overview", text: section.text, &w)
      return
    }
    if spanEquals(kind, "topics") {
      renderLinkSection(title: "Topics", section, &w)
      return
    }
    if spanEquals(kind, "relationships") {
      renderLinkSection(title: "Relationships", section, &w)
      return
    }
    if spanEquals(kind, "see_also") {
      renderLinkSection(title: "See Also", section, &w)
      return
    }
    // default: empty trimmed text → no section; heading ?? humanize(kind).
    let textBytes = section.text.bindMemory(to: UInt8.self)
    let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
    if ts >= te { return }
    w.append("## ")
    if let heading = section.heading {
      w.append(span: heading)
    } else if let kind {
      w.append(JsString.humanize(String(decoding: kind.bindMemory(to: UInt8.self), as: UTF8.self)))
    } else {
      w.append("Section")
    }
    w.append("\n\n")
    w.appendNormalizedParagraphs(section.text)
  }

  static func spanEquals(_ span: ByteSpan?, _ literal: StaticString) -> Bool {
    guard let span, span.count == literal.utf8CodeUnitCount else { return false }
    if literal.utf8CodeUnitCount == 0 { return true }
    guard let base = span.baseAddress else { return false }
    return memcmp(base, literal.utf8Start, literal.utf8CodeUnitCount) == 0
  }

  /// renderTitledSection(title, normalizeParagraphs(text)) — empty body →
  /// no section at all.
  static func renderTitled(heading: ByteSpan?, fallback: StaticString, text: ByteSpan, _ w: inout ByteWriter) {
    w.append("## ")
    if let heading {
      w.append(span: heading)
    } else {
      w.append(fallback)
    }
    w.append("\n\n")
    let mark = w.count
    w.appendNormalizedParagraphs(text)
    if w.count == mark {
      w.removeAll()  // body empty → renderTitledSection returns ''
    }
  }

  static func renderDeclaration(_ section: SectionSpans, _ w: inout ByteWriter) {
    var blocks = ByteWriter(capacity: 256)
    var code = ByteWriter(capacity: 256)
    var blockCount = 0
    if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray {
      doc.root.forEachElement { declaration in
        let obj = declaration.isObject ? declaration : nil
        code.removeAll()
        if let tokens = obj.flatMap({ $0.member("tokens") }), tokens.isArray {
          tokens.forEachElement { token in
            // `token.text ?? ''` — nullish only.
            if token.isObject, let text = token.member("text"),
              !text.isNull
            {
              code.appendCoercion(text)
            }
          }
        }
        // `if (!code.trim()) return null` — emptiness on the trimmed code.
        let (cs, ce) = ByteOps.trimRange(code.bytes, 0, code.bytes.count)
        if cs >= ce { return }
        if blockCount > 0 { blocks.append("\n\n") }
        blockCount += 1
        blocks.append("```")
        if let languages = obj.flatMap({ $0.member("languages") }),
          let first = languages.firstElement, !first.isNull
        {
          blocks.appendCoercion(first)
        } else {
          blocks.append("swift")
        }
        blocks.append(0x0A)
        blocks.bytes.append(contentsOf: code.bytes)  // raw code, untrimmed
        blocks.append("\n```")
      }
    }
    if blockCount > 0 {
      w.append("## Declaration\n\n")
      w.bytes.append(contentsOf: blocks.bytes)
      return
    }
    let textBytes = section.text.bindMemory(to: UInt8.self)
    let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
    if ts >= te { return }
    w.append("## Declaration\n\n```swift\n")
    w.bytes.append(contentsOf: textBytes[ts..<te])
    w.append("\n```")
  }

  static func renderParameters(_ section: SectionSpans, _ w: inout ByteWriter) {
    w.append("## Parameters\n")
    var wrote = false
    if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray,
      doc.root.count > 0
    {
      doc.root.forEachElement { parameter in
        let obj = parameter.isObject ? parameter : nil
        w.append(0x0A)
        let lineMark = w.count
        w.append("- `")
        if let name = obj.flatMap({ $0.member("name") }), !name.isNull {
          w.appendCoercion(name)
        } else {
          w.append("Value")
        }
        w.append("`: ")
        let descMark = w.count
        ContentText.renderNodes(obj.flatMap { $0.member("content") }, refs: .none, into: &w)
        w.collapseWhitespace(since: descMark)
        w.trim(since: descMark)
        w.trim(since: lineMark)
        wrote = true
      }
    } else {
      let textBytes = section.text.bindMemory(to: UInt8.self)
      let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
      if ts < te {
        var lineStart = ts
        var i = ts
        while i <= te {
          if i == te || textBytes[i] == 0x0A {
            if i > lineStart {  // `.filter(Boolean)` drops empty lines
              w.append("\n- ")
              w.bytes.append(contentsOf: textBytes[lineStart..<i])
              wrote = true
            }
            lineStart = i + 1
          }
          i += 1
        }
      }
    }
    // lines.join('\n').trim() — with no items the bare "## Parameters\n"
    // trims to "## Parameters" (still a non-empty section).
    let (s, e) = ByteOps.trimRange(w.bytes, 0, w.bytes.count)
    if e < w.bytes.count { w.bytes.removeLast(w.bytes.count - e) }
    if s > 0 { w.bytes.removeSubrange(0..<s) }
    _ = wrote
  }

  static func renderLinkSection(title: StaticString, _ section: SectionSpans, _ w: inout ByteWriter) {
    w.append("## ")
    w.append(title)
    w.append(0x0A)
    var usedGroups = false
    if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray,
      doc.root.count > 0
    {
      usedGroups = true
      doc.root.forEachElement { group in
        let obj = group.isObject ? group : nil
        if let groupTitle = obj.flatMap({ $0.member("title") }), groupTitle.isTruthy {
          w.append("\n### ")
          w.appendCoercion(groupTitle)
          w.append(0x0A)
        }
        if let items = obj.flatMap({ $0.member("items") }), items.isArray {
          items.forEachElement { item in
            let itemObj = item.isObject ? item : nil
            w.append(0x0A)
            if let key = itemObj.flatMap({ $0.member("key") }), key.isTruthy {
              w.append("- [")
              if let itemTitle = itemObj.flatMap({ $0.member("title") }), !itemTitle.isNull {
                w.appendCoercion(itemTitle)
              } else {
                w.appendCoercion(key)
              }
              w.append("](")
              w.appendCoercion(key)
              w.append(".md)")
            } else {
              let lineMark = w.count
              w.append("- ")
              if let itemTitle = itemObj.flatMap({ $0.member("title") }), !itemTitle.isNull {
                w.appendCoercion(itemTitle)
              } else if let identifier = itemObj.flatMap({ $0.member("identifier") }),
                !identifier.isNull
              {
                w.appendCoercion(identifier)
              }
              w.trim(since: lineMark)
            }
          }
        }
        w.append(0x0A)  // the group's trailing '' line
      }
    }
    if !usedGroups {
      let textBytes = section.text.bindMemory(to: UInt8.self)
      let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
      if ts < te {
        var lineStart = ts
        var i = ts
        while i <= te {
          if i == te || textBytes[i] == 0x0A {
            if i > lineStart {
              w.append("\n- ")
              w.bytes.append(contentsOf: textBytes[lineStart..<i])
            }
            lineStart = i + 1
          }
          i += 1
        }
      }
    }
    let (s, e) = ByteOps.trimRange(w.bytes, 0, w.bytes.count)
    if e < w.bytes.count { w.bytes.removeLast(w.bytes.count - e) }
    if s > 0 { w.bytes.removeSubrange(0..<s) }
  }
}

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
