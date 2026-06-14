// Typed response models for the web routes (RFC 0001 P6 web slice, D5). Under the
// intrinsic-identity gate (D2) the byte form is irrelevant — only the parsed JSON
// must deep-equal the Bun handler's — so route JSON is built from `Encodable`
// models + ADJSON's `JSONEncoder` (no hand-rolled writer). `nilStrategy` is the
// one semantic knob: deep-equal distinguishes `{"a":null}` from `{}`, so a field
// the JS handler emits as `null` uses `.null`, one it omits uses `.omit`.

import ADJSON

enum WebJSON {
  static func encode<T: Encodable>(
    _ value: T, nilStrategy: JSONEncodingOptions.NilStrategy = .omit
  ) -> [UInt8] {
    var encoder = ADJSON.JSONEncoder()
    encoder.options.nilStrategy = nilStrategy
    return (try? encoder.encodeToBytes(value)) ?? Array("null".utf8)
  }
}

// GET /api/fonts (projectListAppleFonts): the `name` key is never emitted (the
// schema has display_name, not name).
struct FontsResponse: Encodable {
  struct File: Encodable {
    let id: String
    let file_name: String
  }
  struct Family: Encodable {
    let id: String
    let files: [File]
  }
  let families: [Family]
}
