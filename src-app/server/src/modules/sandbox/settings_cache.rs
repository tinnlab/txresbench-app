//! In-process cache of the sandbox resource-limits singleton.
//!
//! Mirrors ziee `code_sandbox/resource_limits_cache.rs`: an `OnceLock<RwLock<
//! Arc<..>>>` loaded once from the DB, swapped on every PUT, read on the hot
//! path (each sandbox run). Starts at the hardcoded defaults so a read before
//! the first DB load (or after a DB error) is always safe.

use std::sync::{Arc, OnceLock, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};

use sqlx::SqlitePool;

use super::settings::{SandboxResourceLimits, SandboxSettingsRepository};

static CACHE: OnceLock<RwLock<Arc<SandboxResourceLimits>>> = OnceLock::new();
static LOADED: AtomicBool = AtomicBool::new(false);

fn cell() -> &'static RwLock<Arc<SandboxResourceLimits>> {
    CACHE.get_or_init(|| RwLock::new(Arc::new(SandboxResourceLimits::defaults())))
}

/// Current cached limits (defaults until the first `get`/`invalidate`).
pub fn snapshot() -> Arc<SandboxResourceLimits> {
    cell().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Read the limits, loading from the DB once (subsequent calls hit the cache).
/// A DB error falls back to the current cached value (defaults on first call),
/// so a sandbox run is never blocked by a settings read.
pub async fn get(pool: &SqlitePool) -> Arc<SandboxResourceLimits> {
    if !LOADED.load(Ordering::Acquire) {
        match SandboxSettingsRepository::new(pool.clone()).get().await {
            Ok(row) => {
                *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
            }
            Err(e) => {
                tracing::warn!("sandbox: settings DB read failed ({e}); using cached/default limits");
            }
        }
        LOADED.store(true, Ordering::Release);
    }
    snapshot()
}

/// Swap the cached row after a PUT so the next sandbox run reads the new caps.
pub fn invalidate(row: SandboxResourceLimits) {
    *cell().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
    LOADED.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-12: initial snapshot is defaults; invalidate swaps the Arc so a
    // subsequent snapshot returns the new values (no stale read).
    #[test]
    fn invalidate_swaps_cached_arc() {
        // Initial cache value = defaults.
        let d = SandboxResourceLimits::defaults();
        assert_eq!(snapshot().pids_max, d.pids_max);

        let mut modified = SandboxResourceLimits::defaults();
        modified.pids_max = d.pids_max + 111;
        modified.timeout_secs = 42;
        invalidate(modified.clone());

        let after = snapshot();
        assert_eq!(after.pids_max, d.pids_max + 111, "pids_max swapped");
        assert_eq!(after.timeout_secs, 42, "timeout swapped");

        // Restore defaults so sibling tests in this binary see a clean cache.
        invalidate(SandboxResourceLimits::defaults());
    }
}
