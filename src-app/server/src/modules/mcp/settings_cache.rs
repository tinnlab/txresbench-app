//! In-process cache of the MCP settings singleton.
//!
//! Mirrors `modules/workstore/settings_cache.rs`: an `OnceLock<RwLock<Arc<..>>>`
//! loaded once from the DB, swapped on every PUT, read at the agent-channel +
//! pairing + handlers use sites. Starts at the hardcoded defaults so a read before
//! the first DB load (or after a DB error) is always safe and byte-preserving
//! (INV-1). `snapshot()` needs no pool — the `agent_channel` free functions that
//! have no pool in scope read through it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use sqlx::PgPool;

use super::settings::{McpSettings, McpSettingsRepository};

static CACHE: OnceLock<RwLock<Arc<McpSettings>>> = OnceLock::new();
static LOADED: AtomicBool = AtomicBool::new(false);

fn slot() -> &'static RwLock<Arc<McpSettings>> {
    CACHE.get_or_init(|| RwLock::new(Arc::new(McpSettings::defaults())))
}

/// Current cached settings (defaults until the first `get`/`invalidate`).
pub fn snapshot() -> Arc<McpSettings> {
    slot().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Read the settings, loading from the DB once (subsequent calls hit the cache).
/// A DB error falls back to the current cached value (defaults on first call), so
/// a hot-path read is never blocked by a settings read.
pub async fn get(pool: &PgPool) -> Arc<McpSettings> {
    if !LOADED.load(Ordering::Acquire) {
        match McpSettingsRepository::new(pool.clone()).get().await {
            Ok(row) => {
                *slot().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
                // Only mark loaded on SUCCESS: a transient DB error at the first read
                // (e.g. at boot) must not pin the cache to compiled defaults forever —
                // the next use retries the DB until it loads the admin-configured row.
                LOADED.store(true, Ordering::Release);
            }
            Err(e) => {
                tracing::warn!(
                    "mcp: settings DB read failed ({e}); using cached/default settings (will retry)"
                );
            }
        }
    }
    snapshot()
}

/// Swap the cached row after a PUT so the next use reads the new values.
pub fn invalidate(row: McpSettings) {
    *slot().write().unwrap_or_else(|p| p.into_inner()) = Arc::new(row);
    LOADED.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-4: initial snapshot is defaults (the pool-less fallback the agent_channel
    // sites rely on); invalidate swaps the Arc so a subsequent snapshot returns the
    // new values (no stale read).
    #[test]
    fn snapshot_defaults_then_invalidate_swaps() {
        let d = McpSettings::defaults();
        assert_eq!(snapshot().max_inflight_per_user, d.max_inflight_per_user);

        let modified = McpSettings { max_inflight_per_user: 32, pairing_ttl_secs: 60, ..d.clone() };
        invalidate(modified);

        let after = snapshot();
        assert_eq!(after.max_inflight_per_user, 32, "in-flight cap swapped");
        assert_eq!(after.pairing_ttl_secs, 60, "ttl swapped");

        // Restore defaults so sibling tests in this binary see a clean cache.
        invalidate(McpSettings::defaults());
    }
}
