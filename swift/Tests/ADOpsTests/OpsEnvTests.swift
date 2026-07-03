import Foundation
import Testing

@testable import ADOps

// Unit coverage for the .env loader/derivation (ops/lib/env.js): parse, derive,
// the mode/owner policy checks, and a full-bag parity check against the JS
// `applyDerived` output pinned in Fixtures/derived-vars.json.

// MARK: - parse

@Test func parseBasicPairsSkippingCommentsAndBlanks() {
    let text = """
        # a comment
        USER_NAME=everest

          REPO_DIR=/repo
        # trailing
        """
    let vars = OpsEnv.parse(text)
    #expect(vars["USER_NAME"] == "everest")
    #expect(vars["REPO_DIR"] == "/repo")
    #expect(vars.count == 2)
}

@Test func parseStripsMatchedOuterQuotes() {
    let vars = OpsEnv.parse(
        """
        A="double"
        B='single'
        C="mismatched'
        D=bare
        """)
    #expect(vars["A"] == "double")
    #expect(vars["B"] == "single")
    #expect(vars["C"] == "\"mismatched'")  // not a matched pair → kept
    #expect(vars["D"] == "bare")
}

@Test func parseKeepsEqualsInValueAndSkipsInvalid() {
    let vars = OpsEnv.parse(
        """
        CADDY_ADMIN_ADDR=127.0.0.1:2019
        URL=http://x/y?a=b&c=d
        =leadingEquals
        1BAD=x
        good_KEY9=ok
        """)
    #expect(vars["CADDY_ADMIN_ADDR"] == "127.0.0.1:2019")
    #expect(vars["URL"] == "http://x/y?a=b&c=d")
    #expect(vars["good_KEY9"] == "ok")
    #expect(vars["1BAD"] == nil)  // invalid identifier
    #expect(vars.count == 3)
}

// MARK: - derive

@Test func deriveLabelsFromPrefix() throws {
    var vars = ["LABEL_PREFIX": "mt.everest.apple-docs", "REPO_DIR": "/repo"]
    try OpsEnv.applyDerived(&vars)
    #expect(vars["LABEL_PROXY"] == "mt.everest.apple-docs.proxy")
    #expect(vars["LABEL_WEB"] == "mt.everest.apple-docs.web")
    #expect(vars["LABEL_MCP"] == "mt.everest.apple-docs.mcp")
    #expect(vars["LABEL_TUNNEL_WEB"] == "mt.everest.apple-docs.cloudflared.web")
    #expect(vars["LABEL_TUNNEL_MCP"] == "mt.everest.apple-docs.cloudflared.mcp")
    #expect(vars["LABEL_WATCHDOG"] == "mt.everest.apple-docs.watchdog")
    #expect(vars["LABEL_AUTOROLL"] == "mt.everest.apple-docs.autoroll")
}

@Test func deriveDefaults() throws {
    var vars = ["LABEL_PREFIX": "p", "REPO_DIR": "/repo"]
    try OpsEnv.applyDerived(&vars)
    #expect(vars["AUTOROLL_WEEKDAY"] == "0")
    #expect(vars["AUTOROLL_HOUR"] == "14")
    #expect(vars["STATIC_DIR"] == "/repo/dist/web")
    #expect(vars["APPLE_DOCS_MCP_CACHE_SCALE"] == "1")
    #expect(vars["APPLE_DOCS_NATIVE"] == "")
    #expect(vars["LEGACY_LAUNCHD_LABELS"] == "")
    #expect(vars["SNAPSHOT_CHANNEL"] == "stable")
}

@Test func deriveHonorsOverrides() throws {
    var vars = [
        "LABEL_PREFIX": "p", "REPO_DIR": "/repo", "STATIC_DIR": "/custom",
        "AUTOROLL_HOUR": "4", "SNAPSHOT_CHANNEL": "beta", "APPLE_DOCS_NATIVE": "fusion,embed"
    ]
    try OpsEnv.applyDerived(&vars)
    #expect(vars["STATIC_DIR"] == "/custom")
    #expect(vars["AUTOROLL_HOUR"] == "4")
    #expect(vars["SNAPSHOT_CHANNEL"] == "beta")
    #expect(vars["APPLE_DOCS_NATIVE"] == "fusion,embed")
}

@Test func deriveRejectsBadChannel() {
    var vars = ["LABEL_PREFIX": "p", "REPO_DIR": "/repo", "SNAPSHOT_CHANNEL": "nightly"]
    #expect(throws: EnvLoadError.self) { try OpsEnv.applyDerived(&vars) }
}

@Test func validateRequiredListsMissing() {
    let error = #expect(throws: EnvLoadError.self) {
        try OpsEnv.validateRequired(["USER_NAME": "x"], envPath: "/ops/.env")
    }
    #expect(error?.code == .missingRequired)
    #expect(error?.message.contains("REPO_DIR") ?? false)
}

// MARK: - full-bag parity with the JS oracle

@Test func deriveMatchesJSOracleFullBag() throws {
    var vars = OpsEnv.parse(Fixtures.text("fixture.env"))
    try OpsEnv.applyDerived(&vars)
    let expected = oracleDerivedVars()
    #expect(vars == expected)
}

/// Fixtures/derived-vars.json → [String: String] (the JS `env.vars`).
private func oracleDerivedVars() -> [String: String] {
    let data = Data(Fixtures.bytes("derived-vars.json"))
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] else {
        fatalError("derived-vars.json is not a flat string map")
    }
    return object
}

// MARK: - load policy checks (injected deps)

private let goodEnvText = Fixtures.text("fixture.env")

private func depsReturning(mode: UInt32, uid: UInt32, myUid: UInt32, sudo: String? = nil)
    -> OpsEnv.Deps
{
    OpsEnv.Deps(
        readFile: { _ in goodEnvText },
        stat: { _ in OpsEnv.FileFacts(mode: mode, uid: uid) },
        currentUid: { myUid },
        currentUser: { "tester" },
        sudoUid: { sudo })
}

@Test func loadHappyPath() throws {
    let env = try OpsEnv.load(
        opsDir: "/opt/apple-docs/ops", path: "/opt/apple-docs/ops/.env",
        deps: depsReturning(mode: 0o600, uid: 501, myUid: 501))
    #expect(env.opsDir == "/opt/apple-docs/ops")
    #expect(env.labels.web == "mt.everest.apple-docs.web")
    #expect(env.repoDir == "/Users/everest/Developer/apple-docs")
    #expect(env.bunBin == "/Users/everest/.bun/bin/bun")
    #expect(env.staticDir == "/Users/everest/Developer/apple-docs/dist/web")
}

@Test func loadRejectsWrongOwner() {
    let error = #expect(throws: EnvLoadError.self) {
        try OpsEnv.load(
            opsDir: "/ops", path: "/ops/.env",
            deps: depsReturning(mode: 0o600, uid: 999, myUid: 501))
    }
    #expect(error?.code == .wrongOwner)
    #expect(error?.exitCode == 78)
}

@Test func loadAcceptsSudoOwner() throws {
    // Running as root (uid 0) with SUDO_UID=501 accepts a .env owned by 501.
    let env = try OpsEnv.load(
        opsDir: "/ops", path: "/ops/.env",
        deps: depsReturning(mode: 0o600, uid: 501, myUid: 0, sudo: "501"))
    #expect(env.labels.mcp == "mt.everest.apple-docs.mcp")
}

@Test func loadRejectsWrongMode() {
    let error = #expect(throws: EnvLoadError.self) {
        try OpsEnv.load(
            opsDir: "/ops", path: "/ops/.env",
            deps: depsReturning(mode: 0o644, uid: 501, myUid: 501))
    }
    #expect(error?.code == .wrongMode)
    #expect(error?.message.contains("0644") ?? false)
}

@Test func loadSkipChecksBypassesOwnerAndMode() throws {
    // The test-only escape hatches used by the fixture generator.
    let env = try OpsEnv.load(
        opsDir: "/ops", path: "/ops/.env", skipOwnerCheck: true, skipModeCheck: true,
        deps: depsReturning(mode: 0o777, uid: 999, myUid: 501))
    #expect(env.labels.proxy == "mt.everest.apple-docs.proxy")
}

@Test func loadMissingFileThrowsMissing() {
    let deps = OpsEnv.Deps(
        readFile: { _ in "" },
        stat: { _ in throw OpsIOError("nope") },
        currentUid: { 501 }, currentUser: { "tester" }, sudoUid: { nil })
    let error = #expect(throws: EnvLoadError.self) {
        try OpsEnv.load(opsDir: "/ops", path: "/ops/.env", deps: deps)
    }
    #expect(error?.code == .missing)
}
