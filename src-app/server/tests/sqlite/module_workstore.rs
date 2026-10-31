//! The `workstore` module's SQLite query-surface semantics - TESTS.md TEST-27,
//! the ITEM-20 per-item test.
//!
//! TESTS.md as written: "artifact rows, usable-artifacts view, recipe alignment,
//! upload limits and migration_repo secret round-trip; the object-store cutover
//! queries return identical fixture rows (SQLite `jsonb()` canonical
//! comparison)."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1), so
//! the ported SQL sits IN `src/modules/workstore/**` and is verified against
//! the real sqlite build DB by the sqlx macros at `cargo check` (syntax +
//! schema + bind arity + type coherence). What a test adds on top is the
//! RUNTIME semantics those checks cannot prove, pinned here with the shipped
//! query texts (extracted verbatim from the module's .rs files) against the
//! REAL ported chain (TEST-14's harness: `compose_sqlite_chain` + `apply_chain`):
//!
//! 1. the natural-key UPSERT - the expression `ON CONFLICT` target against the
//!    `artifacts_natural_key` COALESCE(`X'0000...'`) index (the nil-sentinel key
//!    semantics: a project-scoped and a dataset-scoped row with the same
//!    `output_id` are DISTINCT keys), plus the app-bound `id` (the sqlite
//!    chain has no `gen_random_uuid()` - the DEC-12 bind rule);
//! 2. the axis-index containment (`json_type(meta, '$.is_axis_index') =
//!    'true'` - a numeric `1` or string `"true"` does NOT match the PG `@>`
//!    boolean) and the datatype TEXT-array membership (`json_each`);
//! 3. the ITEM-30 membership-narrowing arms (array / legacy scalar / neither,
//!    with the `json_type` exactness pins: a JSON-null `aligned_to` does not
//!    fall into the absence arm - PG `-> IS NULL` semantics);
//! 4. the LATERAL-free reach CTE (`json_tree`: both recipe edges, transitive
//!    composition, cycle termination, hyphenated->`unhex` BLOB, stored rows and
//!    JSON-null refs never expanded);
//! 5. the detach-guard signature + the produced-datasets query (the
//!    hyphenated-text membership the producer writes), the
//!    `json_set`/`json_quote` unresolvable stamp (a numeric-looking source
//!    stays a JSON STRING), and the backfill natural-key precheck + guarded
//!    update;
//! 6. the migration_repo dynamic queries: create -> the single-active 2067/1555
//!    conflict with the app-bound id, `MAX` progress monotonicity, the
//!    RFC3339 `strftime` clock, reap + unretired exclusions (incl. the
//!    `auto_started` arm);
//! 7. the settings singleton (`WHERE id = TRUE`, partial COALESCE update,
//!    `updated_by IS NULL` seed guard), the virtual-dataset `json_extract`
//!    lookups and the footprint aggregate over `usable_artifacts`.
//!
//! (ITEM-20's per-item verification note: authored in the red window like
//! TEST-24/25/26 - first compile+run at ITEM-25; the identical semantics were
//! executed by the item's scratch probe against this same chain.)

use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use uuid::Uuid;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// The repository's `SELECT_COLS` projection (extracted at ITEM-20) — the
/// `format!`-built queries splice it at runtime, exactly as the shipped code does.
const SELECT_COLS: &str = "id, src_backend, src_provider, src_bucket, dst_backend, dst_provider, \
     dst_bucket, phase, blobs_total, blobs_done, bytes_total, bytes_done, cross_cloud, \
     cost_ack, verify_error, auto_started, cutover, src_config_ciphertext";

fn mig_sql(q: &str) -> String {
    q.replace("{SELECT_COLS}", SELECT_COLS)
}

pub const INSERT_ARTIFACT: &str = r#"INSERT INTO artifacts
                 (id, project_id, dataset_id, run_id, output_id, datatype, object_key,
                  is_multifile, content_hash, structure, meta, role, status,
                  stored_bytes, logical_bytes, created_by, hidden, representation_of)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ready',$13,$14,$15,$16,$17)
               ON CONFLICT (COALESCE(project_id, X'00000000000000000000000000000000'),
                            COALESCE(dataset_id, X'00000000000000000000000000000000'),
                            COALESCE(run_id, X'00000000000000000000000000000000'), output_id)
               DO UPDATE SET datatype = EXCLUDED.datatype,
                             object_key = EXCLUDED.object_key,
                             is_multifile = EXCLUDED.is_multifile,
                             content_hash = EXCLUDED.content_hash,
                             structure = EXCLUDED.structure,
                             meta = EXCLUDED.meta,
                             role = EXCLUDED.role,
                             status = 'ready',
                             stored_bytes = EXCLUDED.stored_bytes,
                             logical_bytes = EXCLUDED.logical_bytes,
                             hidden = EXCLUDED.hidden,
                             representation_of = EXCLUDED.representation_of,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id, project_id, dataset_id, run_id, output_id, datatype,
                         object_key, is_multifile, content_hash,
                         structure as "structure: serde_json::Value",
                         meta as "meta: serde_json::Value",
                         role, status, stored_bytes, logical_bytes, created_by,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>",
                         hidden, representation_of"#;

pub const FOOTPRINT: &str = r#"SELECT count(*) as "count!",
                      coalesce(sum(logical_bytes), 0) as "bytes!: i64"
               FROM usable_artifacts WHERE project_id = $1"#;

pub const REACH_CTE: &str = r#"WITH RECURSIVE reach(id) AS (
                   SELECT id FROM artifacts WHERE project_id = $1
                 UNION
                   SELECT unhex(replace(json_extract(a.structure,
                              '$.gathered_from.alignment_artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_extract(a.structure,
                              '$.gathered_from.alignment_artifact_id') IS NOT NULL
                 UNION
                   -- The MASK is as load-bearing as the alignment (ITEM-1/ITEM-2): a
                   -- masked gather without it resolves to nothing, so its blob must be
                   -- kept while any column reads through it. Null for the integration
                   -- (no-mask) and identity cases; the IS NOT NULL guard drops those.
                   SELECT unhex(replace(json_extract(a.structure,
                              '$.gathered_from.mask_artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_extract(a.structure,
                              '$.gathered_from.mask_artifact_id') IS NOT NULL
                 UNION
                   SELECT unhex(replace(json_extract(jt.value, '$.artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   JOIN json_each(COALESCE(
                            json_extract(a.structure, '$.gathered_from.sources'), '[]')) AS jt
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_type(jt.value, '$.artifact_id') = 'text'
               )
               SELECT a.id, a.project_id, a.output_id, a.object_key, a.is_multifile
               FROM artifacts a JOIN reach r ON a.id = r.id"#;

pub const AXIS_CAND: &str = r#"SELECT id, project_id, dataset_id, run_id, output_id, datatype,
                      object_key, is_multifile, content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden, representation_of
               FROM artifacts
               WHERE dataset_id = $1
                 AND datatype IN (SELECT j.value FROM json_each($2) AS j)
                 AND json_type(meta, '$.is_axis_index') = 'true'
                 AND json_extract(structure, '$.axis') = $3
                 AND status = 'ready'
               ORDER BY id"#;

pub const NARROW: &str = r#"SELECT id, project_id, dataset_id, run_id, output_id, datatype,
                      object_key, is_multifile, content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden, representation_of
               FROM artifacts
               -- ITEM-49 — THE LISTING USES THE SAME SCOPE RULE AS THE AUTHZ GATE.
               --
               -- `authz::artifact_scope` resolves a row carrying BOTH columns to
               -- `Project(p)` — the project takes precedence — so `require_artifact_read`
               -- gates such a row by its project. The listing's second disjunct did not
               -- agree: it matched on `dataset_id` alone, so once the ownership backfill
               -- filled that column on project-produced rows, an artifact of project P
               -- appeared in project Q's catalog whenever the dataset was attached to both.
               -- Measured, not theorised: `dual_scope_visibility_test` observed exactly that
               -- (1 where 0 was expected) before this clause.
               --
               -- The byte plane was never exposed — `artifact_scope` denied it — so what
               -- widened was metadata: the existence, `output_id`, datatype and declared
               -- structure of another project's derived work. That is still a disclosure,
               -- and it arrives as a side effect of a column being filled.
               --
               -- `project_id IS NULL` restores the pre-backfill set exactly: a row is listed
               -- in the project that PRODUCED it, or — when it is dataset-scoped and has no
               -- producing project — in every project the dataset is attached to. Whether a
               -- project-produced artifact SHOULD follow its dataset into other projects is
               -- a product decision (it is one line here); it must not be taken by accident.
               WHERE (project_id = $1
                      OR (project_id IS NULL AND dataset_id IN (
                          SELECT pd.dataset_id FROM project_datasets pd WHERE pd.project_id = $1)))
                 AND ($2 IS NULL OR datatype = $2)
                 AND ($3 IS NULL OR run_id = $3)
                 AND ($4 IS NULL OR output_id = $4)
                 AND ($5 IS NULL OR datatype IN (SELECT j.value FROM json_each($5) AS j))
                 -- ITEM-30 — the MEMBERSHIP narrowing (INV-2). The PG arm was
                 -- containment against the GIN `jsonb_path_query_array` expression
                 -- index `202608040004`; the SQLite chain carries NO such index
                 -- (202608280001's port note: JSON1 has no GIN and `json_each`
                 -- cannot appear in an index expression), so the predicate here is
                 -- the ported form — `EXISTS (SELECT 1 FROM json_each(...))` over
                 -- the scope-narrowed rows (bounded), spelled with the exact
                 -- `json_type(..., path) IS NOT NULL` treatment for the two
                 -- absence arms so PG `-> IS NULL` semantics (a JSON-null value is
                 -- a PRESENT key) survive.
                 --
                 -- No identity judgment in SQL, no ordering, no `LIMIT 1`: which candidate is
                 -- OFFERED is decided in TypeScript, where it is unit-testable without a
                 -- database. This narrows the set and decides nothing — the same division
                 -- `list_dataset_axis_index_candidates` draws, and for the same reason its
                 -- doc records.
                 --
                 -- THREE ARMS, and the last two are what make the filter a strict SUPERSET of
                 -- what the client offers (INV-2, TEST-47). A pure containment test would be a
                 -- SUBSET: every artifact in every project today declares the legacy scalar and
                 -- no `memberships` array at all, so containment alone would return nothing and
                 -- the pane would silently lose every offer it has — with no error anywhere,
                 -- which is the exact failure that test exists to catch.
                 --
                 --   1. declares a membership on this axis — the array arm;
                 --   2. declares the LEGACY SCALAR for this axis — which IS a membership
                 --      (ITEM-2 reads it as `kind: full`), just in the older spelling;
                 --   3. declares NEITHER — A3, unknown alignment, which is OFFERED and must
                 --      therefore survive the narrowing.
                 --
                 -- What it drops is A2 and A4: rows that positively declare a DIFFERENT axis.
                 -- On a multi-dataset project that is the bulk of the catalog, which is where
                 -- the narrowing is worth having.
                 --
                 -- NO `status` clause, deliberately. `list_for_project_scope` does not filter on
                 -- status today and the client's offering predicate does not either, so adding
                 -- one HERE would make the server narrower than the client in precisely the way
                 -- INV-2 forbids. Staged/condemned artifacts are refused at CONSUMPTION
                 -- (`ConsumableArtifact`), which is enforcement; this is narrowing.
                 AND ($6 IS NULL OR (
                        EXISTS (
                          SELECT 1 FROM json_each(COALESCE(
                                     json_extract(structure, '$.memberships'), '[]')) AS j
                          WHERE json_extract(j.value, '$.aligned_to') = $6)
                        OR json_extract(structure, '$.aligned_to') = $6
                        OR (json_type(structure, '$.memberships') IS NULL
                            AND json_type(structure, '$.aligned_to') IS NULL)))
               ORDER BY created_at DESC"#;

pub const BACKFILL_ANY: &str = r#"SELECT id, dataset_id FROM artifacts WHERE id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#;

pub const PRECHECK: &str = r#"SELECT id FROM artifacts
                   WHERE id <> $1
                     AND COALESCE(project_id, X'00000000000000000000000000000000')
                         = COALESCE($2, X'00000000000000000000000000000000')
                     AND COALESCE(dataset_id, X'00000000000000000000000000000000') = $3
                     AND COALESCE(run_id, X'00000000000000000000000000000000')
                         = COALESCE($4, X'00000000000000000000000000000000')
                     AND output_id = $5
                   LIMIT 1"#;

pub const BACKFILL_UPDATE: &str = r#"UPDATE artifacts SET dataset_id = $1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                         WHERE id = $2 AND dataset_id IS NULL"#;

pub const DATASETS_BY_ID: &str = r#"SELECT id, name FROM datasets WHERE id IN
               (SELECT unhex(j.value) FROM json_each($1) AS j)"#;

pub const RUNS_BY_ID: &str = r#"SELECT run_id, generator_id FROM provenance_run_repro WHERE run_id IN
               (SELECT unhex(j.value) FROM json_each($1) AS j)"#;

pub const PRODUCED: &str = r#"SELECT id, name, json_extract(metadata, '$.alignment.artifact_id')  FROM datasets  WHERE source = 'integrate' AND json_extract(metadata, '$.alignment.artifact_id')  IN (SELECT j.value FROM json_each($1) AS j)"#;

pub const EXISTING_VD: &str = r#"SELECT id FROM datasets
         WHERE source = $1 AND json_extract(metadata, '$.alignment_run_id') = $2"#;

pub const EXISTING_FILTER: &str = r#"SELECT id FROM datasets WHERE source = $1 AND json_extract(metadata, '$.filter_run_id') = $2"#;

pub const RUN_ARTIFACTS: &str = r#"SELECT id, project_id, dataset_id, run_id, output_id, datatype,
                  object_key, is_multifile, content_hash,
                  structure as "structure: serde_json::Value",
                  meta as "meta: serde_json::Value",
                  role, status, stored_bytes, logical_bytes, created_by,
                  created_at as "created_at: DateTime<Utc>",
                  updated_at as "updated_at: DateTime<Utc>",
                  hidden, representation_of
           FROM artifacts
           WHERE run_id = $1
             AND ($2 IS NULL OR project_id = $2)
             AND ($3 IS NULL OR dataset_id = $3)
           ORDER BY created_at ASC"#;

pub const SETTINGS_GET: &str = r#"SELECT gc_enabled, gc_interval_hours, gc_grace_secs,
                      max_output_file_bytes, max_multifile_total_bytes,
                      max_upload_body_bytes, max_upload_parts
               FROM workstore_settings WHERE id = TRUE"#;

pub const SETTINGS_UPDATE: &str = r#"UPDATE workstore_settings SET
                    gc_enabled = COALESCE($1, gc_enabled),
                    gc_interval_hours = COALESCE($2, gc_interval_hours),
                    gc_grace_secs = COALESCE($3, gc_grace_secs),
                    max_output_file_bytes = COALESCE($4, max_output_file_bytes),
                    max_multifile_total_bytes = COALESCE($5, max_multifile_total_bytes),
                    max_upload_body_bytes = COALESCE($6, max_upload_body_bytes),
                    max_upload_parts = COALESCE($7, max_upload_parts),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                    updated_by = $8
               WHERE id = TRUE
               RETURNING gc_enabled, gc_interval_hours, gc_grace_secs,
                         max_output_file_bytes, max_multifile_total_bytes,
                         max_upload_body_bytes, max_upload_parts"#;

pub const SETTINGS_SEED: &str = r#"UPDATE workstore_settings SET
                    gc_enabled = COALESCE($1, gc_enabled),
                    gc_interval_hours = COALESCE($2, gc_interval_hours)
               WHERE id = TRUE AND updated_by IS NULL"#;

pub const MIG_CREATE: &str = r#"INSERT INTO object_store_migration  (id, src_backend, src_provider, src_bucket, dst_backend, dst_provider, dst_bucket,  cross_cloud, cost_ack, auto_started, blobs_total, bytes_total, created_by,  src_config_ciphertext)  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING {SELECT_COLS}"#;

pub const MIG_SETPHASE: &str = r#"UPDATE object_store_migration SET phase = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1"#;

pub const MIG_PROGRESS: &str = r#"UPDATE object_store_migration SET blobs_done = MAX(blobs_done, $2), bytes_done = MAX(bytes_done, $3), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1"#;

pub const MIG_REAP: &str = r#"UPDATE object_store_migration SET phase = 'failed', verify_error = 'interrupted by a restart (start the migration again)', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE phase IN ('copying','verifying')"#;

pub const MIG_UNRETIRED: &str = r#"SELECT {SELECT_COLS} FROM object_store_migration WHERE phase NOT IN ('retired','abandoned') AND auto_started = true ORDER BY created_at DESC LIMIT 1"#;

pub const ALIGN_SIG: &str = "json_type(meta, '$.sources') = 'array' AND json_type(structure, '$.extents.segments') IS NOT NULL";

pub const MARK_UNRESOLVABLE: &str = r#"UPDATE artifacts SET status = $2, meta = json_set(COALESCE(meta, '{}'), '$.unresolved_source', json_quote($3)), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1 AND object_key IS NULL AND status <> $2"#;

fn uuid_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("Vec<String> is JSON-serializable")
}

fn hyp_json(ids: &[Uuid]) -> String {
    serde_json::to_string(&ids.iter().map(Uuid::to_string).collect::<Vec<String>>()).unwrap()
}

async fn artifact(
    pool: &SqlitePool,
    id: Uuid,
    project: Option<Uuid>,
    dataset: Option<Uuid>,
    run: Option<Uuid>,
    output: &str,
    datatype: &str,
    object_key: Option<&str>,
    structure: serde_json::Value,
    meta: serde_json::Value,
    role: &str,
    status: &str,
    hidden: bool,
) {
    sqlx::query(
        "INSERT INTO artifacts (id, project_id, dataset_id, run_id, output_id, datatype, \
         object_key, is_multifile, content_hash, structure, meta, role, status, \
         stored_bytes, logical_bytes, hidden) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(project)
    .bind(dataset)
    .bind(run)
    .bind(output)
    .bind(datatype)
    .bind(object_key)
    .bind(false)
    .bind("sha256:test")
    .bind(&structure)
    .bind(&meta)
    .bind(role)
    .bind(status)
    .bind(0i64)
    .bind(Option::<i64>::None)
    .bind(hidden)
    .execute(pool)
    .await
    .expect("artifact fixture");
}

async fn dataset(
    pool: &SqlitePool,
    id: Uuid,
    name: &str,
    source: &str,
    meta: serde_json::Value,
    owner: Uuid,
) {
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source) \
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(name)
    .bind(owner)
    .bind(account(pool, owner).await)
    .bind(Option::<String>::None)
    .bind(&meta)
    .bind(source)
    .execute(pool)
    .await
    .expect("dataset fixture");
}

async fn account(pool: &SqlitePool, user_id: Uuid) -> Uuid {
    // idempotent: one personal account per user (the UNIQUE index on
    // personal_user_id), so a fixture that builds a project AND a dataset for
    // one owner reuses the same account
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
        .expect("account");
    id
}

async fn project(pool: &SqlitePool, id: Uuid, owner: Uuid) -> Uuid {
    let acc = account(pool, owner).await;
    sqlx::query("INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(owner)
        .bind("test")
        .bind(acc)
        .execute(pool)
        .await
        .expect("project");
    acc
}

async fn user(pool: &SqlitePool, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, ?, ?)")
        .bind(id)
        .bind(name)
        .bind(format!("{name}@example.com"))
        .execute(pool)
        .await
        .expect("user");
    id
}

async fn fresh_chain(tag: &str) -> (Scratch, SqlitePool) {
    let scratch = Scratch::new(tag);
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    (scratch, pool)
}

/// TEST-27 leg 1 - the natural-key UPSERT.
#[tokio::test]
async fn natural_key_upsert_and_app_bound_id() {
    let (_s, pool) = fresh_chain("ws-1").await;
    let owner = user(&pool, "ws_owner").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let d = Uuid::new_v4();
    let r = Uuid::new_v4();
    let id1 = Uuid::new_v4();
    let id2 = Uuid::new_v4();
    for (id, project, dataset, run) in [
        (id1, Some(p), Option::<Uuid>::None, Some(r)),
        (id2, Option::<Uuid>::None, Some(d), Option::<Uuid>::None),
    ] {
        sqlx::query(INSERT_ARTIFACT)
            .bind(id)
            .bind(project)
            .bind(dataset)
            .bind(run)
            .bind("o1")
            .bind("t/t")
            .bind("k1")
            .bind(false)
            .bind("sha256:k1")
            .bind(serde_json::json!({"encoding": "opaque"}))
            .bind(serde_json::json!({"v": 1}))
            .bind("artifact")
            .bind(0i64)
            .bind(Option::<i64>::None)
            .bind(Some(owner))
            .bind(false)
            .bind(Option::<Uuid>::None)
            .fetch_one(&pool)
            .await
            .expect("insert");
    }
    // same natural key (project row) - DO UPDATE, not a new row
    let row = sqlx::query(INSERT_ARTIFACT)
        .bind(id1)
        .bind(Some(p))
        .bind(Option::<Uuid>::None)
        .bind(Some(r))
        .bind("o1")
        .bind("t/t")
        .bind("k1")
        .bind(false)
        .bind("sha256:k1")
        .bind(serde_json::json!({"encoding": "opaque"}))
        .bind(serde_json::json!({"v": 2}))
        .bind("artifact")
        .bind(0i64)
        .bind(Option::<i64>::None)
        .bind(Some(owner))
        .bind(false)
        .bind(Option::<Uuid>::None)
        .fetch_one(&pool)
        .await
        .expect("re-insert");
    assert_eq!(row.get::<Uuid, _>("id"), id1, "app-bound id round-trips");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 2,
        "the two scoping keys are distinct; the re-insert updated in place"
    );
    let v: serde_json::Value = sqlx::query_scalar("SELECT meta FROM artifacts WHERE id = ?")
        .bind(id1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(v, serde_json::json!({"v": 2}), "DO UPDATE applied");
}

/// TEST-27 leg 2 - axis-index boolean containment + datatype membership.
#[tokio::test]
async fn axis_index_containment_and_datatype_membership() {
    let (_s, pool) = fresh_chain("ws-2").await;
    let owner = user(&pool, "ws_axis").await;
    let d = Uuid::new_v4();
    dataset(&pool, d, "ds", "upload", serde_json::json!({}), owner).await;
    let key = Uuid::new_v4();
    let fake_num = Uuid::new_v4();
    let non_key = Uuid::new_v4();
    artifact(
        &pool,
        key,
        None,
        Some(d),
        None,
        "rows_index",
        "metadata-column-index",
        Some("k"),
        serde_json::json!({"axis": "rows"}),
        serde_json::json!({"is_axis_index": true}),
        "artifact",
        "ready",
        false,
    )
    .await;
    artifact(
        &pool,
        fake_num,
        None,
        Some(d),
        None,
        "n1",
        "metadata-column-index",
        Some("k"),
        serde_json::json!({"axis": "rows"}),
        serde_json::json!({"is_axis_index": 1}),
        "artifact",
        "ready",
        false,
    )
    .await;
    artifact(
        &pool,
        non_key,
        None,
        Some(d),
        None,
        "plain",
        "metadata-column",
        Some("k"),
        serde_json::json!({"axis": "rows"}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;

    let rows = sqlx::query(AXIS_CAND)
        .bind(d)
        .bind(r#"["metadata-column-index"]"#)
        .bind("rows")
        .fetch_all(&pool)
        .await
        .expect("axis_cand");
    assert_eq!(
        rows.len(),
        1,
        "only the JSON-boolean true row is an axis index"
    );
    assert_eq!(rows[0].get::<Uuid, _>("id"), key);

    let none = sqlx::query(AXIS_CAND)
        .bind(d)
        .bind("[]")
        .bind("rows")
        .fetch_all(&pool)
        .await
        .expect("axis_cand-empty");
    assert_eq!(none.len(), 0, "an empty allow-list matches nothing");
}

/// TEST-27 leg 3 - the ITEM-30 membership-narrowing arms.
#[tokio::test]
async fn membership_narrowing_arms_and_json_type_exactness() {
    let (_s, pool) = fresh_chain("ws-3").await;
    let owner = user(&pool, "ws_narrow").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let r_array = Uuid::new_v4();
    let r_scalar = Uuid::new_v4();
    let r_neither = Uuid::new_v4();
    let r_other = Uuid::new_v4();
    let r_bothnull = Uuid::new_v4();
    let r_alnull = Uuid::new_v4();
    let r_manull = Uuid::new_v4();
    for (id, structure) in [
        (
            r_array,
            serde_json::json!({"memberships": [{"aligned_to": "rows"}, {"aligned_to": "cells"}]}),
        ),
        (r_scalar, serde_json::json!({"aligned_to": "genes"})),
        (r_neither, serde_json::json!({})),
        (
            r_other,
            serde_json::json!({"memberships": [{"aligned_to": "other"}]}),
        ),
        (
            r_bothnull,
            serde_json::json!({"memberships": [], "aligned_to": null}),
        ),
        (r_alnull, serde_json::json!({"aligned_to": null})),
        (
            r_manull,
            serde_json::json!({"memberships": null, "aligned_to": "rows"}),
        ),
    ] {
        artifact(
            &pool,
            id,
            Some(p),
            None,
            None,
            "o",
            "m",
            Some("k"),
            structure,
            serde_json::json!({}),
            "artifact",
            "ready",
            false,
        )
        .await;
    }
    let rows = sqlx::query(NARROW)
        .bind(p)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("rows")
        .fetch_all(&pool)
        .await
        .expect("narrow");
    let got: Vec<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    assert_eq!(
        got.len(),
        3,
        "arm1 + arm3 + arm2-with-null-memberships; the JSON-null exactness rows are EXCLUDED"
    );
    for id in &got {
        assert!(
            *id == r_array || *id == r_neither || *id == r_manull,
            "unexpected narrow row {id:?}"
        );
    }
    let rows = sqlx::query(NARROW)
        .bind(p)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("genes")
        .fetch_all(&pool)
        .await
        .expect("narrow2");
    let got_set: std::collections::BTreeSet<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    // arm3 is axis-agnostic ("declares neither -> offered for every axis"), so
    // the scalar row AND the neither row match 'genes'
    let want: std::collections::BTreeSet<Uuid> = [r_scalar, r_neither].into_iter().collect();
    assert_eq!(
        got_set, want,
        "the legacy-scalar arm + the axis-agnostic absence arm"
    );
}

/// TEST-27 leg 4 - the LATERAL-free reach CTE (json_tree walk).
#[tokio::test]
async fn reach_cte_walks_both_edges_and_terminates() {
    let (_s, pool) = fresh_chain("ws-4").await;
    let owner = user(&pool, "ws_reach").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let stored = Uuid::new_v4();
    let s1 = Uuid::new_v4();
    let m1 = Uuid::new_v4();
    let s2 = Uuid::new_v4();
    let g1 = Uuid::new_v4();
    let g2 = Uuid::new_v4();
    let g3 = Uuid::new_v4();
    let g4 = Uuid::new_v4();
    let g_empty = Uuid::new_v4();
    let g_nullref = Uuid::new_v4();
    artifact(
        &pool,
        stored,
        Some(p),
        None,
        None,
        "stored",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    // the refs the recipes name are real catalog rows elsewhere (dataset-scoped
    // source columns) — the reach join returns them only when they exist
    let ds4 = Uuid::new_v4();
    dataset(&pool, ds4, "ds4", "upload", serde_json::json!({}), owner).await;
    for (i, id) in [s1, m1, s2].into_iter().enumerate() {
        artifact(
            &pool,
            id,
            None,
            Some(ds4),
            None,
            &format!("src-{i}"),
            "m",
            Some("k"),
            serde_json::json!({}),
            serde_json::json!({}),
            "artifact",
            "ready",
            false,
        )
        .await;
    }
    // gathered rows (object_key NULL) with the producers' hyphenated uuid refs
    for (id, gathered) in [
        (
            g1,
            serde_json::json!({"gathered_from": {
                "alignment_artifact_id": s1.to_string(),
                "mask_artifact_id": m1.to_string(),
                "sources": [{"artifact_id": s2.to_string()}, {"artifact_id": s1.to_string()}]}}),
        ),
        (
            g2,
            serde_json::json!({"gathered_from": {"sources": [{"artifact_id": g1.to_string()}]}}),
        ),
        (
            g3,
            serde_json::json!({"gathered_from": {"sources": [{"artifact_id": g4.to_string()}]}}),
        ),
        (
            g4,
            serde_json::json!({"gathered_from": {"sources": [{"artifact_id": g3.to_string()}]}}),
        ),
        (
            g_empty,
            serde_json::json!({"gathered_from": {"sources": []}}),
        ),
        (
            g_nullref,
            serde_json::json!({"gathered_from": {"alignment_artifact_id": null, "sources": []}}),
        ),
    ] {
        artifact(
            &pool,
            id,
            Some(p),
            None,
            None,
            "g",
            "m",
            None,
            gathered,
            serde_json::json!({}),
            "artifact",
            "ready",
            false,
        )
        .await;
    }
    // a stored mask row is another project artifact in the reach seed; the
    // bytes_or_recipe CHECK forbids a stored row bearing a recipe, so "stored
    // rows never expand" is enforced by `object_key IS NULL` on the expansion.
    let mask = Uuid::new_v4();
    artifact(
        &pool,
        mask,
        Some(p),
        None,
        None,
        "mask",
        "m",
        Some("km"),
        serde_json::json!({"kind": "mask"}),
        serde_json::json!({}),
        "mask",
        "ready",
        true,
    )
    .await;

    let rows = sqlx::query(REACH_CTE)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("reach");
    let got: Vec<Uuid> = rows.iter().map(|r| r.get("id")).collect();
    let got_set: std::collections::BTreeSet<Uuid> = got.iter().copied().collect();
    let expected: std::collections::BTreeSet<Uuid> =
        [stored, s1, m1, s2, g1, g2, g3, g4, g_empty, g_nullref, mask]
            .into_iter()
            .collect();
    assert_eq!(
        got_set, expected,
        "reach = stored seed + alignment/mask/source refs + transitive gathered refs; \
         cycles terminated, JSON-null refs dropped, stored rows never expanded"
    );
}

/// TEST-27 leg 5 - detach signature + produced query + unresolvable stamp.
#[tokio::test]
async fn detach_signature_produced_and_unresolvable_stamp() {
    let (_s, pool) = fresh_chain("ws-5").await;
    let owner = user(&pool, "ws_detach").await;
    let p = Uuid::new_v4();
    project(&pool, p, owner).await;
    let align_id = Uuid::new_v4();
    let d = Uuid::new_v4();
    let sig_yes = Uuid::new_v4();
    let sig_no_seg = Uuid::new_v4();
    let sig_no_arr = Uuid::new_v4();
    let sig_segnull = Uuid::new_v4();
    for (id, structure, meta) in [
        (
            sig_yes,
            serde_json::json!({"extents": {"segments": ["a"]}}),
            serde_json::json!({"sources": ["s1"]}),
        ),
        (
            sig_no_seg,
            serde_json::json!({"extents": {"other": 1}}),
            serde_json::json!({"sources": ["s1"]}),
        ),
        (
            sig_no_arr,
            serde_json::json!({"extents": {"segments": ["a"]}}),
            serde_json::json!({"sources": {"not": "array"}}),
        ),
        (
            sig_segnull,
            serde_json::json!({"extents": {"segments": null}}),
            serde_json::json!({"sources": []}),
        ),
    ] {
        artifact(
            &pool,
            id,
            Some(p),
            None,
            None,
            "o",
            "m",
            Some("k"),
            structure,
            meta,
            "artifact",
            "ready",
            false,
        )
        .await;
    }
    let sql = format!(
        "SELECT id, output_id, structure, meta FROM artifacts \
         WHERE project_id = $1 AND {ALIGN_SIG}"
    );
    let rows = sqlx::query_as::<_, (Uuid, String, serde_json::Value, serde_json::Value)>(&sql)
        .bind(p)
        .fetch_all(&pool)
        .await
        .expect("align-sig");
    let got: Vec<Uuid> = rows.iter().map(|r| r.0).collect();
    assert_eq!(got.len(), 2);
    assert!(
        got.contains(&sig_yes) && got.contains(&sig_segnull),
        "signature: array sources + segments key present (a JSON-null value counts: `?` is key existence)"
    );

    dataset(
        &pool,
        d,
        "int",
        "integrate",
        serde_json::json!({"alignment": {"artifact_id": align_id.to_string()}}),
        owner,
    )
    .await;
    let rows = sqlx::query(PRODUCED)
        .bind(hyp_json(&[align_id]))
        .fetch_all(&pool)
        .await
        .expect("produced");
    assert_eq!(rows.len(), 1);
    let rows32 = sqlx::query(PRODUCED)
        .bind(uuid_json(&[align_id]))
        .fetch_all(&pool)
        .await
        .expect("produced2");
    assert_eq!(
        rows32.len(),
        0,
        "the producer writes the hyphenated form (text equality)"
    );

    // json_quote: a numeric-looking unresolvable source stays a JSON STRING
    let g = Uuid::new_v4();
    artifact(
        &pool,
        g,
        None,
        Some(d),
        None,
        "col",
        "m",
        None,
        serde_json::json!({"kind": "table", "gathered_from": {"sources": []}}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    let n = sqlx::query(MARK_UNRESOLVABLE)
        .bind(g)
        .bind("unresolvable")
        .bind("123")
        .execute(&pool)
        .await
        .expect("mark");
    assert_eq!(n.rows_affected(), 1);
    let meta: serde_json::Value = sqlx::query_scalar("SELECT meta FROM artifacts WHERE id = ?")
        .bind(g)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        meta["unresolved_source"],
        serde_json::json!("123"),
        "json_quote keeps the value a string (PG to_jsonb semantics)"
    );
    let n2 = sqlx::query(MARK_UNRESOLVABLE)
        .bind(g)
        .bind("unresolvable")
        .bind("x")
        .execute(&pool)
        .await
        .expect("mark2");
    assert_eq!(
        n2.rows_affected(),
        0,
        "idempotence guard: status <> 'unresolvable'"
    );

    // backfill: membership + natural-key precheck + guarded update
    let id1 = Uuid::new_v4();
    let occupant = Uuid::new_v4();
    artifact(
        &pool,
        id1,
        Some(p),
        None,
        None,
        "out",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    artifact(
        &pool,
        occupant,
        Some(p),
        Some(d),
        None,
        "out",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    let rows = sqlx::query(BACKFILL_ANY)
        .bind(uuid_json(&[id1, occupant]))
        .fetch_all(&pool)
        .await
        .expect("bf-any");
    assert_eq!(rows.len(), 2, "32-hex json membership finds both");
    let occ: Option<Uuid> = sqlx::query(PRECHECK)
        .bind(id1)
        .bind(Some(p))
        .bind(Some(d))
        .bind(Option::<Uuid>::None)
        .bind("out")
        .fetch_optional(&pool)
        .await
        .expect("precheck")
        .map(|row| row.get("id"));
    assert_eq!(occ, Some(occupant), "the precheck names the occupying row");
    // a candidate whose assignment does NOT collide (a different output_id)
    let id2 = Uuid::new_v4();
    artifact(
        &pool,
        id2,
        Some(p),
        None,
        None,
        "out2",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    let no_collision: Option<Uuid> = sqlx::query(PRECHECK)
        .bind(id2)
        .bind(Some(p))
        .bind(Some(d))
        .bind(Option::<Uuid>::None)
        .bind("out2")
        .fetch_optional(&pool)
        .await
        .expect("precheck2")
        .map(|row| row.get("id"));
    assert_eq!(no_collision, None, "a different output_id is not occupied");
    let n = sqlx::query(BACKFILL_UPDATE)
        .bind(Some(d))
        .bind(id2)
        .execute(&pool)
        .await
        .expect("bf-upd");
    assert_eq!(n.rows_affected(), 1);
    let n2 = sqlx::query(BACKFILL_UPDATE)
        .bind(Some(d))
        .bind(id2)
        .execute(&pool)
        .await
        .expect("bf-upd2");
    assert_eq!(n2.rows_affected(), 0, "guarded: dataset_id IS NULL only");
}

/// TEST-27 leg 6 - migration_repo lifecycle.
#[tokio::test]
async fn migration_repo_lifecycle_and_progress_monotonicity() {
    let (_s, pool) = fresh_chain("ws-6").await;
    let owner = user(&pool, "ws_mig").await;
    let n1 = Uuid::new_v4();
    let row = sqlx::query(&mig_sql(MIG_CREATE))
        .bind(n1)
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(false)
        .bind(false)
        .bind(false)
        .bind(42i64)
        .bind(1000i64)
        .bind(owner)
        .bind(Option::<Vec<u8>>::None)
        .fetch_one(&pool)
        .await
        .expect("mig create");
    let id: Uuid = row.get("id");
    assert_eq!(id, n1, "the app-bound id round-trips");
    assert_eq!(row.get::<String, _>("phase"), "pending");
    // `SELECT_COLS` carries no created_at; the clock is asserted on a row read
    let created_at: String =
        sqlx::query_scalar("SELECT created_at FROM object_store_migration WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("clock");
    assert!(
        created_at.contains('T') && created_at.ends_with('Z'),
        "RFC3339-UTC clock"
    );

    // the single-active guard: a second create conflicts with the sqlite extended code
    let err = match sqlx::query(&mig_sql(MIG_CREATE))
        .bind(Uuid::new_v4())
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(false)
        .bind(false)
        .bind(false)
        .bind(7i64)
        .bind(7i64)
        .bind(owner)
        .bind(Option::<Vec<u8>>::None)
        .fetch_one(&pool)
        .await
    {
        Ok(_) => panic!("second create must conflict"),
        Err(e) => e,
    };
    let db = err.as_database_error().expect("db error");
    let code = db.code().map(|c| c.to_string());
    assert!(
        code.as_deref() == Some("2067") || code.as_deref() == Some("1555"),
        "unique-conflict code is the sqlx-sqlite extended code, got {code:?}"
    );

    // MAX progress monotonicity: a late smaller write never regresses
    sqlx::query(MIG_SETPHASE)
        .bind(id)
        .bind("copying")
        .execute(&pool)
        .await
        .expect("phase");
    sqlx::query(MIG_PROGRESS)
        .bind(id)
        .bind(10i64)
        .bind(200i64)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(MIG_PROGRESS)
        .bind(id)
        .bind(4i64)
        .bind(50i64)
        .execute(&pool)
        .await
        .unwrap();
    let (b, y): (i64, i64) =
        sqlx::query_as("SELECT blobs_done, bytes_done FROM object_store_migration WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (b, y),
        (10, 200),
        "MAX keeps the progress counters monotonic"
    );

    // the fail-safe boot reaper: interrupted `copying` rows → failed; others untouched
    sqlx::query("UPDATE object_store_migration SET phase = 'verified' WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let n2 = Uuid::new_v4();
    sqlx::query(&mig_sql(MIG_CREATE))
        .bind(n2)
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind("local")
        .bind(Option::<String>::None)
        .bind(Option::<String>::None)
        .bind(false)
        .bind(false)
        .bind(true)
        .bind(1i64)
        .bind(1i64)
        .bind(owner)
        .bind(Option::<Vec<u8>>::None)
        .fetch_one(&pool)
        .await
        .expect("mig create2");
    sqlx::query("UPDATE object_store_migration SET phase = 'copying' WHERE id = ?")
        .bind(n2)
        .execute(&pool)
        .await
        .unwrap();
    let reaped = sqlx::query(MIG_REAP).execute(&pool).await.expect("reap");
    assert_eq!(
        reaped.rows_affected(),
        1,
        "only the interrupted copying row is reaped"
    );
    let phase: String = sqlx::query_scalar("SELECT phase FROM object_store_migration WHERE id = ?")
        .bind(n2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(phase, "failed");

    // latest_unretired: excludes retired + abandoned + manual (auto_started = false)
    let rows = sqlx::query(&mig_sql(MIG_UNRETIRED))
        .fetch_all(&pool)
        .await
        .expect("unretired");
    for row in &rows {
        let phase: String = row.get("phase");
        assert!(
            matches!(
                phase.as_str(),
                "pending" | "copying" | "verifying" | "verified" | "failed"
            ),
            "unretired must exclude retired/abandoned: {phase}"
        );
        let auto: bool = row.get("auto_started");
        assert!(auto, "manual migrations never trigger boot-resume");
    }
    assert_eq!(
        rows.len(),
        1,
        "the abandoned... none here; only the verified auto row remains"
    );
}

/// TEST-27 leg 7 - settings singleton, VD lookups, footprint view.
#[tokio::test]
async fn settings_vd_lookups_and_footprint() {
    let (_s, pool) = fresh_chain("ws-7").await;
    let owner = user(&pool, "ws_set").await;
    let row = sqlx::query(SETTINGS_GET)
        .fetch_one(&pool)
        .await
        .expect("settings-get");
    assert_eq!(row.get::<i64, _>("gc_interval_hours"), 6);
    assert_eq!(row.get::<bool, _>("gc_enabled"), true);
    let uid = Uuid::new_v4();
    let out = sqlx::query(SETTINGS_UPDATE)
        .bind(Option::<bool>::None)
        .bind(Some(12i64))
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::None)
        .bind(Option::<i64>::None)
        .bind(uid)
        .fetch_one(&pool)
        .await
        .expect("settings-update");
    assert_eq!(out.get::<i64, _>("gc_interval_hours"), 12);
    assert_eq!(
        out.get::<i64, _>("gc_grace_secs"),
        3600,
        "untouched fields preserved"
    );
    // the env seed is a no-op once an admin PUT stamped updated_by
    let seed = sqlx::query(SETTINGS_SEED)
        .bind(Some(false))
        .bind(Some(2i64))
        .execute(&pool)
        .await
        .expect("seed");
    assert_eq!(seed.rows_affected(), 0, "updated_by IS NULL guard");
    let cur: bool = sqlx::query_scalar("SELECT gc_enabled FROM workstore_settings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cur, true, "env must not override an admin PUT");

    // virtual-dataset lookups via json_extract
    let run_id = Uuid::new_v4();
    let vd = Uuid::new_v4();
    let vd2 = Uuid::new_v4();
    dataset(
        &pool,
        vd,
        "int",
        "integrate",
        serde_json::json!({
            "alignment_run_id": run_id.to_string(),
            "alignment": {"artifact_id": Uuid::new_v4().to_string()},
        }),
        owner,
    )
    .await;
    dataset(
        &pool,
        vd2,
        "filtered",
        "filter",
        serde_json::json!({"filter_run_id": run_id.to_string()}),
        owner,
    )
    .await;
    let got: Option<Uuid> = sqlx::query(EXISTING_VD)
        .bind("integrate")
        .bind(run_id.to_string())
        .fetch_optional(&pool)
        .await
        .expect("vd")
        .map(|r| r.get("id"));
    assert_eq!(got, Some(vd));
    let got: Option<Uuid> = sqlx::query(EXISTING_FILTER)
        .bind("filter")
        .bind(run_id.to_string())
        .fetch_optional(&pool)
        .await
        .expect("fvd")
        .map(|r| r.get("id"));
    assert_eq!(got, Some(vd2));

    // footprint over the usable_artifacts view
    let fp_p = Uuid::new_v4();
    let fp_account = project(&pool, fp_p, owner).await;
    let _ = fp_account;
    let a1 = Uuid::new_v4();
    artifact(
        &pool,
        a1,
        Some(fp_p),
        None,
        None,
        "ok",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        false,
    )
    .await;
    sqlx::query("UPDATE artifacts SET logical_bytes = 512 WHERE id = ?")
        .bind(a1)
        .execute(&pool)
        .await
        .unwrap();
    let hidden = Uuid::new_v4();
    artifact(
        &pool,
        hidden,
        Some(fp_p),
        None,
        None,
        "h",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "ready",
        true,
    )
    .await;
    let failed = Uuid::new_v4();
    artifact(
        &pool,
        failed,
        Some(fp_p),
        None,
        None,
        "f",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "artifact",
        "failed",
        false,
    )
    .await;
    let mask = Uuid::new_v4();
    artifact(
        &pool,
        mask,
        Some(fp_p),
        None,
        None,
        "mk",
        "m",
        Some("k"),
        serde_json::json!({}),
        serde_json::json!({}),
        "mask",
        "ready",
        false,
    )
    .await;
    // query_as by position: the `"count!"`/`"bytes!: i64"` aliases are query!-macro
    // annotations the macro strips before the DB sees the SQL; a runtime query would
    // return columns literally named `count!`/`bytes!: i64`.
    let (count, bytes): (i64, i64) = sqlx::query_as(FOOTPRINT)
        .bind(fp_p)
        .fetch_one(&pool)
        .await
        .expect("footprint");
    assert_eq!((count, bytes), (1, 512), "the usable population only");
}
