import AppleDocsCore

/// `render_sf_symbol` result (Bun parity): the symbol identity, the rendered format, the `apple-docs://`
/// resource URI that serves the bytes, and the SVG markup inline for the `svg` format.
public struct PublicSymbolRender: Hashable, Sendable, Codable {
    public let name: String
    public let scope: String
    public let format: String
    public let resourceUri: String
    public let svg: String?

    public init(name: String, scope: String, format: String, svg: String?) {
        self.name = name
        self.scope = scope
        self.format = format
        // `encodeURIComponent` semantics: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded.
        let encodedName = PercentEncoding.encode(name) { byte in
            PercentEncoding.isAlphanumeric(byte) || "-_.!~*'()".utf8.contains(byte)
        }
        self.resourceUri = "apple-docs://sf-symbol/\(scope)/\(encodedName).\(format)"
        self.svg = svg
    }
}
