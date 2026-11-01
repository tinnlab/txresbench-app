//! The `provenance` module's SQLite query-surface semantics — TESTS.md
//! TEST-29, the ITEM-22 per-item test.
//!
//! TESTS.md as written: "provenance recorder/verify/export/GC queries pass;
//! the jsonb/text rewrites are value-identical on fixtures."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1), so
//! the ported SQL sits IN `src/modules/provenance/**` and is verified against
//! the real sqlite build DB by the sqlx macros at `cargo check` (syntax +
//! schema + bind arity + type coherence). What a test adds on top is the
//! RUNTIME semantics those checks cannot prove, pinned here with the shipped
//! query texts (extracted verbatim from `provenance/{repository,settings,
//! graph}.rs`) against the REAL ported chain (TEST-14's harness:
//! `compose_sqlite_chain` + `apply_chain`):
//!
//! 1. the code-blob store: `ON CONFLICT (sha256) DO NOTHING` dedup, the
//!    `strftime` RFC3339 `created_at` round-trip and the `byte_len` i64;
//! 2. the run sidecar: the `INSERT … RETURNING` with app-bound uuids / JSON
//!    TEXT / the canonical clock (both entry points share the ONE statement),
//!    the `runs_for_project`/`runs_for_dataset` newest-first ordering, the
//!    `promote` filters and `list_runs` page/total agreement;
//! 3. the reference resources: `IS NOT DISTINCT FROM` NULL-safe scope match
//!    (a `None` scope sees only the global row), the `ON CONFLICT DO NOTHING`
//!    dedup + re-select race path, the per-project-or-global by-id/list;
//! 4. the verifications: `pending` insert + terminal `update` (the
//!    `now()` → `strftime` stamp), the latest-per-run exclusion of `pending`,
//!    the `list_verifications` optional-filter arms (the dropped
//!    `$2::uuid` cast — the macro's "expected 5 parameters, got 4" was the
//!    PG cast binding class), the `DISTINCT ON` → `ROW_NUMBER` window +
//!    `= ANY(uuid[])` → JSON1 membership (`unhex`/`json_each`, 32-hex only —
//!    a hyphenated JSON list never matches) and the `reset_pending` `::jsonb`
//!    → JSON-text literal + boot-reclamation stamp;
//! 5. the graph facade's `code_blob_lens`: `= ANY(text[])` → `json_each`
//!    membership (absent keys are absent, never an error);
//! 6. the scope lookups: `dataset_scope_for_file`'s M:N deterministic
//!    `LIMIT 1`, `dataset_ids_for_project` and the `artifacts_for_dataset`
//!    decode (BLOB uuid / JSON TEXT / bool / i64) over the workstore row;
//! 7. the settings singleton: `id = TRUE` (TRUE = 1) get of the seeded row,
//!    the COALESCE partial update + `updated_by` stamp + `strftime` clock,
//!    and the `updated_by IS NULL` env-seed gate (applies while the row has
//!    never been PUT; a PUT closes it for good);
//! 8. the source-dataset walk's two seed queries (a dataset-scoped artifact
//!    IS its own dataset; a run's declared-edge order is preserved) — the
//!    traversal itself is the lib's pure recursion, pinned by
//!    `tests/provenance/source_dataset_test.rs` at ITEM-25.
//!
//! (ITEM-22's per-item verification note: authored in the red window like
//! TEST-24…TEST-28 — first compile+run at ITEM-25; the identical semantics
//! were executed by the item's scratch probe (…/tmp-item22/probe) against
//! this same chain, ALL GROUPS PASSED.)

use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use uuid::Uuid;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// The repository's shipped query texts, extracted verbatim from
/// `src/modules/provenance/{repository,settings,graph}.rs` (the ITEM-22
/// port). Re-extract after any repository edit; the probe-fixture convention
/// from TEST-26/27/28.
pub const INSERT_CODE_BLOB: &str = r#"INSERT INTO provenance_code_blobs (sha256, language, source, byte_len)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (sha256) DO NOTHING"#;

pub const GET_CODE: &str = r#"SELECT sha256, language, source, byte_len,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_code_blobs WHERE sha256 = $1"#;

pub const INSERT_RUN: &str = r#"INSERT INTO provenance_run_repro
                 (run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                  code_sha256, env_rootfs_sha256, lockfile_json, seed, params,
                  inputs_json, acting_user, rerun_spec_json)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               RETURNING run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                         code_sha256, env_rootfs_sha256,
                         lockfile_json as "lockfile_json?: serde_json::Value",
                         seed,
                         params as "params: serde_json::Value",
                         inputs_json as "inputs_json: serde_json::Value",
                         rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                         acting_user,
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         captured_at as "captured_at: DateTime<Utc>""#;

pub const GET_RUN: &str = r#"SELECT run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE run_id = $1"#;

pub const GET_RERUN_SPEC: &str = r#"SELECT rerun_spec_json as "rerun_spec_json?: serde_json::Value"
               FROM provenance_run_repro WHERE run_id = $1"#;

pub const RUNS_FOR_PROJECT: &str = r#"SELECT run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE project_id = $1
               ORDER BY captured_at DESC"#;

pub const RUNS_FOR_DATASET: &str = r#"SELECT run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE dataset_id = $1
               ORDER BY captured_at DESC"#;

pub const PROMOTE_RUN_FOR_DATASET: &str = r#"SELECT run_id FROM provenance_run_repro
               WHERE dataset_id = $1 AND kind = 'promote'
               ORDER BY captured_at ASC
               LIMIT 1"#;

pub const LIST_RUNS: &str = r#"SELECT run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user,
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE project_id = $1
               ORDER BY captured_at DESC
               LIMIT $2 OFFSET $3"#;

pub const LIST_RUNS_TOTAL: &str =
    r#"SELECT count(*) as "count!" FROM provenance_run_repro WHERE project_id = $1"#;

pub const FIND_REFERENCE_IN_SCOPE: &str = r#"SELECT id, project_id, kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE content_hash = $1 AND project_id IS NOT DISTINCT FROM $2
               LIMIT 1"#;

pub const INSERT_REFERENCE: &str = r#"INSERT INTO provenance_reference_resources
                 (id, project_id, kind, name, version, accession, doi, content_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT DO NOTHING
               RETURNING id, project_id, kind, name, version, accession, doi, content_hash,
                         created_at as "created_at: DateTime<Utc>""#;

pub const FIND_REFERENCE_BY_ID: &str = r#"SELECT id, project_id, kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)"#;

pub const LIST_REFERENCES: &str = r#"SELECT id, project_id, kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE project_id = $1 OR project_id IS NULL
               ORDER BY created_at DESC"#;

pub const INSERT_VERIFICATION: &str = r#"INSERT INTO provenance_verifications
                 (id, target_run_id, project_id, status, tolerance_mode)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, target_run_id, project_id, status, tolerance_mode,
                         diff_report as "diff_report: serde_json::Value",
                         rootfs_digest,
                         cert_json as "cert_json?: serde_json::Value",
                         verified_at as "verified_at?: DateTime<Utc>",
                         created_at as "created_at: DateTime<Utc>""#;

pub const UPDATE_VERIFICATION_RESULT: &str = r#"UPDATE provenance_verifications SET
                    status = $2,
                    diff_report = $3,
                    rootfs_digest = $4,
                    cert_json = $5,
                    verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1
               RETURNING id, target_run_id, project_id, status, tolerance_mode,
                         diff_report as "diff_report: serde_json::Value",
                         rootfs_digest,
                         cert_json as "cert_json?: serde_json::Value",
                         verified_at as "verified_at?: DateTime<Utc>",
                         created_at as "created_at: DateTime<Utc>""#;

pub const LATEST_VERIFICATION_FOR_RUN: &str = r#"SELECT id, target_run_id, project_id, status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications
               WHERE target_run_id = $1 AND status <> 'pending'
               ORDER BY created_at DESC
               LIMIT 1"#;

pub const GET_VERIFICATION: &str = r#"SELECT id, target_run_id, project_id, status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications WHERE id = $1"#;

pub const LIST_VERIFICATIONS: &str = r#"SELECT id, target_run_id, project_id, status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications
               WHERE project_id = $1 AND ($2 IS NULL OR target_run_id = $2)
               ORDER BY created_at DESC
               LIMIT $3 OFFSET $4"#;

pub const LATEST_VERIFICATIONS_FOR_RUNS: &str = r#"SELECT id, target_run_id, project_id, status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM (
                   SELECT id, target_run_id, project_id, status, tolerance_mode,
                          diff_report, rootfs_digest, cert_json, verified_at, created_at,
                          ROW_NUMBER() OVER (PARTITION BY target_run_id
                                             ORDER BY created_at DESC) AS rn
                     FROM provenance_verifications
                    WHERE target_run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                      AND status <> 'pending'
               )
               WHERE rn = 1"#;

pub const RESET_PENDING: &str = r#"UPDATE provenance_verifications
               SET status = 'error',
                   diff_report = '{"error":"interrupted by a server restart"}',
                   verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE status = 'pending'"#;

pub const CODE_BLOB_LENS: &str = r#"SELECT sha256, byte_len FROM provenance_code_blobs
           WHERE sha256 IN (SELECT j.value FROM json_each($1) AS j)"#;

pub const DATASET_SCOPE_FOR_FILE: &str = r#"SELECT d.id as "dataset_id!", d.content_hash
               FROM dataset_files df JOIN datasets d ON d.id = df.dataset_id
               WHERE df.file_id = $1
               ORDER BY d.created_at ASC, d.id ASC
               LIMIT 1"#;

pub const DATASET_IDS_FOR_PROJECT: &str =
    r#"SELECT dataset_id FROM project_datasets WHERE project_id = $1"#;

pub const ARTIFACTS_FOR_DATASET: &str = r#"SELECT id, project_id, dataset_id, run_id, output_id, datatype,
                      object_key, is_multifile, content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden, representation_of
               FROM artifacts WHERE dataset_id = $1
               ORDER BY created_at DESC"#;

pub const ART_BY_ID: &str = r#"SELECT dataset_id, run_id FROM artifacts WHERE id = $1"#;

pub const INPUTS_BY_RUN: &str = r#"SELECT inputs_json as "inputs_json: serde_json::Value"
               FROM provenance_run_repro WHERE run_id = $1"#;

pub const SETTINGS_GET: &str = r#"SELECT export_bundle_max_bytes, capture_code_max_bytes,
                      export_retention_days,
                      methods_llm_polish_enabled, verify_default_tolerance,
                      verify_time_budget_secs, verify_size_budget_bytes,
                      rootfs_gc_interval_secs, rootfs_cache_max_digests,
                      updated_by as "updated_by: uuid::Uuid"
               FROM provenance_settings WHERE id = TRUE"#;

pub const SETTINGS_UPDATE: &str = r#"UPDATE provenance_settings SET
                    export_bundle_max_bytes = COALESCE($1, export_bundle_max_bytes),
                    capture_code_max_bytes = COALESCE($2, capture_code_max_bytes),
                    export_retention_days = COALESCE($3, export_retention_days),
                    methods_llm_polish_enabled = COALESCE($4, methods_llm_polish_enabled),
                    verify_default_tolerance = COALESCE($5, verify_default_tolerance),
                    verify_time_budget_secs = COALESCE($6, verify_time_budget_secs),
                    verify_size_budget_bytes = COALESCE($7, verify_size_budget_bytes),
                    rootfs_gc_interval_secs = COALESCE($8, rootfs_gc_interval_secs),
                    rootfs_cache_max_digests = COALESCE($9, rootfs_cache_max_digests),
                    updated_by = $10,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = TRUE
               RETURNING export_bundle_max_bytes, capture_code_max_bytes,
                         export_retention_days,
                         methods_llm_polish_enabled, verify_default_tolerance,
                         verify_time_budget_secs, verify_size_budget_bytes,
                         rootfs_gc_interval_secs, rootfs_cache_max_digests,
                         updated_by as "updated_by: uuid::Uuid""#;

pub const SETTINGS_ENV_SEED: &str = r#"UPDATE provenance_settings
                    SET rootfs_cache_max_digests = COALESCE($1, rootfs_cache_max_digests)
               WHERE id = TRUE AND updated_by IS NULL"#;

// ------------------------------ fixtures ------------------------------

#[derive(sqlx::FromRow)]
struct CodeBlob {
    sha256: String,
    language: String,
    source: String,
    byte_len: i64,
    #[sqlx(rename = "created_at: DateTime<Utc>")]
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct RunRow {
    run_id: Uuid,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    kind: String,
    status: String,
    generator_id: String,
    generator_version: String,
    code_sha256: Option<String>,
    env_rootfs_sha256: Option<String>,
    #[sqlx(rename = "lockfile_json?: serde_json::Value")]
    lockfile_json: Option<serde_json::Value>,
    seed: Option<i64>,
    #[sqlx(rename = "params: serde_json::Value")]
    params: serde_json::Value,
    #[sqlx(rename = "inputs_json: serde_json::Value")]
    inputs_json: serde_json::Value,
    #[sqlx(rename = "rerun_spec_json?: serde_json::Value")]
    rerun_spec_json: Option<serde_json::Value>,
    acting_user: Option<Uuid>,
    #[sqlx(rename = "started_at?: DateTime<Utc>")]
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "finished_at?: DateTime<Utc>")]
    finished_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "captured_at: DateTime<Utc>")]
    captured_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct RefRow {
    id: Uuid,
    project_id: Option<Uuid>,
    kind: String,
    name: String,
    version: String,
    accession: Option<String>,
    doi: Option<String>,
    content_hash: String,
    #[sqlx(rename = "created_at: DateTime<Utc>")]
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct VerificationRow {
    id: Uuid,
    target_run_id: Uuid,
    project_id: Uuid,
    status: String,
    tolerance_mode: String,
    #[sqlx(rename = "diff_report: serde_json::Value")]
    diff_report: serde_json::Value,
    rootfs_digest: Option<String>,
    #[sqlx(rename = "cert_json?: serde_json::Value")]
    cert_json: Option<serde_json::Value>,
    #[sqlx(rename = "verified_at?: DateTime<Utc>")]
    verified_at: Option<chrono::DateTime<chrono::Utc>>,
    #[sqlx(rename = "created_at: DateTime<Utc>")]
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct ArtifactRow {
    id: Uuid,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Option<Uuid>,
    output_id: String,
    datatype: String,
    object_key: Option<String>,
    is_multifile: bool,
    content_hash: String,
    #[sqlx(rename = "structure: serde_json::Value")]
    structure: serde_json::Value,
    #[sqlx(rename = "meta: serde_json::Value")]
    meta: serde_json::Value,
    role: String,
    status: String,
    stored_bytes: i64,
    logical_bytes: i64,
    created_by: Option<Uuid>,
    #[sqlx(rename = "created_at: DateTime<Utc>")]
    created_at: chrono::DateTime<chrono::Utc>,
    #[sqlx(rename = "updated_at: DateTime<Utc>")]
    updated_at: chrono::DateTime<chrono::Utc>,
    hidden: bool,
    representation_of: Option<Uuid>,
}

#[derive(sqlx::FromRow)]
struct SettingsRow {
    export_bundle_max_bytes: i64,
    capture_code_max_bytes: i64,
    export_retention_days: i64,
    methods_llm_polish_enabled: bool,
    verify_default_tolerance: f64,
    verify_time_budget_secs: i64,
    verify_size_budget_bytes: i64,
    rootfs_gc_interval_secs: i64,
    rootfs_cache_max_digests: i64,
    #[sqlx(rename = "updated_by: uuid::Uuid")]
    updated_by: Option<Uuid>,
}

fn hex(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("serialize")
}

fn hyp(ids: &[Uuid]) -> String {
    serde_json::to_string(&ids.iter().map(|id| id.to_string()).collect::<Vec<String>>())
        .expect("serialize")
}

async fn user(pool: &SqlitePool, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, ?, ?)")
        .bind(id)
        .bind(name)
        .bind(format!("{name}@example.com"))
        .execute(pool)
        .await
        .expect("user fixture");
    id
}

async fn account(pool: &SqlitePool, user_id: Uuid) -> Uuid {
    // Idempotent: one personal account per user (the UNIQUE index on
    // personal_user_id) — a fixture that builds a project AND a dataset for
    // one owner reuses the same account (the module_workstore convention).
    if let Some(existing) = sqlx::query_scalar("SELECT id FROM accounts WHERE personal_user_id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .expect("account lookup")
    {
        return existing;
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name, personal_user_id) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind("personal")
        .bind("probe")
        .bind(user_id)
        .execute(pool)
        .await
        .expect("account fixture");
    id
}

async fn project(pool: &SqlitePool, id: Uuid, owner: Uuid) {
    let acc = account(pool, owner).await;
    sqlx::query("INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(owner)
        .bind("probe-project")
        .bind(acc)
        .execute(pool)
        .await
        .expect("project fixture");
}

async fn dataset(pool: &SqlitePool, id: Uuid, owner: Uuid) {
    let acc = account(pool, owner).await;
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind("probe-ds")
    .bind(owner)
    .bind(acc)
    .bind(Option::<String>::None)
    .bind(serde_json::json!({}))
    .bind("upload")
    .execute(pool)
    .await
    .expect("dataset fixture");
}

async fn run_with(
    pool: &SqlitePool,
    run_id: Uuid,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    kind: &str,
    acting_user: Option<Uuid>,
    params: serde_json::Value,
    inputs: serde_json::Value,
    rerun_spec: Option<serde_json::Value>,
    captured_at: &str,
) {
    sqlx::query(
        "INSERT INTO provenance_run_repro \
         (run_id, project_id, dataset_id, kind, status, generator_id, generator_version, \
          code_sha256, env_rootfs_sha256, lockfile_json, seed, params, inputs_json, \
          acting_user, rerun_spec_json, captured_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(run_id)
    .bind(project_id)
    .bind(dataset_id)
    .bind(kind)
    .bind("completed")
    .bind("gen")
    .bind("1.0")
    .bind(Option::<String>::None)
    .bind(Option::<String>::None)
    .bind(Option::<serde_json::Value>::None)
    .bind(Option::<i64>::None)
    .bind(params)
    .bind(inputs)
    .bind(acting_user)
    .bind(rerun_spec)
    .bind(captured_at)
    .execute(pool)
    .await
    .expect("run fixture");
}

async fn artifact(
    pool: &SqlitePool,
    id: Uuid,
    dataset_id: Option<Uuid>,
    run_id: Option<Uuid>,
    created_at: &str,
) {
    sqlx::query(
        "INSERT INTO artifacts (id, project_id, dataset_id, run_id, output_id, datatype, \
         object_key, is_multifile, content_hash, structure, meta, role, status, \
         stored_bytes, logical_bytes, created_by, hidden, created_at) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(Option::<Uuid>::None)
    .bind(dataset_id)
    .bind(run_id)
    // (the natural-key unique index needs a per-artifact output id in the
    // same-dataset fixtures — the workstore natural key could not hold two
    // NULL-run artifacts with one output_id.)
    .bind(Uuid::new_v4().to_string())
    .bind("data/opaque")
    .bind("obj/test")
    .bind(false)
    .bind("sha256:test")
    .bind("{}")
    .bind("{}")
    .bind("artifact")
    .bind("ready")
    .bind(0i64)
    .bind(100i64)
    .bind(Option::<Uuid>::None)
    .bind(false)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("artifact fixture");
}

async fn fresh_chain(tag: &str) -> (Scratch, SqlitePool) {
    let scratch = Scratch::new(tag);
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    (scratch, pool)
}

// =============================== tests ===============================

/// TEST-29 leg 1 — the code-blob store: dedup + the canonical-clock decode.
#[tokio::test]
async fn code_blob_dedup_and_clock_roundtrip() {
    let (_s, pool) = fresh_chain("prov-1").await;
    let sha = "sha:dedup-1";
    let n = sqlx::query(INSERT_CODE_BLOB)
        .bind(sha)
        .bind("python")
        .bind("mask = 1\n")
        .bind(9i64)
        .execute(&pool)
        .await
        .expect("insert blob")
        .rows_affected();
    assert_eq!(n, 1);
    let n = sqlx::query(INSERT_CODE_BLOB)
        .bind(sha)
        .bind("python")
        .bind("mask = 1\n")
        .bind(9i64)
        .execute(&pool)
        .await
        .expect("insert dup")
        .rows_affected();
    assert_eq!(n, 0, "ON CONFLICT (sha256) DO NOTHING → no-op (dedup key)");
    let row = sqlx::query_as::<_, CodeBlob>(GET_CODE)
        .bind(sha)
        .fetch_one(&pool)
        .await
        .expect("get blob");
    assert_eq!(row.byte_len, 9);
    assert_eq!(row.language, "python");
    assert!(
        row.created_at
            .signed_duration_since(chrono::Utc::now())
            .num_seconds()
            .abs()
            < 60,
        "created_at decodes from the RFC3339 TEXT clock"
    );
    let absent = sqlx::query_as::<_, CodeBlob>(GET_CODE)
        .bind("sha:absent")
        .fetch_optional(&pool)
        .await
        .expect("get absent");
    assert!(absent.is_none());
}

/// TEST-29 leg 2 — the run sidecar: RETURNING insert, ordering and
/// page/total agreement (the `source_datasets_of` walk's inputs select is
/// pinned by the leg-8 group).
#[tokio::test]
async fn run_sidecar_returning_ordering_and_paging() {
    let (_s, pool) = fresh_chain("prov-2").await;
    let owner = user(&pool, "prov2-owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;

    let run1 = Uuid::new_v4();
    run_with(
        &pool,
        run1,
        Some(p),
        None,
        "compute",
        None,
        serde_json::json!({}),
        serde_json::json!([]),
        None,
        "2026-01-01T00:00:00.000Z",
    )
    .await;
    let run2 = Uuid::new_v4();
    run_with(
        &pool,
        run2,
        Some(p),
        None,
        "compute",
        None,
        serde_json::json!({}),
        serde_json::json!([]),
        None,
        "2026-01-03T00:00:00.000Z",
    )
    .await;

    // The INSERT … RETURNING (the repository's `insert_run_with` shape).
    let new_run = Uuid::new_v4();
    let row = sqlx::query_as::<_, RunRow>(INSERT_RUN)
        .bind(new_run)
        .bind(Some(p))
        .bind(Option::<Uuid>::None)
        .bind("compute")
        .bind("recorded")
        .bind("gen")
        .bind("1.2.3")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(Option::<serde_json::Value>::None)
        .bind(Option::<i64>::None)
        .bind(serde_json::json!({"p": 1}))
        .bind(serde_json::json!([{"kind": "dataset", "ref_id": run1.to_string()}]))
        .bind(Option::<Uuid>::None)
        .bind(Option::<serde_json::Value>::None)
        .fetch_one(&pool)
        .await
        .expect("insert run RETURNING");
    assert_eq!(
        row.run_id, new_run,
        "RETURNING id is the app-bound value (no SQL default)"
    );
    assert_eq!(row.params, serde_json::json!({"p": 1}));
    assert_eq!(
        row.inputs_json,
        serde_json::json!([{"kind": "dataset", "ref_id": run1.to_string()}])
    );
    assert!(
        row.captured_at
            .signed_duration_since(chrono::Utc::now())
            .num_seconds()
            .abs()
            < 60
    );

    let got = sqlx::query_as::<_, RunRow>(GET_RUN)
        .bind(new_run)
        .fetch_one(&pool)
        .await
        .expect("get run");
    assert_eq!(got.project_id, Some(p));
    assert_eq!(got.acting_user, None);

    let spec = sqlx::query_scalar::<_, Option<serde_json::Value>>(GET_RERUN_SPEC)
        .bind(run1)
        .fetch_one(&pool)
        .await
        .expect("rerun spec query");
    assert_eq!(spec, None, "a run that recorded none yields None");

    let rows = sqlx::query_as::<_, RunRow>(RUNS_FOR_PROJECT)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("runs for project");
    assert!(rows.len() >= 3);
    assert_eq!(
        rows[0].run_id, new_run,
        "newest-first (the INSERT's strftime clock is now)"
    );
    assert!(
        rows[1].captured_at >= rows[2].captured_at,
        "ORDER BY captured_at DESC"
    );

    let d_rows = sqlx::query_as::<_, RunRow>(RUNS_FOR_DATASET)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("runs for dataset");
    assert!(d_rows.is_empty(), "no dataset-scoped run in this fixture");

    let page = sqlx::query_as::<_, RunRow>(LIST_RUNS)
        .bind(p)
        .bind(2i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("page");
    assert_eq!(page.len(), 2);
    let total = sqlx::query_scalar::<_, i64>(LIST_RUNS_TOTAL)
        .bind(p)
        .fetch_one(&pool)
        .await
        .expect("total");
    assert_eq!(total, 3, "page + total agree");
}

/// TEST-29 leg 3 — reference resources: the NULL-safe scope match and the
/// dedup + re-select race path.
#[tokio::test]
async fn reference_scope_null_safe_dedup() {
    let (_s, pool) = fresh_chain("prov-3").await;
    let owner = user(&pool, "prov3-owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let hash = "sha256:ref-1";
    let ref_id = sqlx::query_as::<_, RefRow>(INSERT_REFERENCE)
        .bind(Uuid::new_v4())
        .bind(Option::<Uuid>::None)
        .bind("upload")
        .bind("ref.bin")
        .bind("v1")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(hash)
        .fetch_one(&pool)
        .await
        .expect("insert global ref")
        .id;
    let p_scope = sqlx::query_as::<_, RefRow>(FIND_REFERENCE_IN_SCOPE)
        .bind(hash)
        .bind(Some(p))
        .fetch_optional(&pool)
        .await
        .expect("find in project");
    assert!(
        p_scope.is_none(),
        "IS NOT DISTINCT FROM: a project scope never matches the global row"
    );
    let g_scope = sqlx::query_as::<_, RefRow>(FIND_REFERENCE_IN_SCOPE)
        .bind(hash)
        .bind(Option::<Uuid>::None)
        .fetch_optional(&pool)
        .await
        .expect("find in global");
    assert!(g_scope.is_some(), "None scope matches only the global row");
    // The lost-race path: the second identical upload conflicts → None →
    // repository re-selects the winner.
    let dup = sqlx::query_as::<_, RefRow>(INSERT_REFERENCE)
        .bind(Uuid::new_v4())
        .bind(Option::<Uuid>::None)
        .bind("upload")
        .bind("ref.bin")
        .bind("v1")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(hash)
        .fetch_optional(&pool)
        .await
        .expect("insert dup");
    assert!(
        dup.is_none(),
        "ON CONFLICT DO NOTHING on the dedup unique index"
    );
    let by_id = sqlx::query_as::<_, RefRow>(FIND_REFERENCE_BY_ID)
        .bind(ref_id)
        .bind(p)
        .fetch_one(&pool)
        .await
        .expect("find by id");
    assert_eq!(by_id.content_hash, hash, "global ref valid for ANY project");
    let list = sqlx::query_as::<_, RefRow>(LIST_REFERENCES)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("list");
    assert_eq!(list.len(), 1, "project rows ∪ global rows");
}

/// TEST-29 leg 4 — verifications: the terminal stamp clock, the optional
/// filter arm (the dropped `$2::uuid` cast), the DISTINCT ON → window
/// rewrite with the JSON1 membership (hex-only), and the pending reset.
#[tokio::test]
async fn verification_terminal_filter_window_and_reset() {
    let (_s, pool) = fresh_chain("prov-4").await;
    let owner = user(&pool, "prov4-owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let run = Uuid::new_v4();
    run_with(
        &pool,
        run,
        Some(p),
        None,
        "compute",
        None,
        serde_json::json!({}),
        serde_json::json!([]),
        None,
        "2026-01-01T00:00:00.000Z",
    )
    .await;
    for (v, status, at) in [
        (Uuid::new_v4(), "pending", "2027-01-02T00:00:00.000Z"),
        (Uuid::new_v4(), "error", "2027-01-03T00:00:00.000Z"),
        (Uuid::new_v4(), "verified", "2027-01-04T00:00:00.000Z"),
    ] {
        sqlx::query("INSERT INTO provenance_verifications (id, target_run_id, project_id, status, tolerance_mode, created_at) \
                     VALUES (?,?,?,?,?,?)")
            .bind(v)
            .bind(run)
            .bind(p)
            .bind(status)
            .bind("tolerant")
            .bind(at)
            .execute(&pool)
            .await
            .expect("verification fixture");
    }

    let vnew = Uuid::new_v4();
    let row = sqlx::query_as::<_, VerificationRow>(INSERT_VERIFICATION)
        .bind(vnew)
        .bind(run)
        .bind(p)
        .bind("pending")
        .bind("strict")
        .fetch_one(&pool)
        .await
        .expect("insert verification");
    assert_eq!(row.status, "pending");
    assert!(row.verified_at.is_none());

    let result = sqlx::query_as::<_, VerificationRow>(UPDATE_VERIFICATION_RESULT)
        .bind(vnew)
        .bind("verified")
        .bind(serde_json::json!({"diff": 0.0}))
        .bind(Option::<String>::Some("sha256:rootfs".into()))
        .bind(Option::<serde_json::Value>::Some(
            serde_json::json!({"ok": true}),
        ))
        .fetch_one(&pool)
        .await
        .expect("update result");
    assert_eq!(result.status, "verified");
    let stamped = result.verified_at.expect("stamped by the strftime clock");
    assert!(
        stamped
            .signed_duration_since(chrono::Utc::now())
            .num_seconds()
            .abs()
            < 60
    );

    let latest = sqlx::query_as::<_, VerificationRow>(LATEST_VERIFICATION_FOR_RUN)
        .bind(run)
        .fetch_one(&pool)
        .await
        .expect("latest");
    assert_eq!(
        latest.diff_report,
        serde_json::json!({}),
        "the v3 terminal row"
    );
    assert_eq!(latest.status, "verified");
    assert!(
        latest.created_at > result.created_at,
        "newest terminal, not the just-stamped one"
    );

    // The optional filter: both arms bind the same Option<Uuid> (the cast is gone).
    let all = sqlx::query_as::<_, VerificationRow>(LIST_VERIFICATIONS)
        .bind(p)
        .bind(Option::<Uuid>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("list all");
    assert_eq!(all.len(), 4);
    let filtered = sqlx::query_as::<_, VerificationRow>(LIST_VERIFICATIONS)
        .bind(p)
        .bind(Some(run))
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("list filtered");
    assert_eq!(filtered.len(), 4);

    let rows = sqlx::query_as::<_, VerificationRow>(LATEST_VERIFICATIONS_FOR_RUNS)
        .bind(hex(&[run]))
        .fetch_all(&pool)
        .await
        .expect("latest batch (hex)");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].status, "verified",
        "the newest terminal per run; pending excluded"
    );
    let rows_hyp = sqlx::query_as::<_, VerificationRow>(LATEST_VERIFICATIONS_FOR_RUNS)
        .bind(hyp(&[run]))
        .fetch_all(&pool)
        .await
        .expect("latest batch (hyphenated)");
    assert!(
        rows_hyp.is_empty(),
        "the JSON1 membership reads 32-hex only (hyphenated never matches)"
    );

    // A later terminal row flips the window's winner.
    let v4 = Uuid::new_v4();
    sqlx::query("INSERT INTO provenance_verifications (id, target_run_id, project_id, status, tolerance_mode, created_at) \
                 VALUES (?,?,?,?,?,?)")
        .bind(v4)
        .bind(run)
        .bind(p)
        .bind("verified")
        .bind("tolerant")
        .bind("2027-01-05T00:00:00.000Z")
        .execute(&pool)
        .await
        .expect("v4");
    let rows2 = sqlx::query_as::<_, VerificationRow>(LATEST_VERIFICATIONS_FOR_RUNS)
        .bind(hex(&[run]))
        .fetch_all(&pool)
        .await
        .expect("latest batch 2");
    assert_eq!(rows2.len(), 1);
    assert_eq!(
        rows2[0].id, v4,
        "one row per run — the DISTINCT ON equivalent"
    );

    // One leftover pending row (the fixture's deliberately-pending first row; vnew
    // was stamped terminal) — the reopen sweep resets exactly it.
    let n = sqlx::query(RESET_PENDING)
        .execute(&pool)
        .await
        .expect("reset")
        .rows_affected();
    assert_eq!(n, 1, "the one leftover pending row is swept");
}

/// TEST-29 leg 5 — the graph facade's `code_blob_lens`: text-array ANY →
/// json_each membership.
#[tokio::test]
async fn code_blob_lens_json_each_membership() {
    let (_s, pool) = fresh_chain("prov-5").await;
    for sha in ["sha:lens-a", "sha:lens-b"] {
        sqlx::query(INSERT_CODE_BLOB)
            .bind(sha)
            .bind("r")
            .bind("src")
            .bind(42i64)
            .execute(&pool)
            .await
            .expect("blob");
    }
    let rows = sqlx::query(CODE_BLOB_LENS)
        .bind(serde_json::to_string(&["sha:lens-a", "sha:lens-b", "sha:absent"]).unwrap())
        .fetch_all(&pool)
        .await
        .expect("lens");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].get::<i64, _>(1), 42);
    let empty = sqlx::query(CODE_BLOB_LENS)
        .bind("[]")
        .fetch_all(&pool)
        .await
        .expect("empty lens");
    assert!(empty.is_empty());
}

/// TEST-29 leg 6 — the scope lookups: the file→dataset deterministic LIMIT 1,
/// the project's dataset set and the workstore artifact decode.
#[tokio::test]
async fn scope_lookups_and_artifact_decode() {
    let (_s, pool) = fresh_chain("prov-6").await;
    let owner = user(&pool, "prov6-owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let ds1 = Uuid::new_v4();
    let ds2 = Uuid::new_v4();
    dataset(&pool, ds1, owner).await;
    dataset(&pool, ds2, owner).await;
    let f = Uuid::new_v4();
    // dataset_files.file_id → files(id) (FK): the file and its version chain must
    // exist before the link rows.
    let ver = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, version, is_head, blob_version_id, \
         file_size, created_by) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(ver)
    .bind(f)
    .bind(1i64)
    .bind(true)
    .bind(Uuid::new_v4())
    .bind(10i64)
    .bind("test")
    .execute(&pool)
    .await
    .expect("file version fixture");
    sqlx::query(
        "INSERT INTO files (id, user_id, filename, file_size, checksum, current_version_id) \
         VALUES (?,?,?,?,?,?)",
    )
    .bind(f)
    .bind(owner)
    .bind("f.csv")
    .bind(10i64)
    .bind(Option::<String>::None)
    .bind(ver)
    .execute(&pool)
    .await
    .expect("file fixture");
    for ds in [ds1, ds2] {
        sqlx::query("INSERT INTO dataset_files (dataset_id, file_id) VALUES (?,?)")
            .bind(ds)
            .bind(f)
            .execute(&pool)
            .await
            .expect("dataset_files");
    }
    let scope = sqlx::query(DATASET_SCOPE_FOR_FILE)
        .bind(f)
        .fetch_one(&pool)
        .await
        .expect("scope");
    // (the runtime column name carries the macro's `!` suffix verbatim, so the
    // test reads by position — the macro strips it at compile time.)
    let ds_id: Uuid = scope.get(0);
    assert_eq!(
        ds_id, ds1,
        "earliest-created (then id) wins the M:N LIMIT 1"
    );
    let none = sqlx::query(DATASET_SCOPE_FOR_FILE)
        .bind(Uuid::new_v4())
        .fetch_optional(&pool)
        .await
        .expect("scope absent");
    assert!(none.is_none());

    for ds in [ds1, ds2] {
        sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES (?,?)")
            .bind(p)
            .bind(ds)
            .execute(&pool)
            .await
            .expect("project_datasets");
    }
    let ids = sqlx::query(DATASET_IDS_FOR_PROJECT)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("project datasets");
    let mut got: Vec<Uuid> = ids.iter().map(|r| r.get("dataset_id")).collect();
    got.sort();
    let mut want = vec![ds1, ds2];
    want.sort();
    assert_eq!(got, want);

    artifact(
        &pool,
        Uuid::new_v4(),
        Some(ds1),
        None,
        "2026-01-01T00:00:00.000Z",
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        Some(ds1),
        None,
        "2026-01-02T00:00:00.000Z",
    )
    .await;
    let arts = sqlx::query_as::<_, ArtifactRow>(ARTIFACTS_FOR_DATASET)
        .bind(ds1)
        .fetch_all(&pool)
        .await
        .expect("artifacts");
    assert_eq!(arts.len(), 2);
    assert_eq!(arts[0].structure, serde_json::json!({}));
    assert_eq!(arts[0].logical_bytes, 100);
    assert_eq!(arts[0].project_id, None);
    assert!(arts[0].created_at >= arts[1].created_at, "newest-first");
}

/// TEST-29 leg 7 — the settings singleton: seeded defaults, the COALESCE
/// partial update with the `updated_by` stamp, and the env-seed gate.
#[tokio::test]
async fn settings_singleton_update_and_env_seed_gate() {
    let (_s, pool) = fresh_chain("prov-7").await;
    let s = sqlx::query_as::<_, SettingsRow>(SETTINGS_GET)
        .fetch_one(&pool)
        .await
        .expect("settings get");
    assert_eq!(s.export_bundle_max_bytes, 1_073_741_824);
    assert!(!s.methods_llm_polish_enabled, "INTEGER 0 → bool");
    assert_eq!(s.verify_default_tolerance, 0.99);
    assert_eq!(s.rootfs_cache_max_digests, 4);
    assert!(s.updated_by.is_none());

    let n = sqlx::query(SETTINGS_ENV_SEED)
        .bind(Option::<i64>::Some(9))
        .execute(&pool)
        .await
        .expect("env seed")
        .rows_affected();
    assert_eq!(n, 1);
    let s = sqlx::query_as::<_, SettingsRow>(SETTINGS_GET)
        .fetch_one(&pool)
        .await
        .expect("get 2");
    assert_eq!(s.rootfs_cache_max_digests, 9);

    let admin = Uuid::new_v4();
    let res = sqlx::query_as::<_, SettingsRow>(SETTINGS_UPDATE)
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::Some(65536))
        .bind(Option::<i64>::Some(90))
        .bind(Option::<bool>::Some(true))
        .bind(Option::<f64>::None)
        .bind(Option::<i64>::Some(7200))
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::Some(21_600))
        .bind(Option::<i64>::None)
        .bind(admin)
        .fetch_one(&pool)
        .await
        .expect("settings update");
    assert_eq!(res.capture_code_max_bytes, 65536);
    assert_eq!(
        res.export_bundle_max_bytes, 1_073_741_824,
        "COALESCE keeps untouched fields"
    );
    assert!(res.methods_llm_polish_enabled);
    assert_eq!(res.updated_by, Some(admin));

    let n = sqlx::query(SETTINGS_ENV_SEED)
        .bind(Option::<i64>::Some(42))
        .execute(&pool)
        .await
        .expect("env seed 2")
        .rows_affected();
    assert_eq!(
        n, 0,
        "a PUT closes the updated_by IS NULL gate — env never re-seeds"
    );
}

/// TEST-29 leg 8 — the source-dataset walk's seed queries: a dataset-scoped
/// artifact is its own dataset and a run's declared-edge order is preserved.
#[tokio::test]
async fn source_dataset_walk_seed_queries() {
    let (_s, pool) = fresh_chain("prov-8").await;
    let owner = user(&pool, "prov8-owner").await;
    let ds = Uuid::new_v4();
    dataset(&pool, ds, owner).await;
    let a = Uuid::new_v4();
    artifact(&pool, a, Some(ds), None, "2026-01-01T00:00:00.000Z").await;
    let row = sqlx::query(ART_BY_ID)
        .bind(a)
        .fetch_one(&pool)
        .await
        .expect("art");
    let dataset_id: Option<Uuid> = row.get("dataset_id");
    let run_id: Option<Uuid> = row.get("run_id");
    assert_eq!(dataset_id, Some(ds));
    assert_eq!(run_id, None);

    let run = Uuid::new_v4();
    run_with(
        &pool,
        run,
        None,
        None,
        "compute",
        None,
        serde_json::json!({}),
        serde_json::json!([
            {"kind": "dataset", "ref_id": ds.to_string(), "slot": "p"},
            {"kind": "artifact", "ref_id": a.to_string(), "slot": "s"},
            {"kind": "reference", "ref_id": null, "slot": "r"}
        ]),
        None,
        "2026-01-01T00:00:00.000Z",
    )
    .await;
    let inputs: serde_json::Value = sqlx::query_scalar(INPUTS_BY_RUN)
        .bind(run)
        .fetch_one(&pool)
        .await
        .expect("inputs");
    let edges: Vec<serde_json::Value> = serde_json::from_value(inputs).expect("edges");
    assert_eq!(
        edges.len(),
        3,
        "declared edge order preserved (depth-first walk input)"
    );
    assert_eq!(edges[0]["kind"], "dataset");
    assert_eq!(edges[2]["kind"], "reference");
}

/// TEST-29 leg 9 — the source-vertex seeds pin the `reset_pending` boot
/// reclamation stamp (a pending row is resolvable to `error` with the JSON
/// text literal — the `::jsonb` cast is gone).
#[tokio::test]
async fn reset_pending_stamps_error_with_json_text() {
    let (_s, pool) = fresh_chain("prov-9").await;
    let owner = user(&pool, "prov9-owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let run = Uuid::new_v4();
    run_with(
        &pool,
        run,
        Some(p),
        None,
        "compute",
        None,
        serde_json::json!({}),
        serde_json::json!([]),
        None,
        "2026-01-01T00:00:00.000Z",
    )
    .await;
    let v = Uuid::new_v4();
    sqlx::query("INSERT INTO provenance_verifications (id, target_run_id, project_id, status, tolerance_mode) \
                 VALUES (?,?,?,?,?)")
        .bind(v)
        .bind(run)
        .bind(p)
        .bind("pending")
        .bind("tolerant")
        .execute(&pool)
        .await
        .expect("pending fixture");
    let n = sqlx::query(RESET_PENDING)
        .execute(&pool)
        .await
        .expect("reset")
        .rows_affected();
    assert_eq!(n, 1, "the orphaned pending row is reclaimed");
    let row = sqlx::query_as::<_, VerificationRow>(GET_VERIFICATION)
        .bind(v)
        .fetch_one(&pool)
        .await
        .expect("get reset");
    assert_eq!(row.status, "error");
    assert_eq!(
        row.diff_report,
        serde_json::json!({"error": "interrupted by a server restart"}),
        "the JSON text literal equals the PG ::jsonb value"
    );
    assert!(
        row.verified_at.is_some(),
        "boot reclamation stamps verified_at"
    );
}
