#!/usr/bin/env python3
"""Differential check: compare a Swift-synced corpus against a Bun-synced corpus of the same pages.

Usage: diff-bun-corpus.py <swift.db> <bun.db> [--examples N] [--strict]

Intentional differences that are not reported: `usr` (Swift also records the DocC external ID; Bun leaves it
NULL), and an empty `content_text` (Swift's column is NOT NULL where Bun stores NULL).

Compares, per document key present in both databases:
  - document columns (title, kind, role, role_heading, framework, url, language, usr, abstract_text,
    declaration_text, headings, min_* platforms, is_deprecated, is_beta, is_release_notes, url_depth)
  - sections keyed by (section_kind, sort_order): heading, content_text, content_json (parsed JSON)
  - relationships (from, to, type, section, sort_order)
Zstandard-compressed cells (Bun stores content_json / content_text as zstd frames) are decoded with the
`zstd` CLI. Prints mismatch counts per field and a few examples; `--strict` exits 1 on any mismatch.
"""

import argparse
import json
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
DOC_COLUMNS = [
    "title", "kind", "role", "role_heading", "framework", "url", "language", "abstract_text",
    "declaration_text", "headings", "min_ios", "min_macos", "min_watchos", "min_tvos", "min_visionos",
    "is_deprecated", "is_beta", "is_release_notes", "url_depth",
]


def decode(cell):
    if cell is None:
        return None
    if isinstance(cell, bytes):
        if cell.startswith(ZSTD_MAGIC):
            cell = subprocess.run(["zstd", "-d", "-c", "-q"], input=cell, capture_output=True, check=True).stdout
        return cell.decode("utf-8")
    return cell


def parse_json(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return ("<invalid json>", text)


def columns(conn, table):
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def load_documents(conn):
    available = columns(conn, "documents")
    selected = [c for c in DOC_COLUMNS if c in available]
    rows = conn.execute(f"SELECT key, {', '.join(selected)} FROM documents").fetchall()
    return {row[0]: dict(zip(selected, row[1:])) for row in rows}


def load_sections(conn):
    out = defaultdict(dict)
    query = """
        SELECT d.key, s.section_kind, s.sort_order, s.heading, s.content_text, s.content_json
        FROM document_sections s JOIN documents d ON d.id = s.document_id
    """
    for key, kind, order, heading, text, blob in conn.execute(query):
        out[key][(kind, order)] = {
            "heading": heading,
            "content_text": decode(text),
            "content_json": parse_json(decode(blob)),
        }
    return out


def load_relationships(conn):
    rows = conn.execute(
        "SELECT from_key, to_key, relation_type, section, sort_order FROM document_relationships"
    ).fetchall()
    return set(rows)


def short(value, limit=160):
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    return text if len(text) <= limit else text[:limit] + "…"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("swift_db")
    parser.add_argument("bun_db")
    parser.add_argument("--examples", type=int, default=3)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    swift = sqlite3.connect(args.swift_db)
    bun = sqlite3.connect(args.bun_db)
    swift_docs, bun_docs = load_documents(swift), load_documents(bun)
    common = sorted(set(swift_docs) & set(bun_docs))
    mismatches = Counter()
    examples = defaultdict(list)

    def record(field, key, swift_value, bun_value):
        mismatches[field] += 1
        if len(examples[field]) < args.examples:
            examples[field].append((key, swift_value, bun_value))

    for key in common:
        for column in DOC_COLUMNS:
            if column in swift_docs[key] and column in bun_docs[key]:
                if swift_docs[key][column] != bun_docs[key][column]:
                    record(f"documents.{column}", key, swift_docs[key][column], bun_docs[key][column])

    swift_sections, bun_sections = load_sections(swift), load_sections(bun)
    for key in common:
        mine, theirs = swift_sections.get(key, {}), bun_sections.get(key, {})
        for slot in sorted(set(mine) | set(theirs), key=lambda s: (s[1], s[0])):
            if slot not in mine or slot not in theirs:
                record("sections.presence", key, slot if slot in mine else None, slot if slot in theirs else None)
                continue
            for field in ("heading", "content_text", "content_json"):
                if field == "content_text" and not mine[slot][field] and not theirs[slot][field]:
                    continue
                if mine[slot][field] != theirs[slot][field]:
                    record(f"sections.{slot[0]}.{field}", key, mine[slot][field], theirs[slot][field])

    common_set = set(common)
    swift_rels = {r for r in load_relationships(swift) if r[0] in common_set}
    bun_rels = {r for r in load_relationships(bun) if r[0] in common_set}
    for row in sorted(swift_rels - bun_rels)[: args.examples]:
        examples["relationships.only_swift"].append((row[0], row, None))
    for row in sorted(bun_rels - swift_rels)[: args.examples]:
        examples["relationships.only_bun"].append((row[0], None, row))
    if swift_rels - bun_rels:
        mismatches["relationships.only_swift"] = len(swift_rels - bun_rels)
    if bun_rels - swift_rels:
        mismatches["relationships.only_bun"] = len(bun_rels - swift_rels)

    print(f"documents: swift={len(swift_docs)} bun={len(bun_docs)} common={len(common)}")
    print(f"only-swift keys: {len(set(swift_docs) - set(bun_docs))}, only-bun keys: {len(set(bun_docs) - set(swift_docs))}")
    if not mismatches:
        print("no differences")
        return 0
    for field, count in sorted(mismatches.items(), key=lambda item: -item[1]):
        print(f"{count:6d}  {field}")
        for key, swift_value, bun_value in examples[field]:
            print(f"          {key}\n            swift: {short(swift_value)}\n            bun:   {short(bun_value)}")
    return 1 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
