# Security Policy

> The full security policy lives in
> [`docs/security.md`](docs/security.md) (rendered at
> `https://apple-docs.example.com/security` on a self-hosted docs site).
> This file is the GitHub-rendered stub for the contact channel.

## Reporting a vulnerability

If you discover a security issue in **apple-docs** (CLI, web server,
or MCP HTTP server), please report it privately rather than opening a
public issue.

**Preferred channel:** open a [GitHub private security advisory](https://github.com/g-cqd/apple-docs/security/advisories/new)
on this repository. GitHub notifies the maintainer; the discussion
stays private until a fix and disclosure timeline are agreed.

If GitHub advisories are unavailable to you, send an email to the
address listed under "Contact" on the GitHub profile of the repository
owner. Use PGP if you can; the maintainer will respond with a key on
first contact if the message is unencrypted.

Include in your report:

- A description of the vulnerability and its impact.
- Reproduction steps (a minimal proof-of-concept is ideal).
- The version (`apple-docs --version`) or commit SHA you observed it on.
- Any mitigations you've already identified.

The project aims to respond within **3 business days** with an
acknowledgement and an expected timeline. Coordinated disclosure is
preferred; the reporter is credited in the release notes unless they
ask otherwise.

## Where to read the rest

| Topic | See |
| --- | --- |
| Supported versions | [`docs/security.md` → Supported versions](docs/security.md#supported-versions) |
| In-scope and out-of-scope surfaces | [`docs/security.md` → Scope](docs/security.md#scope) |
| Hardened defaults (rate limits, body cap, origin policy, spawn deadlines, secret redaction, supply chain) | [`docs/security.md` → Hardened defaults](docs/security.md#hardened-defaults) |
