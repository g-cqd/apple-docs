#include "csqlite_shim.h"

// SQLITE_CONFIG_MEMSTATUS (sqlite3.h, ABI-frozen).
#define AD_SQLITE_CONFIG_MEMSTATUS 9

int ad_sqlite_config_memstatus_off(void *config_fn) {
  if (config_fn == 0) {
    return -1;
  }
  int (*cfg)(int, ...) = (int (*)(int, ...))config_fn;
  return cfg(AD_SQLITE_CONFIG_MEMSTATUS, 0);
}
