#!/usr/bin/env python3
"""Enforce the target dependency layering of ADR-0001 over Package.swift.

    python3 -B Scripts/check-layers.py
    python3 -B Scripts/check-layers.py PACKAGE.json

Every regular library target may depend only on the internal targets explicitly
listed in ALLOWED below. No target may depend on an executable. Upward edges,
cross-surface edges (CLI/MCP/Web depending on each other), or macOS-only setup
leaking into cross-platform runtime targets fail the build gate.
"""
import json
import subprocess
import sys

ALLOWED = {
    "CSQLite": set(),
    "AppleDocsCore": set(),
    "AppleDocsStorage": {"AppleDocsCore", "CSQLite"},
    "AppleDocsContent": {"AppleDocsCore"},
    "AppleDocsSearch": {"AppleDocsCore", "AppleDocsStorage"},
    "AppleDocsOutput": {"AppleDocsCore"},
    "AppleDocsSources": {"AppleDocsCore", "AppleDocsContent"},
    "AppleDocsPipeline": {
        "AppleDocsCore",
        "AppleDocsContent",
        "AppleDocsSearch",
        "AppleDocsSources",
        "AppleDocsStorage",
    },
    "AppleDocsSetup": {
        "AppleDocsCore",
        "AppleDocsPipeline",
        "AppleDocsSearch",
        "AppleDocsStorage",
    },
    "AppleDocsSetupDarwin": {
        "AppleDocsCore",
        "AppleDocsSetup",
        "AppleDocsStorage",
    },
    "AppleDocsCommands": {
        "AppleDocsContent",
        "AppleDocsCore",
        "AppleDocsOutput",
        "AppleDocsPipeline",
        "AppleDocsSearch",
        "AppleDocsSetup",
        "AppleDocsSetupDarwin",
        "AppleDocsStorage",
    },
    "AppleDocsMCP": {
        "AppleDocsCommands",
        "AppleDocsCore",
        "AppleDocsOutput",
        "AppleDocsSearch",
        "AppleDocsStorage",
    },
    "AppleDocsWeb": {
        "AppleDocsCommands",
        "AppleDocsContent",
        "AppleDocsCore",
        "AppleDocsOutput",
        "AppleDocsSearch",
        "AppleDocsStorage",
    },
    "AppleDocsTestSupport": {"AppleDocsCore"},
}


def internal_dependencies(target, names):
    for entry in target.get("dependencies", []):
        kind, value = next(iter(entry.items()))
        if kind in ("byName", "target") and value[0] in names:
            yield value[0]


def violations(package):
    targets = {target["name"]: target for target in package["targets"]}
    executables = {name for name, target in targets.items() if target["type"] == "executable"}
    found = []
    for name, target in sorted(targets.items()):
        dependencies = set(internal_dependencies(target, targets))
        for executable in sorted(dependencies & executables):
            found.append(f"{name} depends on executable {executable}: nothing may")
        if target["type"] in ("regular", "system"):
            if name not in ALLOWED:
                found.append(f"{name} is an undeclared target: register its allowed edges in Scripts/check-layers.py (ADR-0001)")
                continue
            for dependency in sorted(dependencies - ALLOWED[name]):
                found.append(f"{name} depends on {dependency}, which ADR-0001 layering forbids")
    return found


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as handle:
            package = json.load(handle)
    else:
        dump = subprocess.run(
            ["swift", "package", "dump-package"],
            check=True,
            capture_output=True,
            text=True,
        )
        package = json.loads(dump.stdout)
    found = violations(package)
    for line in found:
        print(f"[FAIL] {line}")
    if not found:
        print("[OK] target layering (ADR-0001)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
