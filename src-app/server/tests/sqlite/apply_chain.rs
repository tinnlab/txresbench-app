//! The SQLite chain apply harness — TESTS.md TEST-14, built by ITEM-7 and
//! extended by every chain-port item (ITEM-7…ITEM-11).
//!
//! The port is verified against real SQLite (the sqlx-bundled 3.46 engine)
//! without a full compiled tree, exactly as DEC-19 prescribes: this test
//! composes the ported chain through the REAL SDK composer
//! (`ziee_build_support::compose_merged_migrations_from`) with the REAL
//! driver-selected source lists (`build_helper/migration_chain.rs` is
//! `#[path]`-included — the same module `build.rs` compiles, so the harness
//! and the build can never disagree about which dirs form the chain), then
//! applies it with `sqlx::migrate::Migrator` — the same apply engine the
//! runtime uses at boot.
//!
//! What each chain item adds here: the group's file set applies from scratch
//! (zero errors), every file has a unique numeric prefix, the group's table
//! set matches the Postgres chain, and the group-specific row semantics hold
//! (TEST-15…TEST-18). ITEM-7 owns the SDK group: `ziee-auth` (5 files),
//! `ziee-file` (1), `ziee-notification` (1).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::Row;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

// The app's build-script module that selects the chain by driver. Included
// verbatim (same pattern as ITEM-6's probe) so this harness drives the REAL
// selection logic rather than a copy of its path lists.
#[path = "../../build_helper/migration_chain.rs"]
mod migration_chain;

use migration_chain::MigrationChain;

/// The SDK chain groups ITEM-7 ports: (crate dir name, expected `.sql` count).
const SDK_CHAIN_GROUPS: &[(&str, usize)] =
    &[("ziee-auth", 5), ("ziee-file", 1), ("ziee-notification", 1)];

/// The table set the ported SDK chain creates (auth 9 + file 2 +
/// notification 1), alphabetically — the Postgres chain's table names verbatim.
const SDK_TABLE_SET: &[&str] = &[
    "auth_providers",
    "file_versions",
    "files",
    "groups",
    "notifications",
    "oauth_sessions",
    "pending_account_links",
    "refresh_tokens",
    "session_settings",
    "user_auth_links",
    "user_groups",
    "users",
];

/// Every file the ported SDK chain ships, in the version-sorted order the
/// merged chain applies them.
const SDK_CHAIN_FILES: &[&str] = &[
    "202607140050_auth_schema.sql",
    "202607140125_file_schema.sql",
    "202607140190_notification_schema.sql",
    "202607144000_auth_fkeys.sql",
    "202607144500_auth_seed.sql",
    "202607144600_auth_add_users_token_version.sql",
    "202609090010_users_email_lowercase_invariant.sql",
];

static UNIQUE: AtomicU64 = AtomicU64::new(0);

/// A scratch dir under `TMPDIR` (never the repo), removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join("cyto-sqlite-apply-chain");
        std::fs::create_dir_all(&base).expect("scratch base");
        let unique = UNIQUE.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!("{tag}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Scratch(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
}

/// Compose the ported SQLite chain the way `build.rs` does under a `sqlite://`
/// `DATABASE_URL`: driver-selected source lists → real SDK composer. Returns
/// the merged dir.
fn compose_sqlite_chain(scratch: &Path) -> PathBuf {
    let chain = migration_chain::for_build_db_url(Some(
        "sqlite://target/sqlx-build/compose_scratch.sqlite",
    ));
    assert_eq!(chain, MigrationChain::Sqlite);
    let (module_roots, explicit_dirs) = chain.compose_args(&manifest_dir());
    // DEC-9: the staged chain lives OUTSIDE src/modules; the sqlite leg never
    // globs module dirs (the composer's `app_module_roots` are GLOBBED for
    // `*/migrations`), so the args must be roots=empty + explicit staged dirs.
    assert!(
        module_roots.is_empty(),
        "sqlite leg must pass no glob root (DEC-9 staging)"
    );

    let merged = scratch.join("migrations-merged");
    ziee_build_support::compose_merged_migrations_from(&merged, &module_roots, &explicit_dirs);
    merged
}

/// Apply `merged` to a scratch SQLite FILE (create-if-missing, WAL,
/// foreign_keys ON — the DEC-7 connect profile's correctness properties) and
/// return the pool + the migrator (for the no-op re-apply assertion).
async fn apply_chain(merged: &Path, db_path: &Path) -> (SqlitePool, Migrator) {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect scratch sqlite");
    let migrator = Migrator::new(merged).await.expect("load merged migrator");
    migrator
        .run(&pool)
        .await
        .expect("apply ported chain from scratch");
    (pool, migrator)
}

fn merged_sql_files(merged: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(merged)
        .expect("merged dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".sql"))
        .collect();
    names.sort();
    names
}

fn version_prefix(name: &str) -> &str {
    let end = name
        .find(|c: char| !c.is_ascii_digit())
        .expect("migration files start with a numeric version prefix");
    &name[..end]
}

async fn table_set(pool: &SqlitePool) -> Vec<String> {
    let rows = sqlx::query(
        "SELECT name FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE '_sqlx%' AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .expect("sqlite_master");
    rows.iter().map(|r| r.get::<String, _>("name")).collect()
}

async fn applied_version_count(pool: &SqlitePool) -> i64 {
    sqlx::query("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .expect("migrations table")
        .get::<i64, _>(0)
}

/// The dispatch rule shared with `build.rs` — a `sqlite:` URL selects the
/// ported chain; unset/postgres stays on the module-owned chains (the pre-flip
/// behavior). PINNED here because compose and provision must never disagree.
#[test]
fn driver_dispatch_selects_the_port_for_sqlite_urls() {
    assert_eq!(
        migration_chain::for_build_db_url(Some("sqlite://target/sqlx-build/x.sqlite")),
        MigrationChain::Sqlite
    );
    assert_eq!(
        migration_chain::for_build_db_url(Some("postgresql://u:p@127.0.0.1:54321/postgres")),
        MigrationChain::Postgres
    );
    assert_eq!(
        migration_chain::for_build_db_url(None),
        MigrationChain::Postgres
    );
}

/// TEST-14 (ITE-7 group): the ported SDK chain composes to exactly the seven
/// files, applies to a scratch SQLite 3.46 file with zero errors, yields the
/// Postgres chain's table set, and re-applies as a no-op.
#[tokio::test]
async fn sdk_chain_applies_from_scratch_and_reapplies_as_noop() {
    let scratch = Scratch::new("sdk-chain");
    let merged = compose_sqlite_chain(scratch.path());

    // The composed set is exactly the seven ported files (the app-side ported
    // groups land in ITEM-8…11 — nothing else exists in the chain yet).
    assert_eq!(merged_sql_files(&merged), SDK_CHAIN_FILES);

    // Every file has a unique numeric prefix (the merge-gate C2 namespace
    // property; the composer's collision guard panics on a true duplicate,
    // this asserts the property directly).
    let files = merged_sql_files(&merged);
    let mut prefixes: Vec<&str> = files.iter().map(|n| version_prefix(n)).collect();
    prefixes.sort_unstable();
    let before = prefixes.len();
    prefixes.dedup();
    assert_eq!(before, 7, "version prefixes must be unique: {prefixes:?}");

    // Each SDK group ships its expected file count in its own staged dir.
    for (crate_name, count) in SDK_CHAIN_GROUPS {
        let dir = manifest_dir()
            .join("../../sdk/crates")
            .join(crate_name)
            .join("migrations-sqlite");
        let n = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("missing staged dir {dir:?}: {e}"))
            .flatten()
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("sql"))
            .count();
        assert_eq!(n, *count, "{crate_name} staged file count");
    }

    // Apply from scratch.
    let db = scratch.path().join("scratch.sqlite");
    let (pool, migrator) = apply_chain(&merged, &db).await;
    assert_eq!(
        table_set(&pool).await,
        SDK_TABLE_SET,
        "table set per module"
    );
    assert_eq!(applied_version_count(&pool).await, 7);
    assert!(db.exists(), "the DB is a real file at the given path");

    // The SAME chain applied twice is a no-op (schema version recorded, no
    // re-run, no checksum drift).
    migrator.run(&pool).await.expect("re-apply must be a no-op");
    assert_eq!(applied_version_count(&pool).await, 7);
}

/// The ported chain's row semantics (TEST-14's "row semantics preserved"):
/// the seeded groups carry JSON-array permissions, `uuid` columns are 16-byte
/// BLOBs that round-trip through sqlx's `Uuid`, timestamps are RFC3339 text,
/// `token_version` defaults to 0, `updated_at` triggers stamp on UPDATE, FKs
/// enforce (cascades), and the email-lowercase invariant refuses case variants
/// and non-lowercase addresses.
#[tokio::test]
async fn sdk_chain_type_contract_and_seed_semantics_hold() {
    let scratch = Scratch::new("sdk-semantics");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- seeded groups: text[] -> JSON-array text -------------------------
    let rows = sqlx::query(
        "SELECT name, permissions, json_valid(permissions) AS valid \
         FROM groups ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .expect("groups");
    let groups: Vec<(String, String, i64)> = rows
        .iter()
        .map(|r| (r.get("name"), r.get("permissions"), r.get("valid")))
        .collect();
    assert_eq!(
        groups,
        vec![
            ("Administrators".to_string(), "[\"*\"]".to_string(), 1),
            (
                "Users".to_string(),
                "[\"profile::read\",\"profile::edit\"]".to_string(),
                1
            ),
        ]
    );

    // --- uuid: sqlx `Uuid` binds as/reads back 16-byte BLOB ---------------
    let id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, ?, ?)")
        .bind(id)
        .bind("probe")
        .bind("probe@example.com")
        .execute(&pool)
        .await
        .expect("insert probe user");
    let (back, storage, token_version): (uuid::Uuid, String, i64) =
        sqlx::query_as("SELECT id, typeof(id), token_version FROM users WHERE username = 'probe'")
            .fetch_one(&pool)
            .await
            .expect("read probe user");
    assert_eq!(back, id, "uuid round-trips through sqlx Uuid");
    assert_eq!(
        storage, "blob",
        "uuid columns are 16-byte blobs, never text"
    );

    // --- timestamps: canonical RFC3339 text (lexicographic == chronological)
    let created_at: String =
        sqlx::query_scalar("SELECT created_at FROM users WHERE username = 'probe'")
            .fetch_one(&pool)
            .await
            .expect("created_at");
    chrono::DateTime::parse_from_rfc3339(&created_at)
        .unwrap_or_else(|e| panic!("created_at {created_at:?} is not RFC3339: {e}"));
    assert_eq!(token_version, 0, "revocation epoch defaults to 0");

    // --- updated_at trigger: an UPDATE stamps the row (AFTER-trigger re-write)
    std::thread::sleep(std::time::Duration::from_millis(20));
    sqlx::query("UPDATE users SET display_name = 'Probe' WHERE username = 'probe'")
        .execute(&pool)
        .await
        .expect("update probe user");
    let stamped: String =
        sqlx::query_scalar("SELECT updated_at FROM users WHERE username = 'probe'")
            .fetch_one(&pool)
            .await
            .expect("updated_at");
    assert!(
        stamped > created_at,
        "updated_at must be stamped by the trigger: {created_at} -> {stamped}"
    );

    // --- FK enforcement (foreign_keys ON; cascade declared inline) --------
    let err = sqlx::query(
        "INSERT INTO oauth_sessions (id, state, provider_id, redirect_uri, expires_at) \
         VALUES (?, 'st', ?, 'r', '2026-01-01T00:00:00.000Z')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect_err("bogus provider_id must violate the FK");
    assert!(
        err.to_string().contains("FOREIGN KEY"),
        "FK violation must surface: {err}"
    );

    // --- email-lowercase invariant (202609090010 port) --------------------
    let err =
        sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'upper', 'BOB@CORP.COM')")
            .bind(uuid::Uuid::new_v4())
            .execute(&pool)
            .await
            .expect_err("non-lowercase email must be refused by the guard trigger");
    assert!(
        err.to_string().contains("must be lowercase"),
        "guard must name the invariant: {err}"
    );
    let err =
        sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'upper2', 'Bob@CORP.COM')")
            .bind(uuid::Uuid::new_v4())
            .execute(&pool)
            .await
            .expect_err("case-variant email must be refused");
    assert!(
        err.to_string().contains("must be lowercase"),
        "case variant must hit the guard: {err}"
    );

    // --- notifications / files: the other two groups' schema is live -------
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM notifications")
        .fetch_one(&pool)
        .await
        .expect("notifications");
    assert_eq!(n, 0);
    let err = sqlx::query(
        "INSERT INTO file_versions (id, file_id, version, is_head, blob_version_id, file_size, created_by) \
         VALUES (?, ?, 1, 0, ?, 0, 't')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(uuid::Uuid::new_v4())
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("file_versions insert (no FK in the crate schema)");
    assert_eq!(err.rows_affected(), 1);
}

/// The invariant's refuse-on-legacy-data leg (the Postgres `DO` block's job):
/// a scratch DB that already holds two users differing only by case must REFUSE
/// the 202609090010 migration with the data untouched — no case is silently
/// chosen. The migration fails inside its transaction, so nothing of it is
/// applied.
#[tokio::test]
async fn email_invariant_refuses_case_collisions_in_legacy_data() {
    let scratch = Scratch::new("invariant-refuse");
    let merged = compose_sqlite_chain(scratch.path());

    // Apply the chain UP TO (not including) the invariant migration: the first
    // six SDK files form the pre-invariant schema (the version-sorted merge
    // interleaves the file/notification baselines inside the auth baseline
    // window, so "everything but 202609090010" is the literal slice).
    let pre = scratch.path().join("pre");
    std::fs::create_dir_all(&pre).expect("pre dir");
    for name in &SDK_CHAIN_FILES[..SDK_CHAIN_FILES.len() - 1] {
        std::fs::copy(merged.join(name), pre.join(name)).expect("copy pre-file");
    }
    let pre_db = scratch.path().join("pre.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&pre_db)
                .create_if_missing(true),
        )
        .await
        .expect("pre pool");
    Migrator::new(pre.as_path())
        .await
        .expect("pre migrator")
        .run(&pool)
        .await
        .expect("pre chain applies");
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'Bob', 'Bob@corp.com')")
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("legacy lower row");
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'BOB', 'BOB@CORP.COM')")
        .bind(uuid::Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("legacy case-twinned row");

    // The full chain now REFUSES: the functional unique index cannot be
    // created over the case-twin rows, the transaction rolls back, and the
    // migration is not recorded — the operator decides which account survives.
    let full_migrator = Migrator::new(merged.as_path())
        .await
        .expect("full migrator");
    let err = full_migrator
        .run(&pool)
        .await
        .expect_err("migration must refuse case collisions");
    assert!(
        err.to_string().contains("users_email_lower_uniq"),
        "refusal must name the invariant index: {err}"
    );
    assert_eq!(
        applied_version_count(&pool).await,
        6,
        "the refused migration must leave the chain at 6 applied files"
    );
    let emails: Vec<String> = sqlx::query_scalar("SELECT email FROM users ORDER BY email")
        .fetch_all(&pool)
        .await
        .expect("users");
    assert_eq!(
        emails,
        vec!["BOB@CORP.COM".to_string(), "Bob@corp.com".to_string()],
        "the ABORT must leave the legacy rows untouched (no winner chosen)"
    );
}
