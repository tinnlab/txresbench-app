//! In-process cache of the workstore settings singleton.
//!
//! Mirrors `modules/sandbox/settings_cache.rs`: an `OnceLock<RwLock<Arc<..>>>`
//! loaded once from the DB, swapped on every PUT, read at the GC + ingest use
//! sites. Starts at the hardcoded defaults so a read before the first DB load (or
//! after a DB error) is always safe and byte-preserving (INV-1/INV-4).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use sqlx::SqlitePool;

use super::settings::{WorkstoreSettings, WorkstoreSettingsRepository};

static CACHE: OnceLock<RwLock<Arc<WorkstoreSettings>>> = OnceLock::new();
static LOADED: AtomicBool = AtomicBool::new(false);

fn cell() -> &'static RwLock<Arc<WorkstoreSettings>> {
    CACHE.get_or_init(|| RwLock::new(Arc::new(WorkstoreSettings::defaults())))
}

/// Current cached settings (defaults until the first `get`/`invalidate`).
pub fn snapshot() -> Arc<WorkstoreSettings> {
    cell().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Read the settings, loading from the DB once (subsequent calls hit the cache).
/// A DB error falls back to the current cached value (defaults on first call), so
/// a GC sweep / ingest is never blocked by a settings read.
pub async fn get(pool: &SqlitePool) -> Arc<WorkstoreSettings> {
    if !LOADED.load(Ordering::Acquire) {
        match WorkstoreSettingsRepository::new(pool.clone()).get().await {
            Ok(row) => {
                *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
                // Only mark loaded on SUCCESS: a transient DB error at the first read
                // (e.g. at boot) must not pin the cache to compiled defaults forever —
                // the next use retries the DB until it loads the admin-configured row.
                LOADED.store(true, Ordering::Release);
            }
            Err(e) => {
                tracing::warn!(
                    "workstore: settings DB read failed ({e}); using cached/default settings (will retry)"
                );
            }
        }
    }
    snapshot()
}

/// Swap the cached row after a PUT so the next sweep / ingest reads the new values.
pub fn invalidate(row: WorkstoreSettings) {
    *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
    LOADED.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Initial snapshot is defaults; invalidate swaps the Arc so a subsequent
    // snapshot returns the new values (no stale read).
    #[test]
    fn invalidate_swaps_cached_arc() {
        let d = WorkstoreSettings::defaults();
        assert_eq!(snapshot().gc_interval_hours, d.gc_interval_hours);

        let modified = WorkstoreSettings { gc_interval_hours: 12, gc_grace_secs: 999, ..d.clone() };
        invalidate(modified);

        let after = snapshot();
        assert_eq!(after.gc_interval_hours, 12, "interval swapped");
        assert_eq!(after.gc_grace_secs, 999, "grace swapped");

        // Restore defaults so sibling tests in this binary see a clean cache.
        invalidate(WorkstoreSettings::defaults());
    }
}
