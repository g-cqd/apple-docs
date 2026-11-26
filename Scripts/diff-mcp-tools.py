#!/usr/bin/env python3
"""Differential check of MCP tool outputs: the Bun server vs the Swift server over the same corpus.

Usage:
  diff-mcp-tools.py --bun "bun /path/to/apple-docs/cli.js mcp start" \
                    --swift ".build/debug/apple-docs mcp stdio --db /tmp/v1.db" [--cases cases.json] [--only NAME]

Each case is {"name", "tool", "arguments"}; both servers receive `initialize`, `notifications/initialized`, then
every `tools/call` over stdio. Text payloads that parse as JSON are compared structurally, others verbatim.
Prints a per-case verdict and a unified diff for mismatches; exits 1 when any case differs.
"""

import argparse
import difflib
import json
import select
import shlex
import subprocess
import sys

DEFAULT_CASES = [
    {"name": "read_doc path", "tool": "read_doc", "arguments": {"path": "compression/algorithm"}},
    {"name": "read_doc function", "tool": "read_doc",
     "arguments": {"path": "compression/compression_decode_buffer(_:_:_:_:_:_:)"}},
    {"name": "read_doc article", "tool": "read_doc", "arguments": {"path": "swiftui/managing-model-data-in-your-app"}},
    {"name": "read_doc symbol", "tool": "read_doc", "arguments": {"symbol": "NavigationStack"}},
    {"name": "read_doc section", "tool": "read_doc", "arguments": {"path": "swiftui/navigationstack", "section": "Topics"}},
    {"name": "read_doc paginated", "tool": "read_doc",
     "arguments": {"path": "swiftui/navigationstack", "maxChars": 1000, "page": 2}},
    {"name": "read_doc match", "tool": "read_doc",
     "arguments": {"path": "swiftui/navigationstack", "match": {"query": "path", "max": 3}}},
    {"name": "read_doc missing", "tool": "read_doc", "arguments": {"path": "nope/missing"}},
    {"name": "search_docs", "tool": "search_docs", "arguments": {"query": "NavigationStack", "limit": 5}},
    {"name": "search_docs framework", "tool": "search_docs",
     "arguments": {"query": "compression algorithm", "framework": "compression", "limit": 5}},
    {"name": "list_frameworks kind", "tool": "list_frameworks", "arguments": {"kind": "design"}},
    {"name": "browse", "tool": "browse", "arguments": {"framework": "compression", "limit": 10}},
    {"name": "list_taxonomy", "tool": "list_taxonomy", "arguments": {"field": "role"}},
    {"name": "search_sf_symbols", "tool": "search_sf_symbols", "arguments": {"query": "star.fill", "limit": 3}},
    {"name": "list_apple_fonts", "tool": "list_apple_fonts", "arguments": {}},
    {"name": "render_sf_symbol svg", "tool": "render_sf_symbol", "arguments": {"name": "star.fill", "format": "svg"}},
]


def call_server(command, cases):
    messages = [
        {"jsonrpc": "2.0", "id": 0, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "diff", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
    ]
    for index, case in enumerate(cases, start=1):
        messages.append({"jsonrpc": "2.0", "id": index, "method": "tools/call",
                         "params": {"name": case["tool"], "arguments": case["arguments"]}})
    process = subprocess.Popen(shlex.split(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    responses = {}
    for message in messages:
        process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()
        if "id" not in message:
            continue
        while True:
            ready, _, _ = select.select([process.stdout], [], [], 60)
            if not ready:
                print(f"timeout waiting for reply {message['id']} from {command}", file=sys.stderr)
                break
            line = process.stdout.readline()
            if not line:
                break
            try:
                reply = json.loads(line)
            except ValueError:
                continue
            if reply.get("id") == message["id"]:
                responses[message["id"]] = reply
                break
    process.stdin.close()
    process.terminate()
    return responses


def payload(reply):
    if reply is None:
        return ("<no reply>",)
    if "error" in reply:
        return {"error": reply["error"].get("message")}
    content = reply.get("result", {}).get("content", [])
    texts = [item.get("text", "") for item in content if item.get("type") == "text"]
    text = "\n".join(texts)
    try:
        return json.loads(text)
    except ValueError:
        return text


def render(value):
    return json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) if not isinstance(value, str) else value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--swift", required=True)
    parser.add_argument("--cases")
    parser.add_argument("--only")
    parser.add_argument("--context", type=int, default=2)
    args = parser.parse_args()
    cases = json.load(open(args.cases)) if args.cases else DEFAULT_CASES
    if args.only:
        cases = [case for case in cases if args.only in case["name"]]
    bun, swift = call_server(args.bun, cases), call_server(args.swift, cases)
    failures = 0
    for index, case in enumerate(cases, start=1):
        expected, actual = payload(bun.get(index)), payload(swift.get(index))
        if expected == actual:
            print(f"ok    {case['name']}")
            continue
        failures += 1
        print(f"DIFF  {case['name']}")
        diff = difflib.unified_diff(render(expected).splitlines(), render(actual).splitlines(),
                                    "bun", "swift", lineterm="", n=args.context)
        for line in list(diff)[:80]:
            print("      " + line[:220])
    print(f"{len(cases) - failures}/{len(cases)} cases identical")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
