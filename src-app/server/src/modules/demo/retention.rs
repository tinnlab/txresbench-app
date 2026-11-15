//! The demo's shared-pool retention (demo-mode ITEM-4: retention, global,
//! pinned examples).
//!
//! ## The one policy
//!
//! The demo keeps the NEWEST `history_limit` non-pinned runs and the newest
//! non-pinned model sets/models up to `model_limit` — everything older
//! non-pinned is deleted (rows in one transaction, files AFTER the commit, so
//! a crash can never remove files whose rows still exist). Pinned entries are
//! never evicted and NOT counted: the boot-seeded example runs
//! ([`super::replay::seed_example_runs`] — one finished replay run per
//! recorded configuration, marked in `txr_demo_seeded_runs`) and the example
//! model set (the `txr_example_set` ready row's set id, derived — the ONE
//! example set of a deployment). A run that is still replaying is never
//! evicted: the run's non-terminal status (or a live [`super::replay`]
//! control registry entry) is a hard exclude, so a burst of visitors can
//! transiently overflow the limit while their replays run — the specified
//! behaviour (they are evicted as they finish).
//!
//! ## When it runs
//!
//! * Synchronously at boot (`lib.rs::build_app` — pre-serving, so the seed's
//!   rows are born terminal and no request can race them): seed the example
//!   runs, enforce the limits, sweep the orphan files of a crashed cleanup,
//!   reap stale sessions.
//! * After every run insert (`create_replay`/`rerun_replay`) and every
//!   model-set save (`models/save`, the example-set seed): a detached
//!   enforcement pass (serialized by [`housekeeping_lock`]).
//! * A periodic job (every 10 minutes): enforce + reap stale sessions.
//!
//! ## The crash-window closes (no orphan files)
//!
//! "Rows in one transaction, files after commit" has ONE crash window: the
//! commit succeeded, the files were not yet removed. The boot sweep removes
//! the leftovers: a `<data_root>/analysis-*` dir whose run row is gone, and a
//! model-store tree dir whose digest has no reference (age-gated — an
//! in-flight save's tree is born BEFORE its row, so a no-age-gate walk would
//! race a live save; the gate is the same "older than the longest plausible
//! operation" idea as the store's own staging sweep, which this sweep also
//! calls — the model-store orphan half). Every removal re-checks the row
//! fresh per target.
//!
//! ## Non-scope
//!
//! The engine's own deletions (copy-clear, explicit row deletes) are
//! untouched; the demo blocks delete/rename from the API (ITEM-1's
//! allowlist), so the retention sweep is the ONLY destructive surface in
//! demo mode. Stale anonymous sessions: a session unseen for a full cookie
//! lifetime (30 days — `session.rs`'s Max-Age, the one staleness number a
//! browser can also see) has its visitor USER row removed (the auth rows
//! cascade) — the shared runs stay (their ownership rows are session-id
//! strings, not FKs; a reaped session's runs are simply controlled by
//! nobody), and a still-active visitor is never reaped (every request
//! touches `last_seen_at`).

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;

use crate::modules::execution_engine::orchestrator;
use crate::modules::model_store::store;
use crate::modules::rootfs;

/// The stale-session horizon: a demo session unseen for a full cookie
/// lifetime is stale (the cookie's own Max-Age is the one staleness number
/// the browser can also observe — 30 days, `session.rs`).
const STALE_SESSION_DAYS: i64 = 30;

/// The model-tree orphan age gate: a tree dir.Below this age a tree without
/// references may simply be an in-flight save (the save copies the tree
/// BEFORE inserting the row), so only an aged one is reclaimed. Same idea as
/// the store's own `STAGING_MAX_AGE` (24 h) with a much shorter horizon —
/// the retention's own trees only ever went through a commit-then-prune
/// window, never a multi-GiB import.
const TREE_ORPHAN_AGE: Duration = Duration::from_secs(60 * 60);

/// The periodic job's tick (every 10 minutes — the plan's number).
const PERIODIC_TICK: Duration = Duration::from_secs(10 * 60);

/// The wire shape of `GET /api/txr/history/usage` in demo mode (ITEM-4; the
/// desktop arm keeps the byte-figure shape). `runs`/`models` are the COUNTED
/// (non-pinned) entries — the "37 of 50 runs" counters; `pinned_runs` /
/// `pinned_models` are the pinned side (never evicted, not counted);
/// `shared: true` is the shared-pool announcement flag.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DemoUsage {
    pub runs: u32,
    pub run_limit: u32,
    pub models: u32,
    pub model_limit: u32,
    pub pinned_runs: u32,
    pub pinned_models: u32,
    pub shared: bool,
}

/// One enforcement pass's numbers (the boot + the logs; not a wire type).
#[derive(Debug, Default, Clone)]
pub struct EnforceReport {
    pub runs_evicted: u32,
    pub set_dirs: u32,
    pub models_evicted: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// The housekeeping serialization (detached enforcement passes + the periodic
// tick must never run two deletions at once; the sync boot pass is
// pre-serving, so it needs no lock)
// ─────────────────────────────────────────────────────────────────────────────

static HOUSEKEEPING_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn housekeeping_lock() -> &'static tokio::sync::Mutex<()> {
    HOUSEKEEPING_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// A detached enforcement pass (the "after every run/model-set insert" rule:
/// the API call is not held up by the sweep, the report is logged). The lock
/// serializes passes; a pass is idempotent, so a queued backlog converges.
pub fn enforce_limits_detached(pool: SqlitePool) {
    tokio::spawn(async move {
        let _guard = housekeeping_lock().lock().await;
        match enforce_limits(&pool).await {
            Ok(report) => {
                if report.runs_evicted > 0 || report.models_evicted > 0 {
                    tracing::info!(
                        runs = report.runs_evicted,
                        sets = report.set_dirs,
                        models = report.models_evicted,
                        "demo retention: enforced the shared-pool limits"
                    );
                }
            }
            Err(e) => {
                tracing::warn!(error = ?e, "demo retention: enforcement failed");
            }
        }
    });
}

/// The periodic task (every 10 minutes: enforce the limits + reap stale
/// sessions — the boot half ran already). Spawned by the sync boot pass.
fn spawn_periodic(pool: SqlitePool) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(PERIODIC_TICK);
        tick.tick().await; // the first tick is immediate — consume it (the boot pass ran)
        loop {
            tick.tick().await;
            let _guard = housekeeping_lock().lock().await;
            if let Err(e) = enforce_limits(&pool).await {
                tracing::warn!(error = ?e, "demo retention: periodic enforcement failed");
            }
            if let Err(e) = reap_stale_sessions(&pool).await {
                tracing::warn!(error = ?e, "demo retention: periodic session reap failed");
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The pinned predicates
// ─────────────────────────────────────────────────────────────────────────────

/// Is this run pinned (a boot-seeded example run)?
pub async fn is_pinned_run(pool: &SqlitePool, run_id: Uuid) -> Result<bool, AppError> {
    let pinned = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM txr_demo_seeded_runs WHERE run_id = $1) as "pinned!: bool""#,
        run_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(pinned)
}

/// The ONE pinned set of a deployment: the `txr_example_set` ready row's set
/// id (the demo example set — the desktop arm is irrelevant: the demo's
/// own DB only ever has the demo-seeded set).
pub async fn example_set_id(pool: &SqlitePool) -> Result<Option<Uuid>, AppError> {
    let set_id = sqlx::query_scalar!(
        r#"SELECT set_id as "set_id?: Uuid" FROM txr_example_set
           WHERE id = 1 AND state = 'ready' AND set_id IS NOT NULL"#,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(set_id.flatten())
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/txr/history/usage (demo arm)
// ─────────────────────────────────────────────────────────────────────────────

/// The demo counters (the shared-pool "n of 50" figures + the pinned side).
pub async fn usage(pool: &SqlitePool) -> Result<DemoUsage, AppError> {
    let pinned_runs: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM txr_demo_seeded_runs")
        .fetch_one(pool)
        .await
        .map_err(AppError::database_error)?;
    let runs: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) FROM txr_runs r
           WHERE NOT EXISTS (SELECT 1 FROM txr_demo_seeded_runs s WHERE s.run_id = r.id)"#
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?;

    let example = example_set_id(pool).await?;
    let (models, pinned_models): (i64, i64) = match example {
        Some(set_id) => {
            let models: i64 = sqlx::query_scalar!(
                "SELECT COUNT(*) FROM txr_models WHERE set_id IS NULL OR set_id <> $1",
                set_id,
            )
            .fetch_one(pool)
            .await
            .map_err(AppError::database_error)?;
            let pinned: i64 = sqlx::query_scalar!(
                "SELECT COUNT(*) FROM txr_models WHERE set_id = $1",
                set_id,
            )
            .fetch_one(pool)
            .await
            .map_err(AppError::database_error)?;
            (models, pinned)
        }
        None => {
            let models: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM txr_models")
                .fetch_one(pool)
                .await
                .map_err(AppError::database_error)?;
            (models, 0)
        }
    };

    Ok(DemoUsage {
        runs: runs as u32,
        run_limit: history_limit(),
        models: models as u32,
        model_limit: model_limit(),
        pinned_runs: pinned_runs as u32,
        pinned_models: pinned_models as u32,
        shared: true,
    })
}

fn history_limit() -> u32 {
    super::state().map(|s| s.history_limit).unwrap_or(50)
}

fn model_limit() -> u32 {
    super::state().map(|s| s.model_limit).unwrap_or(50)
}

// ─────────────────────────────────────────────────────────────────────────────
// The enforcement (rows in one transaction, files after the commit)
// ─────────────────────────────────────────────────────────────────────────────

/// A run row's retention-relevant projection.
#[derive(Debug, Clone, sqlx::FromRow)]
struct RunCandidate {
    id: Uuid,
    dir: String,
    status: String,
}

/// One model set with its model count (newest-kept / oldest-evicted order is
/// the caller's `ORDER BY`).
#[derive(Debug, Clone, sqlx::FromRow)]
struct SetCandidate {
    id: Uuid,
    models: i64,
}

/// Enforce both limits: delete the oldest non-pinned runs beyond
/// `history_limit` (terminal ones only — a live replay is never evicted) and
/// the oldest non-pinned model sets whose models exceed `model_limit` (a set
/// is evicted WHOLE — rows + files; the set is the save unit, its models go
/// with it, per D14's cascade semantics). Rows first (one transaction), files
/// after the commit.
pub async fn enforce_limits(pool: &SqlitePool) -> Result<EnforceReport, AppError> {
    let mut report = EnforceReport::default();

    // ── runs ────────────────────────────────────────────────────────────────
    let limit = history_limit() as i64;
    let rows = sqlx::query_as!(
        RunCandidate,
        r#"SELECT id as "id: Uuid", dir, status FROM txr_runs
           ORDER BY created_at DESC, id DESC"#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    let mut counted = 0i64;
    let mut victim_runs: Vec<(Uuid, String)> = Vec::new();
    for row in rows {
        if is_pinned_run(pool, row.id).await? {
            continue;
        }
        counted += 1;
        if counted <= limit {
            continue;
        }
        // Beyond the limit: a live replay (non-terminal status, or a live
        // control registry — the running→finished window) is kept this round.
        if run_is_live(&row.status) || super::replay::is_replay_live(row.id) {
            continue;
        }
        victim_runs.push((row.id, row.dir));
    }
    if !victim_runs.is_empty() {
        let mut tx = pool.begin().await.map_err(AppError::database_error)?;
        for (id, _) in &victim_runs {
            sqlx::query("DELETE FROM txr_runs WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(AppError::database_error)?;
        }
        tx.commit().await.map_err(AppError::database_error)?;
        // Files after the commit (the crash window is closed by the boot
        // sweep; the removal is best-effort per dir — a refused dir is
        // logged, never the failure of the rows' deletion).
        for (_, dir) in &victim_runs {
            remove_dir_best_effort(Path::new(dir));
        }
        report.runs_evicted = victim_runs.len() as u32;
    }

    // ── model sets ──────────────────────────────────────────────────────────
    let example = example_set_id(pool).await?;
    let base_set_ids: Vec<SetCandidate> = if let Some(example_id) = example {
        sqlx::query_as!(
            SetCandidate,
            r#"SELECT s.id as "id: Uuid", COUNT(m.id) as "models!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               WHERE s.id <> $1
               GROUP BY s.id
               ORDER BY s.created_at ASC, s.id ASC"#,
            example_id,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?
    } else {
        sqlx::query_as!(
            SetCandidate,
            r#"SELECT s.id as "id: Uuid", COUNT(m.id) as "models!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               GROUP BY s.id
               ORDER BY s.created_at ASC, s.id ASC"#,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?
    };
    let counted_models: i64 = base_set_ids.iter().map(|s| s.models).sum();
    if counted_models > model_limit() as i64 {
        // Oldest-first walk; a set's models all count against the limit, and
        // evicting a set removes them ALL (the save unit — never a partial
        // set: the reuse flow needs a whole set).
        let mut reclaimed = 0i64;
        let mut victim_sets: Vec<(Uuid, i64)> = Vec::new();
        for set in &base_set_ids {
            if counted_models - reclaimed <= model_limit() as i64 {
                break;
            }
            victim_sets.push((set.id, set.models));
            reclaimed += set.models;
        }
        if !victim_sets.is_empty() {
            // The digests of the evicted models (the file-prune list).
            let mut digests: Vec<String> = Vec::new();
            for (set_id, _) in &victim_sets {
                let set_digests = sqlx::query_scalar!(
                    "SELECT tree_sha256 FROM txr_models WHERE set_id = $1",
                    set_id,
                )
                .fetch_all(pool)
                .await
                .map_err(AppError::database_error)?;
                digests.extend(set_digests);
            }
            let mut tx = pool.begin().await.map_err(AppError::database_error)?;
            for (set_id, _) in &victim_sets {
                sqlx::query("DELETE FROM txr_model_sets WHERE id = $1")
                    .bind(set_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(AppError::database_error)?;
            }
            tx.commit().await.map_err(AppError::database_error)?;
            // Files after the commit: the unreferenced trees (the refcount is
            // the authority — a digest still used by a surviving set is
            // untouched) + the set's training dir, when the save kept one.
            if let Err(e) = store::prune_unreferenced_trees(pool, &digests).await {
                tracing::warn!(error = ?e, "demo retention: tree prune failed");
            }
            for (set_id, _) in &victim_sets {
                let _ = store::remove_training_dir(*set_id);
            }
            report.set_dirs = victim_sets.len() as u32;
            report.models_evicted = victim_sets.iter().map(|(_, n)| *n).sum::<i64>() as u32;
        }
    }

    Ok(report)
}

/// The live-replay predicate: a non-terminal run status.
fn run_is_live(status: &str) -> bool {
    matches!(status, "creating" | "preparing" | "running" | "finishing")
}

/// Best-effort dir removal (the engine's prune rule: missing is success;
/// a refusal is logged, never a failure of the enforcement).
fn remove_dir_best_effort(dir: &Path) {
    match orchestrator::prune_run_dir(dir) {
        Ok(()) => {}
        Err(e) => {
            tracing::warn!(dir = %dir.display(), error = ?e,
                "demo retention: could not remove the evicted run's dir");
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale anonymous sessions
// ─────────────────────────────────────────────────────────────────────────────

/// Remove sessions unseen for [`STALE_SESSION_DAYS`]: each stale visit's
/// visitor USER row (its refresh tokens / group memberships cascade) and the
/// session row itself, in one transaction. The shared runs stay — the
/// run-creator rows are session-id strings, and a reaped session's runs are
/// simply controlled by nobody (the same rule as a run that never had a
/// creator row). The cutoff is computed by SQLite with the SAME `strftime`
/// formatter the rows were written with, so the text comparison is a
/// same-format chronological one.
pub async fn reap_stale_sessions(pool: &SqlitePool) -> Result<u32, AppError> {
    let stale: Vec<Uuid> = sqlx::query_scalar(
        r#"SELECT user_id FROM txr_demo_sessions
           WHERE last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"#,
    )
    .bind(format!("-{STALE_SESSION_DAYS} days"))
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    if stale.is_empty() {
        return Ok(0);
    }
    let mut tx = pool.begin().await.map_err(AppError::database_error)?;
    for user_id in &stale {
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(&mut *tx)
            .await
            .map_err(AppError::database_error)?;
    }
    sqlx::query(
        r#"DELETE FROM txr_demo_sessions
           WHERE last_seen_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)"#,
    )
    .bind(format!("-{STALE_SESSION_DAYS} days"))
    .execute(&mut *tx)
    .await
    .map_err(AppError::database_error)?;
    tx.commit().await.map_err(AppError::database_error)?;
    Ok(stale.len() as u32)
}

// ─────────────────────────────────────────────────────────────────────────────
// The boot pass (lib.rs, pre-serving) + the orphan sweep
// ─────────────────────────────────────────────────────────────────────────────

/// The boot pass: seed the pinned example runs, enforce the limits, sweep
/// the orphan files of a crashed cleanup, reap stale sessions, and arm the
/// 10-minute job. Runs inside `build_app` BEFORE the listener accepts, so
/// the seed's rows are born terminal and no request can race them.
pub async fn boot_pass(pool: SqlitePool) {
    match super::replay::seed_example_runs(&pool, super::bundle()).await {
        Ok(seeded) if !seeded.is_empty() => {
            tracing::info!(runs = seeded.len(), "demo retention: seeded the pinned example runs");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!(error = ?e, "demo retention: example-run seeding failed");
        }
    }
    if let Err(e) = enforce_limits(&pool).await {
        tracing::warn!(error = ?e, "demo retention: boot enforcement failed");
    }
    match sweep_orphans(&pool).await {
        Ok(removed) if removed > 0 => {
            tracing::info!(removed, "demo retention: boot orphan sweep reclaimed files");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = ?e, "demo retention: boot orphan sweep failed");
        }
    }
    if let Err(e) = reap_stale_sessions(&pool).await {
        tracing::warn!(error = ?e, "demo retention: boot session reap failed");
    }
    spawn_periodic(pool);
}

/// Reclaim the file leftovers of a crashed cleanup (the "rows committed,
/// files not yet removed" window) plus the model-store's own aged staging
/// orphans. Run-dirs: every removal re-checks the run row (a dir whose row
/// exists — or whose row is being inserted BEFORE its dirs, the create
/// path's order — is never touched). Model trees: age-gated + refcounted
/// (a fresh unreferenced tree may be an in-flight save's).
pub async fn sweep_orphans(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut removed = 0u64;

    // Run dirs without a run row (the crash window of the run half).
    let root = rootfs::data_root();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("analysis-") {
                continue;
            }
            let dir_str = entry.path().to_string_lossy().to_string();
            let has_row: bool = sqlx::query_scalar!(
                r#"SELECT EXISTS (SELECT 1 FROM txr_runs WHERE dir = $1) as "has!: bool""#,
                dir_str,
            )
            .fetch_one(pool)
            .await
            .map_err(AppError::database_error)?;
            if !has_row {
                remove_dir_best_effort(&entry.path());
                removed += 1;
            }
        }
    }

    // Model-store trees without a reference, aged past the in-flight-save
    // window (a save copies the tree BEFORE its row — an age gate is the
    // only honest discriminator for a scan).
    let trees_dir = store::trees_dir();
    if let Ok(entries) = std::fs::read_dir(&trees_dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !crate::modules::sandbox::stack::is_sha256_hex(&name) {
                continue;
            }
            let aged = meta
                .modified()
                .map(|m| m.elapsed().map(|e| e > TREE_ORPHAN_AGE).unwrap_or(false))
                .unwrap_or(false);
            if !aged {
                continue;
            }
            let refs: i64 = sqlx::query_scalar!(
                "SELECT COUNT(*) as \"refs!: i64\" FROM txr_models WHERE tree_sha256 = $1",
                name,
            )
            .fetch_one(pool)
            .await
            .map_err(AppError::database_error)?;
            if refs == 0 {
                remove_dir_best_effort(&entry.path());
                removed += 1;
            }
        }
    }

    // The model-store's own orphan half: aged staging entries of a process
    // killed mid-save/import/export (the store's standing sweep).
    removed += store::sweep_stale_staging();

    // The retention's own sweep is complete; the orphan WALK could race a
    // live create only if a dir were born BEFORE its row — the create path
    // inserts the row first (stage_replay_run), and the seed runs pre-serving.
    Ok(removed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — the enforcement rules + the usage counters + the crash-window
// sweep + the stale-session reap (the HTTP tier of the counters lives in
// `tests/demo/mod.rs`)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — the enforcement rules + the usage counters + the crash-window
// sweep + the stale-session reap (the HTTP tier of the counters lives in
// `tests/demo/mod.rs`)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use crate::modules::execution_engine::repository::{NewRun, TxrRepository};
    use crate::modules::execution_engine::types::{
        RunConfig, TxrRunCounts, TxrRunFileNames, TxrRunInputSummary, TxrRunMode, TxrRunStatus,
    };
    use crate::modules::model_store::repository::{ModelStoreRepository, NewModel};
    use crate::modules::rootfs;

    use super::*;

    /// A scratch dir under `TMPDIR` (never the repo), removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join("txr-demo-retention");
            std::fs::create_dir_all(&base).expect("scratch base");
            let dir = base.join(format!("{tag}-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A migrated scratch pool (the MERGED chain — the same source the boot
    /// applies, so the demo's own migrations are present).
    async fn test_db() -> (SqlitePool, Scratch) {
        let scratch = Scratch::new("db");
        let path = scratch.0.join("txr.sqlite");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .expect("test sqlite connects");
        static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-merged");
        MIGRATOR.run(&pool).await.expect("merged migrations apply");
        (pool, scratch)
    }

    fn summary() -> TxrRunInputSummary {
        TxrRunInputSummary {
            patients: Some(94),
            predict_patients: None,
            markers: 3,
            events: Some(630),
            file_names: TxrRunFileNames {
                patients: Some("patients.csv".into()),
                measurements: "measurements.csv".into(),
                predict_measurements: None,
            },
        }
    }

    fn counts(finished: u32) -> TxrRunCounts {
        TxrRunCounts {
            finished,
            failed: 0,
            stopped: 0,
            skipped: 0,
            cannot_run: 0,
            running: 0,
            downloading: 0,
            waiting: 0,
        }
    }

    /// Insert one terminal run (optionally `running` — a replaying run).
    async fn insert_run(
        repo: &TxrRepository,
        created_at_secs: i64,
        status: TxrRunStatus,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let created = chrono::DateTime::<chrono::Utc>::from_timestamp(created_at_secs, 0)
            .expect("timestamp");
        repo.insert_run(&NewRun {
            id,
            created_at: Some(created),
            status,
            mode: TxrRunMode::Train,
            config: RunConfig::default(),
            input_summary: summary(),
            model_ids: Vec::new(),
            method_count: 1,
            counts: counts(1),
            dir: format!("/nonexistent/analysis-{id}"),
            memory_total_bytes: None,
            cpus: None,
            seed: 1,
            estimate: None,
        })
        .await
        .expect("run insert");
        id
    }

    /// A synthetic produced-model record (the model-store test's fixture
    /// shape; opaque bytes are never opened).
    fn new_model(set_id: Uuid, tree_sha256: &str, name: &str) -> NewModel {
        NewModel {
            set_id: Some(set_id),
            name: name.to_string(),
            method_id: "kelim".to_string(),
            method_version: "1.2.0".to_string(),
            group: "kinetics".to_string(),
            group_label: "Kinetics".to_string(),
            task: Some("pfs".to_string()),
            provenance: "run".to_string(),
            imported_from: None,
            pretrained_catalogue_id: None,
            pretrained_catalogue_version: None,
            licence: None,
            tree_sha256: tree_sha256.to_string(),
            dir: format!("/data/models/trees/{tree_sha256}"),
            size_bytes: 4096,
            contract: "2.0".to_string(),
            env_base_digest: Some("sha256:base0000".to_string()),
            env_layer_digest: Some("sha256:layer000".to_string()),
            trained_on_patients: Some(151),
            trained_at: None,
            decision_day: 56.0,
            endpoint: "pfs".to_string(),
            horizon: 238.0,
            features: serde_json::json!(["M1", "M2"]),
            required_markers: None,
            marker_facts: serde_json::json!({"kind": "single", "count": 2}),
            covariates: serde_json::json!({"catalogue": "optional", "used": true}),
            embeds_training_data: false,
            own_auc: Some(0.66),
            own_c: None,
            conversions: serde_json::json!({}),
        }
    }

    /// One set with `count` models (the eviction unit), backdated so the
    /// tests control the eviction order.
    async fn insert_set(
        pool: &SqlitePool,
        repo: &ModelStoreRepository,
        created_at_secs: i64,
        count: u32,
        prefix: &str,
    ) -> Uuid {
        let set = repo
            .insert_set(&format!("{prefix} {created_at_secs}"), None, Some("example"), false, None)
            .await
            .expect("set insert");
        sqlx::query(
            "UPDATE txr_model_sets SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?",
        )
        .bind(format!("-{} seconds", 1_700_000_200 - created_at_secs))
        .bind(set.id)
        .execute(pool)
        .await
        .unwrap();
        for i in 0..count {
            let digest = format!("{:064x}", (created_at_secs * 100 + i as i64) as u64);
            repo.insert_model(&new_model(set.id, &digest, &format!("{prefix}-{i}")))
                .await
                .expect("model insert");
        }
        set.id
    }

    #[tokio::test]
    async fn enforce_evicts_the_oldest_non_pinned_beyond_the_limit() {
        let (pool, _scratch) = test_db().await;
        let repo = TxrRepository::new(pool.clone());

        // 60 finished runs, oldest first; run #3 is PINNED (a seeded example
        // run) and run #8 is STILL LIVE (preparing — a replaying run).
        let mut ids = Vec::new();
        for i in 0..60 {
            let status = if i == 8 {
                TxrRunStatus::Preparing
            } else {
                TxrRunStatus::Finished
            };
            ids.push(insert_run(&repo, 1_700_000_000 + i, status).await);
        }
        sqlx::query("INSERT INTO txr_demo_seeded_runs (configuration_id, run_id) VALUES ($1, $2)")
            .bind("pfs_d56_h238")
            .bind(ids[2])
            .execute(&pool)
            .await
            .expect("pin row");

        let report = enforce_limits(&pool).await.expect("enforce runs");
        assert_eq!(
            report.runs_evicted, 8,
            "59 counted + 1 pinned: the newest 50 stay; the 9 oldest counted beyond it — and \
             the live one among them stays: {report:?}"
        );

        // The 10 oldest non-pinned runs (0,1,3,4,5,6,7,9) go; the pinned #2
        // and the live #8 stay; the newest 50 counted runs stay.
        for i in [0usize, 1, 3, 4, 5, 6, 7, 9] {
            assert!(repo.get_run(ids[i]).await.unwrap().is_none(), "run {i} evicted");
        }
        for i in [2usize, 8] {
            assert!(repo.get_run(ids[i]).await.unwrap().is_some(), "run {i} kept");
        }
        for i in 10..60 {
            assert!(repo.get_run(ids[i]).await.unwrap().is_some(), "run {i} among the newest 50");
        }

        // Idempotent: a second pass evicts nothing new.
        let again = enforce_limits(&pool).await.expect("second enforce");
        assert_eq!(again.runs_evicted, 0, "idempotent: {again:?}");
    }

    #[tokio::test]
    async fn enforce_evicts_whole_sets_never_the_pinned_example_set() {
        let (pool, _scratch) = test_db().await;
        let repo = ModelStoreRepository::new(pool.clone());

        // The example set (the ONE pinned set) + 60 non-pinned sets of 1 model.
        let example_id = insert_set(&pool, &repo, 1_700_000_000, 2, "Example models").await;
        sqlx::query("INSERT INTO txr_example_set (id, state, set_id) VALUES (1, 'ready', $1)")
            .bind(example_id)
            .execute(&pool)
            .await
            .expect("example state row");
        let mut set_ids = Vec::new();
        for i in 0..60 {
            set_ids.push(insert_set(&pool, &repo, 1_700_000_100 + i, 1, "Demo models").await);
        }

        let report = enforce_limits(&pool).await.expect("enforce runs");
        // The example set's models are NOT counted: 60 counted models, 50
        // stay, the 10 oldest sets go WHOLE (the save unit).
        assert_eq!(report.set_dirs, 10, "10 whole sets evicted: {report:?}");
        assert_eq!(report.models_evicted, 10, "one model per set: {report:?}");

        for i in 0..10 {
            assert!(repo.get_set(set_ids[i]).await.unwrap().is_none(), "the oldest set {i} is gone");
        }
        for i in 10..60 {
            assert!(repo.get_set(set_ids[i]).await.unwrap().is_some(), "set {i} kept");
        }
        let example = repo.get_set(example_id).await.unwrap().expect("the pinned set");
        assert!(example.name.starts_with("Example models"), "the pinned example set survives");
        let models = repo.list_models(Some(example_id), None, None).await.unwrap();
        assert_eq!(models.len(), 2, "the example set's models survive whole");
    }

    #[tokio::test]
    async fn usage_reports_the_pinned_and_counted_sides() {
        let (pool, _scratch) = test_db().await;
        let repo = TxrRepository::new(pool.clone());
        let models = ModelStoreRepository::new(pool.clone());

        let pinned = insert_run(&repo, 1_700_000_000, TxrRunStatus::Finished).await;
        sqlx::query("INSERT INTO txr_demo_seeded_runs (configuration_id, run_id) VALUES ($1, $2)")
            .bind("pfs_d56_h238")
            .bind(pinned)
            .execute(&pool)
            .await
            .expect("pin row");
        for i in 0..3 {
            insert_run(&repo, 1_700_000_100 + i, TxrRunStatus::Finished).await;
        }
        let example_id = insert_set(&pool, &models, 1_700_000_000, 2, "Example models").await;
        sqlx::query("INSERT INTO txr_example_set (id, state, set_id) VALUES (1, 'ready', $1)")
            .bind(example_id)
            .execute(&pool)
            .await
            .expect("example state row");
        insert_set(&pool, &models, 1_700_000_100, 1, "Demo models").await;
        insert_set(&pool, &models, 1_700_000_200, 1, "Another demo set").await;

        let usage = usage(&pool).await.expect("usage");
        assert_eq!(usage.runs, 3, "counted runs (the pinned one is not counted)");
        assert_eq!(usage.run_limit, 50, "the default limit (no boot state in unit tests)");
        assert_eq!(usage.models, 2, "counted models (the pinned set's are not counted)");
        assert_eq!(usage.pinned_runs, 1, "{usage:?}");
        assert_eq!(usage.pinned_models, 2);
        assert!(usage.shared, "the shared-pool flag");
    }

    #[tokio::test]
    async fn stale_sessions_are_reaped_but_live_ones_stay() {
        let (pool, _scratch) = test_db().await;

        for (id, username, days_ago) in [
            (Uuid::new_v4(), "guest-stale", "-31 days".to_string()),
            (Uuid::new_v4(), "guest-fresh", "-1 days".to_string()),
        ] {
            sqlx::query("INSERT INTO users (id, username, email) VALUES ($1, $2, $3)")
                .bind(id)
                .bind(username)
                .bind(format!("{username}@demo.invalid"))
                .execute(&pool)
                .await
                .expect("user insert");
            sqlx::query(
                r#"INSERT INTO txr_demo_sessions (id, user_id, last_seen_at)
                   VALUES ($1, $2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', $3))"#,
            )
            .bind(id)
            .bind(id)
            .bind(days_ago)
            .execute(&pool)
            .await
            .expect("session insert");
        }

        let reaped = reap_stale_sessions(&pool).await.expect("reap runs");
        assert_eq!(reaped, 1, "the 31-day session is reaped");
        let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM txr_demo_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sessions, 1, "the fresh session stays");
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(users, 1, "the stale visitor's user row is gone (the fresh one stays)");
    }

    #[tokio::test]
    async fn orphan_sweep_reclaims_a_crashed_cleanups_files_only() {
        let (pool, scratch) = test_db().await;
        let _root_guard = rootfs::scoped_data_root(scratch.0.join("data"));
        let root = rootfs::data_root();
        store::ensure_dirs().expect("store dirs");

        // The run-dir halves: a dir whose row is gone (the commit-then-prune
        // crash window) is reclaimed; a dir with a live row is kept.
        let orphan = root.join("analysis-orphan-run");
        let live = root.join("analysis-live-run");
        std::fs::create_dir_all(orphan.join("output")).unwrap();
        std::fs::create_dir_all(live.join("output")).unwrap();
        let repo = TxrRepository::new(pool.clone());
        let live_id = insert_run(&repo, 1_700_000_000, TxrRunStatus::Finished).await;
        sqlx::query("UPDATE txr_runs SET dir = $2 WHERE id = $1")
            .bind(live_id)
            .bind(live.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();

        // The tree halves: an AGED, unreferenced tree is reclaimed; a FRESH
        // unreferenced one is kept (an in-flight save's); an aged one with a
        // reference survives the refcount guard.
        let stale_digest = "a".repeat(64);
        let fresh_digest = "b".repeat(64);
        let bound_digest = "c".repeat(64);
        for digest in [&stale_digest, &fresh_digest, &bound_digest] {
            let dir = store::trees_dir().join(digest);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("demo-model.json"), "{}").unwrap();
            if digest != &fresh_digest {
                let two_days_ago = chrono::Utc::now() - chrono::TimeDelta::days(2);
                let f = std::fs::File::open(&dir).unwrap();
                f.set_modified(two_days_ago.into()).expect("backdate the tree");
            }
        }
        let models = ModelStoreRepository::new(pool.clone());
        let bound_set = insert_set(&pool, &models, 1_700_000_000, 0, "Bound set").await;
        models
            .insert_model(&new_model(bound_set, &bound_digest, "bound"))
            .await
            .expect("bound model");

        let removed = sweep_orphans(&pool).await.expect("sweep runs");
        assert!(!orphan.exists(), "the orphan run dir is reclaimed");
        assert!(live.exists(), "the live run dir is kept");
        assert!(!store::tree_dir(&stale_digest).exists(), "the aged orphan tree is reclaimed");
        assert!(store::tree_dir(&fresh_digest).exists(), "the fresh tree is kept");
        assert!(store::tree_dir(&bound_digest).exists(), "the still-referenced tree is kept");
        assert!(removed >= 2, "at least the run dir + the aged tree: {removed}");
    }

    #[tokio::test]
    async fn the_pin_row_cascades_with_its_run() {
        let (pool, _scratch) = test_db().await;
        let repo = TxrRepository::new(pool.clone());
        let run_id = insert_run(&repo, 1_700_000_000, TxrRunStatus::Finished).await;
        sqlx::query("INSERT INTO txr_demo_seeded_runs (configuration_id, run_id) VALUES ($1, $2)")
            .bind("pfs_d56_h238")
            .bind(run_id)
            .execute(&pool)
            .await
            .expect("pin row");
        sqlx::query("DELETE FROM txr_runs WHERE id = $1")
            .bind(run_id)
            .execute(&pool)
            .await
            .unwrap();
        let pins: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM txr_demo_seeded_runs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(pins, 0, "the pin row cascades with the run (the FK's ON DELETE CASCADE)");
    }
}
