# Contributing to `apple-docs` (Swift)

## Requirements

- Swift **6.4.2** (`.swift-version`)
- macOS 15+ or Linux (Ubuntu 24.04+, x86_64 or arm64) with system `sqlite3` development headers (`libsqlite3-dev` on Ubuntu)

## Local verification gate

```sh
.ci/swift-ci local
python3 -B Scripts/check-layers.py && python3 -B Scripts/test-layers.py
```

`swift-ci` runs the exact pinned quality checks (swift-format, SwiftLint, `deadwood`, `dolly`, `arcleak`, `fcheck`, `modeler`, and `quality.discipline`) plus the test suite.

## Style and structure

- **TDD:** write a failing test first, verify it fails for the right reason, implement the minimal general fix, then simplify.
- **Source structure (`SourceStructureTests`):** one top-level non-private type per file matching the filename (`Type.swift` or `Type+Feature.swift`); only `private` or `fileprivate` supporting types in the same file; ≤ 250 lines per file across `Sources/` and `Tests/`.
- **Safety:** zero `!`, `try!`, `as!`, IUOs, `unowned` captures, or `DispatchQueue` usage.
- **Layering (`Scripts/check-layers.py`):** no upward edges, no cross-surface edges between CLI/MCP/Web, and no Darwin-only imports outside `AppleDocsSetupDarwin`.

## Commits

Keep commits atomic, focused on one behavior, and buildable. Never mix behavior changes with unrelated refactors.
