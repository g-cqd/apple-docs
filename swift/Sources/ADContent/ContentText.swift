// Port of src/content/normalize/render-content.js — DocC block + inline
// nodes to plain text, walking the references map for titles (normative
// JS until the phase-5 kill). Tape + writer implementation.

import ADBase

public enum ContentText {
  /// renderContentNodesToText: blocks joined with '' (no separators).
  public static func renderNodes(_ tape: JsonTape, _ nodes: Int?, refs: PageMarkdown.Refs, into w: inout ByteWriter) {
    guard let nodes, tape.kind(nodes) == .array else { return }
    tape.forEachElement(nodes) { node in
      renderNode(tape, node, refs, &w)
    }
  }

  static func renderNode(_ tape: JsonTape, _ node: Int, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
    guard tape.kind(node) == .object else { return }
    let type = tape.member(node, "type")

    if let type, tape.stringEquals(type, "paragraph") {
      renderInline(tape, tape.member(node, "inlineContent"), refs, &w)
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "heading") {
      // `node.text ?? renderInline(...)` then `${text ?? ''}`.
      if let text = tape.member(node, "text"), !tape.isNull(text) {
        w.appendCoercion(tape: tape, text)
      } else {
        renderInline(tape, tape.member(node, "inlineContent"), refs, &w)
      }
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "codeListing") {
      if let code = tape.member(node, "code"), tape.kind(code) == .array {
        var first = true
        tape.forEachElement(code) { line in
          if !first { w.append(0x0A) }
          first = false
          if !tape.isNull(line) { w.appendCoercion(tape: tape, line) }
        }
      }
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "unorderedList") || tape.stringEquals(type, "orderedList") {
      if let items = tape.member(node, "items"), tape.kind(items) == .array {
        tape.forEachElement(items) { item in
          if tape.kind(item) == .object {
            renderNodes(tape, tape.member(item, "content"), refs: refs, into: &w)
          }
        }
      }
      return
    }
    if let type, tape.stringEquals(type, "aside") {
      if let style = tape.member(node, "style"), !tape.isNull(style) {
        w.appendCoercion(tape: tape, style)
      } else {
        w.append("Note")
      }
      w.append(": ")
      let mark = w.count
      renderNodes(tape, tape.member(node, "content"), refs: refs, into: &w)
      w.trim(since: mark)
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "table") {
      if let rows = tape.member(node, "rows"), tape.kind(rows) == .array {
        var firstRow = true
        tape.forEachElement(rows) { row in
          if !firstRow { w.append(0x0A) }
          firstRow = false
          var firstCell = true
          func renderCell(_ cell: Int) {
            if !firstCell { w.append(" | ") }
            firstCell = false
            let mark = w.count
            if tape.kind(cell) == .object {
              renderNodes(tape, tape.member(cell, "content"), refs: refs, into: &w)
            }
            w.trim(since: mark)
          }
          if tape.kind(row) == .array {
            tape.forEachElement(row, renderCell)
          } else if tape.kind(row) == .object, let cells = tape.member(row, "cells"),
            tape.kind(cells) == .array {
            tape.forEachElement(cells, renderCell)
          }
        }
      }
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "links") {
      if let items = tape.member(node, "items"), tape.kind(items) == .array {
        var first = true
        tape.forEachElement(items) { idValue in
          if !first { w.append(0x0A) }
          first = false
          let id = tape.kind(idValue) == .string ? tape.string(idValue) : nil
          if let id, let ref = refs.lookup(tape, id),
            let title = tape.member(ref, "title"), !tape.isNull(title) {
            w.appendCoercion(tape: tape, title)
          } else if let id, let normalized = Identifier.normalize(id) {
            w.append(normalized)
          } else if tape.isNull(idValue) {
            // `?? id` then Array.join: null elements coerce to ''.
          } else if let id {
            w.append(id)
          } else {
            w.appendCoercion(tape: tape, idValue)
          }
        }
      }
      w.append(0x0A)
      return
    }
    if let type, tape.stringEquals(type, "text") {
      if let text = tape.member(node, "text"), !tape.isNull(text) {
        w.appendCoercion(tape: tape, text)
      }
      return
    }
    if let type, tape.stringEquals(type, "codeVoice") {
      if let code = tape.member(node, "code"), !tape.isNull(code) {
        w.appendCoercion(tape: tape, code)
      }
      return
    }
    if let type, isInlineMark(tape, type) {
      renderInline(tape, tape.member(node, "inlineContent"), refs, &w)
      return
    }
    if let type, tape.stringEquals(type, "reference") {
      appendReferenceTitle(tape, node, refs, &w)
      return
    }
    if let type, tape.stringEquals(type, "link") {
      appendLinkText(tape, node, &w)
      return
    }
    // Best-effort default: truthy text → String(text); truthy code →
    // String(code); else recurse into inlineContent / content arrays.
    if let text = tape.member(node, "text"), tape.isTruthy(text) {
      w.appendCoercion(tape: tape, text)
      return
    }
    if let code = tape.member(node, "code"), tape.isTruthy(code) {
      w.appendCoercion(tape: tape, code)
      return
    }
    if let inline = tape.member(node, "inlineContent"), tape.kind(inline) == .array {
      renderInline(tape, inline, refs, &w)
      return
    }
    if let content = tape.member(node, "content"), tape.kind(content) == .array {
      renderNodes(tape, content, refs: refs, into: &w)
    }
  }

  static func isInlineMark(_ tape: JsonTape, _ type: Int) -> Bool {
    tape.stringEquals(type, "emphasis") || tape.stringEquals(type, "strong")
      || tape.stringEquals(type, "newTerm") || tape.stringEquals(type, "inlineHead")
      || tape.stringEquals(type, "superscript") || tape.stringEquals(type, "subscript")
      || tape.stringEquals(type, "strikethrough")
  }

  public static func renderInline(_ tape: JsonTape, _ nodes: Int?, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
    guard let nodes, tape.kind(nodes) == .array else { return }
    tape.forEachElement(nodes) { node in
      guard tape.kind(node) == .object else { return }
      let type = tape.member(node, "type")
      if let type, tape.stringEquals(type, "text") {
        if let text = tape.member(node, "text"), !tape.isNull(text) {
          w.appendCoercion(tape: tape, text)
        }
        return
      }
      if let type, tape.stringEquals(type, "codeVoice") {
        if let code = tape.member(node, "code"), !tape.isNull(code) {
          w.appendCoercion(tape: tape, code)
        }
        return
      }
      if let type, isInlineMark(tape, type) {
        renderInline(tape, tape.member(node, "inlineContent"), refs, &w)
        return
      }
      if let type, tape.stringEquals(type, "reference") {
        appendReferenceTitle(tape, node, refs, &w)
        return
      }
      if let type, tape.stringEquals(type, "link") {
        appendLinkText(tape, node, &w)
        return
      }
      // default: text ?? code ?? ''
      if let text = tape.member(node, "text"), !tape.isNull(text) {
        w.appendCoercion(tape: tape, text)
      } else if let code = tape.member(node, "code"), !tape.isNull(code) {
        w.appendCoercion(tape: tape, code)
      }
    }
  }

  /// `refs?.[id]?.title ?? node.title ?? node.identifier ?? ''`
  static func appendReferenceTitle(_ tape: JsonTape, _ node: Int, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
    let identifier = tape.member(node, "identifier")
    let id = identifier.flatMap { tape.kind($0) == .string ? tape.string($0) : nil }
    if let id, let ref = refs.lookup(tape, id),
      let title = tape.member(ref, "title"), !tape.isNull(title) {
      w.appendCoercion(tape: tape, title)
      return
    }
    if let title = tape.member(node, "title"), !tape.isNull(title) {
      w.appendCoercion(tape: tape, title)
      return
    }
    if let identifier, !tape.isNull(identifier) {
      w.appendCoercion(tape: tape, identifier)
    }
  }

  /// `node.title ?? node.destination ?? ''`
  static func appendLinkText(_ tape: JsonTape, _ node: Int, _ w: inout ByteWriter) {
    if let title = tape.member(node, "title"), !tape.isNull(title) {
      w.appendCoercion(tape: tape, title)
      return
    }
    if let destination = tape.member(node, "destination"), !tape.isNull(destination) {
      w.appendCoercion(tape: tape, destination)
    }
  }
}
