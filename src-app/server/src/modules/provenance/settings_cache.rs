//! In-process cache of the provenance settings singleton (ITEM-25). Mirrors
//! `sandbox/settings_cache.rs`: an `OnceLock<RwLock<Arc<..>>>` loaded once from
//! the DB, swapped on every PUT, read on the export hot path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use sqlx::SqlitePool;

use super::settings::{ProvenanceSettings, ProvenanceSettingsRepository};

static CACHE: OnceLock<RwLock<Arc<ProvenanceSettings>>> = OnceLock::new();
static LOADED: AtomicBool = AtomicBool::new(false);

fn cell() -> &'static RwLock<Arc<ProvenanceSettings>> {
    CACHE.get_or_init(|| RwLock::new(Arc::new(ProvenanceSettings::defaults())))
}

/// Current cached settings (defaults until the first `get`/`invalidate`).
pub fn snapshot() -> Arc<ProvenanceSettings> {
    cell().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Read the settings, loading from the DB once (subsequent calls hit the cache).
/// A DB error falls back to the current cached value FOR THAT CALL ONLY — the
/// next call retries (see [`load_once`]).
pub async fn get(pool: &SqlitePool) -> Arc<ProvenanceSettings> {
    load_once(pool, &LOADED).await
}

/// The load-once body with the latch flag INJECTED, so the failure path is
/// unit-testable against a caller-owned flag (the production `LOADED` is a
/// process-wide static shared by every test in the binary).
async fn load_once(pool: &SqlitePool, loaded: &AtomicBool) -> Arc<ProvenanceSettings> {
    if !loaded.load(Ordering::Acquire) {
        match ProvenanceSettingsRepository::new(pool.clone()).get().await {
            Ok(row) => {
                *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
                // Latch ONLY on a successful load. A transient DB error must NOT
                // pin the capture/export path to compile-time defaults forever —
                // that would silently ignore an admin-configured
                // `capture_code_max_bytes` after a boot-time DB blip and refuse a
                // legitimate capture while naming a cap nobody set. Leave `loaded`
                // false so the NEXT call retries; return defaults as a transient
                // fallback this call.
                loaded.store(true, Ordering::Release);
            }
            Err(e) => {
                tracing::warn!(
                    "provenance: settings DB read failed ({e}); retrying next use (not latching defaults)"
                );
            }
        }
    }
    snapshot()
}

/// Swap the cached row after a PUT so the next export reads the new caps.
pub fn invalidate(row: ProvenanceSettings) {
    *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
    LOADED.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-13 (cache): initial snapshot is defaults; invalidate swaps the Arc.
    #[test]
    fn invalidate_swaps_cached_arc() {
        let d = ProvenanceSettings::defaults();
        assert_eq!(snapshot().export_retention_days, d.export_retention_days);

        let mut modified = ProvenanceSettings::defaults();
        modified.export_retention_days = 90;
        invalidate(modified.clone());

        assert_eq!(snapshot().export_retention_days, 90, "retention swapped");

        // Restore defaults so sibling tests see a clean cache.
        invalidate(ProvenanceSettings::defaults());
    }

    // ERROR-HANDLING-1 (F2-10): a FAILED settings read must not latch the
    // compile-time defaults for the process lifetime. It used to: `LOADED` was
    // stored OUTSIDE the `Ok` arm, so one transient DB error pinned
    // `capture_code_max_bytes` to 262144 forever — after the DB recovered the
    // identical capture still 422'd, naming a cap the operator never configured
    // and telling them to raise the cap they had already raised.
    //
    // RED ON REVERT: move `loaded.store(true, …)` back out of the `Ok` arm and
    // this assertion fails (the flag latches on the failed read).
    #[tokio::test]
    async fn a_failed_db_read_does_not_latch_defaults() {
        use sqlx::sqlite::SqlitePoolOptions;

        // A lazily-connected pool at a nonexistent path: every query errors
        // (the ITEM-19/20 convention — the sqlite driver has no "closed port"
        // equivalent, so the unreachable supplier is a bad path instead).
        let unreachable = SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(2))
            .connect_lazy("sqlite:///data/pbya/txresbench-app-work/__no_such_dir__/offline.sqlite")
            .expect("build a lazy pool");

        let loaded = AtomicBool::new(false);
        let first = load_once(&unreachable, &loaded).await;

        // The call still answers (a transient fallback, not a hard failure)…
        assert_eq!(
            first.capture_code_max_bytes,
            ProvenanceSettings::defaults().capture_code_max_bytes,
            "a failed read falls back to the cached/default value for THIS call"
        );
        // …but it must NOT latch, or the operator's configured cap is ignored
        // for the whole process lifetime.
        assert!(
            !loaded.load(Ordering::Acquire),
            "a failed settings read must leave the cache un-latched so the next call retries"
        );
    }
}
