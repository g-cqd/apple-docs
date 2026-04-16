#!/usr/bin/env bun
/**
 * audit-languages.js
 *
 * Audits all code-block languages present in the apple-docs corpus by
 * querying the SQLite database at ~/.apple-docs/apple-docs.db.
 *
 * Three extraction passes:
 *   1. Declaration sections  — `languages` arrays on declaration-token objects
 *   2. Discussion sections   — `syntax` fields on `codeListing` nodes
 *   3. All sections          — fenced code-block markers in `content_text`
 *
 * Prints a unified frequency table (language → count), sorted descending.
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const DB_PATH = join(homedir(), ".apple-docs", "apple-docs.db");
const db = new Database(DB_PATH, { readonly: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively walk a parsed JSON value and collect every `codeListing` node. */
function collectCodeListings(node, results = []) {
  if (node === null || typeof node !== "object") return results;
  if (Array.isArray(node)) {
    for (const item of node) collectCodeListings(item, results);
  } else {
    if (node.type === "codeListing") results.push(node);
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") {
        collectCodeListings(value, results);
      }
    }
  }
  return results;
}

/** Safely parse JSON, returning null on failure. */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Normalise a raw language string: trim and lowercase. */
function normalise(lang) {
  return lang.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Frequency accumulator
// ---------------------------------------------------------------------------

const freq = new Map(); // normalised language → total count

function tally(lang, source) {
  if (!lang) return;
  const key = normalise(lang);
  if (!key) return;
  freq.set(key, (freq.get(key) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// Pass 1 — Declaration sections: `languages` arrays
// ---------------------------------------------------------------------------

console.error("Pass 1: declaration sections …");

const decl = db.query(
  "SELECT content_json FROM document_sections WHERE section_kind = 'declaration' AND content_json IS NOT NULL"
);

let declRows = 0;
for (const row of decl.iterate()) {
  declRows++;
  const parsed = tryParse(row.content_json);
  if (!Array.isArray(parsed)) continue;

  for (const token of parsed) {
    if (!token || !Array.isArray(token.languages)) continue;
    for (const lang of token.languages) {
      if (typeof lang === "string") tally(lang, "declaration");
    }
  }
}

console.error(`  Processed ${declRows.toLocaleString()} declaration rows.`);

// ---------------------------------------------------------------------------
// Pass 2 — Discussion sections: `codeListing` nodes → `syntax`
// ---------------------------------------------------------------------------

console.error("Pass 2: discussion sections (codeListing nodes) …");

const disc = db.query(
  "SELECT content_json FROM document_sections WHERE section_kind = 'discussion' AND content_json IS NOT NULL"
);

let discRows = 0;
let codeListingCount = 0;
for (const row of disc.iterate()) {
  discRows++;
  const parsed = tryParse(row.content_json);
  if (!parsed) continue;

  const listings = collectCodeListings(parsed);
  for (const listing of listings) {
    codeListingCount++;
    if (typeof listing.syntax === "string") {
      tally(listing.syntax, "codeListing");
    } else {
      // Count listings with no syntax value separately
      tally("(none)", "codeListing");
    }
  }
}

console.error(
  `  Processed ${discRows.toLocaleString()} discussion rows, found ${codeListingCount.toLocaleString()} codeListing nodes.`
);

// ---------------------------------------------------------------------------
// Pass 3 — All sections: fenced code blocks in content_text
// ---------------------------------------------------------------------------

console.error("Pass 3: fenced code blocks in content_text …");

const text = db.query(
  "SELECT content_text FROM document_sections WHERE content_text LIKE '%```%'"
);

// Matches ``` optionally followed by a language identifier on the same line.
// Group 1 = language identifier (may be empty for bare ```)
const FENCE_RE = /^```([^\n`]*)/gm;

let textRows = 0;
let fenceCount = 0;
for (const row of text.iterate()) {
  textRows++;
  const content = row.content_text;
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(content)) !== null) {
    fenceCount++;
    const lang = m[1].trim();
    tally(lang || "(none)", "fence");
  }
}

console.error(
  `  Processed ${textRows.toLocaleString()} rows, found ${fenceCount.toLocaleString()} fenced code blocks.`
);

// ---------------------------------------------------------------------------
// Output — frequency table sorted by count descending
// ---------------------------------------------------------------------------

const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);

const total = sorted.reduce((s, [, c]) => s + c, 0);

console.log("");
console.log("Language frequency table");
console.log("========================");
console.log(
  `${"Language".padEnd(30)} ${"Count".padStart(8)}  ${"Share".padStart(7)}`
);
console.log("-".repeat(52));
for (const [lang, count] of sorted) {
  const share = ((count / total) * 100).toFixed(1).padStart(6);
  console.log(`${lang.padEnd(30)} ${String(count).padStart(8)}  ${share}%`);
}
console.log("-".repeat(52));
console.log(`${"TOTAL".padEnd(30)} ${String(total).padStart(8)}`);

db.close();
