import Testing

@testable import ADOps

// The Linux systemd analogue (RFC 0007 §4): ops/systemd/*.service.tpl render
// through the SAME allowlisted substitution as the macOS plists, drop `.tpl`
// (no launchd label mapping), and leave no unresolved `${...}` — every
// placeholder is an allowlisted primary/derived var. Expected bytes are produced
// by the shared render engine (the generic substitution oracle) and pinned.

private let systemdUnits = ["apple-docs-web.service", "apple-docs-mcp.service"]

private func fixtureEnvVars() throws -> [String: String] {
    var vars = OpsEnv.parse(Fixtures.text("fixture.env"))
    try OpsEnv.applyDerived(&vars)
    return vars
}

@Test func systemdUnitsRenderWithNoLeftoverPlaceholders() throws {
    let vars = try fixtureEnvVars()
    for unit in systemdUnits {
        let template = Fixtures.bytes("systemd/\(unit).tpl")
        let expected = Fixtures.bytes("systemd/\(unit)")
        let result = RenderTemplate.render(bytes: template, env: vars, allowed: allowedVarsSet)
        #expect(result.contentBytes == expected, "byte mismatch rendering \(unit)")
        #expect(result.unresolved.isEmpty, "systemd unit \(unit) has unresolved vars")
        #expect(result.ignored.isEmpty, "systemd unit \(unit) has ignored placeholders")
        // No leftover ${...} in the rendered unit.
        #expect(!result.content.contains("${"), "\(unit) still contains a ${ placeholder")
    }
}

@Test func systemdOutputDropsTplSuffixWithoutLaunchdMapping() throws {
    let opsDir = "/opt/apple-docs/ops"
    for unit in systemdUnits {
        let template = "\(opsDir)/systemd/\(unit).tpl"
        let resolved = RenderAll.resolveOutput(template: template, opsDir: opsDir, vars: [:])
        #expect(resolved == "\(opsDir)/systemd/\(unit)")
    }
}

@Test func systemdUnitCarriesSubstitutedRuntimeValues() throws {
    let vars = try fixtureEnvVars()
    let web = RenderTemplate.render(
        bytes: Fixtures.bytes("systemd/apple-docs-web.service.tpl"), env: vars,
        allowed: allowedVarsSet)
    let text = web.content
    // Spot-check the key substitutions land in the ExecStart / labels.
    #expect(text.contains("Description=apple-docs web server (mt.everest.apple-docs.web)"))
    #expect(text.contains("--port 3130"))
    #expect(text.contains("User=everest"))
    #expect(text.contains("https://apple-docs.example.com"))
}
