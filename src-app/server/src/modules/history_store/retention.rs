//! The `history_store` retention + usage policy (ITEM-3 — PROV-HS-4 / HS-5 /
//! HS-6): the K footer's keep-copies preference (the seeded singleton row),
//! the two copy-clear operations (per-run and all-runs — the ONLY destructive
//! surface this node owns), and the data-root usage walk the footer's "uses
//! 312 MB" figure renders.
//!
//! ## What is written, and where (the boundary is the point)
//!
//! - `txr_history_preferences` — THIS module's table. The id=1 row is created
//!   by the module's migration, NEVER by a code INSERT (a code INSERT is a
//!   test failure); the PUT is an upsert on that row (`ON CONFLICT(id)`,
//!   the engine's `put_analysis_config` singleton idiom).
//! - `txr_run_retention` — THIS module's table, written LAZILY: a row is born
//!   with the first copy-clear of a run (`copies_kept = 0` + the clear stamp)
//!   and dies WITH the run (the FK's ON DELETE CASCADE — the engine's
//!   clear-all keeps working and this node never prunes a dead row). A run
//!   without a row reads as `copies_kept = true` (INV-2's conservative
//!   direction: copies are considered kept until the explicit clear action).
//! - `txr_runs` — the ENGINE's table, READ-only here (PROV-EE-10's declared
//!   seam): the per-run clear resolves the recorded `dir` through the
//!   engine's own `RunRow` (never a second row shape); the all-runs sweep
//!   takes the two facts it needs (`id`, `dir`) in one minimal projection.
//!   Nothing in this file ever INSERTs/UPDATEs/DELETEs a run/method/log row.
//!
//! ## The destructive half (INV-2 / DEC-12 — the ONE policy)
//!
//! Copy deletion exists ONLY as the two board-mandated clear actions, and
//! each removes ONLY `<run_dir>/input/` — never `bundles/`, never per-method
//! outputs, never `models/`, never a run record, never the run dir itself.
//! The target is resolved through [`guard_input_dir`]: the recorded `dir`
//! must be `<data_root>/analysis-*` (DEC-12's naming rule — the only shape an
//! engine run dir has), and the canonicalized target must sit STRICTLY under
//! the recorded dir AND under the data root (a symlink out, a `/` row, a
//! `..` escape or a sibling path is refused with `UNSAFE_RUN_DIR` before
//! anything is touched — a tampered `dir` value can never delete outside).
//! A clear whose `input/` is already gone is the honest no-op: the row is
//! still marked (`copies_kept = 0` + stamp) so the K list stops offering the
//! rerun affordance (DEC-6), and the call stays 204.
//!
//! ## The usage walk (PROV-HS-6 / DEC-8)
//!
//! `usage()` computes the footer figure: `run_count` from the DB (never from
//! the walk — the count is the engine's rows, the bytes are the data root's)
//! plus a recursive `read_dir` pass over `rootfs::data_root()` grouped by
//! TOP-LEVEL segment: `analysis-*` dirs → `runs_bytes`, `models/` →
//! `models_bytes`, everything else (e.g. the env cache under `txr-envs/`) →
//! `other_bytes`. Symlinks are not followed, unreadable entries are skipped,
//! and a missing data root is zero bytes — the same best-effort honesty as
//! the detail's `dir_bytes` (the ONE walker is
//! [`crate::modules::history_store::repository::dir_size`], shared, never
//! duplicated). The result is cached in-process for 10 seconds (keyed by the
//! data-root path — a single-user local app must not re-walk a large data
//! root per keystroke; spending ~ms on a fresh read every render is worse
//! than being 10 seconds stale); the routes run the walk through
//! `spawn_blocking` (this module performs no blocking work on its own).
//!
//! ## Non-scope (the plan's lines, enforced)
//!
//! The preference PUT does NOT clear existing copies: DEC-5/D25's "future
//! default + immediate clear" is two composable steps — the preference row
//! (this module) and the explicit all-runs clear call (PROV-HS-5) the UI
//! issues after its confirmation dialog (D27); coupling them would make the
//! preference write destructive without a confirmation. No GC, no
//! retention window, no per-method cleanup — the module's deletions are
//! exactly the two explicit actions.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use crate::modules::execution_engine::repository::TxrRepository;
use crate::modules::history_store::repository::dir_size;
use crate::modules::history_store::types::{
    HistoryErrorCode, TxrHistoryPreferences, TxrHistoryPreferencesUpdate, TxrHistoryUsage,
};
use crate::modules::rootfs;

/// The usage cache's TTL (DEC-8: fresh compute per render is the honest
/// default, but a huge data root must not be walked per keystroke).
const USAGE_TTL: Duration = Duration::from_secs(10);

// ─────────────────────────────────────────────────────────────────────────────
// The typed errors (PROV-HS-3/5's entity vocabulary — HISTORY's own codes,
// never the framework's generic 404/400 text)
// ─────────────────────────────────────────────────────────────────────────────

fn run_not_found(run_id: Uuid) -> AppError {
    AppError::new(
        axum::http::StatusCode::NOT_FOUND,
        HistoryErrorCode::RunNotFound.code(),
        format!("no run {run_id}"),
    )
}

fn unsafe_run_dir(dir: &str, why: &str) -> AppError {
    AppError::new(
        axum::http::StatusCode::BAD_REQUEST,
        HistoryErrorCode::UnsafeRunDir.code(),
        format!("refusing copy-clear for run dir {dir:?}: {why}"),
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// The input-dir guard (TEST-HS-2 — DEC-12, INV-2)
// ─────────────────────────────────────────────────────────────────────────────

/// The guard's verdict on one run's `input/`: a validated deletion target, or
/// the honest "already gone" (the run dir was deleted, or `input/` was never
/// written — a no-op that still marks the retention row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClearTarget {
    /// The validated `<run_dir>/input/` to remove.
    Input(PathBuf),
    /// Nothing to remove (`input/` does not exist).
    Absent,
}

/// Resolve + floor-check one run's `input/` target (DEC-12, PROV-HS-5): the
/// recorded `dir` (an attacker/tamper surface — it is engine-written but
/// stored in the user's own DB) must be a `<data_root>/analysis-*` path, and
/// the canonicalized target must sit strictly under the (canonicalized)
/// recorded dir AND strictly under the (canonicalized) data root.
///
/// The two checks are a LAYERED fence, not a single one:
/// 1. the lexical naming rule (parent == data root, `analysis-*` stem) — the
///    only shape an engine run dir has, and it rejects `/`, `..`-escapes,
///    relative and sibling paths before any filesystem work;
/// 2. `canonicalize` + the two strict-under probes — the symlink defense (a
///    run dir or `input/` that is a symlink resolves OUTSIDE and is refused
///    here, even though its lexical name is fine).
/// A refusal touches nothing and is `UNSAFE_RUN_DIR` (nothing deleted, the
/// retention row untouched — TEST-HS-12).
pub(crate) fn guard_input_dir(dir: &str, root: &Path) -> Result<ClearTarget, AppError> {
    // 1. The naming rule.
    let dir_path = Path::new(dir);
    let is_named_like_a_run_dir = dir_path.parent() == Some(root)
        && dir_path
            .file_name()
            .map(|n| n.to_string_lossy().starts_with("analysis-"))
            .unwrap_or(false);
    if !is_named_like_a_run_dir {
        return Err(unsafe_run_dir(
            dir,
            "the recorded dir is not <data_root>/analysis-* (a tampered or foreign path)",
        ));
    }

    let input = dir_path.join("input");
    if !input.exists() {
        return Ok(ClearTarget::Absent);
    }

    // 2. The canonicalize + floor probes (only ever reached for an existing
    //    target — a missing one cannot be deleted and needs no proof).
    let canon_input = input
        .canonicalize()
        .map_err(|_| unsafe_run_dir(dir, "the input dir cannot be canonicalized"))?;
    let canon_dir = dir_path
        .canonicalize()
        .map_err(|_| unsafe_run_dir(dir, "the run dir cannot be canonicalized"))?;
    let canon_root = root
        .canonicalize()
        .map_err(|_| unsafe_run_dir(dir, "the data root cannot be canonicalized"))?;

    let strictly_under_dir = canon_input.starts_with(&canon_dir) && canon_input != canon_dir;
    let strictly_under_root = canon_input.starts_with(&canon_root) && canon_input != canon_root;
    if !strictly_under_dir || !strictly_under_root {
        return Err(unsafe_run_dir(
            dir,
            "the canonical input path is not strictly under the run dir and the data root (a symlink escape)",
        ));
    }
    Ok(ClearTarget::Input(input))
}

// ─────────────────────────────────────────────────────────────────────────────
// The Retention service (pool-bound, the `HistoryRepository` shape — ITEM-4's
// routes construct it from the same `axum::Extension<SqlitePool>`)
// ─────────────────────────────────────────────────────────────────────────────

/// This module's retention policy surface: the preference singleton, the
/// two copy-clear operations and the usage figure.
#[derive(Clone)]
pub struct Retention {
    pool: SqlitePool,
}

impl Retention {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The pool (the repository + routes bind the same handle).
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // ── the preference (PROV-HS-4) ─────────────────────────────────────────

    /// The K footer's keep-copies preference. The row is the migration's
    /// seed (singleton id = 1) — a code INSERT never creates it; a missing
    /// row (a DB that lost the seed) is a server defect surfaced as an
    /// error, never silently re-created as `true`.
    pub async fn get_preferences(&self) -> Result<TxrHistoryPreferences, AppError> {
        let row = sqlx::query_as!(
            PreferenceRow,
            r#"SELECT keep_file_copies as "keep_file_copies: bool",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM txr_history_preferences WHERE id = 1"#
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| {
            AppError::internal_error(
                "txr_history_preferences is missing its seeded id=1 row (migration defect)",
            )
        })?;
        Ok(TxrHistoryPreferences {
            keep_file_copies: row.keep_file_copies,
            updated_at: Some(row.updated_at),
        })
    }

    /// Upsert the preference (id = 1 — the engine's
    /// `put_analysis_config` singleton idiom; the `CHECK (id = 1)` + the
    /// PRIMARY KEY make a duplicate row impossible). Returns the new state
    /// (the routes surface the plan's 204; the round-trip is pinned here,
    /// TEST-HS-1). This write does NOT clear copies — the immediate-clear
    /// half of D25 is the explicit all-runs operation, the UI's after its
    /// confirmation.
    pub async fn update_preferences(
        &self,
        update: &TxrHistoryPreferencesUpdate,
    ) -> Result<TxrHistoryPreferences, AppError> {
        let keep = update.keep_file_copies;
        sqlx::query!(
            r#"INSERT INTO txr_history_preferences (id, keep_file_copies, updated_at)
               VALUES (1, $1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT(id) DO UPDATE SET
                 keep_file_copies = excluded.keep_file_copies,
                 updated_at = excluded.updated_at"#,
            keep,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        self.get_preferences().await
    }

    // ── the copy-clear operations (PROV-HS-5) ──────────────────────────────

    /// Clear ONE run's input copies (the K row's per-run action): resolve the
    /// recorded run dir through the engine's own run row, floor-check it,
    /// remove ONLY `<run_dir>/input/`, and mark the retention row
    /// (`copies_kept = 0` + the stamp — the K list's `can_rerun` flips false,
    /// DEC-6). Idempotent: a run whose `input/` is already gone still gets
    /// its row marked and returns 204; a missing run row is `404
    /// RUN_NOT_FOUND`; a tampered dir is `400 UNSAFE_RUN_DIR` (nothing
    /// deleted, row untouched). Bundles / outputs / models / logs / the run
    /// row are NEVER touched (INV-2).
    pub async fn clear_run_copies(&self, run_id: Uuid) -> Result<(), AppError> {
        let engine = TxrRepository::new(self.pool.clone());
        let Some(row) = engine.get_run(run_id).await? else {
            return Err(run_not_found(run_id));
        };
        self.clear_and_mark(run_id, &row.dir).await
    }

    /// Clear EVERY run's input copies (the K footer's "Do not keep copies of
    /// my files" destructive half — after the UI's confirmation, D25/D27):
    /// the same per-run guard + removal + retention row, composed over one
    /// `(id, dir)` sweep of the engine's table. A run whose recorded dir is
    /// tampered is SKIPPED (its guard refusal means nothing is deleted —
    /// aborting the whole sweep over one corrupt row would leave every
    /// healthy run's copies uncleared, which is the opposite of the one
    /// intent; the skip is logged, the refusal semantics stay per-run).
    /// Idempotent.
    pub async fn clear_all_copies(&self) -> Result<(), AppError> {
        let rows = sqlx::query_as!(
            RunDirRow,
            r#"SELECT id as "id: Uuid", dir FROM txr_runs"#
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        for row in rows {
            if let Err(e) = self.clear_and_mark(row.id, &row.dir).await {
                if e.error_code() == HistoryErrorCode::UnsafeRunDir.code() {
                    tracing::warn!(
                        run_id = %row.id,
                        "history-store clear-all: skipping run with an unsafe recorded dir: {e}"
                    );
                    continue;
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// The one destructive step, shared by the per-run and all-runs
    /// operations: guard the recorded dir, remove `input/` (an existing
    /// target only), then mark the run's retention row. Order matters: the
    /// guard runs FIRST (a refusal must leave the DB untouched too —
    /// TEST-HS-12), and the row is marked only after a successful removal (an
    /// IO failure leaves `copies_kept` honest at its previous value).
    async fn clear_and_mark(&self, run_id: Uuid, dir: &str) -> Result<(), AppError> {
        let target = guard_input_dir(dir, &rootfs::data_root())?;
        if let ClearTarget::Input(path) = target {
            match std::fs::remove_dir_all(&path) {
                Ok(()) => {}
                // Raced with the engine's own prune: the copies are gone —
                // the honest success (the engine's `prune_run_dir` rule).
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(AppError::internal_error(format!(
                        "copy-clear failed to remove {}: {e}",
                        path.display()
                    )))
                }
            }
        }
        // The lazy-row upsert: the FIRST clear of a run creates the row, a
        // later clear refreshes the stamp — one row per run, always
        // `copies_kept = 0`. A run with no row (the INV-2 default) lands
        // here as `copies_kept = false` from its first clear.
        sqlx::query!(
            r#"INSERT INTO txr_run_retention (run_id, copies_kept, copies_cleared_at)
               VALUES ($1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT(run_id) DO UPDATE SET
                 copies_kept = 0,
                 copies_cleared_at = excluded.copies_cleared_at"#,
            run_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    // ── the usage figure (PROV-HS-6) ───────────────────────────────────────

    /// The K footer's usage figure: `run_count` from the DB and the grouped
    /// byte walk of `rootfs::data_root()` (a 10-second TTL cache keyed by the
    /// data-root path — so a per-thread test override and the production
    /// root can never serve each other's value). The walk runs in
    /// `spawn_blocking` (the plan's route line; this async fn blocks
    /// nothing on its own thread) and a missing data root is zero bytes.
    pub async fn usage(&self) -> Result<TxrHistoryUsage, AppError> {
        let root = rootfs::data_root();
        if let Some(cached) = cached_usage(&root) {
            return Ok(cached);
        }
        let run_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM txr_runs")
            .fetch_one(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        let root_for_walk = root.clone();
        let (runs_bytes, models_bytes, other_bytes) = tokio::task::spawn_blocking(move || {
            walk_data_root(&root_for_walk)
        })
        .await
        .map_err(|e| AppError::internal_error(format!("usage walk join: {e}")))?;
        let total = runs_bytes
            .checked_add(models_bytes)
            .and_then(|v| v.checked_add(other_bytes))
            .ok_or_else(|| AppError::internal_error("usage byte figures overflow u64"))?;
        let usage = TxrHistoryUsage {
            run_count: run_count as u32,
            total_bytes: total,
            runs_bytes,
            models_bytes,
            other_bytes,
            data_dir: root.display().to_string(),
            computed_at: Utc::now(),
        };
        store_usage(root, usage.clone());
        Ok(usage)
    }
}

/// The preference singleton's row shape (the module's own two-column read of
/// its own table).
#[derive(Debug, Clone, sqlx::FromRow)]
struct PreferenceRow {
    keep_file_copies: bool,
    updated_at: DateTime<Utc>,
}

/// The all-runs sweep's minimal projection over the ENGINE's run table (two
/// facts, nothing of the run's JSON shape restated — the sweep is not a view
/// and never parses a run row).
#[derive(Debug, Clone, sqlx::FromRow)]
struct RunDirRow {
    id: Uuid,
    dir: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// The usage walk + TTL cache (DEC-8, TEST-HS-3)
// ─────────────────────────────────────────────────────────────────────────────

/// One recursive pass over the data root's TOP-LEVEL entries, grouped by
/// segment per DEC-8: `analysis-*` dirs → runs, `models/` → models,
/// everything else (the env cache under `txr-envs/`, top-level files, …) →
/// other. Each segment's bytes come from [`dir_size`] — the SAME walker the
/// detail's `dir_bytes` uses (one implementation; no new crate, DEC-15).
/// Best-effort: symlinks are not followed, unreadable entries are skipped,
/// a missing root is (0, 0, 0).
fn walk_data_root(root: &Path) -> (u64, u64, u64) {
    let (mut runs, mut models, mut other) = (0u64, 0u64, 0u64);
    let Ok(entries) = std::fs::read_dir(root) else {
        return (runs, models, other);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            other += meta.len();
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let bytes = dir_size(&entry.path()).unwrap_or(0);
        if name == "models" {
            models += bytes;
        } else if name.starts_with("analysis-") {
            runs += bytes;
        } else {
            other += bytes;
        }
    }
    (runs, models, other)
}

/// One cached usage result.
struct UsageCacheEntry {
    at: Instant,
    value: TxrHistoryUsage,
}

/// The in-process usage cache (single-user local app; the figure may be up to
/// `USAGE_TTL` seconds stale — the footer refreshes on the next expiry). The
/// key is the DATA-ROOT PATH: `rootfs::data_root()` is thread-scoped in tests
/// (`scoped_data_root`), so a root-keyed cache is what keeps two concurrent
/// test roots from serving each other's figures.
static USAGE_CACHE: OnceLock<Mutex<Option<(PathBuf, UsageCacheEntry)>>> = OnceLock::new();

fn usage_cache() -> &'static Mutex<Option<(PathBuf, UsageCacheEntry)>> {
    USAGE_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_usage(root: &Path) -> Option<TxrHistoryUsage> {
    let guard = usage_cache().lock().unwrap_or_else(|p| p.into_inner());
    match guard.as_ref() {
        Some((cached_root, entry)) if cached_root == root && entry.at.elapsed() < USAGE_TTL => {
            Some(entry.value.clone())
        }
        _ => None,
    }
}

fn store_usage(root: PathBuf, value: TxrHistoryUsage) {
    let mut guard = usage_cache().lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some((
        root,
        UsageCacheEntry {
            at: Instant::now(),
            value,
        },
    ));
}

/// TEST SEAM (the `rootfs::scoped_data_root` class): drop the cached usage
/// value so the next `usage()` call re-walks. Production never calls it —
/// the TTL is the only expiry in the running app.
pub fn reset_usage_cache() {
    let mut guard = usage_cache().lock().unwrap_or_else(|p| p.into_inner());
    *guard = None;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-HS-1 (the preference singleton + upsert round-trip),
// TEST-HS-2 (the input-dir guard), TEST-HS-3 (the usage walk + TTL cache)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::*;

    /// A fresh temp-FILE pool with the FULL merged chain applied (the build
    /// composer's one chain — the runtime's `MERGED_MIGRATOR` shape; the
    /// module's two tables + the engine's six + model-store's two), WAL off,
    /// `foreign_keys` ON like the app pool (PROV-sqlite-store-1) so the FK +
    /// cascade seams are exercised. The file lives under `TMPDIR` (never
    /// /tmp).
    async fn merged_pool(label: &str) -> SqlitePool {
        let path = std::env::temp_dir().join(format!(
            "history-store-item3-{label}-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR
            .run(&pool)
            .await
            .expect("the merged chain applies");
        pool
    }

    /// A fresh temp data root under `TMPDIR` (never /tmp), created empty.
    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "history-store-item3-{label}-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("data root");
        root
    }

    // ── TEST-HS-1: the preference ──────────────────────────────────────────

    /// The preference row is the MIGRATION's seed — it exists after the
    /// merged chain applies and BEFORE any retention code ran (the
    /// code-INSERT pin: a code path that creates the row would fail THIS
    /// assertion's ordering, and the singleton is never duplicated by an
    /// upsert).
    #[tokio::test]
    async fn preference_row_is_migration_seeded_reads_true_and_upserts() {
        let pool = merged_pool("prefs").await;

        // Assert BEFORE any Retention call: the seed is the migration's.
        let seeded: (bool, String) = sqlx::query_as(
            "SELECT keep_file_copies, updated_at FROM txr_history_preferences WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .expect("the seed row exists from the migration");
        assert!(seeded.0, "the seed is keep_file_copies = true");
        assert!(!seeded.1.is_empty(), "the migration stamps updated_at");

        let retention = Retention::new(pool.clone());

        // GET before any write → the default true.
        let prefs = retention.get_preferences().await.expect("get prefs");
        assert!(prefs.keep_file_copies);
        assert!(
            prefs.updated_at.is_some(),
            "the seeded stamp is part of the wire"
        );

        // PUT false → id = 1 upserted, stamp refreshed, GET returns it.
        let stamp_before = prefs.updated_at.expect("seeded stamp");
        let new = retention
            .update_preferences(&TxrHistoryPreferencesUpdate {
                keep_file_copies: false,
            })
            .await
            .expect("put prefs");
        assert!(!new.keep_file_copies, "the PUT lands");
        let stamp_after = new.updated_at.expect("put stamp");
        assert!(
            stamp_after >= stamp_before,
            "the upsert refreshes updated_at ({stamp_before} → {stamp_after})"
        );
        let got = retention.get_preferences().await.expect("get after put");
        assert!(!got.keep_file_copies);
        assert_eq!(got.updated_at, Some(stamp_after));

        // Still ONE row (the upsert, never an append).
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM txr_history_preferences")
            .fetch_one(&pool)
            .await
            .expect("count prefs");
        assert_eq!(count, 1, "the singleton is one row");

        // PUT again → idempotent, still one row, stamp moves on.
        let again = retention
            .update_preferences(&TxrHistoryPreferencesUpdate {
                keep_file_copies: true,
            })
            .await
            .expect("put again");
        assert!(again.keep_file_copies);
        let count2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM txr_history_preferences")
            .fetch_one(&pool)
            .await
            .expect("count prefs again");
        assert_eq!(count2, 1);
    }

    // ── TEST-HS-2: the input-dir guard ─────────────────────────────────────

    /// The guard accepts exactly a `<root>/analysis-*` run with an existing
    /// `input/`, refuses a tampered/foreign `dir` (nothing deleted — the
    /// guard itself never deletes), and reports `Absent` for a missing
    /// `input/`.
    #[test]
    fn guard_resolves_and_refuses_without_deleting() {
        let root = temp_root("guard");
        let sender = Uuid::new_v4().simple().to_string();
        let run_dir = root.join(format!("analysis-2026-10-26-1002-{sender}"));
        let input = run_dir.join("input");
        std::fs::create_dir_all(&input).expect("run input");
        let user_copy = input.join("patients.csv");
        std::fs::write(&user_copy, b"patient_id\np-1\n").expect("user copy");

        // The honest case: Ok(Input(<dir>/input)).
        let dir = run_dir.display().to_string();
        let target = guard_input_dir(&dir, &root).expect("guarded");
        assert_eq!(
            target,
            ClearTarget::Input(input.clone()),
            "the one shape the engine writes"
        );

        // `/` — refused (nothing deleted).
        assert!(matches!(
            guard_input_dir("/", &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));
        assert!(user_copy.exists(), "a refusal deletes nothing");

        // A `..`-escape — the recorded dir is not <root>/analysis-*.
        let escaped = run_dir
            .join("..")
            .join("not-an-analysis-dir")
            .display()
            .to_string();
        assert!(matches!(
            guard_input_dir(&escaped, &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));

        // A sibling path (same root, wrong shape).
        let sibling = root.join("other-dir");
        std::fs::create_dir_all(sibling.join("input")).expect("sibling input");
        assert!(matches!(
            guard_input_dir(&sibling.display().to_string(), &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));

        // A path whose parent is not the data root at all.
        let elsewhere = std::env::temp_dir().join(format!("elsewhere-{}", Uuid::new_v4()));
        std::fs::create_dir_all(elsewhere.join("input")).expect("elsewhere input");
        assert!(matches!(
            guard_input_dir(&elsewhere.display().to_string(), &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));
        let _ = std::fs::remove_dir_all(&elsewhere);

        // A missing `input/` (the run dir exists, copies were never written
        // or the dir was pruned) → Absent, the honest no-op.
        let empty = root.join(format!("analysis-2026-10-26-1100-{sender}"));
        std::fs::create_dir_all(&empty).expect("empty run dir");
        assert_eq!(
            guard_input_dir(&empty.display().to_string(), &root).expect("absent"),
            ClearTarget::Absent
        );

        // The data root path still exists → the file is intact (nothing any
        // refusal path ever deleted).
        assert!(user_copy.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The symlink defense: a run dir (or its `input/`) that is a symlink
    /// OUT is refused by the canonicalize + floor probes even though its
    /// lexical name is exactly right — and the outside tree is untouched.
    #[cfg(unix)]
    #[test]
    fn guard_refuses_a_symlink_escape() {
        let root = temp_root("symlink");
        let outside = temp_root("outside");
        let outside_input = outside.join("input");
        std::fs::create_dir_all(&outside_input).expect("outside input");
        let outside_file = outside_input.join("data.csv");
        std::fs::write(&outside_file, b"outside-bytes").expect("outside file");

        let link = root.join("analysis-2026-10-26-1002-01234567");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink run dir");
        assert!(matches!(
            guard_input_dir(&link.display().to_string(), &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));
        assert!(
            outside_file.exists(),
            "the symlink-escape refusal deletes nothing outside"
        );

        // The inverse: a REAL run dir whose `input/` is a symlink out.
        let real = root.join("analysis-2026-10-26-1002-abcdef01");
        std::fs::create_dir_all(&real).expect("real run dir");
        std::os::unix::fs::symlink(&outside_input, real.join("input")).expect("symlink input");
        assert!(matches!(
            guard_input_dir(&real.display().to_string(), &root),
            Err(e) if e.error_code() == HistoryErrorCode::UnsafeRunDir.code()
        ));
        assert!(outside_file.exists());

        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── TEST-HS-3: the usage walk + TTL cache ──────────────────────────────

    /// Write a file of exactly `n` bytes (deterministic sizes).
    fn write_file(path: PathBuf, n: usize) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mk parent");
        std::fs::write(path, vec![0u8; n]).expect("write file");
    }

    /// The usage walk groups by top-level segment, sums recursively, and the
    /// 10-second cache serves a stale figure within the TTL — with the
    /// per-root key so two data roots never serve each other's value.
    #[tokio::test]
    async fn usage_walk_groups_by_segment_and_caches_for_the_ttl() {
        let root = temp_root("usage");
        write_file(
            root.join("analysis-2026-10-26-1002-aaaaaaaa/input/patients.csv"),
            10,
        );
        write_file(
            root.join("analysis-2026-10-26-1002-aaaaaaaa/bundles/landmark/train.csv"),
            5,
        );
        write_file(root.join("analysis-2026-10-26-0930-bbbbbbbb/output/pred.csv"), 7);
        write_file(root.join("models/trees/cohort/tree.bin"), 20);
        write_file(root.join("txr-envs/python/base.squashfs"), 3);
        write_file(root.join("stats.json"), 4);

        let pool = merged_pool("usage").await;
        let retention = Retention::new(pool);

        let _g = rootfs::scoped_data_root(root.clone());
        reset_usage_cache();

        let usage = retention.usage().await.expect("usage");
        assert_eq!(usage.run_count, 0, "no seeded runs");
        assert_eq!(usage.runs_bytes, 15 + 7, "analysis-* dirs sum recursively");
        assert_eq!(usage.models_bytes, 20, "models/ is its own segment");
        assert_eq!(usage.other_bytes, 3 + 4, "the env cache + top-level file land in other");
        assert_eq!(usage.total_bytes, 49);
        assert_eq!(usage.data_dir, root.display().to_string());
        assert!(usage.computed_at.timestamp() > 0, "the stamp is fresh");

        // Within the TTL: a NEW file is NOT reflected (the cached figure is
        // served — a walk per keystroke is the DISC-planned anti-behaviour).
        write_file(
            root.join("analysis-2026-10-26-1002-aaaaaaaa/input/new.csv"),
            9,
        );
        let served = retention.usage().await.expect("cached usage");
        assert_eq!(served.total_bytes, 49, "the TTL serves the cached figure");

        // Reset (the test seam for the 10 s): the next call re-walks.
        reset_usage_cache();
        let fresh = retention.usage().await.expect("fresh usage");
        assert_eq!(fresh.total_bytes, 58, "the re-walk sees the new file");
        assert_eq!(fresh.runs_bytes, 31);

        // The cache is keyed by the data-root path: a DIFFERENT (empty) root
        // is served its own (zero) figures, never root1's cached value.
        let root2 = temp_root("usage2");
        let _g2 = rootfs::scoped_data_root(root2.clone());
        reset_usage_cache();
        let usage2 = retention.usage().await.expect("usage2");
        assert_eq!(usage2.total_bytes, 0);
        assert_eq!(usage2.data_dir, root2.display().to_string());

        // Back on root1 (still inside... the TTL for root1 is not serving
        // root2's value — keying pinned by the root account).
        drop(_g2);
        let back = retention.usage().await.expect("root1 again");
        assert_eq!(back.data_dir, root.display().to_string());
        assert_eq!(back.total_bytes, 58);

        let _ = std::fs::remove_dir_all(&root2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
