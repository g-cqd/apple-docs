/**
 * v11 — rebuild sf_symbols_fts. The v10 virtual table was created with a
 * column shape that didn't match the populator (keyword/category/alias
 * columns were unused). Drop and rebuild from the JSON sidecar columns.
 */
export function up(db) {
  db.exec(`
    DROP TABLE IF EXISTS sf_symbols_fts;
    CREATE VIRTUAL TABLE sf_symbols_fts USING fts5(
      name,
      keywords,
      categories,
      aliases,
      tokenize='porter unicode61'
    );
    INSERT INTO sf_symbols_fts(rowid, name, keywords, categories, aliases)
    SELECT rowid, name, COALESCE(keywords_json, ''), COALESCE(categories_json, ''), COALESCE(aliases_json, '')
    FROM sf_symbols;
  `)
}
