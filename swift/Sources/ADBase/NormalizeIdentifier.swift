// normalizeIdentifier (apple/normalizer.js) — THE canonical identifier
// normalization, shared by the render pipeline (ADContent link resolution),
// the read path (ADStorage read_doc retry, ad-server tools/resources, ad-cli
// read), and the static build. Extracted here (WS-H) from the two hand-mirrored
// copies in ADContent and ADStorage so serve/build/CLI cannot drift.
//
// Foundation-free: stdlib + ADFUnicode's engine-derived case tables only.

import ADFUnicode

public enum Identifier {
    /// Canonicalize a pasted identifier — strip doc:// URIs, /documentation/
    /// and documentation/ prefixes (keeping design/ and app-store-review/
    /// namespaces), JS-toLowerCase, trim trailing slashes and any #fragment —
    /// returning nil for non-page identifiers (full URLs, Swift operator
    /// segments, empty segments).
    public static func normalize(_ raw: String?) -> String? {
        guard var id = raw, !id.isEmpty else { return nil }

        // /^https?:\/\//
        if id.hasPrefix("http://") || id.hasPrefix("https://") { return nil }

        // /^doc:\/\/[^/]+\/documentation\/(.+)$/ then the design variant.
        if let rest = matchDocUri(id, segmentPrefix: "documentation/") {
            id = rest
        } else if let rest = matchDocUri(id, segmentPrefix: "design/") {
            id = "design/" + rest
        }

        if id.hasPrefix("/design/") || id.hasPrefix("/app-store-review/") {
            id = String(id.dropFirst())
        } else if id.hasPrefix("/documentation/") {
            id = String(id.dropFirst("/documentation/".count))
        }
        if id.hasPrefix("documentation/") {
            id = String(id.dropFirst("documentation/".count))
        }

        id = jsLowercase(id)

        // /\/+$/ strip
        while id.hasSuffix("/") { id = String(id.dropLast()) }

        // Fragment strip
        if let hash = id.firstIndex(of: "#") { id = String(id[..<hash]) }

        if id.isEmpty { return nil }

        // Segment rejections: dot-prefixed operator segments, empty segments.
        let operatorChars: Set<Character> = [".", "-", "+", "*", "/", "<", ">", "=", "!", "&", "|", "^", "~", "%", "_"]
        for segment in id.split(separator: "/", omittingEmptySubsequences: false) {
            if segment.isEmpty { return nil }
            if segment.first == "." {
                let second = segment.dropFirst().first
                if let second, operatorChars.contains(second) { return nil }
            }
        }
        return id
    }

    /// `doc://<authority-without-slash>/<prefix>(rest)` — for the design
    /// variant the prefix is kept.
    private static func matchDocUri(_ id: String, segmentPrefix: String) -> String? {
        guard id.hasPrefix("doc://") else { return nil }
        let afterScheme = id.dropFirst("doc://".count)
        guard let slash = afterScheme.firstIndex(of: "/") else { return nil }
        let authority = afterScheme[..<slash]
        guard !authority.isEmpty else { return nil }
        let path = afterScheme[afterScheme.index(after: slash)...]
        guard path.hasPrefix(segmentPrefix) else { return nil }
        let rest = path.dropFirst(segmentPrefix.count)
        guard !rest.isEmpty else { return nil }
        return String(rest)
    }

    /// JS toLowerCase (full Unicode incl. Final_Sigma) via the engine-derived
    /// tables — the same lowering ADContent's JsString.lowercase applies.
    /// Identifier-sized inputs only.
    private static func jsLowercase(_ text: String) -> String {
        let lowered = CaseFolding.lowercase(Array(text.unicodeScalars))
        var out = ""
        out.unicodeScalars.append(contentsOf: lowered)
        return out
    }
}
