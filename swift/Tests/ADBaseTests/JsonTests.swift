// JSON.parse-equivalence tests for the ordered parser (RFC 0004
// D-0004-1). Expected values are pinned against Bun's JSON.parse /
// String() behavior.

import Testing

@testable import ADBase

private func parse(_ text: String) throws -> JsonValue {
  try Json.parse(Array(text.utf8))
}

private func safe(_ text: String) -> JsonValue? {
  Json.safeJson(Array(text.utf8))
}

struct JsonParserTests {
  @Test func objectsPreserveInsertionOrderAndDuplicateSemantics() throws {
    // JSON.parse('{"b":1,"a":2,"b":3}') → {"b":3,"a":2} — last value,
    // first position.
    let value = try parse(#"{"b":1,"a":2,"b":3}"#)
    let object = value.asObject!
    #expect(object.keys == ["b", "a"])
    #expect(object["b"]?.asNumber == 3)
    #expect(object["a"]?.asNumber == 2)
    #expect(object.entries.map(\.key) == ["b", "a"])
  }

  @Test func surrogatePairsCombineAndLoneSurrogatesReplace() throws {
    #expect(try parse(#""😀""#).asString == "😀")
    // Lone high, lone low, and high-followed-by-BMP all yield U+FFFD —
    // the JS string crosses a UTF-8 boundary and becomes U+FFFD there.
    #expect(try parse(#""a\ud800b""#).asString == "a\u{FFFD}b")
    #expect(try parse(#""\udc00""#).asString == "\u{FFFD}")
    #expect(try parse(#""\ud800A""#).asString == "\u{FFFD}A")
    #expect(try parse(#""\ud800😀""#).asString == "\u{FFFD}😀")
  }

  @Test func stringEscapesAndControls() throws {
    #expect(try parse(#""\n\t\"\\\/\b\f\r""#).asString == "\n\t\"\\/\u{08}\u{0C}\r")
    #expect(throws: (any Error).self) { try parse("\"raw\u{01}control\"") }
    #expect(throws: (any Error).self) { try parse(#""dangling\"#) }
    #expect(throws: (any Error).self) { try parse(#""\q""#) }
  }

  @Test func numbersFollowJsonGrammar() throws {
    #expect(try parse("0").asNumber == 0)
    #expect(try parse("-0").asNumber?.sign == .minus)
    #expect(try parse("1e2").asNumber == 100)
    #expect(try parse("123.456").asNumber == 123.456)
    #expect(throws: (any Error).self) { try parse("01") }
    #expect(throws: (any Error).self) { try parse("1.") }
    #expect(throws: (any Error).self) { try parse(".5") }
    #expect(throws: (any Error).self) { try parse("1e") }
  }

  @Test func trailingGarbageAndLiterals() throws {
    #expect(try parse("true").isTruthy)
    #expect(try parse("null").asString == nil)
    #expect(throws: (any Error).self) { try parse("true false") }
    #expect(throws: (any Error).self) { try parse("nul") }
  }

  @Test func safeJsonDepthMirrorsTheFreezeLimit() {
    // src/content/safe-json.js: containers deeper than 64 levels → null.
    let okDepth = 65 // containers at depths 0...64
    let ok = String(repeating: "[", count: okDepth) + String(repeating: "]", count: okDepth)
    #expect(safe(ok) != nil)
    let tooDeep = String(repeating: "[", count: 66) + String(repeating: "]", count: 66)
    #expect(safe(tooDeep) == nil)
    #expect(safe("not json") == nil)
  }

  @Test func ecmaNumberToStringMatchesJs() {
    // Pinned against String(x) in Bun.
    #expect(Json.ecmaNumberToString(0) == "0")
    #expect(Json.ecmaNumberToString(-0.0) == "0")
    #expect(Json.ecmaNumberToString(1) == "1")
    #expect(Json.ecmaNumberToString(16.0) == "16")
    #expect(Json.ecmaNumberToString(-42) == "-42")
    #expect(Json.ecmaNumberToString(0.5) == "0.5")
    #expect(Json.ecmaNumberToString(123.456) == "123.456")
    #expect(Json.ecmaNumberToString(0.000001) == "0.000001")
    #expect(Json.ecmaNumberToString(1e-7) == "1e-7")
    #expect(Json.ecmaNumberToString(1.5e-7) == "1.5e-7")
    #expect(Json.ecmaNumberToString(1e20) == "100000000000000000000")
    #expect(Json.ecmaNumberToString(1e21) == "1e+21")
    #expect(Json.ecmaNumberToString(1.7976931348623157e308) == "1.7976931348623157e+308")
    #expect(Json.ecmaNumberToString(9007199254740993) == "9007199254740992")
  }

  @Test func jsStringCoercionMatchesTemplates() throws {
    // `String(value)` semantics for the renderer default branches.
    let array = try parse(#"["a",null,1.5,["x","y"]]"#)
    #expect(array.jsStringCoercion == "a,,1.5,x,y")
    #expect(try parse("{}").jsStringCoercion == "[object Object]")
    #expect(try parse("true").jsStringCoercion == "true")
    #expect(try parse("null").jsStringCoercion == "null")
  }
}
