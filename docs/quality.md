# Quality Gates & Engineering Standards

Every rule below is enforced automatically by the compiler, `swift test`, `Scripts/check-layers.py`, or `.ci/swift-ci run quality`.

| Gate | Standard | Enforced by |
|---|---|---|
| Swift language & safety mode | Swift 6.4.2, `.swiftLanguageMode(.v6)`, `StrictMemorySafety`, `ExistentialAny`, `InferIsolatedConformances`, `InternalImportsByDefault`, `MemberImportVisibility`, `.treatAllWarnings(as: .error)` | `Package.swift`, `.swift-version`, `.ci/action.json` |
| Formatting | Canonical g-cqd `.swift-format` (120 cols, 4 spaces, `NeverForceUnwrap`, `NeverUseForceTry`, `NeverUseImplicitlyUnwrappedOptionals`) | `swift format lint --strict` via `swift-ci` |
| Metrics & crash bans | File ≤ 300/500, type ≤ 200/400, function ≤ 60/80, cyclomatic ≤ 10/15, tuples ≤ 3, params ≤ 6, nesting ≤ 3/5; zero `!`, `try!`, `as!`, IUO, `unowned`, message-less `fatalError` | `.swiftlint.yml` via `swift-ci` |
| Source structure | At most **one** non-`private`/non-`fileprivate` top-level type per file named after it (`Type.swift` / `Type+Feature.swift`); only `private`/`fileprivate` supporting types in the same file; ≤ 250 lines per file across `Sources/` and `Tests/` | `SourceStructureTests` (`swift test`) |
| Banned APIs & Darwin isolation | Zero GCD (`DispatchQueue`, `DispatchSource`, `DispatchSemaphore`, …); zero `Task.sleep`/`Thread.sleep`/`usleep` in tests; zero macOS UI/CoreText/AppKit imports outside `AppleDocsSetupDarwin` | `BannedAPITests` (`swift test`) |
| Static analyzers | Unused code (`deadwood`), structural clones (`dolly`), ARC retain cycles (`arcleak`), resource/durable-write obligations (`fcheck`), concurrency/model checks (`modeler`) | `swift-ci` (`quality.analyzers`) |
| Discipline rules | No `strtod`, no inline test PRNGs, typed `#expect(throws:)` errors, no wall-clock test assertions | `swift-ci` (`quality.discipline`) |
| Mutation testing | Isolated copy workspace (`litmus`) on core domain, output projection, storage, and search targets | `swift-ci` (`mutation` command, nightly/dispatch & local) |
| Target layering & declared deps | Strict DAG preventing upward edges, cross-surface coupling, or Darwin leaks; every target imports only declared dependencies | `Scripts/check-layers.py`, `Scripts/test-layers.py`, `Scripts/dependency-audit.sh` |
| Workflow security | 40-char SHA-pinned actions, minimal `permissions`, zero injection vectors | `actionlint`, `zizmor --offline --persona=pedantic` |
