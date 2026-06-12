// Port of src/apple/renderer.js renderPage — raw DocC JSON → the crawl
// markdown file (normative JS until the phase-5 kill). Tape + writer
// implementation (RFC 0004 §6b): no per-node objects, no intermediate
// Strings on the hot path.
//
// `convertFile` is the batch-convert unit (D-0004-6): Swift owns the
// read+parse+render so page bytes never round-trip through JS.

import ADBase

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum PageMarkdown {
  /// Read + parse + render one raw DocC JSON file into `out` (the final
  /// finished document bytes). false on any trouble — the JS path serves
  /// that page instead.
  public static func convertFile(
    absolutePath: String, canonicalPath: String, scratch: inout ByteWriter, out: inout [UInt8]
  ) -> Bool {
    let fd = open(absolutePath, O_RDONLY)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_size >= 0, info.st_size <= 1 << 30 else { return false }
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
    guard ok else { return false }
    return bytes.withUnsafeBytes { raw -> Bool in
      guard let tape = try? JsonTape.parse(ByteSpan(raw), maxContainerDepth: 512) else { return false }
      scratch.removeAll()
      render(tape: tape, canonicalPath: canonicalPath, into: &scratch)
      ByteOps.finishDocument(scratch.bytes, into: &out, trailingNewline: true)
      return true
    }
  }

  /// Test/compat wrapper: full render to a String.
  public static func render(tape: JsonTape, canonicalPath: String) -> String {
    var writer = ByteWriter()
    render(tape: tape, canonicalPath: canonicalPath, into: &writer)
    var out: [UInt8] = []
    ByteOps.finishDocument(writer.bytes, into: &out, trailingNewline: true)
    return String(decoding: out, as: UTF8.self)
  }

  /// Renders the UNFINISHED parts stream (caller applies
  /// ByteOps.finishDocument — `parts.join('\n').replace(/\n{3,}/).trim()+'\n'`).
  public static func render(tape: JsonTape, canonicalPath: String, into w: inout ByteWriter) {
    let root = tape.root
    let isObject = tape.kind(root) == .object
    let meta = isObject ? tape.member(root, "metadata") : nil
    let refs = Refs(tape: tape, object: isObject ? tape.member(root, "references") : nil)
    var parts = PartsWriter()

    parts.begin(&w)
    frontMatter(tape: tape, meta: meta, canonicalPath: canonicalPath, into: &w)
    parts.begin(&w) // the '' part after front matter

    if let title = member(tape, meta, "title"), tape.isTruthy(title) {
      parts.begin(&w)
      w.append("# ")
      w.appendCoercion(tape: tape, title)
      parts.begin(&w)
    }

    if let abstract = member(tape, root, "abstract"), tape.kind(abstract) == .array,
      tape.childCount(abstract) > 0 {
      parts.begin(&w)
      renderInline(tape, abstract, refs, canonicalPath, &w)
      parts.begin(&w)
    }

    if let sections = member(tape, root, "primaryContentSections"), tape.kind(sections) == .array {
      tape.forEachElement(sections) { section in
        // Non-object sections have no kind/content — JS's default branch
        // pushes nothing.
        guard tape.kind(section) == .object else { return }
        let kind = tape.member(section, "kind")
        if let kind, tape.stringEquals(kind, "declarations") {
          parts.begin(&w)
          renderDeclarations(tape, section, &w)
        } else if let kind, tape.stringEquals(kind, "parameters") {
          parts.begin(&w)
          renderParameters(tape, section, &w)
        } else if let kind, tape.stringEquals(kind, "content") {
          parts.begin(&w)
          renderContentNodes(tape, tape.member(section, "content"), refs, canonicalPath, &w)
        } else if let kind, tape.stringEquals(kind, "mentions") {
          // metadata, not content — JS pushes nothing for this section
        } else if let content = tape.member(section, "content") {
          parts.begin(&w)
          renderContentNodes(tape, content, refs, canonicalPath, &w)
        }
      }
    }

    let linkBlocks: [(StaticString, StaticString)] = [
      ("topicSections", "## Topics"),
      ("relationshipsSections", "## Relationships"),
      ("seeAlsoSections", "## See Also"),
    ]
    for (field, heading) in linkBlocks {
      guard let sections = member(tape, root, field), tape.kind(sections) == .array,
        tape.childCount(sections) > 0
      else { continue }
      parts.begin(&w)
      w.append(heading)
      parts.begin(&w)
      tape.forEachElement(sections) { section in
        parts.begin(&w)
        if tape.kind(section) == .object {
          renderLinkSection(tape, section, refs, canonicalPath, &w)
        } else {
          // JS renderLinkSection on a non-object pushes just the trailing ''.
        }
      }
    }
  }

  /// `obj?.[key]` over an optional object index.
  @inline(__always)
  static func member(_ tape: JsonTape, _ object: Int?, _ key: StaticString) -> Int? {
    guard let object, tape.kind(object) == .object else { return nil }
    return tape.member(object, key)
  }

  static func frontMatter(tape: JsonTape, meta: Int?, canonicalPath: String, into w: inout ByteWriter) {
    w.append("---")
    func field(_ name: StaticString, _ index: Int?) {
      guard let index, !tape.isNull(index) else { return }
      w.append(0x0A)
      w.append(name)
      w.append(": ")
      appendYamlScalar(tape: tape, index, &w)
    }
    field("title", member(tape, meta, "title"))
    let modules = member(tape, meta, "modules")
    let firstModule = modules.flatMap { tape.firstElement($0) }
    field("framework", firstModule.flatMap { tape.kind($0) == .object ? tape.member($0, "name") : nil })
    field("role", member(tape, meta, "role"))
    field("role_heading", member(tape, meta, "roleHeading"))
    // platforms: always present (`?? []`) — emitted even when empty.
    w.append("\nplatforms: [")
    var first = true
    if let platforms = member(tape, meta, "platforms"), tape.kind(platforms) == .array {
      tape.forEachElement(platforms) { platform in
        let obj = tape.kind(platform) == .object ? platform : nil
        let introduced = obj.flatMap { tape.member($0, "introducedAt") }
        let name = obj.flatMap { tape.member($0, "name") }
        if let introduced, tape.isTruthy(introduced) {
          if !first { w.append(", ") }
          first = false
          // `${p.name} ${p.introducedAt}+` — missing name interpolates as
          // "undefined", faithfully. Quoting applies to the whole item.
          var item = ByteWriter(capacity: 64)
          if let name {
            item.appendCoercion(tape: tape, name)
          } else {
            item.append("undefined")
          }
          item.append(0x20)
          item.appendCoercion(tape: tape, introduced)
          item.append(0x2B) // '+'
          appendYamlQuoted(item.bytes, &w)
        } else if let name, tape.isTruthy(name) {
          if !first { w.append(", ") }
          first = false
          var item = ByteWriter(capacity: 32)
          item.appendCoercion(tape: tape, name)
          appendYamlQuoted(item.bytes, &w)
        }
      }
    }
    w.append(0x5D) // ']'
    w.append("\npath: ")
    var item = ByteWriter(capacity: canonicalPath.utf8.count)
    item.append(canonicalPath)
    appendYamlQuoted(item.bytes, &w)
    w.append("\n---")
  }

  /// toFrontMatter scalar: String(value) then quoteIfNeeded.
  static func appendYamlScalar(tape: JsonTape, _ index: Int, _ w: inout ByteWriter) {
    var item = ByteWriter(capacity: 64)
    item.appendCoercion(tape: tape, index)
    appendYamlQuoted(item.bytes, &w)
  }

  /// yaml.js quoteIfNeeded over raw bytes.
  static func appendYamlQuoted(_ value: [UInt8], _ w: inout ByteWriter) {
    if FrontMatter.needsQuotingBytes(value) {
      w.append(0x22)
      for byte in value {
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
      w.bytes.append(contentsOf: value)
    }
  }

  static func renderDeclarations(_ tape: JsonTape, _ section: Int, _ w: inout ByteWriter) {
    w.append("## Declaration\n")
    if let declarations = tape.member(section, "declarations"), tape.kind(declarations) == .array {
      tape.forEachElement(declarations) { declaration in
        w.append(0x0A)
        let obj = tape.kind(declaration) == .object ? declaration : nil
        w.append("```")
        appendFirstLanguage(tape, obj, &w)
        w.append(0x0A)
        if let tokens = obj.flatMap({ tape.member($0, "tokens") }), tape.kind(tokens) == .array {
          tape.forEachElement(tokens) { token in
            // `.map(t => t.text).join('')` — join coerces undefined/null
            // elements to '' (NOT "undefined").
            if tape.kind(token) == .object, let text = tape.member(token, "text"),
              !tape.isNull(text) {
              w.appendCoercion(tape: tape, text)
            }
          }
        }
        w.append("\n```\n")
      }
    }
    // The trailing '' line of lines.join('\n') is the final \n already
    // appended per block; JS also leaves one trailing '' element — the
    // outer parts machinery reproduces it via the next separator.
  }

  static func appendFirstLanguage(_ tape: JsonTape, _ declaration: Int?, _ w: inout ByteWriter) {
    if let languages = declaration.flatMap({ tape.member($0, "languages") }),
      let first = tape.firstElement(languages), !tape.isNull(first) {
      w.appendCoercion(tape: tape, first)
    } else {
      w.append("swift")
    }
  }

  static func renderParameters(_ tape: JsonTape, _ section: Int, _ w: inout ByteWriter) {
    w.append("## Parameters\n")
    if let parameters = tape.member(section, "parameters"), tape.kind(parameters) == .array {
      tape.forEachElement(parameters) { parameter in
        let obj = tape.kind(parameter) == .object ? parameter : nil
        w.append("\n- `")
        if let name = obj.flatMap({ tape.member($0, "name") }), !tape.isNull(name) {
          w.appendCoercion(tape: tape, name)
        }
        w.append("`: ")
        if let content = obj.flatMap({ tape.member($0, "content") }), tape.isTruthy(content) {
          // map(renderContentNode).join(' ') then trim.
          let mark = w.count
          var firstNode = true
          tape.forEachElement(content) { node in
            if !firstNode { w.append(0x20) }
            firstNode = false
            renderContentNode(tape, node, .none, "", &w)
          }
          w.trim(since: mark)
        }
      }
    }
    w.append(0x0A)
  }

  static func renderLinkSection(_ tape: JsonTape, _ section: Int, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    var first = true
    func line() {
      if !first { w.append(0x0A) }
      first = false
    }
    if let title = tape.member(section, "title"), tape.isTruthy(title) {
      line()
      w.append("### ")
      w.appendCoercion(tape: tape, title)
      line() // ''
    }
    if let identifiers = tape.member(section, "identifiers"), tape.kind(identifiers) == .array {
      tape.forEachElement(identifiers) { idValue in
        line()
        appendLinkItem(tape, idValue, refs, fromPath, &w)
      }
    }
    line() // trailing ''
  }

  /// One `- [title](rel.md)` / `- title` line (shared by link sections and
  /// the `links` content node).
  static func appendLinkItem(_ tape: JsonTape, _ idValue: Int, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    let id = tape.kind(idValue) == .string ? tape.string(idValue) : nil
    let ref = id.flatMap { refs.lookup(tape, $0) }
    let normPath = Identifier.normalize(id)
    w.append("- ")
    if let normPath {
      w.append(0x5B) // '['
      if let title = ref.flatMap({ tape.member($0, "title") }), !tape.isNull(title) {
        w.appendCoercion(tape: tape, title)
      } else {
        w.append(normPath)
      }
      w.append("](")
      w.append(relativePath(from: fromPath, to: normPath))
      w.append(".md)")
    } else {
      if let title = ref.flatMap({ tape.member($0, "title") }), !tape.isNull(title) {
        w.appendCoercion(tape: tape, title)
      } else {
        w.appendCoercion(tape: tape, idValue) // `?? id` — null → "null"
      }
    }
  }

  /// The references map: keys are looked up by DYNAMIC id many times per
  /// page (big pages carry hundreds of refs × hundreds of reference
  /// nodes), so one Dictionary built per page replaces per-node linear
  /// scans — the one place hashing pays for itself.
  public struct Refs: Sendable {
    let index: [String: Int]?

    init(tape: JsonTape, object: Int?) {
      guard let object, tape.kind(object) == .object else {
        index = nil
        return
      }
      var built: [String: Int] = Dictionary(minimumCapacity: tape.childCount(object))
      tape.forEachMember(object) { key, value in
        // First occurrence wins position; dup keys were already routed
        // through the eager parser, so plain insert-if-absent is exact.
        let keyString = tape.string(key)
        if built[keyString] == nil { built[keyString] = value }
      }
      index = built
    }

    static let none = Refs(index: nil)

    private init(index: [String: Int]?) {
      self.index = index
    }

    func lookup(_ tape: JsonTape, _ id: String) -> Int? {
      guard let found = index?[id], tape.kind(found) == .object else { return nil }
      return found
    }
  }

  static func renderContentNodes(_ tape: JsonTape, _ nodes: Int?, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    guard let nodes, tape.kind(nodes) == .array else { return }
    var first = true
    tape.forEachElement(nodes) { node in
      if !first { w.append(0x0A) }
      first = false
      renderContentNode(tape, node, refs, fromPath, &w)
    }
  }

  static func renderContentNode(_ tape: JsonTape, _ node: Int, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    guard tape.kind(node) == .object else { return }
    let type = tape.member(node, "type")

    if let type, tape.stringEquals(type, "paragraph") {
      renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "heading") {
      let level = tape.member(node, "level").map { tape.numberValue($0) } ?? 2
      // '#'.repeat(ToInteger(level)) — NaN/∞/huge must not trap (no-trap
      // rule; Int(Double) aborts beyond Int64). Real levels are 1-6; the
      // 2^20 ceiling only guards adversarial JSON.
      let hashes = level.isFinite ? max(0, Int(min(level, 1_048_576))) : 0
      for _ in 0..<hashes { w.append(0x23) }
      w.append(0x20)
      if let text = tape.member(node, "text"), !tape.isNull(text) {
        w.appendCoercion(tape: tape, text)
      } else {
        renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      }
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "codeListing") {
      w.append("```")
      if let syntax = tape.member(node, "syntax"), !tape.isNull(syntax) {
        w.appendCoercion(tape: tape, syntax)
      }
      w.append(0x0A)
      if let code = tape.member(node, "code"), tape.kind(code) == .array {
        var first = true
        tape.forEachElement(code) { line in
          if !first { w.append(0x0A) }
          first = false
          if !tape.isNull(line) { w.appendCoercion(tape: tape, line) }
        }
      }
      w.append("\n```\n")
      return
    }
    if let type, tape.stringEquals(type, "unorderedList") {
      renderList(tape, node, refs, fromPath, ordered: false, &w)
      return
    }
    if let type, tape.stringEquals(type, "orderedList") {
      renderList(tape, node, refs, fromPath, ordered: true, &w)
      return
    }
    if let type, tape.stringEquals(type, "aside") {
      w.append("> **")
      if let style = tape.member(node, "style"), !tape.isNull(style) {
        w.appendCoercion(tape: tape, style)
      } else {
        w.append("Note")
      }
      w.append(":** ")
      let mark = w.count
      renderContentNodes(tape, tape.member(node, "content"), refs, fromPath, &w)
      w.trim(since: mark)
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "table") {
      renderTable(tape, node, refs, fromPath, &w)
      return
    }
    if let type, tape.stringEquals(type, "links") {
      if let items = tape.member(node, "items"), tape.kind(items) == .array {
        var first = true
        tape.forEachElement(items) { idValue in
          if !first { w.append(0x0A) }
          first = false
          appendLinkItem(tape, idValue, refs, fromPath, &w)
        }
      }
      w.append(0x0A)
      return
    }
    // default: truthy inlineContent → inline + \n; truthy content → nodes.
    if let inline = tape.member(node, "inlineContent"), tape.isTruthy(inline) {
      renderInline(tape, inline, refs, fromPath, &w)
      w.append(0x0A)
      return
    }
    if let content = tape.member(node, "content"), tape.isTruthy(content) {
      renderContentNodes(tape, content, refs, fromPath, &w)
    }
  }

  static func renderList(_ tape: JsonTape, _ node: Int, _ refs: Refs, _ fromPath: String, ordered: Bool, _ w: inout ByteWriter) {
    if let items = tape.member(node, "items"), tape.kind(items) == .array {
      var index = 0
      tape.forEachElement(items) { item in
        if index > 0 { w.append(0x0A) }
        if ordered {
          w.append(Json.ecmaNumberToString(Double(index + 1)))
          w.append(". ")
        } else {
          w.append("- ")
        }
        let mark = w.count
        if tape.kind(item) == .object, let content = tape.member(item, "content"),
          tape.kind(content) == .array {
          tape.forEachElement(content) { child in
            renderContentNode(tape, child, refs, fromPath, &w)
          }
        }
        w.trim(since: mark)
        index += 1
      }
    }
    w.append(0x0A)
  }

  static func renderTable(_ tape: JsonTape, _ node: Int, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    guard let rows = tape.member(node, "rows"), tape.kind(rows) == .array,
      let firstRow = tape.firstElement(rows)
    else { return }

    func forEachCell(_ row: Int, _ body: (Int) -> Void) {
      if tape.kind(row) == .array {
        tape.forEachElement(row, body)
      } else if tape.kind(row) == .object, let cells = tape.member(row, "cells"),
        tape.kind(cells) == .array {
        tape.forEachElement(cells, body)
      }
    }
    func renderCell(_ cell: Int) {
      let mark = w.count
      if tape.kind(cell) == .object, let content = tape.member(cell, "content"),
        tape.kind(content) == .array {
        tape.forEachElement(content) { child in
          renderContentNode(tape, child, refs, fromPath, &w)
        }
      }
      w.trim(since: mark)
      w.newlinesToSpaces(since: mark)
    }

    var headerCount = 0
    w.append("| ")
    var firstCell = true
    forEachCell(firstRow) { cell in
      if !firstCell { w.append(" | ") }
      firstCell = false
      renderCell(cell)
      headerCount += 1
    }
    w.append(" |\n| ")
    for i in 0..<headerCount {
      if i > 0 { w.append(" | ") }
      w.append("---")
    }
    w.append(" |")
    var skippedFirst = false
    tape.forEachElement(rows) { row in
      if !skippedFirst {
        skippedFirst = true
        return
      }
      w.append("\n| ")
      var first = true
      forEachCell(row) { cell in
        if !first { w.append(" | ") }
        first = false
        renderCell(cell)
      }
      w.append(" |")
    }
    w.append(0x0A)
  }

  static func renderInline(_ tape: JsonTape, _ nodes: Int?, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    guard let nodes, tape.kind(nodes) == .array else { return }
    tape.forEachElement(nodes) { node in
      renderInlineNode(tape, node, refs, fromPath, &w)
    }
  }

  static func renderInlineNode(_ tape: JsonTape, _ node: Int, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
    guard tape.kind(node) == .object else { return }
    let type = tape.member(node, "type")

    if let type, tape.stringEquals(type, "text") {
      if let text = tape.member(node, "text"), !tape.isNull(text) {
        w.appendCoercion(tape: tape, text)
      }
      return
    }
    if let type, tape.stringEquals(type, "codeVoice") {
      w.append(0x60)
      if let code = tape.member(node, "code"), !tape.isNull(code) {
        w.appendCoercion(tape: tape, code)
      }
      w.append(0x60)
      return
    }
    if let type, tape.stringEquals(type, "emphasis") {
      w.append(0x2A)
      renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      w.append(0x2A)
      return
    }
    if let type,
      tape.stringEquals(type, "strong") || tape.stringEquals(type, "newTerm")
        || tape.stringEquals(type, "inlineHead") {
      w.append("**")
      renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      w.append("**")
      return
    }
    if let type, tape.stringEquals(type, "reference") {
      let identifier = tape.member(node, "identifier")
      let id = identifier.flatMap { tape.kind($0) == .string ? tape.string($0) : nil }
      let ref = id.flatMap { refs.lookup(tape, $0) }
      // normalizeIdentifier(node.identifier ?? ref?.url) — string-guarded.
      var normSource: String? = id
      if normSource == nil, identifier == nil || tape.isNull(identifier!) {
        if let url = ref.flatMap({ tape.member($0, "url") }), tape.kind(url) == .string {
          normSource = tape.string(url)
        }
      }
      let normPath = Identifier.normalize(normSource)
      var isActiveFalse = false
      if let isActive = tape.member(node, "isActive"), tape.kind(isActive) == .bool,
        !tape.isTruthy(isActive) {
        isActiveFalse = true
      }
      func appendTitle() {
        if let title = ref.flatMap({ tape.member($0, "title") }), !tape.isNull(title) {
          w.appendCoercion(tape: tape, title)
        } else if let identifier, !tape.isNull(identifier) {
          w.appendCoercion(tape: tape, identifier)
        }
      }
      if let normPath, !isActiveFalse {
        w.append(0x5B)
        appendTitle()
        w.append("](")
        w.append(relativePath(from: fromPath, to: normPath))
        w.append(".md)")
      } else {
        w.append(0x60)
        appendTitle()
        w.append(0x60)
      }
      return
    }
    if let type, tape.stringEquals(type, "link") {
      let destination = tape.member(node, "destination")
      let hasDestination = destination.map { !tape.isNull($0) } ?? false
      w.append(0x5B)
      if let title = tape.member(node, "title"), !tape.isNull(title) {
        w.appendCoercion(tape: tape, title)
      } else if hasDestination {
        w.appendCoercion(tape: tape, destination!)
      }
      w.append("](")
      if hasDestination { w.appendCoercion(tape: tape, destination!) }
      w.append(0x29)
      return
    }
    if let type, tape.stringEquals(type, "superscript") || tape.stringEquals(type, "subscript") {
      renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      return
    }
    if let type, tape.stringEquals(type, "strikethrough") {
      w.append("~~")
      renderInline(tape, tape.member(node, "inlineContent"), refs, fromPath, &w)
      w.append("~~")
      return
    }
    if let type, tape.stringEquals(type, "image") {
      w.append("![")
      if let alt = tape.member(node, "alt"), !tape.isNull(alt) {
        w.appendCoercion(tape: tape, alt)
      }
      w.append("](")
      if let source = tape.member(node, "source"), !tape.isNull(source) {
        w.appendCoercion(tape: tape, source)
      }
      w.append(0x29)
      return
    }
    // default: text ?? code ?? ''
    if let text = tape.member(node, "text"), !tape.isNull(text) {
      w.appendCoercion(tape: tape, text)
    } else if let code = tape.member(node, "code"), !tape.isNull(code) {
      w.appendCoercion(tape: tape, code)
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

/// `parts: []` + `parts.join('\n')` reproduced as a separator protocol:
/// every `parts.push(x)` is `begin()` (separator when not first) followed
/// by the content writes; pushing '' is a bare `begin()`.
struct PartsWriter {
  var first = true

  mutating func begin(_ w: inout ByteWriter) {
    if !first { w.append(0x0A) }
    first = false
  }
}
