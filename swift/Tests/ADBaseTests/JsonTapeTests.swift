// Tape-parser semantics tests (RFC 0004 §6b): the fast path plus every
// correctness fallback (dup keys, invalid UTF-8, depth, escapes).

import Testing

@testable import ADBase

private func withTape<R>(_ text: String, _ body: (JsonTape) throws -> R) throws -> R {
  var copy = Array(text.utf8)
  return try copy.withUnsafeBytes { bytes in
    let tape = try JsonTape.parse(UnsafeRawBufferPointer(bytes))
    return try body(tape)
  }
}

struct JsonTapeTests {
  @Test func spansAndLookups() throws {
    try withTape(#"{"type":"paragraph","level":2,"items":["a","b",null]}"#) { tape in
      let root = tape.root
      #expect(tape.kind(root) == .object)
      #expect(tape.childCount(root) == 3)
      let type = tape.member(root, "type")!
      #expect(tape.stringEquals(type, "paragraph"))
      #expect(!tape.stringEquals(type, "heading"))
      #expect(tape.numberValue(tape.member(root, "level")!) == 2)
      let items = tape.member(root, "items")!
      #expect(tape.childCount(items) == 3)
      var seen: [String] = []
      tape.forEachElement(items) { element in
        seen.append(tape.isNull(element) ? "<null>" : tape.string(element))
      }
      #expect(seen == ["a", "b", "<null>"])
      #expect(tape.member(root, "missing") == nil)
    }
  }

  @Test func escapedStringsDecodeIntoScratch() throws {
    try withTape(#"{"a":"x\ny","emoji":"😀","lone":"\ud800Z"}"#) { tape in
      #expect(tape.string(tape.member(tape.root, "a")!) == "x\ny")
      #expect(tape.string(tape.member(tape.root, "emoji")!) == "😀")
      #expect(tape.string(tape.member(tape.root, "lone")!) == "\u{FFFD}Z")
    }
  }

  @Test func duplicateKeysFallBackToEagerSemantics() throws {
    // ECMA: last value at the FIRST key position — the eager tree adopts.
    try withTape(#"{"b":1,"a":2,"b":3}"#) { tape in
      #expect(tape.numberValue(tape.member(tape.root, "b")!) == 3)
      var order: [String] = []
      tape.forEachMember(tape.root) { key, _ in order.append(tape.string(key)) }
      #expect(order == ["b", "a"])
    }
  }

  @Test func escapedKeysCompareDecoded() throws {
    // "a" is the key "a" — lookup and dup detection both see it decoded.
    try withTape(#"{"a":1}"#) { tape in
      #expect(tape.member(tape.root, "a") != nil)
    }
    try withTape(#"{"a":1,"a":2}"#) { tape in
      #expect(tape.numberValue(tape.member(tape.root, "a")!) == 2) // dup → eager
    }
  }

  @Test func invalidUtf8FallsBackToRepairSemantics() throws {
    var bytes = Array(#"{"k":""#.utf8)
    bytes.append(0xFF) // invalid lead byte inside the string
    bytes.append(contentsOf: Array(#""}"#.utf8))
    try bytes.withUnsafeBytes { raw in
      let tape = try JsonTape.parse(UnsafeRawBufferPointer(raw))
      #expect(tape.string(tape.member(tape.root, "k")!) == "\u{FFFD}")
    }
  }

  @Test func depthSemanticsMatchSafeJson() {
    let ok = String(repeating: "[", count: 65) + String(repeating: "]", count: 65)
    var okBytes = Array(ok.utf8)
    okBytes.withUnsafeBytes { raw in
      #expect(JsonTape.safeJson(UnsafeRawBufferPointer(raw)) != nil)
    }
    let deep = String(repeating: "[", count: 66) + String(repeating: "]", count: 66)
    var deepBytes = Array(deep.utf8)
    deepBytes.withUnsafeBytes { raw in
      #expect(JsonTape.safeJson(UnsafeRawBufferPointer(raw)) == nil)
    }
    var bad = Array("not json".utf8)
    bad.withUnsafeBytes { raw in
      #expect(JsonTape.safeJson(UnsafeRawBufferPointer(raw)) == nil)
    }
  }

  @Test func coercionMatchesJsonValueTwin() throws {
    try withTape(#"["a",null,1.5,["x","y"],16.0,{"o":1},true]"#) { tape in
      #expect(tape.jsStringCoercion(tape.root) == "a,,1.5,x,y,16,[object Object],true")
      var index = tape.root + 1
      index = tape.skip(index) // "a"
      index = tape.skip(index) // null
      #expect(tape.numberValue(index) == 1.5)
    }
  }

  @Test func truthiness() throws {
    try withTape(#"{"e":"","z":0,"f":false,"n":null,"arr":[],"obj":{},"s":"x"}"#) { tape in
      #expect(!tape.isTruthy(tape.member(tape.root, "e")!))
      #expect(!tape.isTruthy(tape.member(tape.root, "z")!))
      #expect(!tape.isTruthy(tape.member(tape.root, "f")!))
      #expect(!tape.isTruthy(tape.member(tape.root, "n")!))
      #expect(tape.isTruthy(tape.member(tape.root, "arr")!))
      #expect(tape.isTruthy(tape.member(tape.root, "obj")!))
      #expect(tape.isTruthy(tape.member(tape.root, "s")!))
    }
  }
}
