// The `sf_symbol_renders.cache_key` for one exact SF-Symbol render request. Both the offline bulk
// bake (`ad-cli resources prerender-symbols`, Sources/ADCLI/ResourcesPrerenderSymbols.swift) and the
// `render_sf_symbol` MCP handler's disk-cache-first check (Sources/ADServer/Tools.swift) must
// compute this IDENTICALLY, or a cache hit never occurs. Mirrors the JS `renderSfSymbol`'s
// cache-key field set — renderer version, scope, name, format, pointSize, weight, scale, color,
// background (src/resources/apple-symbols/render.js) — but hashes with FNV-1a/64, the codebase's
// existing stable-string-hash idiom (see `SymbolPdfToSvg+SvgEmit.swift`'s mask-id hash,
// `ADEmbed/Vocab.swift`'s table hash, `ADBuilder/URLSessionHTTPClient.swift`'s pool-selection hash),
// rather than JS's `sha256(JSON.stringify(...))`. This is an INTERNAL cache index: nothing reads
// `cache_key` cross-runtime, so byte parity with the JS hash isn't required, only internal
// (writer == reader) consistency.
import Foundation

public enum SymbolRenderCacheKey {
    /// Folded into every key. Bump to invalidate every existing `sf_symbol_renders` row after a
    /// change to `SymbolPdf`/`SymbolPdfToSvg` output — the Swift-side twin of JS's
    /// `SYMBOL_RENDERER_VERSION` cache-busting discipline (an independent counter; the two
    /// runtimes never share a cache).
    public static let version = 1

    /// The full parameter set one render request is keyed on — bundled into a struct (rather than
    /// an 8-parameter `compute` overload) to stay under the family's `function_parameter_count`
    /// metric gate.
    public struct Request: Sendable {
        public var scope: String
        public var name: String
        public var format: String
        public var pointSize: Int
        public var weight: String
        public var scale: String
        public var color: String
        public var background: String?

        // `pointSize` defaults to the prerender bake's own baseline (`SYMBOL_DEFAULT_RENDER_SIZE`,
        // matching `SymbolPdfToSvg.Options`'s identical default) so this init's non-defaulted
        // parameter count (scope, name, format, weight, scale, color) stays at the family's
        // `function_parameter_count` metric ceiling; every current caller still passes it explicitly.
        public init(
            scope: String, name: String, format: String, weight: String, scale: String, color: String,
            pointSize: Int = 128, background: String? = nil
        ) {
            self.scope = scope
            self.name = name
            self.format = format
            self.pointSize = pointSize
            self.weight = weight
            self.scale = scale
            self.color = color
            self.background = background
        }
    }

    /// The deterministic key for one render request. Two calls with identical fields always
    /// produce the identical key; `background` folds in as the empty string when nil (never
    /// collides with a real value, which always starts with `#`).
    public static func compute(_ request: Request) -> String {
        let key =
            "sf-symbol-render|v\(version)|\(request.scope)|\(request.name)|\(request.format)|\(request.pointSize)|\(request.weight)|\(request.scale)|\(request.color)|\(request.background ?? "")"
        return fnv1a64Hex(key)
    }

    // Standard 64-bit FNV-1a constants (offset basis / prime), written so the value is verifiable
    // by inspection rather than by hex-digit-grouping (a neighboring FNV-64 constant in this family
    // — ADEmbed/Vocab.swift's `fnvPrime` — is mis-grouped by two digits; decimal sidesteps the whole
    // transcription-risk class for the prime here).
    private static let fnvOffsetBasis: UInt64 = 0xCBF2_9CE4_8422_2325
    private static let fnvPrime: UInt64 = 1_099_511_628_211

    /// FNV-1a, 64-bit, over the UTF-8 bytes, formatted as 16 lowercase hex chars.
    private static func fnv1a64Hex(_ string: String) -> String {
        var hash = fnvOffsetBasis
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* fnvPrime
        }
        return String(format: "%016llx", hash)
    }
}
