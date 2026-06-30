// Web-template primitives — the `Bun.escapeHTML`-matching escaper the page
// templates use, plus the pure spine helpers from `src/web/templates.js`.
// NOTE: `escape` uses `&#x27;` for the apostrophe (Bun.escapeHTML), distinct
// from the content renderer's `&#39;`.

enum WebHtml {
    /// `Bun.escapeHTML` — escapes `& < > " '` (apostrophe as `&#x27;`). Single
    /// pass (byte-identical to Bun's per-char escape).
    static func escape(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.count)
        for ch in value {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#x27;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// `assetUrl(siteConfig, file)` — `<base>/assets/<file>` + optional `?v=`.
    static func assetUrl(_ config: SiteConfig, _ file: String) -> String {
        let base = "\(config.baseUrl)/assets/\(file)"
        guard let v = config.assetVersion, !v.isEmpty else { return base }
        return "\(base)?v=\(encodeURIComponent(v))"
    }

    /// `frameworkOriginalUrl(root)` — the upstream URL for a root/framework
    /// record (its `url`, else synthesized from `source_type` + `slug`).
    static func frameworkOriginalUrl(sourceType: String?, slug: String?, url: String?) -> String? {
        if let url, !url.isEmpty { return url }
        let slug = slug ?? ""
        switch sourceType {
        case "hig": return "https://developer.apple.com/design/human-interface-guidelines"
        case "guidelines": return "https://developer.apple.com/app-store/review/guidelines/"
        case "wwdc": return "https://developer.apple.com/videos/"
        case "sample-code": return "https://developer.apple.com/sample-code/"
        case "swift-evolution": return "https://www.swift.org/swift-evolution/"
        case "swift-book": return "https://docs.swift.org/swift-book/"
        case "swift-org": return "https://www.swift.org/"
        case "apple-archive": return "https://developer.apple.com/library/archive/"
        case "packages": return "https://swiftpackageindex.com/"
        default: return slug.isEmpty ? nil : "https://developer.apple.com/documentation/\(slug)"
        }
    }

    /// `encodeURIComponent` — keep `A-Za-z0-9-_.!~*'()`, percent-encode the rest (UTF-8).
    static func encodeURIComponent(_ s: String) -> String {
        let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let hex = Array("0123456789ABCDEF")
        var out = ""
        for ch in s {
            if unreserved.contains(ch) {
                out.append(ch)
            } else {
                for byte in String(ch).utf8 {
                    out.append("%")
                    out.append(hex[Int(byte >> 4)])
                    out.append(hex[Int(byte & 0x0F)])
                }
            }
        }
        return out
    }
}
