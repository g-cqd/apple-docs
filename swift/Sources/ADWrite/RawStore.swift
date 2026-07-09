// The crawl's raw-payload store — the native half of persist.js's raw-json
// write (`keyPath(dataDir, 'raw-json', path, '.json')` + stage/promote): every
// fetched DocC JSON payload lands as `<dataDir>/raw-json/<key>.json`, bodied as
// `stableStringify(json)` — the SAME canonical bytes `raw_payload_hash` hashes
// in JS, and the bytes `Snapshot.embedRawPayloads` later packs (zstd) into
// `document_raw` so the release archive carries the payloads. Without this
// producer the snapshot's document_raw embedding had nothing to read — the
// ~0.9GB composition gap against the published release archives.
//
// Divergences from persist.js, both deliberate:
//   - No markdown render-cache twin (`markdown/<key>.md`): the native read path
//     renders on demand and `storage materialize` produces the tree when asked;
//     the snapshot never ships markdown either way.
//   - promote-with-backup collapses to write-temp + atomic rename: the JS
//     backup dance exists for interleaved writers, and the native crawl's file
//     writes are per-key-unique within a single process.

import ADJSONCore
import Foundation

public enum RawStore {
    /// `stableStringify(json)` of a fetched payload — parse + re-encode with the
    /// canonical options (compact, ECMA-262 numbers, sorted keys — the exact
    /// storage/files.js form Consolidate's minify also uses). nil for a payload
    /// that isn't JSON (flat sources' HTML/Markdown — JS's raw-json writer only
    /// ever sees DocC JSON) or fails to parse.
    public static func stableStringify(_ bytes: [UInt8]) -> String? {
        guard let first = bytes.first(where: { $0 != 0x20 && $0 != 0x09 && $0 != 0x0A && $0 != 0x0D }),
            first == 0x7B || first == 0x5B
        else { return nil }
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512)) else {
            return nil
        }
        guard
            let encoded = try? JSONValue(document.root)
                .encodedBytes(options: Consolidate.stableStringifyOptions)
        else { return nil }
        return String(decoding: encoded, as: UTF8.self)
    }

    /// Write `text` to `<dataDir>/raw-json/<key>.json` (the `storageKeyPath`
    /// mapping — long leaves truncate + SHA-1-tag exactly like the JS
    /// `safeFilename`). Atomic: temp-in-place + rename. Throws on any I/O
    /// failure — the caller treats it as the page's persist failing, matching
    /// persist.js's try/catch (a stranded raw file never pairs with a DB row).
    public static func writeRawJson(dataDir: String, key: String, text: String) throws {
        guard let path = Snapshot.rawJsonPath(dataDir: dataDir, key: key) else {
            throw RawStoreError.invalidKey(key)
        }
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let temp = "\(path).tmp-\(ProcessInfo.processInfo.processIdentifier)"
        try Data(text.utf8).write(to: URL(fileURLWithPath: temp))
        do {
            // rename(2) semantics: atomically replaces an existing destination.
            if FileManager.default.fileExists(atPath: path) {
                _ = try FileManager.default.replaceItemAt(
                    URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: temp))
            } else {
                try FileManager.default.moveItem(atPath: temp, toPath: path)
            }
        } catch {
            try? FileManager.default.removeItem(atPath: temp)
            throw error
        }
    }

    public enum RawStoreError: Error, CustomStringConvertible {
        case invalidKey(String)
        public var description: String {
            switch self {
                case .invalidKey(let key): return "raw store: invalid storage key '\(key)'"
            }
        }
    }
}
