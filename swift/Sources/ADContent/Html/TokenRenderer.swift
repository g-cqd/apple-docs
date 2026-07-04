// Declaration / type-token → HTML rendering — native port of
// `src/content/render-html/tokens.js`. Walks the DocC `tokens` array (semantic
// kind + text + optional `_resolvedKey` type link) and emits semantic spans.

import ADBase
import ADJSONCore

enum HtmlTokens {
    static let semanticKinds: Set<String> = [
        "keyword", "attribute", "typeIdentifier", "identifier",
        "genericParameter", "externalParam", "internalParam", "number"
    ]

    /// Join token texts, inserting a space between adjacent semantic tokens that
    /// lack whitespace (but not after `@`). Port of `joinTokenTexts`.
    static func joinTokenTexts(_ tokens: JSON?) -> String {
        var result = ""
        var prevWasSemantic = false
        var prevText = ""
        forEach(tokens) { t in
            let text = coerce(t.member("text"))
            if text.isEmpty { return }
            let isSemantic = semanticKinds.contains(kind(t))
            if isSemantic && prevWasSemantic && !prevText.hasSuffix("@") { result += " " }
            prevWasSemantic = isSemantic
            prevText = text
            result += text
        }
        return result
    }

    /// Render declaration tokens with semantic CSS classes + per-type links.
    /// Port of `renderDeclarationTokens`.
    static func renderDeclarationTokens(_ tokens: JSON?, _ knownKeys: Set<String>) -> String {
        var spans = ""
        var prevWasSemantic = false
        var prevTokenText = ""
        forEach(tokens) { token in
            let raw = coerce(token.member("text"))
            let text = RenderHelpers.escapeHtml(raw)
            if text.isEmpty { return }
            let k = kind(token)
            let isSemantic = semanticKinds.contains(k)
            if isSemantic && prevWasSemantic && !prevTokenText.hasSuffix("@") { spans += " " }
            prevWasSemantic = isSemantic
            prevTokenText = raw

            if let rk = token.member("_resolvedKey"), rk.isTruthy,
                k == "typeIdentifier" || k == "attribute"
            {
                let key = coerce(rk)
                if knownKeys.contains(key) {
                    spans +=
                        "<a href=\"/docs/\(RenderHelpers.escapeHtml(SafePath.safeWebDocKey(key)))/\" class=\"code-type-link\"><span class=\"decl-\(k)\">\(text)</span></a>"
                    return
                }
            }

            switch k {
                case "keyword", "attribute": spans += "<span class=\"decl-keyword\">\(text)</span>"
                case "typeIdentifier": spans += "<span class=\"decl-type\">\(text)</span>"
                case "identifier": spans += "<span class=\"decl-identifier\">\(text)</span>"
                case "genericParameter": spans += "<span class=\"decl-generic\">\(text)</span>"
                case "externalParam", "internalParam": spans += "<span class=\"decl-param\">\(text)</span>"
                case "number": spans += "<span class=\"decl-number\">\(text)</span>"
                default: spans += text
            }
        }
        return "<pre class=\"decl-tokens\"><code>\(spans)</code></pre>"
    }

    /// Render type tokens (properties / restParams / restResponses) with links.
    /// Port of `renderTypeTokens`. `knownKeys == nil` trusts every resolved key.
    static func renderTypeTokens(_ tokens: JSON?, _ knownKeys: Set<String>?) -> String {
        guard let tokens, tokens.isArray else { return "" }
        var out = ""
        tokens.forEachElement { token in
            let text = RenderHelpers.escapeHtml(coerce(token.member("text")))
            if text.isEmpty { return }
            let isType = token.member("kind")?.utf8Equals("typeIdentifier") ?? false
            if isType, let rk = token.member("_resolvedKey"), rk.isTruthy {
                let key = coerce(rk)
                if knownKeys == nil || knownKeys!.contains(key) {
                    out +=
                        "<a href=\"/docs/\(RenderHelpers.escapeHtml(SafePath.safeWebDocKey(key)))/\" class=\"code-type-link\"><code>\(text)</code></a>"
                    return
                }
            }
            if isType {
                out += "<code>\(text)</code>"
                return
            }
            out += text
        }
        return out
    }

    // MARK: - helpers

    private static func kind(_ token: JSON) -> String { token.member("kind")?.string ?? "text" }

    private static func coerce(_ node: JSON?) -> String {
        guard let node, !node.isNull else { return "" }
        return node.string ?? node.jsString
    }

    private static func forEach(_ node: JSON?, _ body: (JSON) -> Void) {
        guard let node, node.isArray else { return }
        node.forEachElement(body)
    }
}
