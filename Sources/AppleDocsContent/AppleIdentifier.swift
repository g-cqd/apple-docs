/// Canonical lowercase corpus path for an Apple documentation identifier — a port of Bun's
/// `apple/normalizer.js` `normalizeIdentifier`, kept byte-compatible so both pipelines derive the same keys.
///
/// Handles `doc://<bundle>/documentation/...`, `doc://<bundle>/design/...`, `/documentation/...`,
/// `/design/...`, `/app-store-review/...`, `documentation/...`, and mixed case; strips trailing slashes and
/// fragments; rejects absolute `http(s)` URLs, empty segments, and Swift operator segments (`.==`, `..<`).
public enum AppleIdentifier {
    public static func normalize(_ raw: String) -> String? {
        guard !raw.isEmpty, !raw.hasPrefix("http://"), !raw.hasPrefix("https://") else { return nil }
        var id = stripDocScheme(Substring(raw))
        if id.hasPrefix("/design/") || id.hasPrefix("/app-store-review/") {
            id = id.dropFirst()
        } else if id.hasPrefix("/documentation/") {
            id = id.dropFirst("/documentation/".count)
        }
        if id.hasPrefix("documentation/") { id = id.dropFirst("documentation/".count) }
        var lowered = id.lowercased()
        while lowered.hasSuffix("/") { lowered.removeLast() }
        if let hash = lowered.firstIndex(of: "#") { lowered = String(lowered[..<hash]) }
        guard !lowered.isEmpty else { return nil }
        for segment in lowered.split(separator: "/", omittingEmptySubsequences: false)
        where segment.isEmpty || isOperatorSegment(segment) {
            return nil
        }
        return lowered
    }

    /// `doc://<bundle>/documentation/<path>` → `<path>`; `doc://<bundle>/design/<path>` → `design/<path>`.
    private static func stripDocScheme(_ id: Substring) -> Substring {
        guard id.hasPrefix("doc://"), let slash = id.dropFirst("doc://".count).firstIndex(of: "/") else { return id }
        let rest = id[slash...]
        if rest.hasPrefix("/documentation/"), rest.count > "/documentation/".count {
            return rest.dropFirst("/documentation/".count)
        }
        if rest.hasPrefix("/design/"), rest.count > "/design/".count { return rest.dropFirst() }
        return id
    }

    /// `^\.[.\-+*/<>=!&|^~%_]`: a dot followed by an operator character.
    private static func isOperatorSegment(_ segment: Substring) -> Bool {
        guard segment.first == ".", let second = segment.dropFirst().first else { return false }
        return ".-+*/<>=!&|^~%_".contains(second)
    }
}
