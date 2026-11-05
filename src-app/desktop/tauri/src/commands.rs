//! Tauri IPC commands + the single-owner provisioning seam.
//! TxResBench desktop — the owner identity mirrors the server's localsession module.
//!
//! The harness owns the readable/mint half of single-user (via
//! `SingleUserStrategy`); owner *creation* stays app-side (the SDK design keeps
//! admin CRUD out of the reusable crates). SDK_GAPS D-1: ziee-auth's
//! `UserRepository::create` can't set `is_admin` and ships no `set_admin`, so the
//! app drops to a raw UPDATE to make the owner an admin.
//!
//! SQLite store (sqlite-store ITEM-24): the pool the desktop holds is the app's
//! `SqlitePool` — the SDK's `DbPool` alias resolves to it under the app's
//! `sqlite-backend` features (PROV-sqlite-store-2's desktop half).

use std::sync::{Arc, OnceLock};

use sqlx::SqlitePool;
use ziee_auth::auth::JwtService;
use ziee_desktop_harness::single_user::{OwnerLogin, SingleUserStrategy};

/// Set once in the boot→window `on_ready` closure.
pub static SERVER_PORT: OnceLock<u16> = OnceLock::new();
pub static SERVER_POOL: OnceLock<SqlitePool> = OnceLock::new();
pub static JWT_SERVICE: OnceLock<Arc<JwtService>> = OnceLock::new();

/// The bound HTTP port — the webview reads this to build its API base URL
/// (`http://127.0.0.1:<port>`), since it's loaded from the Tauri asset protocol,
/// not the server origin.
#[tauri::command]
pub fn get_server_port() -> Result<u16, String> {
    SERVER_PORT
        .get()
        .copied()
        .ok_or_else(|| "server not ready".to_string())
}

/// Mint a permanent-session login for the single desktop owner — the harness
/// half of the single-user strategy.
#[tauri::command]
pub async fn auto_login() -> Result<OwnerLogin, String> {
    let pool = SERVER_POOL.get().ok_or("server not ready")?;
    let jwt = JWT_SERVICE.get().ok_or("server not ready")?;
    SingleUserStrategy::desktop_default()
        .mint_owner_login(pool, jwt)
        .await
        .map_err(|e| e.to_string())
}

/// Create the single desktop owner (admin) on first run. Idempotent — no-ops once
/// an admin exists. Shared with the HTTP server's local-session mint
/// (`cytoanalyst::modules::localsession::ensure_owner`), so the desktop and the
/// web-service mode provision the SAME owner.
pub async fn ensure_owner(pool: &SqlitePool) -> anyhow::Result<()> {
    Ok(cytoanalyst::modules::localsession::ensure_owner(pool).await?)
}

/// The run-folder reveal seam (DEC-9 / PROV-UR-7, ITEM-10): open a run's
/// output directory in the system file manager — the results screens'
/// "Open the folder" affordance.
///
/// Implemented with the already-dependency-present `tauri-plugin-opener`
/// 2.x (`app.opener().open_path(path, None)` — verified against the plugin
/// source pinned in Cargo.lock; `opener:default` is already granted and
/// `opener:allow-open-path` is the one added permission line). The command
/// is a thin seam: the path is DATA — the run directory the engine reports
/// as `TxrRunDetail.dir`, never constructed or defaulted here — and the
/// pure `validate_reveal_path` gate runs BEFORE the open, so a malformed
/// value never silently opens the wrong location.
///
/// The runtime is a generic parameter because the crate's
/// `register_invoke_handler` is runtime-generic (`R: tauri::Runtime`):
/// `tauri::AppHandle` without its runtime argument would default to `Wry`
/// and the macro's generated `CommandArg` conversion could not unify it
/// with the invoke's runtime R.
#[tauri::command]
pub async fn reveal_in_file_manager<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    validate_reveal_path(&path)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The pure validation half of the reveal command (TEST-UR-10): Ok for an
/// existing ABSOLUTE directory, an Err with the reason otherwise — empty,
/// relative, missing and non-directory paths are all rejected before
/// anything opens. An open is never panically attempted; a rejected path
/// surfaces as the command's Err string (which `revealRunDir` swallows to
/// the path-only rendering on the UI side).
fn validate_reveal_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("reveal path is empty".to_string());
    }
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("reveal path must be absolute".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("reveal path not readable: {e}"))?;
    if !meta.is_dir() {
        return Err("reveal path is not a directory".to_string());
    }
    Ok(())
}

// A5 TEST-6 / TEST-31 [INV-4] — the DESKTOP path, on the node's file store.
//
// Exercises the REAL `ensure_owner` against a freshly-migrated, ISOLATED SQLite
// FILE (the sqlite-store node's store — the baseline test's shared-cluster DB
// is replaced by a per-test file under TMPDIR), asserting the desktop
// degenerate: the fixed `admin` owner ends with EXACTLY ONE personal account
// (single-valued, AC-INV-7), and a re-run of `ensure_owner` adds NONE
// (idempotent; the `owner_missing` short-circuit + the ON CONFLICT upserts).
//
// The merged migration set is the real composed chain (`migrations-merged`),
// the same dir `database.rs` embeds at boot.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// A unique scratch dir under TMPDIR (owner rule: never /tmp directly — the
    /// harness runs export TMPDIR=/data/pbya/txresbench-app-work/...).
    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// TEST-31 (sqlite-store ITEM-24): `desktop_config()` is the sqlite
    /// variant — no `postgresql` block, a `database:` block naming the store
    /// file under the app-data dir — and the app-name the SDK derives the data
    /// dir from is `txresbench` (`~/.txresbench`, never the stale
    /// `~/.cytoanalyst`).
    #[test]
    fn desktop_config_is_sqlite_and_data_dir_is_txresbench() {
        // The app name is set-ONCE (OnceLock), so it must be set before any
        // other app-state access; this test is the only one in this crate's
        // binary touching `app_state`. HOME is pointed at a scratch dir so the
        // assertions never touch the real `~/.txresbench`.
        let scratch = scratch_dir("cyto_desktop_config");
        std::env::set_var("HOME", &scratch);

        let cfg = super::super::config::desktop_config();

        assert!(
            cfg.postgresql.is_none(),
            "desktop config must not carry a postgresql block (PROV-sqlite-store-8)"
        );

        let db = cfg.database.as_ref().expect("database block present");
        let path = db.path.as_deref().expect("database.path is set");
        assert!(
            path.ends_with("txresbench.db"),
            "db file is DEC-13's txresbench.db, got {path}"
        );
        let data_dir = std::path::PathBuf::from(path)
            .parent()
            .expect("db path has a parent")
            .to_path_buf();
        assert_eq!(
            data_dir,
            scratch.join(".txresbench"),
            "the store file lives under ~/.txresbench (the app-name-derived data dir)"
        );

        // Ephemeral-HTTP-port posture unchanged (the real port is read back
        // from local_addr by the harness).
        assert_eq!(cfg.server.port, 0);
        assert_eq!(cfg.server.host, "127.0.0.1");
        assert_eq!(cfg.server.api_prefix, "/api");
    }

    #[tokio::test]
    async fn desktop_ensure_owner_yields_exactly_one_personal_account() {
        // A unique, isolated SQLite FILE (never a shared cluster DB).
        let dir = scratch_dir("cyto_desktop_owner");
        let db_path = dir.join("txresbench.db");
        let url = format!("sqlite://{}", db_path.display());

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(
                SqliteConnectOptions::from_str(&url)
                    .expect("valid sqlite url")
                    .create_if_missing(true),
            )
            .await
            .expect("open isolated sqlite file");

        // Apply the merged migrations (app + ziee-auth + ziee-file +
        // ziee-notification) at runtime — the composed dir the boot embeds.
        let migrations =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/migrations-merged");
        let mut migrator = sqlx::migrate::Migrator::new(migrations)
            .await
            .expect("load merged migrations");
        migrator.set_ignore_missing(true);
        migrator.run(&pool).await.expect("apply merged migrations");

        // Run the REAL desktop provisioning twice — idempotent.
        ensure_owner(&pool).await.expect("first ensure_owner");
        ensure_owner(&pool)
            .await
            .expect("second ensure_owner (no-op)");

        // The fixed admin owns EXACTLY ONE personal account + one owner membership.
        let strat = SingleUserStrategy::desktop_default();
        let admin_id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(&strat.owner_username)
            .fetch_one(&pool)
            .await
            .expect("owner user id");

        let personal: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM accounts WHERE kind='personal' AND personal_user_id=$1",
        )
        .bind(admin_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            personal, 1,
            "desktop owner has exactly one personal account (INV-4)"
        );

        let owner_memberships: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM account_members m JOIN accounts a ON a.id = m.account_id
             WHERE a.kind='personal' AND a.personal_user_id=$1 AND m.user_id=$1 AND m.role='owner'",
        )
        .bind(admin_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(owner_memberships, 1, "exactly one owner membership");

        // Single-valued: there is no SECOND account of any kind for this desktop.
        let total_accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            total_accounts, 1,
            "desktop is single-valued (AC-INV-7): one account total"
        );

        // Teardown — close the pool, remove the isolated file + sidecars
        // (best-effort; the WAL is folded by the close).
        pool.close().await;
        let _ = std::fs::remove_file(dir.join("txresbench.db"));
        let _ = std::fs::remove_file(dir.join("txresbench.db-wal"));
        let _ = std::fs::remove_file(dir.join("txresbench.db-shm"));
        let _ = std::fs::remove_dir(dir);
    }

    /// TEST-UR-10 (ITEM-10): the pure `validate_reveal_path` gate — an
    /// existing ABSOLUTE directory opens, and every malformed value
    /// (empty, relative, missing, a file) is rejected with a reason BEFORE
    /// the system file manager is ever asked. The command never handles a
    /// bad path silently; the UI's `revealRunDir` returns the path-only
    /// rendering on any rejection.
    #[test]
    fn reveal_validation_accepts_an_existing_absolute_directory() {
        let dir = scratch_dir("cyto_desktop_reveal_dir");
        assert!(
            super::validate_reveal_path(dir.to_str().expect("scratch path is utf8")).is_ok(),
            "an existing absolute directory passes the reveal gate"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reveal_validation_rejects_empty_and_relative_paths() {
        assert!(super::validate_reveal_path("").is_err(), "empty path is rejected");
        assert!(
            super::validate_reveal_path("Documents/TxResBench").is_err(),
            "a relative path never opens (the engine's dir is absolute)"
        );
        assert!(
            super::validate_reveal_path("~/.txresbench").is_err(),
            "a tilde path is not an absolute path (never shell-expanded here)"
        );
    }

    #[test]
    fn reveal_validation_rejects_missing_paths() {
        let dir = scratch_dir("cyto_desktop_reveal_missing");
        let missing = dir.join("no-such-run-dir");
        assert!(
            super::validate_reveal_path(missing.to_str().expect("utf8")).is_err(),
            "a missing path is rejected instead of opening nothing"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reveal_validation_rejects_a_file() {
        let dir = scratch_dir("cyto_desktop_reveal_file");
        let file = dir.join("predictions.csv");
        std::fs::write(&file, b"patient_id\nS0001\n").expect("write scratch file");
        assert!(
            super::validate_reveal_path(file.to_str().expect("utf8")).is_err(),
            "a file is rejected: the affordance opens the run DIRECTORY, never a file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
