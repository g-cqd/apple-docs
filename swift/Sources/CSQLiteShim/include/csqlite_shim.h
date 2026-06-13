#ifndef CSQLITE_SHIM_H
#define CSQLITE_SHIM_H

// Calls a dlsym'd `sqlite3_config(int, ...)` pointer with the CORRECT variadic
// ABI to disable SQLite memory statistics (RFC 0001 P6). With memstatus ON
// (the default) every `sqlite3Malloc`/`sqlite3_free` enters a GLOBAL mutex to
// update usage counters, which serializes all allocation across connections —
// under concurrent FTS queries the reader threads spend their time blocked on
// that one lock instead of executing SQL. Disabling it makes SQLite call the
// (already thread-safe, concurrent) system allocator directly.
//
// A C shim is required because a variadic C function cannot be called correctly
// through a fixed `@convention(c)` Swift function pointer on arm64 (the trailing
// argument must be passed on the stack, not in a register).
//
// `config_fn` is the dlsym'd `sqlite3_config` symbol. Must be called BEFORE the
// first `sqlite3_open`/`sqlite3_initialize`. Returns the sqlite3_config result
// code (0 = SQLITE_OK; SQLITE_MISUSE if SQLite is already initialized — benign),
// or -1 if `config_fn` is NULL.
int ad_sqlite_config_memstatus_off(void *config_fn);

#endif
