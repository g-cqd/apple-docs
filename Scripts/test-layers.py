#!/usr/bin/env python3
"""Self-tests for Scripts/check-layers.py."""
import importlib.util
import pathlib
import sys

SCRIPT = pathlib.Path(__file__).with_name("check-layers.py")
spec = importlib.util.spec_from_file_location("check_layers", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def make_pkg(targets):
    return {"targets": targets}


def reg(name, deps):
    return {"name": name, "type": "regular", "dependencies": [{"byName": [d, None]} for d in deps]}


def exe(name, deps):
    return {"name": name, "type": "executable", "dependencies": [{"byName": [d, None]} for d in deps]}


def run():
    clean = make_pkg([
        reg("AppleDocsCore", []),
        reg("AppleDocsOutput", ["AppleDocsCore"]),
        reg("AppleDocsCommands", ["AppleDocsCore", "AppleDocsOutput"]),
        reg("AppleDocsMCP", ["AppleDocsCommands", "AppleDocsCore", "AppleDocsOutput"]),
        reg("AppleDocsWeb", ["AppleDocsCommands", "AppleDocsCore", "AppleDocsOutput"]),
        exe("apple-docs", ["AppleDocsCommands", "AppleDocsMCP", "AppleDocsWeb"]),
    ])
    assert mod.violations(clean) == [], f"expected clean, got {mod.violations(clean)}"

    cross_surface = make_pkg([
        reg("AppleDocsCore", []),
        reg("AppleDocsMCP", ["AppleDocsWeb"]),
        reg("AppleDocsWeb", ["AppleDocsCore"]),
    ])
    v = mod.violations(cross_surface)
    assert len(v) == 1 and "AppleDocsWeb" in v[0], f"expected cross-surface violation, got {v}"

    darwin_leak = make_pkg([
        reg("AppleDocsCore", []),
        reg("AppleDocsSetupDarwin", ["AppleDocsCore"]),
        reg("AppleDocsStorage", ["AppleDocsCore", "AppleDocsSetupDarwin"]),
    ])
    v = mod.violations(darwin_leak)
    assert len(v) == 1 and "AppleDocsSetupDarwin" in v[0], f"expected darwin leak violation, got {v}"

    exe_dep = make_pkg([
        reg("AppleDocsCore", ["apple-docs"]),
        exe("apple-docs", []),
    ])
    v = mod.violations(exe_dep)
    assert any("executable apple-docs" in line for line in v), f"expected executable dep violation, got {v}"

    unknown = make_pkg([reg("RogueTarget", [])])
    v = mod.violations(unknown)
    assert len(v) == 1 and "undeclared target" in v[0], f"expected undeclared violation, got {v}"

    print("[OK] Scripts/test-layers.py")
    return 0


if __name__ == "__main__":
    sys.exit(run())
