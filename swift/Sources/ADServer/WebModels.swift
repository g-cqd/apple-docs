// Typed response models for the web routes. Route JSON is built from ADJSON:
//   - fixed shapes with no `null`-valued fields → `Encodable` structs (here);
//   - anything with `null`-vs-omit or dynamic keys → `ADJSON.JSONValue` (WebRoutes).
// (Synthesized `Encodable` OMITS nil Optionals — JS `undefined` semantics — so a
// field the handler emits as `null` must go through `JSONValue.null`, not `T?`.)

import ADJSON

enum WebJSON {
  static func encode<T: Encodable>(_ value: T) -> [UInt8] {
    (try? ADJSON.JSONEncoder().encodeToBytes(value)) ?? Array("null".utf8)
  }
}

// GET /api/fonts: the `name` key is never emitted (the schema has display_name, not name).
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

// GET /data/search/title-index[.<hash>].json: columnar v2, no null-valued fields → a struct.
struct TitleIndexResponse: Encodable {
  let v: Int
  let frameworks: [String]
  let keys: [String]
  let titles: [String]
  let abstracts: [String]
  let fwIndices: [Int]
  let kinds: [String]
  let roleHeadings: [String]
}

// GET /data/search/search-manifest.json. `files` is a dict (the keys are hyphenated,
// e.g. "title-index"); the filename hashes are `sha256(artifact-bytes).slice(0,10)` —
// ad-server's own, self-coherent.
struct SearchManifest: Encodable {
  let version: Int
  let titleCount: Int
  let aliasCount: Int
  let shardCount: Int
  let files: [String: String]
  let generatedAt: String
}
