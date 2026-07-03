import Testing

@testable import ADOps

// Unit coverage for the allowlist `${VAR}` substitution — the JS
// `renderTemplateString` semantics (ops/lib/render-template.js): allowlisted +
// present → value; allowlisted + empty/absent → `unresolved` + verbatim
// placeholder; not allowlisted → `ignored` + verbatim placeholder.

private let testEnv: [String: String] = [
    "USER_NAME": "everest", "REPO_DIR": "/repo", "APPLE_DOCS_NATIVE": "",
    "WEB_PORT": "3030"
]

private func rendered(_ template: String) -> RenderResult {
    RenderTemplate.render(template, env: testEnv, allowed: allowedVarsSet)
}

@Test func substitutesAllowlistedPresentVar() {
    let result = rendered("user=${USER_NAME} port=${WEB_PORT}")
    #expect(result.content == "user=everest port=3030")
    #expect(result.unresolved.isEmpty)
    #expect(result.ignored.isEmpty)
}

@Test func allowlistedButEmptyPassesThroughAndReportsUnresolved() {
    let result = rendered("native=${APPLE_DOCS_NATIVE}")
    #expect(result.content == "native=${APPLE_DOCS_NATIVE}")
    #expect(result.unresolved == ["APPLE_DOCS_NATIVE"])
    #expect(result.ignored.isEmpty)
}

@Test func allowlistedButAbsentPassesThroughAndReportsUnresolved() {
    // DATA_DIR is allowlisted but not in testEnv.
    let result = rendered("dir=${DATA_DIR}")
    #expect(result.content == "dir=${DATA_DIR}")
    #expect(result.unresolved == ["DATA_DIR"])
}

@Test func nonAllowlistedPassesThroughAndReportsIgnored() {
    let result = rendered("shell=${SOMETHING_ELSE} home=${HOME}")
    #expect(result.content == "shell=${SOMETHING_ELSE} home=${HOME}")
    #expect(result.ignored == ["SOMETHING_ELSE", "HOME"])
    #expect(result.unresolved.isEmpty)
}

@Test func deduplicatesUnresolvedAndIgnoredPreservingOrder() {
    let result = rendered("${DATA_DIR} ${HOME} ${DATA_DIR} ${HOME} ${MCP_PORT}")
    #expect(result.unresolved == ["DATA_DIR", "MCP_PORT"])
    #expect(result.ignored == ["HOME"])
}

@Test func malformedPlaceholdersStayLiteral() {
    // Digit-first ident, hyphen, dangling brace, bare $ — none match the regex.
    let cases = ["${123}", "${A-B}", "${", "$FOO", "${}", "a ${ b }"]
    for input in cases {
        let result = rendered(input)
        #expect(result.content == input, "expected \(input) to stay literal")
        #expect(result.unresolved.isEmpty)
        #expect(result.ignored.isEmpty)
    }
}

@Test func doubleDollarKeepsLeadingDollar() {
    // `$${USER_NAME}` — the regex matches `${USER_NAME}` at offset 1.
    let result = rendered("$${USER_NAME}")
    #expect(result.content == "$everest")
}

@Test func adjacentPlaceholders() {
    let result = rendered("${USER_NAME}${WEB_PORT}")
    #expect(result.content == "everest3030")
}

@Test func multiByteUtf8PassesThroughByteExact() {
    // An em-dash + non-ASCII around a placeholder must survive byte-for-byte.
    let template = "— ${USER_NAME} café ✓"
    let result = RenderTemplate.render(template, env: testEnv, allowed: allowedVarsSet)
    #expect(result.contentBytes == Array("— everest café ✓".utf8))
}

@Test func customAllowlistIsHonored() {
    // A key not on the default allowlist can be enabled via an explicit set.
    let result = RenderTemplate.render(
        "x=${CUSTOM}", env: ["CUSTOM": "yes"], allowed: ["CUSTOM"])
    #expect(result.content == "x=yes")
    #expect(result.ignored.isEmpty)
}

@Test func allowlistOrderAndContentsMatchJS() {
    // The exact ALLOWED_VARS list from render-template.js.
    #expect(allowedVars.count == 30)
    #expect(allowedVars.first == "USER_NAME")
    #expect(allowedVars.contains("APPLE_DOCS_NATIVE"))
    #expect(allowedVars.contains("CLOUDFLARED_BIN"))
    #expect(!allowedVars.contains("SNAPSHOT_CHANNEL"))  // derived, not allowlisted
}
