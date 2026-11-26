#pragma once
#include <sqlite3.h>

/// Non-variadic wrapper over `sqlite3_db_config` for integer on/off options (Swift cannot call C variadics).
/// Returns the SQLite result code; `*current` receives the option's value after the call when non-NULL.
static inline int apple_docs_sqlite3_db_config_flag(sqlite3 *db, int option, int value, int *current) {
    return sqlite3_db_config(db, option, value, current);
}
