//! The SQLite chain apply harness — TESTS.md TEST-14, built by ITEM-7 and
//! extended by every chain-port item (ITEM-7…ITEM-11).
//!
//! The port is verified against real SQLite (the sqlx-bundled 3.46 engine)
//! without a full compiled tree, exactly as DEC-19 prescribes: this test
//! composes the ported chain through the REAL SDK composer
//! (`ziee_build_support::compose_merged_migrations_from`) with the SAME source
//! lists `build.rs` uses (the module-owned `src/modules/*/migrations/` root
//! plus the three schema-bound SDK crates' `migrations/` dirs — ITEM-26
//! collapsed the driver selection, so the lists are now UNCONDITIONAL and the
//! harness hardcodes exactly what the build script passes, keeping the two
//! from ever disagreeing), then applies it with `sqlx::migrate::Migrator` —
//! the same apply engine the runtime uses at boot.
//!
//! What each chain item adds here: the group's file set applies from scratch
//! (zero errors), every file has a unique numeric prefix, the group's table
//! set matches the Postgres chain, and the group-specific row semantics hold
//! (TEST-15…TEST-18). ITEM-7 owns the SDK group: `ziee-auth` (5 files),
//! `ziee-file` (1), `ziee-notification` (1). ITEM-8 owns the app group part 1:
//! `jobs` (6), `sandbox` (3), `mcp` (2), `features` (1), `file` (1). ITEM-9
//! owns the app group part 2: `workstore` (19) — the shared-harness leg pins
//! the whole 39-file chain + the app groups' row semantics; the jobs-specific
//! scheduler invariants live in `chain_jobs.rs` (TEST-15) and the
//! workstore-specific ones in `chain_workstore.rs` (TEST-16). ITEM-10 owns
//! the app group part 3: `account` (8) + `project` (1) — the shared harness
//! now pins the 48-file chain; the account/project-specific row semantics
//! live in `chain_account_project.rs` (TEST-17). ITEM-11 owns the last app
//! group part 4: `dataset` (4), `drafts` (3), `provenance` (2) — the shared
//! harness now pins the FULL 57-file chain (the complete SQLite chain that
//! ITEM-12 flips to); the dataset/drafts/provenance-specific row semantics
//! live in `chain_dataset_drafts_prov.rs` (TEST-18). ITEM-26 then moved every
//! file into its FINAL dir (the module dirs / the SDK crates' `migrations/`)
//! and deleted the staging tree + the PG chains.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::Row;

/// The SDK chain groups ITEM-7 ports: (crate dir name, expected `.sql` count).
const SDK_CHAIN_GROUPS: &[(&str, usize)] =
    &[("ziee-auth", 5), ("ziee-file", 1), ("ziee-notification", 1)];

/// The app chain module groups ITEM-8 + ITEM-9 + ITEM-10 + ITEM-11 ports:
/// (module dir name, expected `.sql` count).
const APP_CHAIN_GROUPS: &[(&str, usize)] = &[
    ("jobs", 6),
    ("sandbox", 3),
    ("mcp", 2),
    ("features", 1),
    ("file", 1),
    ("workstore", 19),
    ("account", 8),
    ("project", 1),
    ("dataset", 4),
    ("drafts", 3),
    ("provenance", 2),
];

/// The table set the ported chain creates (SDK 12 + jobs 8 (incl.
/// compute_meter) + sandbox 1 + mcp 2 + features 1 + workstore 6 +
/// account 5 + project 5 + dataset 5 + drafts 3 + provenance 5 = 53),
/// alphabetically — the Postgres chain's table names verbatim.
/// `workstore_axis_entry` is NOT in the set: the baseline creates it and
/// `202608040002` drops it (in the PG chain too). ITEM-11 (dataset)
/// replaced the `datasets` test stub with the REAL chain table — the name
/// in the set is unchanged; every other name in the set has been real
/// since its own item.
const TABLE_SET: &[&str] = &[
    "account_invitation_mints",
    "account_invitations",
    "account_member_events",
    "account_members",
    "accounts",
    "artifacts",
    "auth_providers",
    "compute_meter",
    "dataset_files",
    "dataset_folder_members",
    "dataset_folders",
    "dataset_shares",
    "datasets",
    "draft_artifact_lineage",
    "draft_freeze_jobs",
    "drafts",
    "feature_flags",
    "file_versions",
    "files",
    "groups",
    "infra_compute",
    "infra_object_store",
    "job_dependencies",
    "job_logs",
    "job_metrics",
    "job_milestones",
    "job_scope",
    "job_settings",
    "jobs",
    "mcp_pairing_codes",
    "mcp_settings",
    "notifications",
    "oauth_sessions",
    "object_store_migration",
    "pending_account_links",
    "project_datasets",
    "project_settings",
    "project_shares",
    "project_transfers",
    "projects",
    "provenance_code_blobs",
    "provenance_reference_resources",
    "provenance_run_repro",
    "provenance_settings",
    "provenance_verifications",
    "refresh_tokens",
    "sandbox_settings",
    "session_settings",
    "storage_meter",
    "user_auth_links",
    "user_groups",
    "users",
    "workstore_settings",
];

/// Every file the SDK group ships, in the version-sorted order the merged
/// chain applies them (the ITEM-7 rows).
const SDK_CHAIN_FILES: &[&str] = &[
    "202607140050_auth_schema.sql",
    "202607140125_file_schema.sql",
    "202607140190_notification_schema.sql",
    "202607144000_auth_fkeys.sql",
    "202607144500_auth_seed.sql",
    "202607144600_auth_add_users_token_version.sql",
    "202609090010_users_email_lowercase_invariant.sql",
];

/// Every file the ported chain ships (SDK 7 + app ITEM-8 groups 13 +
/// ITEM-9's workstore 19 + ITEM-10's account 8 + project 1 + ITEM-11's
/// dataset 4 + drafts 3 + provenance 2), in the version-sorted order the
/// merged chain applies them — the complete 57-file SQLite chain.
pub(crate) const CHAIN_FILES: &[&str] = &[
    "202607140050_auth_schema.sql",
    "202607140125_file_schema.sql",
    "202607140190_notification_schema.sql",
    "202607144000_auth_fkeys.sql",
    "202607144500_auth_seed.sql",
    "202607144600_auth_add_users_token_version.sql",
    "202608030001_jobs_baseline.sql",
    "202608030002_dataset_baseline.sql",
    "202608030003_project_baseline.sql",
    "202608030004_workstore_baseline.sql",
    "202608030005_provenance_baseline.sql",
    "202608030006_sandbox_baseline.sql",
    "202608030007_mcp_baseline.sql",
    "202608030008_file_baseline.sql",
    "202608040001_artifact_model.sql",
    "202608040002_artifact_model_drop.sql",
    "202608040003_artifact_role.sql",
    "202608040004_artifact_gathered.sql",
    "202608040005_dataset_source_integrate.sql",
    "202608040006_usable_artifacts_view.sql",
    "202608040007_stored_vs_logical_bytes.sql",
    "202608040008_integrate_declares_alignment.sql",
    "202608040009_artifact_mask_role.sql",
    "202608040010_recipe_alignment_or_single_source.sql",
    "202608040011_dataset_source_filter.sql",
    "202608040012_account_baseline.sql",
    "202608040013_ownership_account_id.sql",
    "202608040014_account_id_indexes.sql",
    "202608050001_storage_meter.sql",
    "202608050002_compute_meter.sql",
    "202608050003_multiworker_claim.sql",
    "202608240001_drafts_baseline.sql",
    "202608240002_draft_freeze_jobs.sql",
    "202608240003_draft_artifact_lineage.sql",
    "202608260001_compute_meter_account.sql",
    "202608260002_storage_meter_account.sql",
    "202608280001_artifact_membership_index.sql",
    "202608280002_features_baseline.sql",
    "202608280011_account_admin_suspend.sql",
    "202608290010_sandbox_per_class_defaults.sql",
    "202608290020_workstore_settings.sql",
    "202608290030_jobs_sse_admission_knobs.sql",
    "202608290040_mcp_settings.sql",
    "202608290050_provenance_gc_settings.sql",
    "202608290070_jobs_scheduler_reaper_knobs.sql",
    "202608290090_infra_config.sql",
    "202608290100_object_store_migration.sql",
    "202608290110_object_store_cutover.sql",
    "202608290120_object_store_old_config.sql",
    "202608290130_object_store_abandon.sql",
    "202609020010_upload_limits.sql",
    "202609020020_sandbox_fsize_default.sql",
    "202609040001_account_members_manage.sql",
    "202609040002_account_invitations.sql",
    "202609040003_account_invitation_mints.sql",
    "202609040010_account_member_events.sql",
    "202609090010_users_email_lowercase_invariant.sql",
];

static UNIQUE: AtomicU64 = AtomicU64::new(0);

/// A scratch dir under `TMPDIR` (never the repo), removed on drop.
pub(crate) struct Scratch(PathBuf);

impl Scratch {
    pub(crate) fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join("cyto-sqlite-apply-chain");
        std::fs::create_dir_all(&base).expect("scratch base");
        let unique = UNIQUE.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!("{tag}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Scratch(dir)
    }

    pub(crate) fn path(&self) -> &Path {
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

/// Compose the SQLite chain the way `build.rs` does (ITEM-26: the driver
/// selection is gone): module-owned `src/modules/*/migrations/` glob root +
/// the three schema-bound SDK crates' `migrations/` dirs → real SDK composer.
/// Returns the merged dir.
pub(crate) fn compose_sqlite_chain(scratch: &Path) -> PathBuf {
    let manifest = manifest_dir();
    let module_roots = vec![manifest.join("src/modules")];
    let sdk_dirs: Vec<PathBuf> = ["ziee-auth", "ziee-file", "ziee-notification"]
        .iter()
        .map(|c| manifest.join("../../sdk/crates").join(c).join("migrations"))
        .collect();

    let merged = scratch.join("migrations-merged");
    ziee_build_support::compose_merged_migrations_from(&merged, &module_roots, &sdk_dirs);
    merged
}

/// Apply `merged` to a scratch SQLite FILE (create-if-missing, WAL,
/// foreign_keys ON — the DEC-7 connect profile's correctness properties) and
/// return the pool + the migrator (for the no-op re-apply assertion).
pub(crate) async fn apply_chain(merged: &Path, db_path: &Path) -> (SqlitePool, Migrator) {
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

pub(crate) async fn table_set(pool: &SqlitePool) -> Vec<String> {
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

pub(crate) async fn applied_version_count(pool: &SqlitePool) -> i64 {
    sqlx::query("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .expect("migrations table")
        .get::<i64, _>(0)
}

/// TEST-14 (ITEM-7 + ITEM-8/9/10/11 groups): the ported chain (SDK 7 + app
/// ITEM-8 groups 13 + ITEM-9 workstore 19 + ITEM-10 account 8 + project 1
/// + ITEM-11 dataset 4 + drafts 3 + provenance 2) composes to exactly its
/// fifty-seven files, applies to a scratch SQLite 3.46 file with zero
/// errors, yields the Postgres chain's table set, and re-applies as a
/// no-op.
#[tokio::test]
async fn ported_chain_applies_from_scratch_and_reapplies_as_noop() {
    let scratch = Scratch::new("full-chain");
    let merged = compose_sqlite_chain(scratch.path());

    // The composed set is exactly the fifty-seven ported files — the FULL
    // SQLite chain (the final, post-ITEM-26 layout).
    assert_eq!(merged_sql_files(&merged), CHAIN_FILES);

    // Every file has a unique numeric prefix (the merge-gate C2 namespace
    // property; the composer's collision guard panics on a true duplicate,
    // this asserts the property directly).
    let files = merged_sql_files(&merged);
    let mut prefixes: Vec<&str> = files.iter().map(|n| version_prefix(n)).collect();
    prefixes.sort_unstable();
    let before = prefixes.len();
    prefixes.dedup();
    assert_eq!(
        before,
        CHAIN_FILES.len(),
        "version prefixes must be unique: {prefixes:?}"
    );

    // Each group ships its expected file count in its own migration dir.
    for (crate_name, count) in SDK_CHAIN_GROUPS {
        let dir = manifest_dir()
            .join("../../sdk/crates")
            .join(crate_name)
            .join("migrations");
        let n = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("missing migration dir {dir:?}: {e}"))
            .flatten()
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("sql"))
            .count();
        assert_eq!(n, *count, "{crate_name} migration file count");
    }
    for (module, count) in APP_CHAIN_GROUPS {
        let dir = manifest_dir().join("src/modules").join(module).join("migrations");
        let n = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("missing migration dir {dir:?}: {e}"))
            .flatten()
            .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("sql"))
            .count();
        assert_eq!(n, *count, "{module} migration file count");
    }

    // Apply from scratch.
    let db = scratch.path().join("scratch.sqlite");
    let (pool, migrator) = apply_chain(&merged, &db).await;
    assert_eq!(table_set(&pool).await, TABLE_SET, "table set per module");
    assert_eq!(applied_version_count(&pool).await, CHAIN_FILES.len() as i64);
    assert!(db.exists(), "the DB is a real file at the given path");

    // The SAME chain applied twice is a no-op (schema version recorded, no
    // re-run, no checksum drift).
    migrator.run(&pool).await.expect("re-apply must be a no-op");
    assert_eq!(applied_version_count(&pool).await, CHAIN_FILES.len() as i64);
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
                // The app-side grants (ITEM-8: jobs::use by 202608030001,
                // mcp::use by 202608030007, the six files:: perms by
                // 202608030008; ITEM-10: projects::use + notifications::read
                // by 202608030003, account::read by 202608040012,
                // account::members::manage by 202609040001; ITEM-11:
                // provenance::read + provenance::export by 202608030005,
                // drafts::use by 202608240001) ride ON TOP of the auth
                // seed's two profile perms — the order is the chain's
                // version order.
                "[\"profile::read\",\"profile::edit\",\"jobs::use\",\
                 \"projects::use\",\"notifications::read\",\
                 \"provenance::read\",\"provenance::export\",\"mcp::use\",\
                 \"files::read\",\"files::upload\",\"files::download\",\
                 \"files::delete\",\"files::preview\",\"files::generate_token\",\
                 \"account::read\",\"drafts::use\",\"account::members::manage\"]"
                    .to_string(),
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
    // The refusal lands at the LAST file of the chain (202609090010 sorts
    // above every app file), so the six pre-applied files plus the
    // fifty app files (ITEM-8's 13 + ITEM-9's 19 + ITEM-10's 9 +
    // ITEM-11's 9) are applied and only the invariant file itself is not:
    // 56 of 57. Every parent table the mid-chain migrations reference
    // (`accounts`, `projects`, `datasets`) is REAL — the full chain is applied
    // below — so no test-side stubs stand in any more (ITEM-26 deleted the
    // staged chain and with it the stub machinery).
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
        (CHAIN_FILES.len() - 1) as i64,
        "the refused migration must be the only file not applied"
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

/// The ITEM-8 app group's row semantics (the harness's per-item self-check,
/// TEST-14's "row semantics preserved" for this group): the three settings
/// singletons are seeded exactly once, the group grants are JSON-appended
/// idempotently (jobs::use, mcp::use, the six files:: perms — each exactly
/// once alongside the auth seed's profile perms), the sandbox per-class
/// defaults + the 64 GiB fsize raise are in place (row AND schema default —
/// the rebuild), compute_meter stays exactly-once under ON CONFLICT, the
/// mcp/sandbox bound checks refuse out-of-bounds values, and the
/// feature_flags global-uniqueness partial index + env-id grammar hold.
#[tokio::test]
async fn app_chain_item8_row_semantics_hold() {
    let scratch = Scratch::new("app-item8-semantics");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- singletons: seeded exactly once -------------------------------
    let job_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM job_settings")
        .fetch_one(&pool)
        .await
        .expect("job_settings");
    assert_eq!(job_rows, 1, "job_settings singleton (ON CONFLICT seed)");
    let sandbox_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM sandbox_settings")
        .fetch_one(&pool)
        .await
        .expect("sandbox_settings");
    assert_eq!(sandbox_rows, 1, "sandbox_settings singleton");
    let mcp_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM mcp_settings")
        .fetch_one(&pool)
        .await
        .expect("mcp_settings");
    assert_eq!(mcp_rows, 1, "mcp_settings singleton");

    // --- grants: JSON1 append, idempotent, each exactly once -----------
    let permissions: String =
        sqlx::query_scalar("SELECT permissions FROM groups WHERE name = 'Users'")
            .fetch_one(&pool)
            .await
            .expect("Users group");
    let granted: Vec<&str> = serde_json::from_str(&permissions).expect("permissions JSON array");
    for perm in [
        "jobs::use",
        "mcp::use",
        "files::read",
        "files::upload",
        "files::download",
        "files::delete",
        "files::preview",
        "files::generate_token",
        "profile::read",
        "profile::edit",
    ] {
        assert_eq!(
            granted.iter().filter(|p| **p == perm).count(),
            1,
            "{perm} granted exactly once: {permissions}"
        );
    }

    // --- sandbox per-class defaults + the 64 GiB fsize raise ------------
    let (fsize, interactive_mem, default_env): (i64, i64, Option<String>) = sqlx::query_as(
        "SELECT fsize_bytes, interactive_mem_bytes, default_env_id FROM sandbox_settings",
    )
    .fetch_one(&pool)
    .await
    .expect("sandbox_settings row");
    assert_eq!(fsize, 68_719_476_736, "fsize raised to 64 GiB");
    assert_eq!(
        interactive_mem, 4_294_967_296,
        "interactive class default 4 GiB"
    );
    assert_eq!(default_env, None, "default_env_id NULL = auto-detect seed");
    let schema_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'sandbox_settings'")
            .fetch_one(&pool)
            .await
            .expect("sandbox_settings schema");
    assert!(
        schema_sql.contains("fsize_bytes INTEGER NOT NULL DEFAULT 68719476736"),
        "the rebuilt table carries the 64 GiB DEFAULT: {schema_sql}"
    );
    assert!(
        schema_sql.contains("sandbox_settings_batch_mem_bounds"),
        "the rebuild folds the per-class bounds INLINE with their names: {schema_sql}"
    );

    // --- bounds checks refuse (named after the 202609020020 rebuild) ----
    let err = sqlx::query("UPDATE mcp_settings SET max_control_sessions = 99999")
        .execute(&pool)
        .await
        .expect_err("mcp OOM cap must refuse");
    assert!(
        err.to_string()
            .contains("mcp_settings_control_sessions_bounds"),
        "mcp bound names the constraint: {err}"
    );
    let err = sqlx::query("UPDATE sandbox_settings SET normal_cpu_cores = 0")
        .execute(&pool)
        .await
        .expect_err("sandbox cpu floor must refuse");
    assert!(
        err.to_string()
            .contains("sandbox_settings_normal_cpu_bounds"),
        "sandbox bound: {err}"
    );
    // env-id grammar (the GLOB/length port of the PG regexp check)
    let err = sqlx::query("UPDATE sandbox_settings SET default_env_id = 'Bad ID'")
        .execute(&pool)
        .await
        .expect_err("env-id grammar must refuse");
    assert!(
        err.to_string()
            .contains("sandbox_settings_default_env_id_grammar"),
        "env-id grammar names the constraint: {err}"
    );

    // --- compute_meter exactly-once (ON CONFLICT DO NOTHING) ------------
    let id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO compute_meter (job_id) VALUES (?)")
        .bind(id)
        .execute(&pool)
        .await
        .expect("meter insert");
    sqlx::query("INSERT INTO compute_meter (job_id) VALUES (?) ON CONFLICT (job_id) DO NOTHING")
        .bind(id)
        .execute(&pool)
        .await
        .expect("meter re-insert must be a no-op");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM compute_meter")
        .fetch_one(&pool)
        .await
        .expect("compute_meter");
    assert_eq!(n, 1, "compute_meter is exactly-once per job");

    // --- feature_flags: one global row per flag_key, per-account allowed --
    // The feature_flags FK references `accounts` — the account module's
    // baseline, ported at ITEM-10 (the REAL table sorts at 202608040012,
    // before this test's inserts on the fully-applied chain; the ITEM-8
    // staged state used the idempotent stub, which the conditional stub
    // creator no longer creates once the account dir is staged).
    let gid = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO feature_flags (id, flag_key, enabled) VALUES (?, 'demo.f', 1)")
        .bind(gid)
        .execute(&pool)
        .await
        .expect("global flag insert");
    let err =
        sqlx::query("INSERT INTO feature_flags (id, flag_key, enabled) VALUES (?, 'demo.f', 0)")
            .bind(uuid::Uuid::new_v4())
            .execute(&pool)
            .await
            .expect_err("a second global row must be refused by the partial unique index");
    assert!(
        err.to_string().contains("UNIQUE"),
        "global-uniqueness must surface as a UNIQUE violation: {err}"
    );
    let uid = uuid::Uuid::new_v4();
    // The FK is real (ON DELETE CASCADE declared): the per-account row's
    // account must exist in the parent. ITEM-10's REAL `accounts` table
    // landed with the strict baseline (kind/name NOT NULL, the
    // personal_has_user CHECK), so the fixture is a full org row.
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'probe')")
        .bind(uid)
        .execute(&pool)
        .await
        .expect("accounts fixture row (the ITEM-10 real table)");
    let n = sqlx::query(
        "INSERT INTO feature_flags (id, flag_key, account_id, enabled) VALUES (?, 'demo.f', ?, 0)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(uid)
    .execute(&pool)
    .await
    .expect("per-account override row");
    assert_eq!(
        n.rows_affected(),
        1,
        "per-account row does not collide with the global row"
    );
}
