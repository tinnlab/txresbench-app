//! Tauri IPC commands + the single-owner provisioning seam.
//! TxResBench desktop — the owner identity mirrors the server's localsession module.
//!
//! The harness owns the readable/mint half of single-user (via
//! `SingleUserStrategy`); owner *creation* stays app-side (the SDK design keeps
//! admin CRUD out of the reusable crates). SDK_GAPS D-1: ziee-auth's
//! `UserRepository::create` can't set `is_admin` and ships no `set_admin`, so the
//! app drops to a raw UPDATE to make the owner an admin.

use std::sync::{Arc, OnceLock};

use sqlx::PgPool;
use ziee_auth::auth::JwtService;
use ziee_desktop_harness::single_user::{OwnerLogin, SingleUserStrategy};

/// Set once in the boot→window `on_ready` closure.
pub static SERVER_PORT: OnceLock<u16> = OnceLock::new();
pub static SERVER_POOL: OnceLock<PgPool> = OnceLock::new();
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
pub async fn ensure_owner(pool: &PgPool) -> anyhow::Result<()> {
    Ok(cytoanalyst::modules::localsession::ensure_owner(pool).await?)
}

// A5 TEST-6 [acceptance, INV-4] — the DESKTOP path.
//
// Exercises the REAL `ensure_owner` against a freshly-migrated, ISOLATED database on
// the shared build cluster (the same cluster the server integration harness uses),
// asserting the desktop degenerate: the fixed `admin` owner ends with EXACTLY ONE
// personal account (single-valued, AC-INV-7), and a re-run of `ensure_owner` adds
// NONE (idempotent; the `owner_missing` short-circuit + A1's `ON CONFLICT`).
//
// Linux-gated: this box's shared pgvector cluster is reachable on 127.0.0.1:54321
// (preflight-verified); the test provisions a uniquely-named DB and drops it after.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, PgConnection};

    /// The cluster maintenance URL (env override, else the shared-cluster default).
    fn maintenance_url() -> String {
        std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgresql://postgres:password@127.0.0.1:54321/postgres".into())
    }

    /// Swap the database name in a `postgres://…/<db>` URL.
    fn url_with_db(base: &str, db: &str) -> String {
        let cut = base.rfind('/').expect("url has a path segment");
        format!("{}/{}", &base[..cut], db)
    }

    #[tokio::test]
    async fn desktop_ensure_owner_yields_exactly_one_personal_account() {
        let base = maintenance_url();
        let db = format!("cyto_a5_desktop_{}", uuid::Uuid::new_v4().simple());

        // Provision an isolated DB.
        let mut admin_conn = PgConnection::connect(&base)
            .await
            .expect("connect to the build cluster (is it up on :54321?)");
        admin_conn
            .execute(format!("CREATE DATABASE \"{db}\"").as_str())
            .await
            .expect("create isolated test db");

        // Apply the merged migrations (app + ziee-auth) at runtime.
        let db_url = url_with_db(&base, &db);
        let pool = sqlx::PgPool::connect(&db_url)
            .await
            .expect("connect isolated db");
        let migrations =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/migrations-merged");
        sqlx::migrate::Migrator::new(migrations)
            .await
            .expect("load merged migrations")
            .run(&pool)
            .await
            .expect("apply merged migrations");

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

        // Teardown — drop the isolated DB (best-effort).
        pool.close().await;
        let _ = admin_conn
            .execute(format!("DROP DATABASE IF EXISTS \"{db}\" WITH (FORCE)").as_str())
            .await;
    }
}
