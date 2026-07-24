// Help text for the low-frequency maintenance commands, split out of
// help.js to keep that file under the 400-line ceiling.

export const INDEX_HELP = `
Usage: apple-docs index <subcommand> [target] [options]

Rebuild a search index from existing data. Useful after recovering from a
corrupted FTS5 / trigram table, or to (re)build the optional semantic tier.

Subcommands:
  rebuild body         Rebuild the full-body FTS5 index from documents.
  rebuild trigram      Rebuild the trigram FTS5 index from document titles.
  embeddings           Build the semantic index (document_chunks: per-chunk
                       binary + int8 codes, plus the document_vectors anchor)
                       with the model2vec embedder. Runs automatically at
                       setup; needs the optional @huggingface/transformers
                       dep + the local model, otherwise lexical-only.

Options:
  --full               (embeddings) Re-chunk + re-embed every document.
                       Without it, only documents with no chunks yet are
                       processed.

Examples:
  apple-docs index rebuild body
  apple-docs index rebuild trigram
  apple-docs index embeddings --full
`.trim()

export const PRUNE_HELP = `
Usage: apple-docs prune [options]

Trim the corpus to <data-dir>/scope.json WITHOUT re-crawling: pages whose
root falls outside the scope are deleted (documents, search indexes,
semantic vectors, markdown/raw-json/html files included), fonts/symbols
are optionally dropped, and the database is VACUUMed to reclaim space.

Requires a scope.json — prune defines nothing by itself; the file says
what to KEEP. Example:

  {
    "version": 1,
    "sources": ["apple-docc", "hig", "swift-book"],
    "appleDoccFrameworks": ["swiftui", "combine"],
    "keepFonts": true,
    "keepSymbols": false
  }

The same file scopes future "apple-docs sync" runs, so a pruned corpus
stays pruned. Delete scope.json and sync to grow back to full coverage.

Options:
  --dry-run            Report what would be removed; change nothing.
  --no-vacuum          Skip the VACUUM space-reclaim pass.

Examples:
  apple-docs prune --dry-run
  apple-docs prune
`.trim()
