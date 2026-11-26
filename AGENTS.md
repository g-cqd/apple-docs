# Working in `apple-docs` (Swift)

Cross-platform (macOS 15+ and Linux) Swift 6.4 CLI, MCP server, local website/SSG, and corpus setup toolchain for Apple developer documentation (`g-cqd/apple-docs`, `swift` branch).

## Engineering rules

- **Verify every claim with executable proof.** Red test first → minimal general green → refactor/simplify → security & performance gate.
- **Strict Swift 6.4.** Swift 6 language mode, `StrictMemorySafety`, `ExistentialAny`, `InferIsolatedConformances`, `InternalImportsByDefault`, `MemberImportVisibility`, warnings as errors.
- **One top-level type per file.** Each Swift file declares at most one non-`private`/non-`fileprivate` top-level type named after the file (or extensions of one type in `Type+Feature.swift`). Only `private`/`fileprivate` supporting types may share the file. Files stay at or under 250 lines (`SourceStructureTests`).
- **No GCD, no wall-clock sleeps, no force crashes.** Zero `!`, `try!`, `as!`, IUOs, `unowned`, `DispatchQueue`, or `Task.sleep` in tests (`BannedAPITests`, `.swiftlint.yml`, `.swift-format`).
- **Cross-platform runtime, Darwin-gated setup.** Every runtime/server target (`Core`, `Storage`, `Search`, `Content`, `Output`, `MCP`, `Web`, `Sources`, `Pipeline`, `Setup`) must build cleanly on both macOS and Linux. macOS-only authoring/extraction capabilities (CoreGlyphs, SF Symbols prerender, CoreText, DMG/hdiutil, local Xcode MobileAsset) live exclusively in `AppleDocsSetupDarwin` behind `#if os(macOS)`.
- **One public projection boundary.** Every CLI `--json`, MCP tool/resource, and Web `/api/*` payload routes through `AppleDocsOutput`.
- **Promote shared capabilities upstream.** When a capability belongs in `Aemi-Studio/aemi`, `g-cqd/HTTP`, `g-cqd/AemiSearch`, or another `g-cqd/Aemi*` package, evaluate promotion explicitly rather than duplicating infrastructure here.

## Commands

```sh
swift test
swift build -c release --product apple-docs
.ci/swift-ci run quality
python3 -B Scripts/check-layers.py && python3 -B Scripts/test-layers.py
```

## Documentation

- Architecture decision records: `docs/adr/`
- Quality gates reference: `docs/quality.md`
- Threat model & security invariants: `docs/threat-model.md`
