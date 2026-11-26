# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's **Report a vulnerability** button on the Security tab — never in public issues or pull requests.

Include:

- The `apple-docs` version (`apple-docs --version`) and OS/architecture.
- The surface affected (CLI, MCP stdio/HTTP, Web server/SSG, snapshot setup, or sync crawler).
- A minimal reproduction (command line, HTTP request, archive, or crafted upstream payload).

## Response targets

This is a solo-maintained open-source repository. Best-effort targets:

| Milestone | Target |
|---|---|
| Private acknowledgement | Within 7–14 days |
| Initial triage & severity confirmation | Within 30 days |
| Critical fix & advisory | Within 30 days |
| High fix & advisory | Within 60–90 days |
| Medium / Low fix | Next scheduled release |

## Hardened architecture

See [`docs/threat-model.md`](docs/threat-model.md) for the trust boundaries, input limits, archive/path canonicalization rules, rate limiting, secret redaction, and process isolation invariants enforced by regression tests.

## Release verification

Official tag releases are built in CI from pinned revisions (`Package.resolved`), Developer ID signed with Hardened Runtime and Apple-notarised on macOS, and shipped with SHA-256 checksums, CycloneDX SBOMs, and GitHub SLSA Build Provenance attestations (`gh attestation verify <asset> --owner g-cqd`).
