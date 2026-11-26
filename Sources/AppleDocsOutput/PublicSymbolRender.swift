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
        let encodedName = name.addingPercentEncodingForURIComponent()
        self.resourceUri = "apple-docs://sf-symbol/\(scope)/\(encodedName).\(format)"
        self.svg = svg
    }
}

extension String {
    /// `encodeURIComponent` semantics: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded.
    fileprivate func addingPercentEncodingForURIComponent() -> String {
        var out = ""
        for byte in utf8 {
            let isUnreserved =
                (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
                || "-_.!~*'()".utf8.contains(byte)
            if isUnreserved {
                out.unicodeScalars.append(Unicode.Scalar(byte))
            } else {
                let hex = String(byte, radix: 16, uppercase: true)
                out += "%" + (hex.count == 1 ? "0" + hex : hex)
            }
        }
        return out
    }
}
