#!/usr/bin/env python3
"""MCP latency benchmark: the Bun and Swift servers over stdio, same corpus, same tool calls.

Usage:
  Benchmarks/compare-bun-mcp.py --bun "bun ../apple-docs/cli.js mcp start" \
      --swift ".build/release/apple-docs mcp stdio --db /tmp/v1.db" [--rounds 200]

For each case, sends `rounds` sequential tools/call requests (after 10 warm-up calls) and reports p50/p90/p99
latency per server, plus each server's resident memory at the end (ps RSS). Requests are strictly sequential
(one in flight), so this measures per-call latency, not throughput.

Repeated cases hit both servers' tool-result caches; with --db, "cold" cases also read a different sampled page
(or query) per call, so every call misses the caches.
"""

import argparse
import json
import select
import random
import shlex
import sqlite3
import subprocess
import time

CASES = [
    ("read_doc", {"path": "swiftui/navigationstack"}),
    ("read_doc paginated", {"path": "swiftui/view", "maxChars": 4000, "page": 2}),
    ("read_doc symbol", {"symbol": "NavigationStack"}),
    ("search_docs", {"query": "navigation stack", "limit": 10}),
    ("browse", {"framework": "swiftui", "limit": 50}),
    ("search_sf_symbols", {"query": "star", "limit": 20}),
]


class Server:
    def __init__(self, command):
        self.process = subprocess.Popen(shlex.split(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.next_id = 0
        self.call({"jsonrpc": "2.0", "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "bench", "version": "1"}}})
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, message):
        self.next_id += 1
        message = dict(message, id=self.next_id)
        self.send(message)
        while True:
            ready, _, _ = select.select([self.process.stdout], [], [], 120)
            if not ready:
                raise TimeoutError("no reply")
            reply = json.loads(self.process.stdout.readline())
            if reply.get("id") == self.next_id:
                return reply

    def tool(self, name, arguments):
        return self.call({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": name, "arguments": arguments}})

    def rss_mib(self):
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(self.process.pid)], capture_output=True, text=True).stdout
        return int(out.strip() or 0) / 1024

    def close(self):
        self.process.stdin.close()
        self.process.terminate()


def percentile(samples, fraction):
    ordered = sorted(samples)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bun", required=True)
    parser.add_argument("--swift", required=True)
    parser.add_argument("--rounds", type=int, default=200)
    parser.add_argument("--db", help="corpus to sample cold (cache-missing) arguments from")
    args = parser.parse_args()
    cases = [(label, [arguments]) for label, arguments in CASES]
    if args.db:
        rng = random.Random(42)
        keys = [row[0] for row in sqlite3.connect(args.db).execute("SELECT key FROM documents")]
        titles = [row[0] for row in sqlite3.connect(args.db).execute("SELECT title FROM documents WHERE length(title) > 4")]
        sample = rng.sample(keys, args.rounds + 10)
        cases += [
            ("read_doc cold", [{"path": key} for key in sample]),
            ("read_doc paginated cold", [{"path": key, "maxChars": 2000} for key in sample]),
            ("search_docs cold", [{"query": title, "limit": 10} for title in rng.sample(titles, args.rounds + 10)]),
        ]
    servers = {"bun": Server(args.bun), "swift": Server(args.swift)}
    print(f"{'case':24} {'server':6} {'p50 ms':>8} {'p90 ms':>8} {'p99 ms':>8}")
    for label, variants in cases:
        name = label.split(" ")[0]
        for server_name, server in servers.items():
            calls = [variants[index % len(variants)] for index in range(args.rounds + 10)]
            for arguments in calls[:10]:
                server.tool(name, arguments)
            samples = []
            for arguments in calls[10:]:
                start = time.perf_counter()
                server.tool(name, arguments)
                samples.append((time.perf_counter() - start) * 1000)
            print(f"{label:24} {server_name:6} {percentile(samples, 0.5):8.3f} {percentile(samples, 0.9):8.3f} "
                  f"{percentile(samples, 0.99):8.3f}")
    for server_name, server in servers.items():
        print(f"{server_name} RSS after run: {server.rss_mib():.0f} MiB")
        server.close()


if __name__ == "__main__":
    main()
