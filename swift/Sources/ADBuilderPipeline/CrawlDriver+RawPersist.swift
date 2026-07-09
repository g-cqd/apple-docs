// The raw-payload persist half of the crawl's fetch path — split from
// CrawlDriver.swift purely for type-body-length; see RawStore.swift for the
// store's contract and the deliberate divergences from persist.js.

import ADBuilder
import ADWrite

extension CrawlDriver {
    /// The raw-payload persist + hash, shared by the flat and BFS fetch paths. A JSON
    /// payload is canonicalized via `RawStore.stableStringify` — the SAME bytes JS's
    /// `rawPayloadHash = sha256(stableStringify(json))` hashes AND writes as the
    /// `raw-json/<key>.json` body (closing the header's long-noted raw-hash
    /// divergence: the native hash previously covered the raw upstream bytes). A
    /// non-JSON payload (flat sources' HTML/Markdown) hashes its raw bytes as before
    /// and writes no file — matching the JS raw store, which only ever sees DocC
    /// JSON. A raw-file WRITE failure throws → the page fails, exactly like
    /// persist.js's promote try/catch (a DB row never lands without its raw twin).
    static func persistRaw(_ payload: SourcePayload, key: String, dataDir: String?) throws -> String {
        guard let text = RawStore.stableStringify(rawBytes(payload)) else {
            return sha256Hex(rawBytes(payload))
        }
        if let dataDir {
            try RawStore.writeRawJson(dataDir: dataDir, key: key, text: text)
        }
        return sha256Hex(Array(text.utf8))
    }
}
