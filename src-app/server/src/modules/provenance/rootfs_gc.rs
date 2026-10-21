//! The rootfs-cache eviction DRIVER (#154).
//!
//! `rootfs::cache` owns the eviction MECHANISM; this owns the schedule and the
//! one input the mechanism cannot compute for itself — the set of rootfs content
//! digests extant runs pin. That set lives in `provenance_run_repro`, which is
//! why the driver sits on the provenance side: the alternative (a raw cross-module
//! query from `rootfs` into provenance's schema) is the layering violation the
//! original `gc_unreferenced` doc comment declined to commit, and it is also why
//! that function sat unwired — and therefore why the cache had no eviction path at
//! all until now.
//!
//! The dependency edge is not new: `provenance::env_obtain::DefaultObtainability`
//! already reads `rootfs::embedded`.
//!
//! # Why a periodic loop and not a fetch-time hook
//!
//! The cache grows at exactly one moment — when `OciEnvImageProvider::provide`
//! stages a newly-resolved digest — which argues for evicting right there. But
//! `provide` is synchronous, holds no `PgPool`, and runs on the critical path of a
//! job that is about to execute; making it reach the database for the referenced
//! set would put a query (and a 300 MB delete) in front of every run. Growth is
//! one digest per REPUBLISH of the env image, not per run, so a periodic sweep
//! bounds the cache just as tightly at none of that cost.

use std::collections::HashSet;
use std::time::Duration;

use sqlx::PgPool;
use ziee_core::AppError;

use super::env_obtain::normalize_digest;
use super::repository::ProvenanceRepository;
use super::settings::ProvenanceSettings;
use super::settings_cache;
use crate::modules::rootfs::cache;

/// Sweep-cadence FALLBACK constant. The live cadence is the admin-editable
/// `provenance_settings.rootfs_gc_interval_secs` (read-at-use each cycle, #54); this const is
/// the compile-time default the settings row seeds to and the fallback if the settings read
/// is unavailable. Byte-preserving: 6 hours — the cache gains at most one digest per
/// env-image republish, so six hours bounds it to within a single digest of the cap at all
/// times while costing four `SELECT DISTINCT`s a day.
pub const GC_INTERVAL_SECS: u64 = 6 * 3600;

/// The eviction cap this pass should honor, resolved read-at-use (#54) from the
/// admin-configured `rootfs_cache_max_digests`. The DB setting is AUTHORITATIVE at read
/// time so an admin PUT actually takes effect (DEC-2 correction); the legacy
/// `CYTO_ROOTFS_CACHE_MAX_DIGESTS` env var is folded into this row ONCE at boot (a SEED, via
/// `seed_rootfs_cap_from_env_if_unmodified`) rather than winning here — otherwise an admin
/// change to the cap would be silently inert on an env-pinned deployment. Floored at 1 (a 0
/// would ask the GC to evict the digest a run is executing on).
pub fn resolve_max_digests(settings: &ProvenanceSettings) -> usize {
    settings.rootfs_cache_max_digests.max(1) as usize
}

/// The sweep cadence this loop should sleep, resolved read-at-use (#54) from
/// `rootfs_gc_interval_secs`, floored at 1s so a degenerate row can never yield a busy-loop.
pub fn resolve_interval(settings: &ProvenanceSettings) -> Duration {
    Duration::from_secs(settings.rootfs_gc_interval_secs.max(1) as u64)
}

/// Run ONE eviction pass against the local rootfs cache with an explicit cap. Synchronous
/// and runtime-free on purpose: it is the unit a test can drive directly on its own thread,
/// where `rootfs::scoped_data_root`'s THREAD-scoped override is visible (a `spawn_blocking`
/// hop would land on a different thread and silently resolve the shared `~/.app` cache
/// instead of the test's isolated one).
///
/// Returns the digests evicted.
pub fn sweep_now_with_cap(referenced: &HashSet<String>, max: usize) -> Vec<String> {
    cache::gc_unreferenced_with_cap(referenced, max)
}

/// The referenced set as the cache wants it: distinct pinned digests, normalized
/// to bare lowercase hex (a stored value may legitimately carry a `sha256:`
/// scheme prefix, and a cache key never does — an un-normalized entry would fail
/// to protect the digest it names).
pub async fn referenced_digests(pool: &PgPool) -> Result<HashSet<String>, AppError> {
    let repo = ProvenanceRepository::new(pool.clone());
    Ok(repo
        .distinct_env_rootfs_digests()
        .await?
        .iter()
        .map(|d| normalize_digest(d))
        .collect())
}

/// Boot pass + periodic sweeps. Fire-and-forget, mirroring the workstore GC
/// sweeper: a failed pass is logged and the loop continues, because a database
/// hiccup must never leave the cache permanently unbounded.
///
/// The FIRST pass is what reclaims the backlog a deployment has already
/// accumulated (this box measured 2.3 GB across six digest dirs before any of
/// this existed).
pub fn spawn_loop(pool: PgPool) {
    tokio::spawn(async move {
        loop {
            // Read the live settings each cycle (read-at-use, #54): the interval AND the cap
            // both come from the admin-editable `provenance_settings` row, so a PUT takes
            // effect on the next pass with no restart. `settings_cache::get` falls back to the
            // compile-time defaults on a DB error, so a hiccup never busy-loops or unbounds
            // the cache.
            let settings = settings_cache::get(&pool).await;
            let cap = resolve_max_digests(&settings);
            let interval = resolve_interval(&settings);

            match referenced_digests(&pool).await {
                Ok(referenced) => {
                    // The eviction itself is blocking filesystem work (a rename plus
                    // a multi-hundred-megabyte delete), so it does not run on a
                    // runtime worker.
                    match tokio::task::spawn_blocking(move || sweep_now_with_cap(&referenced, cap))
                        .await
                    {
                        Ok(evicted) if !evicted.is_empty() => {
                            tracing::info!(
                                count = evicted.len(),
                                "rootfs cache GC: pass evicted digests"
                            );
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!(error = %e, "rootfs cache GC: pass panicked"),
                    }
                }
                Err(e) => {
                    tracing::warn!(error = ?e, "rootfs cache GC: could not read referenced digests; cache not swept this pass");
                }
            }
            tokio::time::sleep(interval).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::provenance::settings::ProvenanceSettings;

    // ITEM-4: the cadence + cap come from the settings row (read-at-use), not the const.
    #[test]
    fn resolve_interval_reads_the_settings_row() {
        let mut s = ProvenanceSettings::defaults();
        assert_eq!(resolve_interval(&s), Duration::from_secs(21_600));
        s.rootfs_gc_interval_secs = 3600;
        assert_eq!(resolve_interval(&s), Duration::from_secs(3600));
        // A degenerate row is floored, never a busy-loop.
        s.rootfs_gc_interval_secs = 0;
        assert!(resolve_interval(&s) >= Duration::from_secs(1));
    }

    // DEC-2 correction: the DB setting is AUTHORITATIVE at read time — an env var does NOT
    // win here (it is a boot SEED via seed_rootfs_cap_from_env_if_unmodified), so an admin
    // change to the cap is never silently inert. Set the env to a distinct value and prove
    // the resolved cap still follows the settings row, not the env.
    #[test]
    fn resolve_max_digests_reads_settings_not_env() {
        std::env::set_var("CYTO_ROOTFS_CACHE_MAX_DIGESTS", "99");
        let mut s = ProvenanceSettings::defaults();
        assert_eq!(resolve_max_digests(&s), 4, "default settings cap, env is NOT consulted at read");
        s.rootfs_cache_max_digests = 7;
        assert_eq!(resolve_max_digests(&s), 7, "an admin-set cap is honored despite the env var");
        s.rootfs_cache_max_digests = 0; // degenerate → floored to 1
        assert_eq!(resolve_max_digests(&s), 1, "a 0 setting floors to 1");
        std::env::remove_var("CYTO_ROOTFS_CACHE_MAX_DIGESTS");
    }

    // DEC-2 correction: the env override is parsed as a BOOT SEED value, positive-only and
    // clamped to the DB/validate bounds so a malformed/out-of-range env can never seed a bad row.
    #[test]
    fn env_seed_parses_positive_and_clamps() {
        use crate::modules::provenance::settings::rootfs_cache_max_digests_env_seed_from as seed;
        assert_eq!(seed(None), None, "unset → no seed");
        assert_eq!(seed(Some("")), None, "empty → no seed");
        assert_eq!(seed(Some("0")), None, "zero → no seed (a 0 cap is illegal)");
        assert_eq!(seed(Some("-3")), None, "negative → no seed");
        assert_eq!(seed(Some("junk")), None, "malformed → no seed");
        assert_eq!(seed(Some("  6 ")), Some(6), "a valid value seeds (trimmed)");
        assert_eq!(seed(Some("100000")), Some(1000), "an over-ceiling env is clamped to the max");
    }
}
