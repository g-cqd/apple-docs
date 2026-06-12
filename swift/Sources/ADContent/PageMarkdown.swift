// Port of src/apple/renderer.js renderPage — raw DocC JSON → the crawl
// markdown file (normative JS until the phase-5 kill).
//
// `convertFile` is the batch-convert unit (RFC 0004 D-0004-6): Swift owns
// the read+parse+render so page bytes never round-trip through JS — the
// shape that actually beats the in-process JS pipeline.

import ADBase

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum PageMarkdown {
  /// Read + parse + render one raw DocC JSON file. nil on any trouble
  /// (unreadable, oversized, malformed, too deep) — the JS path serves
  /// that page instead.
  public static func convertFile(absolutePath: String, canonicalPath: String) -> String? {
    let fd = open(absolutePath, O_RDONLY)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_size >= 0, info.st_size <= 1 << 30 else { return nil }
    var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
    var done = 0
    let wanted = bytes.count
    let ok = bytes.withUnsafeMutableBytes { buffer -> Bool in
      while done < wanted {
        let n = read(fd, buffer.baseAddress! + done, wanted - done)
        if n <= 0 { return false }
        done += n
      }
      return true
    }
    guard ok else { return nil }
    guard let parsed = try? Json.parse(bytes, maxContainerDepth: 512) else { return nil }
    return render(json: parsed, canonicalPath: canonicalPath)
  }

  public static func render(json: JsonValue, canonicalPath: String) -> String {
    let root = json.asObject ?? JsonObject()
    let meta = root["metadata"]?.asObject ?? JsonObject()
    let refs = root["references"]?.asObject ?? JsonObject()
    var parts: [String] = []

    parts.append(frontMatter(meta: meta, canonicalPath: canonicalPath))
    parts.append("")

    if let title = meta["title"], title.isTruthy {
      parts.append("# \(title.jsStringCoercion)")
      parts.append("")
    }

    if let abstract = root["abstract"]?.asArray, !abstract.isEmpty {
      parts.append(renderInline(.array(abstract), refs: refs, fromPath: canonicalPath))
      parts.append("")
    }

    for section in root["primaryContentSections"]?.asArray ?? [] {
      let obj = section.asObject ?? JsonObject()
      switch obj["kind"]?.asString {
      case "declarations":
        parts.append(renderDeclarations(obj))
      case "parameters":
        parts.append(renderParameters(obj))
      case "content":
        parts.append(renderContentNodes(obj["content"] ?? .array([]), refs: refs, fromPath: canonicalPath))
      case "mentions":
        break // metadata, not content
      default:
        if let content = obj["content"] {
          parts.append(renderContentNodes(content, refs: refs, fromPath: canonicalPath))
        }
      }
    }

    let linkBlocks: [(String, String)] = [
      ("topicSections", "## Topics"),
      ("relationshipsSections", "## Relationships"),
      ("seeAlsoSections", "## See Also"),
    ]
    for (field, heading) in linkBlocks {
      guard let sections = root[field]?.asArray, !sections.isEmpty else { continue }
      parts.append(heading)
      parts.append("")
      for section in sections {
        parts.append(renderLinkSection(section.asObject ?? JsonObject(), refs: refs, fromPath: canonicalPath))
      }
    }

    return JsString.trim(JsString.collapseBlankRuns(parts.joined(separator: "\n"))) + "\n"
  }

  static func frontMatter(meta: JsonObject, canonicalPath: String) -> String {
    var fields: [(String, FrontMatter.Value?)] = []
    fields.append(("title", meta["title"]?.nullish.map { .scalar($0.jsStringCoercion) }))
    let frameworkName = meta["modules"]?.asArray?.first?.asObject?["name"]
    fields.append(("framework", frameworkName?.nullish.map { .scalar($0.jsStringCoercion) }))
    fields.append(("role", meta["role"]?.nullish.map { .scalar($0.jsStringCoercion) }))
    fields.append(("role_heading", meta["roleHeading"]?.nullish.map { .scalar($0.jsStringCoercion) }))
    let platforms = (meta["platforms"]?.asArray ?? []).compactMap { platform -> String? in
      let obj = platform.asObject
      let introduced = obj?["introducedAt"]
      let name = obj?["name"]
      if let introduced, introduced.isTruthy {
        // `${p.name} ${p.introducedAt}+` — a missing name interpolates as
        // "undefined", faithfully.
        return "\(JsonValue.templateString(name)) \(introduced.jsStringCoercion)+"
      }
      // p.name with filter(Boolean): non-truthy values drop out.
      guard let name, name.isTruthy else { return nil }
      return name.jsStringCoercion
    }
    fields.append(("platforms", .list(platforms)))
    fields.append(("path", .scalar(canonicalPath)))
    return FrontMatter.render(fields)
  }

  static func renderDeclarations(_ section: JsonObject) -> String {
    var lines = ["## Declaration", ""]
    for declaration in section["declarations"]?.asArray ?? [] {
      let obj = declaration.asObject
      let code = (obj?["tokens"]?.asArray ?? []).map { token in
        JsonValue.templateString(token.asObject?["text"])
      }.joined()
      let language = obj?["languages"]?.asArray?.first?.nullish?.jsStringCoercion ?? "swift"
      lines.append("```\(language)")
      lines.append(code)
      lines.append("```")
      lines.append("")
    }
    return lines.joined(separator: "\n")
  }

  static func renderParameters(_ section: JsonObject) -> String {
    var lines = ["## Parameters", ""]
    for parameter in section["parameters"]?.asArray ?? [] {
      let obj = parameter.asObject
      let name = obj?["name"]?.nullish?.jsStringCoercion ?? ""
      var description = ""
      if let content = obj?["content"], content.isTruthy {
        description = JsString.trim(
          (content.asArray ?? []).map { node in
            renderContentNode(node, refs: JsonObject(), fromPath: "")
          }.joined(separator: " "))
      }
      lines.append("- `\(name)`: \(description)")
    }
    lines.append("")
    return lines.joined(separator: "\n")
  }

  static func renderLinkSection(_ section: JsonObject, refs: JsonObject, fromPath: String) -> String {
    var lines: [String] = []
    if let title = section["title"], title.isTruthy {
      lines.append("### \(title.jsStringCoercion)")
      lines.append("")
    }
    for idValue in section["identifiers"]?.asArray ?? [] {
      let id = idValue.asString
      let ref = id.flatMap { refs[$0]?.asObject }
      let normPath = Identifier.normalize(id)
      // `ref?.title ?? normPath ?? id` — a null id interpolates as "null".
      let title =
        ref?["title"]?.nullish?.jsStringCoercion ?? normPath ?? idValue.jsStringCoercion
      if let normPath {
        let rel = relativePath(from: fromPath, to: normPath)
        lines.append("- [\(title)](\(rel).md)")
      } else {
        lines.append("- \(title)")
      }
    }
    lines.append("")
    return lines.joined(separator: "\n")
  }

  static func renderContentNodes(_ nodes: JsonValue, refs: JsonObject, fromPath: String) -> String {
    (nodes.asArray ?? []).map { renderContentNode($0, refs: refs, fromPath: fromPath) }
      .joined(separator: "\n")
  }

  static func renderContentNode(_ node: JsonValue, refs: JsonObject, fromPath: String) -> String {
    guard let obj = node.asObject else { return "" }
    switch obj["type"]?.asString {
    case "paragraph":
      return renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath) + "\n"

    case "heading":
      let level = obj["level"]?.asNumber ?? 2
      let hashes = String(repeating: "#", count: max(0, Int(level)))
      let text =
        obj["text"]?.nullish?.jsStringCoercion
        ?? renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath)
      return "\(hashes) \(text)\n"

    case "codeListing":
      let lang = obj["syntax"]?.nullish?.jsStringCoercion ?? ""
      let code = (obj["code"]?.asArray ?? []).map { line -> String in
        if case .null = line { return "" }
        return line.jsStringCoercion
      }.joined(separator: "\n")
      return "```\(lang)\n\(code)\n```\n"

    case "unorderedList":
      let items = (obj["items"]?.asArray ?? []).map { item in
        renderListItem(item, prefix: "- ", refs: refs, fromPath: fromPath)
      }
      return items.joined(separator: "\n") + "\n"

    case "orderedList":
      let items = (obj["items"]?.asArray ?? []).enumerated().map { index, item in
        renderListItem(item, prefix: "\(index + 1). ", refs: refs, fromPath: fromPath)
      }
      return items.joined(separator: "\n") + "\n"

    case "aside":
      let style = obj["style"]?.nullish?.jsStringCoercion ?? "Note"
      let content = JsString.trim(
        renderContentNodes(obj["content"] ?? .array([]), refs: refs, fromPath: fromPath))
      return "> **\(style):** \(content)\n"

    case "table":
      return renderTable(obj, refs: refs, fromPath: fromPath)

    case "links":
      let items = (obj["items"]?.asArray ?? []).map { idValue -> String in
        let id = idValue.asString
        let ref = id.flatMap { refs[$0]?.asObject }
        let normPath = Identifier.normalize(id)
        let title =
          ref?["title"]?.nullish?.jsStringCoercion ?? normPath ?? idValue.jsStringCoercion
        if let normPath {
          return "- [\(title)](\(relativePath(from: fromPath, to: normPath)).md)"
        }
        return "- \(title)"
      }
      return items.joined(separator: "\n") + "\n"

    default:
      // JS truthiness: [] is truthy, '' / null are not.
      if let inline = obj["inlineContent"], inline.isTruthy {
        return renderInline(inline, refs: refs, fromPath: fromPath) + "\n"
      }
      if let content = obj["content"], content.isTruthy {
        return renderContentNodes(content, refs: refs, fromPath: fromPath)
      }
      return ""
    }
  }

  static func renderListItem(_ item: JsonValue, prefix: String, refs: JsonObject, fromPath: String)
    -> String {
    let content = JsString.trim(
      (item.asObject?["content"]?.asArray ?? []).map { node in
        renderContentNode(node, refs: refs, fromPath: fromPath)
      }.joined())
    return prefix + content
  }

  static func renderTable(_ node: JsonObject, refs: JsonObject, fromPath: String) -> String {
    let rows = node["rows"]?.asArray ?? []
    if rows.isEmpty { return "" }

    func rowCells(_ row: JsonValue) -> [JsonValue] {
      if let array = row.asArray { return array }
      return row.asObject?["cells"]?.asArray ?? []
    }
    func renderCell(_ cell: JsonValue) -> String {
      let rendered = (cell.asObject?["content"]?.asArray ?? []).map { node in
        renderContentNode(node, refs: refs, fromPath: fromPath)
      }.joined()
      var flattened = ""
      for ch in JsString.trim(rendered).unicodeScalars {
        flattened.unicodeScalars.append(ch == "\n" ? " " : ch)
      }
      return flattened
    }

    let headerCells = rowCells(rows[0]).map(renderCell)
    var lines = [
      "| \(headerCells.joined(separator: " | ")) |",
      "| \(headerCells.map { _ in "---" }.joined(separator: " | ")) |",
    ]
    for row in rows.dropFirst() {
      let cells = rowCells(row).map(renderCell)
      lines.append("| \(cells.joined(separator: " | ")) |")
    }
    lines.append("")
    return lines.joined(separator: "\n")
  }

  static func renderInline(_ nodes: JsonValue, refs: JsonObject, fromPath: String) -> String {
    guard let items = nodes.asArray else { return "" }
    return items.map { renderInlineNode($0, refs: refs, fromPath: fromPath) }.joined()
  }

  static func renderInlineNode(_ node: JsonValue, refs: JsonObject, fromPath: String) -> String {
    guard let obj = node.asObject else { return "" }
    switch obj["type"]?.asString {
    case "text":
      return obj["text"]?.nullish?.jsStringCoercion ?? ""

    case "codeVoice":
      return "`\(obj["code"]?.nullish?.jsStringCoercion ?? "")`"

    case "emphasis":
      return "*\(renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath))*"

    case "strong", "newTerm", "inlineHead":
      return "**\(renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath))**"

    case "reference":
      let id = obj["identifier"]?.asString
      let ref = id.flatMap { refs[$0]?.asObject }
      let title =
        ref?["title"]?.nullish?.jsStringCoercion
        ?? obj["identifier"]?.nullish?.jsStringCoercion ?? ""
      // normalizeIdentifier type-guards on string — non-strings yield null.
      let normSource = (obj["identifier"]?.nullish ?? ref?["url"]?.nullish)?.asString
      let normPath = Identifier.normalize(normSource)
      let isActiveFalse = obj["isActive"].map { value -> Bool in
        if case .bool(false) = value { return true }
        return false
      } ?? false
      if let normPath, !isActiveFalse {
        return "[\(title)](\(relativePath(from: fromPath, to: normPath)).md)"
      }
      return "`\(title)`"

    case "link":
      let destination = obj["destination"]?.nullish?.jsStringCoercion
      let title = obj["title"]?.nullish?.jsStringCoercion ?? destination ?? ""
      return "[\(title)](\(destination ?? ""))"

    case "superscript", "subscript":
      return renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath)

    case "strikethrough":
      return "~~\(renderInline(obj["inlineContent"] ?? .array([]), refs: refs, fromPath: fromPath))~~"

    case "image":
      let alt = obj["alt"]?.nullish?.jsStringCoercion ?? ""
      let source = obj["source"]?.nullish?.jsStringCoercion ?? ""
      return "![\(alt)](\(source))"

    default:
      return obj["text"]?.nullish?.jsStringCoercion ?? obj["code"]?.nullish?.jsStringCoercion ?? ""
    }
  }

  /// renderer.js relativePath: directory-to-directory common prefix, then
  /// `..` climbs + target path.
  public static func relativePath(from fromPath: String, to toPath: String) -> String {
    if fromPath.isEmpty || toPath.isEmpty { return toPath }
    if fromPath == toPath {
      return toPath.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
    }
    let fromParts = fromPath.split(separator: "/", omittingEmptySubsequences: false)
    let toParts = toPath.split(separator: "/", omittingEmptySubsequences: false)
    let fromDir = fromParts.dropLast()
    let toDir = toParts.dropLast()
    let toFile = toParts.last ?? ""

    var common = 0
    while common < fromDir.count, common < toDir.count, fromDir[common] == toDir[common] {
      common += 1
    }
    var parts: [Substring] = []
    for _ in 0..<(fromDir.count - common) { parts.append("..") }
    parts.append(contentsOf: toDir.dropFirst(common))
    parts.append(toFile)
    return parts.joined(separator: "/")
  }
}
