// Port of src/content/render-markdown.js — document + sections → markdown
// (normative JS until the phase-5 kill). Span + tape + writer
// implementation (RFC 0004 §6b): fields stay as byte spans over the FFI
// request; contentJson parses onto a tape; sections render into a reused
// section writer (the `if (rendered)` skip-if-empty protocol).

public import ADBase

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
  public var text: ByteSpan // contentText (coerced default '')
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
    guard let json = platformsJson, let tape = JsonTape.safeJson(json) else { return }
    let root = tape.root
    var items = ByteWriter(capacity: 128)
    var first = true
    func appendItem(_ body: (inout ByteWriter) -> Void) {
      var item = ByteWriter(capacity: 48)
      body(&item)
      if !first { items.append(", ") }
      first = false
      appendQuotedBytes(item.bytes, &items)
    }
    if tape.kind(root) == .array {
      tape.forEachElement(root) { element in
        appendItem { item in item.appendCoercion(tape: tape, element) }
      }
    } else if tape.kind(root) == .object {
      tape.forEachMember(root) { key, value in
        appendItem { item in
          appendPrettyPlatform(tape, key, &item)
          if tape.isTruthy(value) {
            item.append(0x20)
            item.appendCoercion(tape: tape, value)
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

  static func appendPrettyPlatform(_ tape: JsonTape, _ key: Int, _ w: inout ByteWriter) {
    let pretty: [(StaticString, StaticString)] = [
      ("ios", "iOS"), ("macos", "macOS"), ("watchos", "watchOS"), ("tvos", "tvOS"),
      ("visionos", "visionOS"), ("maccatalyst", "Mac Catalyst"), ("ipados", "iPadOS"),
    ]
    for (raw, display) in pretty where tape.stringEquals(key, raw) {
      w.append(display)
      return
    }
    w.append(tape: tape, string: key)
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
      w.removeAll() // body empty → renderTitledSection returns ''
    }
  }

  static func renderDeclaration(_ section: SectionSpans, _ w: inout ByteWriter) {
    var blocks = ByteWriter(capacity: 256)
    var code = ByteWriter(capacity: 256)
    var blockCount = 0
    if let json = section.json, let tape = JsonTape.safeJson(json), tape.kind(tape.root) == .array {
      tape.forEachElement(tape.root) { declaration in
        let obj = tape.kind(declaration) == .object ? declaration : nil
        code.removeAll()
        if let tokens = obj.flatMap({ tape.member($0, "tokens") }), tape.kind(tokens) == .array {
          tape.forEachElement(tokens) { token in
            // `token.text ?? ''` — nullish only.
            if tape.kind(token) == .object, let text = tape.member(token, "text"),
              !tape.isNull(text) {
              code.appendCoercion(tape: tape, text)
            }
          }
        }
        // `if (!code.trim()) return null` — emptiness on the trimmed code.
        let (cs, ce) = ByteOps.trimRange(code.bytes, 0, code.bytes.count)
        if cs >= ce { return }
        if blockCount > 0 { blocks.append("\n\n") }
        blockCount += 1
        blocks.append("```")
        if let languages = obj.flatMap({ tape.member($0, "languages") }),
          let first = tape.firstElement(languages), !tape.isNull(first) {
          blocks.appendCoercion(tape: tape, first)
        } else {
          blocks.append("swift")
        }
        blocks.append(0x0A)
        blocks.bytes.append(contentsOf: code.bytes) // raw code, untrimmed
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
    if let json = section.json, let tape = JsonTape.safeJson(json), tape.kind(tape.root) == .array,
      tape.childCount(tape.root) > 0 {
      tape.forEachElement(tape.root) { parameter in
        let obj = tape.kind(parameter) == .object ? parameter : nil
        w.append(0x0A)
        let lineMark = w.count
        w.append("- `")
        if let name = obj.flatMap({ tape.member($0, "name") }), !tape.isNull(name) {
          w.appendCoercion(tape: tape, name)
        } else {
          w.append("Value")
        }
        w.append("`: ")
        let descMark = w.count
        ContentText.renderNodes(tape, obj.flatMap { tape.member($0, "content") }, refs: .none, into: &w)
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
            if i > lineStart { // `.filter(Boolean)` drops empty lines
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
    if let json = section.json, let tape = JsonTape.safeJson(json), tape.kind(tape.root) == .array,
      tape.childCount(tape.root) > 0 {
      usedGroups = true
      tape.forEachElement(tape.root) { group in
        let obj = tape.kind(group) == .object ? group : nil
        if let groupTitle = obj.flatMap({ tape.member($0, "title") }), tape.isTruthy(groupTitle) {
          w.append("\n### ")
          w.appendCoercion(tape: tape, groupTitle)
          w.append(0x0A)
        }
        if let items = obj.flatMap({ tape.member($0, "items") }), tape.kind(items) == .array {
          tape.forEachElement(items) { item in
            let itemObj = tape.kind(item) == .object ? item : nil
            w.append(0x0A)
            if let key = itemObj.flatMap({ tape.member($0, "key") }), tape.isTruthy(key) {
              w.append("- [")
              if let itemTitle = itemObj.flatMap({ tape.member($0, "title") }), !tape.isNull(itemTitle) {
                w.appendCoercion(tape: tape, itemTitle)
              } else {
                w.appendCoercion(tape: tape, key)
              }
              w.append("](")
              w.appendCoercion(tape: tape, key)
              w.append(".md)")
            } else {
              let lineMark = w.count
              w.append("- ")
              if let itemTitle = itemObj.flatMap({ tape.member($0, "title") }), !tape.isNull(itemTitle) {
                w.appendCoercion(tape: tape, itemTitle)
              } else if let identifier = itemObj.flatMap({ tape.member($0, "identifier") }),
                !tape.isNull(identifier) {
                w.appendCoercion(tape: tape, identifier)
              }
              w.trim(since: lineMark)
            }
          }
        }
        w.append(0x0A) // the group's trailing '' line
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
