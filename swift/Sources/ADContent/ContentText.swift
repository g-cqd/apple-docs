// Port of src/content/normalize/render-content.js — DocC block + inline
// nodes to plain text, walking the references map for titles (normative
// JS until the phase-5 kill).

import ADBase

public enum ContentText {
  public static func renderNodes(_ nodes: JsonValue?, refs: JsonObject?) -> String {
    guard let items = nodes?.asArray else { return "" }
    return items.map { renderNode($0, refs: refs) }.joined()
  }

  static func renderNode(_ node: JsonValue, refs: JsonObject?) -> String {
    guard let obj = node.asObject else { return "" }
    let type = obj["type"]?.asString
    switch type {
    case "paragraph":
      return renderInline(obj["inlineContent"], refs: refs) + "\n"

    case "heading":
      // `node.text ?? renderInline(...)` then `${text ?? ''}` — the inner
      // nullish can only fire when both are absent (renderInline returns
      // '' otherwise).
      let text = obj["text"]?.nullish?.jsStringCoercion ?? renderInline(obj["inlineContent"], refs: refs)
      return text + "\n"

    case "codeListing":
      let lines = obj["code"]?.asArray ?? []
      return lines.map { $0.asString ?? $0.jsStringCoercion }.joined(separator: "\n") + "\n"

    case "unorderedList", "orderedList":
      let items = obj["items"]?.asArray ?? []
      return items.map { item in
        renderNodes(item.asObject?["content"] ?? .array([]), refs: refs)
      }.joined()

    case "aside":
      let style = obj["style"]?.nullish?.jsStringCoercion ?? "Note"
      let inner = JsString.trim(renderNodes(obj["content"] ?? .array([]), refs: refs))
      return "\(style): \(inner)\n"

    case "table":
      let rows = obj["rows"]?.asArray ?? []
      let rendered = rows.map { row -> String in
        let cells = row.asArray ?? row.asObject?["cells"]?.asArray ?? []
        return cells.map { cell in
          JsString.trim(renderNodes(cell.asObject?["content"] ?? .array([]), refs: refs))
        }.joined(separator: " | ")
      }.joined(separator: "\n")
      return rendered + "\n"

    case "links":
      let items = obj["items"]?.asArray ?? []
      let rendered = items.map { idValue -> String in
        let id = idValue.asString
        if let id, let ref = refs?[id]?.asObject, let title = ref["title"]?.nullish {
          return title.jsStringCoercion
        }
        if let id, let normalized = Identifier.normalize(id) { return normalized }
        // `?? id` then Array.join: null elements coerce to ''.
        if case .null = idValue { return "" }
        return id ?? idValue.jsStringCoercion
      }.joined(separator: "\n")
      return rendered + "\n"

    case "text":
      return obj["text"]?.nullish?.jsStringCoercion ?? ""

    case "codeVoice":
      return obj["code"]?.nullish?.jsStringCoercion ?? ""

    case "emphasis", "strong", "newTerm", "inlineHead", "superscript", "subscript", "strikethrough":
      return renderInline(obj["inlineContent"], refs: refs)

    case "reference":
      return referenceTitle(obj, refs: refs)

    case "link":
      return obj["title"]?.nullish?.jsStringCoercion ?? obj["destination"]?.nullish?.jsStringCoercion ?? ""

    default:
      // Best-effort: text, then String(code), then recurse.
      if let text = obj["text"], text.isTruthy { return text.jsStringCoercion }
      if let code = obj["code"], code.isTruthy { return code.jsStringCoercion }
      if let inline = obj["inlineContent"], inline.asArray != nil {
        return renderInline(inline, refs: refs)
      }
      if let content = obj["content"], content.asArray != nil {
        return renderNodes(content, refs: refs)
      }
      return ""
    }
  }

  /// renderInlineNodes — plain-text inline walk.
  public static func renderInline(_ nodes: JsonValue?, refs: JsonObject?) -> String {
    guard let items = nodes?.asArray else { return "" }
    return items.map { node -> String in
      guard let obj = node.asObject else { return "" }
      switch obj["type"]?.asString {
      case "text":
        return obj["text"]?.nullish?.jsStringCoercion ?? ""
      case "codeVoice":
        return obj["code"]?.nullish?.jsStringCoercion ?? ""
      case "emphasis", "strong", "newTerm", "inlineHead", "superscript", "subscript", "strikethrough":
        return renderInline(obj["inlineContent"], refs: refs)
      case "reference":
        return referenceTitle(obj, refs: refs)
      case "link":
        return obj["title"]?.nullish?.jsStringCoercion ?? obj["destination"]?.nullish?.jsStringCoercion ?? ""
      default:
        return obj["text"]?.nullish?.jsStringCoercion ?? obj["code"]?.nullish?.jsStringCoercion ?? ""
      }
    }.joined()
  }

  /// `refs?.[node.identifier]?.title ?? node.title ?? node.identifier ?? ''`
  private static func referenceTitle(_ obj: JsonObject, refs: JsonObject?) -> String {
    if let id = obj["identifier"]?.asString, let ref = refs?[id]?.asObject,
      let title = ref["title"]?.nullish {
      return title.jsStringCoercion
    }
    if let title = obj["title"]?.nullish { return title.jsStringCoercion }
    if let id = obj["identifier"]?.nullish { return id.jsStringCoercion }
    return ""
  }
}
