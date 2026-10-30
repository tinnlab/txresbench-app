//! The `dataset` module's SQLite query-surface semantics - TESTS.md TEST-28,
//! the ITEM-21 per-item test.
//!
//! TESTS.md as written: "dataset list/source-filter/integrate queries; the
//! representative-artifact `json_group_array` rewrite returns the same row as
//! PG on the fixture; source-filter `= ANY` membership matches."
//!
//! Where the repository lives: the app's modules are single-driver (DEC-1), so
//! the ported SQL sits IN `src/modules/dataset/**` and is verified against the
//! real sqlite build DB by the sqlx macros at `cargo check` (syntax + schema +
//! bind arity + type coherence). What a test adds on top is the RUNTIME
//! semantics those checks cannot prove, pinned here with the shipped query
//! texts (extracted verbatim from `dataset/repository.rs`) against the REAL
//! ported chain (TEST-14's harness: `compose_sqlite_chain` + `apply_chain`):
//!
//! 1. the `ILIKE` → `instr(lower(d.name), lower($n)) > 0` ASCII-fold search
//!    (DEC-11's documented limitation), the dropped `$n::text`/`$n::uuid`
//!    casts, and the page/total agreement of `list_mine` (incl. the folder
//!    filter and the H-1 current-membership arm: a removed member's org
//!    datasets vanish from the listing);
//! 2. the `= ANY(uuid[])` → JSON1 membership (`unhex`/`json_each` over the
//!    `uuid_list_json` 32-hex form — a hyphenated JSON list never matches) in
//!    `list_shared` and `artifact_summary_rows`' visible set;
//! 3. the `ARRAY_AGG(… ORDER BY …)[1]` → `json_group_array` +
//!    `json_extract(…,'$[0]')` representative rewrite: the richest-artifact
//!    ranking on the ITEM-11 fixture shape (empty vs non-empty JSON, the
//!    key-order-variant tie falling to `created_at DESC`), the LEFT-JOIN
//!    empty-dataset row (absence is one thing), and the `SUM(...)::bigint`
//!    cast removal (i64 totals);
//! 4. the visibility/access arms (account-membership union incl. the bare-
//!    member read-only floor, user/group share, the H-1 removed-owner
//!    outcome) and `editable_subset`'s byte-alignment with `access`'s
//!    `can_edit` arm;
//! 5. `list_files`' CASE-derived `integration_status` (job-status override,
//!    legacy stored fallback), the `ordinal: i32` INTEGER override, the
//!    `processing_status_map` LEFT JOIN and the shares `ON CONFLICT DO
//!    UPDATE` upsert + audience resolution (current members ∪ user shares ∪
//!    ACTIVE-group members);
//! 6. the folder guard (guarded INSERT + the "already a member" recheck with
//!    the SAME membership conjunct), the `DELETE … USING` → EXISTS rewrite,
//!    and the mutation clock (`strftime` RFC3339 stamps).
//!
//! (ITEM-21's per-item verification note: authored in the red window like
//! TEST-24/25/26/27 - first compile+run at ITEM-25; the identical semantics
//! were executed by the item's scratch probe against this same chain.)

use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use uuid::Uuid;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// The repository's shipped query texts, extracted verbatim from
/// `src/modules/dataset/repository.rs` (the ITEM-21 port). Re-extract after any
/// repository edit; the probe-fixture convention from TEST-26/27.
pub const CREATE: &str = r#"INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source)
               VALUES ($1, $2, $3, $4, $5, $6, 'upload')
               RETURNING id, name, owner_id, account_id, datatype,
                         metadata as "metadata: serde_json::Value",
                         source, source_artifact_id, content_hash,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#;

pub const LIST_MINE_ITEMS: &str = r#"SELECT d.id, d.name, d.owner_id, d.account_id, d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id, d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               -- H-1 (#147): "datasets you own" is conjoined with CURRENT membership
               -- of each row's account. Without it a removed member kept seeing the
               -- names/metadata of every dataset they created in the organization,
               -- each of which now 404s when opened — a listing that contradicts the
               -- gate. Edited IDENTICALLY in the page and the `total` query so the
               -- pager cannot promise pages that do not exist.
               WHERE d.owner_id = $1
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $1)
                 -- (DEC-11: ILIKE has no SQLite form; instr(lower(...), lower($2))
                 -- is ASCII-only folding — documented limitation.)
                 AND ($2 IS NULL OR instr(lower(d.name), lower($2)) > 0)
                 AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM dataset_folder_members m
                         JOIN dataset_folders fo ON fo.id = m.folder_id
                        WHERE m.dataset_id = d.id
                          AND m.folder_id = $3 AND fo.owner_id = $1))
               ORDER BY d.created_at DESC
               LIMIT $4 OFFSET $5"#;

pub const LIST_MINE_TOTAL: &str = r#"SELECT COUNT(*) as "count!"
               FROM datasets d
               -- H-1 (#147): "datasets you own" is conjoined with CURRENT membership
               -- of each row's account. Without it a removed member kept seeing the
               -- names/metadata of every dataset they created in the organization,
               -- each of which now 404s when opened — a listing that contradicts the
               -- gate. Edited IDENTICALLY in the page and the `total` query so the
               -- pager cannot promise pages that do not exist.
               WHERE d.owner_id = $1
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $1)
                 AND ($2 IS NULL OR instr(lower(d.name), lower($2)) > 0)
                 AND ($3 IS NULL OR EXISTS (
                       SELECT 1 FROM dataset_folder_members m
                         JOIN dataset_folders fo ON fo.id = m.folder_id
                        WHERE m.dataset_id = d.id
                          AND m.folder_id = $3 AND fo.owner_id = $1))"#;

pub const LIST_SHARED_ITEMS: &str = r#"SELECT d.id, d.name, d.owner_id, d.account_id, d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id, d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               WHERE d.owner_id <> $1
                 AND ($3 IS NULL OR instr(lower(d.name), lower($3)) > 0)
                 AND EXISTS (
                   SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                     AND ( (ds.principal_type = 'user'  AND ds.principal_id = $1)
                        OR (ds.principal_type = 'group' AND ds.principal_id IN
                              (SELECT unhex(j.value) FROM json_each($2) AS j)) ))
               ORDER BY d.created_at DESC
               LIMIT $4 OFFSET $5"#;

pub const ARTIFACT_SUMMARY: &str = r#"WITH visible AS (
                   SELECT d.id, d.created_at
                     FROM datasets d
                    -- H-1 (#147): the creator branch is conjoined with CURRENT
                    -- membership of the dataset's account, so a removed member's
                    -- created datasets stop appearing in the artifact rollup that
                    -- backs the dataset list. Behaviour-preserving for every current
                    -- member (owner => member by construction) and for personal
                    -- accounts (sole member IS the owner).
                    WHERE (d.owner_id = $1
                           AND d.account_id IN (SELECT am.account_id
                                                  FROM account_members am
                                                 WHERE am.user_id = $1))
                       OR EXISTS (
                            SELECT 1 FROM dataset_shares ds
                             WHERE ds.dataset_id = d.id
                               AND ( (ds.principal_type = 'user'  AND ds.principal_id = $1)
                                  OR (ds.principal_type = 'group' AND ds.principal_id IN
                                        (SELECT unhex(j.value) FROM json_each($2) AS j)) ))
                    ORDER BY d.created_at DESC
                    LIMIT $3
               ),
               counted AS (
                   SELECT a.dataset_id, a.datatype, a.output_id, a.meta, a.structure,
                          a.logical_bytes, a.id, a.created_at
                     -- The POPULATION is the `usable_artifacts` view, not a predicate
                     -- written out here: it is the same definition the project-level
                     -- footprint reads, so the two totals cannot drift apart. See the
                     -- view's migration for why it is a view and not a constant.
                     FROM usable_artifacts a
                     JOIN visible v ON v.id = a.dataset_id
               ),
               grouped AS (
                   SELECT dataset_id, datatype,
                          COUNT(*) AS cnt,
                          -- SUM of INTEGER is INTEGER (i64) on SQLite; the PG
                          -- `::bigint` cast is gone and the wire model reads it
                          -- through the same `bytes?` projection. LOGICAL, not
                          -- stored: this total is displayed as the size of the
                          -- data. `SUM` skips NULLs, so an artifact with no
                          -- derivable size contributes nothing instead of a made-up 0.
                          SUM(logical_bytes) AS bytes,
                          -- The REPRESENTATIVE — the rule is stated in full on
                          -- `DatasetArtifactGroup`: best-DECLARED first, then most
                          -- RECENT, then a total order. It is deliberately no longer
                          -- `size_bytes DESC, id`. All three aggregates must keep the
                          -- IDENTICAL `ORDER BY`: the group ships one member's
                          -- declarations, and pairing one row's `meta` with another's
                          -- `structure` describes an artifact that does not exist.
                          --
                          -- SQLite port (DEC-12): `(ARRAY_AGG(x ORDER BY …))[1]` has
                          -- no SQLite form — it is `json_group_array(x ORDER BY …)`
                          -- + `json_extract(…, '$[0]')`. The PG `<> '{}'::jsonb`
                          -- comparisons become `jsonb(x) <> jsonb('{}')` (the DEC-8
                          -- canonical form for whitespace/number/escape — its ONLY
                          -- JSON comparison is against the `'{}'` literal, so the
                          -- key-order non-canonicalization measured at ITEM-11 is
                          -- not a hazard here; tied ranks fall through to
                          -- `created_at DESC` exactly as PG's jsonb-equality tie does).
                          json_extract(json_group_array(output_id ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_output_id,
                          json_extract(json_group_array(meta      ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_meta,
                          json_extract(json_group_array(structure ORDER BY jsonb(structure) <> jsonb('{}') DESC, jsonb(meta) <> jsonb('{}') DESC, created_at DESC, output_id, id), '$[0]') AS representative_structure
                     FROM counted
                    GROUP BY dataset_id, datatype
               ),
               ranked AS (
                   SELECT g.*,
                          ROW_NUMBER() OVER (PARTITION BY dataset_id ORDER BY cnt DESC, datatype) AS rn,
                          SUM(cnt)   OVER (PARTITION BY dataset_id) AS total_count,
                          SUM(bytes) OVER (PARTITION BY dataset_id) AS total_bytes
                     FROM grouped g
               )
               -- LEFT JOIN from `visible`, so a dataset holding nothing still yields a
               -- row (with a NULL group). See the doc comment: absence has to mean
               -- exactly one thing, and it means "not covered".
               SELECT v.id as "dataset_id!",
                      COALESCE(r.total_count, 0) as "total_count!",
                      COALESCE(r.total_bytes, 0) as "total_bytes!",
                      r.datatype as "datatype?",
                      r.cnt as "cnt?",
                      r.bytes as "bytes?",
                      r.representative_output_id as "representative_output_id?: String",
                      r.representative_meta as "representative_meta?: serde_json::Value",
                      r.representative_structure as "representative_structure?: serde_json::Value"
                 FROM visible v
                 LEFT JOIN ranked r ON r.dataset_id = v.id AND r.rn <= $4
                ORDER BY v.id, r.rn"#;

pub const IS_VISIBLE_TO: &str = r#"SELECT EXISTS(
                 SELECT 1 FROM datasets d WHERE d.id = $1 AND (
                   d.account_id IN (SELECT am.account_id FROM account_members am
                                     WHERE am.user_id = $2)
                   OR EXISTS (
                     SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                       AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                          OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 )) as "e!""#;

pub const ACCESS: &str = r#"SELECT
                 (d.account_id IN (SELECT am.account_id FROM account_members am
                                    WHERE am.user_id = $2)
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 ) AS "visible!: bool",
                 ((d.owner_id = $2
                   AND d.account_id IN (SELECT am.account_id FROM account_members am
                                         WHERE am.user_id = $2))
                  OR d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2 AND am.role IN ('admin','owner'))
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ds.role = 'edit'
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 ) AS "can_edit!: bool"
               FROM datasets d WHERE d.id = $1"#;

pub const EDITABLE_SUBSET: &str = r#"SELECT d.id as "id!" FROM datasets d
               WHERE d.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                 AND ((d.owner_id = $2
                       AND d.account_id IN (SELECT am.account_id FROM account_members am
                                             WHERE am.user_id = $2))
                  OR d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2 AND am.role IN ('admin','owner'))
                  OR EXISTS (
                    SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                      AND ds.role = 'edit'
                      AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                         OR (ds.principal_type = 'group' AND ds.principal_id IN (SELECT unhex(j.value) FROM json_each($3) AS j)) ))
                 )"#;

pub const LIST_FILES: &str = r#"SELECT df.file_id, f.filename, f.file_size, df.ordinal as "ordinal: i32",
                      df.role, df.kind,
                      CASE
                        WHEN df.role <> 'supporting'      THEN NULL
                        WHEN df.integration_job_id IS NULL THEN df.integration_status
                        WHEN j.status IN ('blocked','queued') THEN 'pending'
                        WHEN j.status = 'running'          THEN 'running'
                        WHEN j.status = 'completed'        THEN 'integrated'
                        WHEN j.status IN ('failed','stopped') THEN 'failed'
                        ELSE df.integration_status
                      END as "integration_status?: String",
                      df.integration_summary as "integration_summary?: serde_json::Value"
               FROM dataset_files df
               JOIN files f ON f.id = df.file_id
               LEFT JOIN jobs j ON j.id = df.integration_job_id
               WHERE df.dataset_id = $1 ORDER BY df.ordinal, f.filename
               LIMIT $2 OFFSET $3"#;

pub const ADD_SHARE: &str = r#"INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (dataset_id, principal_type, principal_id)
                 DO UPDATE SET role = EXCLUDED.role
               RETURNING id, dataset_id, principal_type, principal_id, role,
                         created_at as "created_at: DateTime<Utc>""#;

pub const AUDIENCE_USER_IDS: &str = r#"SELECT DISTINCT uid as "id!" FROM (
                 SELECT am.user_id AS uid
                   FROM datasets d
                   JOIN account_members am ON am.account_id = d.account_id
                  WHERE d.id = $1
                 UNION
                 SELECT ds.principal_id
                   FROM dataset_shares ds
                  WHERE ds.dataset_id = $1 AND ds.principal_type = 'user'
                 UNION
                 SELECT ug.user_id
                   FROM dataset_shares ds
                   JOIN user_groups ug ON ug.group_id = ds.principal_id
                   JOIN groups g ON g.id = ug.group_id AND g.is_active
                  WHERE ds.dataset_id = $1 AND ds.principal_type = 'group'
               ) audience
               ORDER BY 1"#;

pub const LIST_DATASETS_IN_FOLDER: &str = r#"SELECT d.id, d.name, d.owner_id, d.account_id, d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id, d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               JOIN dataset_folder_members m ON m.dataset_id = d.id
               JOIN dataset_folders fo ON fo.id = m.folder_id
               -- H-1 (#147): the predicate constrained only the FOLDER's owner —
               -- NOTHING constrained `d`, so a member removed from an account kept
               -- reading the full rows (name, account_id, datatype, metadata,
               -- content_hash) of every org dataset they had foldered. `list_mine`'s
               -- folder filter WAS conjoined; these two are siblings and must agree,
               -- or the listing contradicts the gate exactly as `list_mine`'s own
               -- comment warns. `dataset_folders` itself carries no `account_id`, so
               -- the folder-owner clause is left alone (DEC-7's reasoning).
               WHERE m.folder_id = $1 AND fo.owner_id = $2
                 AND d.account_id IN (SELECT am.account_id FROM account_members am
                                       WHERE am.user_id = $2)
               ORDER BY d.created_at DESC
               LIMIT $3 OFFSET $4"#;

pub const ADD_TO_FOLDER: &str = r#"INSERT INTO dataset_folder_members (folder_id, dataset_id)
               SELECT $1, $2
               -- H-1 (#147): the dataset side of this guard admitted purely on
               -- `datasets.owner_id`, so a removed member could keep foldering (and
               -- thereby re-listing) the account's datasets. Conjoined with current
               -- membership; the FOLDER side is untouched (`dataset_folders` has no
               -- `account_id` — DEC-7).
               WHERE EXISTS (SELECT 1 FROM dataset_folders WHERE id = $1 AND owner_id = $3)
                 AND EXISTS (SELECT 1 FROM datasets d WHERE d.id = $2 AND d.owner_id = $3
                               AND d.account_id IN (SELECT am.account_id
                                                      FROM account_members am
                                                     WHERE am.user_id = $3))
               ON CONFLICT (folder_id, dataset_id) DO NOTHING"#;

pub const REMOVE_FROM_FOLDER: &str = r#"DELETE FROM dataset_folder_members
               WHERE folder_id = $1 AND dataset_id = $2
                 AND EXISTS (SELECT 1 FROM dataset_folders fo
                              WHERE fo.id = dataset_folder_members.folder_id
                                AND fo.owner_id = $3)"#;

// =============================== fixtures ===============================

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

async fn account(pool: &SqlitePool, user_id: Uuid) -> Uuid {
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
        .bind("test")
        .bind(user_id)
        .execute(pool)
        .await
        .expect("account");
    // The owner is a member of their personal account by construction (the
    // repository's `ensure_personal_account_for` contract); every visibility /
    // list predicate reads CURRENT membership (H-1), so the fixture creates the
    // edge too.
    member(pool, id, user_id, "owner").await;
    id
}

async fn member(pool: &SqlitePool, account_id: Uuid, user_id: Uuid, role: &str) {
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES (?, ?, ?)")
        .bind(account_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .expect("member");
}

async fn dataset(
    pool: &SqlitePool,
    id: Uuid,
    owner: Uuid,
    account: Uuid,
    name: &str,
    source: &str,
    meta: serde_json::Value,
) {
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source) \
         VALUES (?,?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(name)
    .bind(owner)
    .bind(account)
    .bind(Option::<String>::None)
    .bind(&meta)
    .bind(source)
    .execute(pool)
    .await
    .expect("dataset fixture");
}

async fn artifact(
    pool: &SqlitePool,
    id: Uuid,
    dataset_id: Uuid,
    output: &str,
    structure: &str,
    meta: &str,
    created_at: &str,
    logical_bytes: i64,
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
    .bind(Option::<Uuid>::None)
    .bind(output)
    .bind("data/opaque")
    .bind("obj/test")
    .bind(false)
    .bind("sha256:test")
    .bind(structure)
    .bind(meta)
    .bind("artifact")
    .bind("ready")
    .bind(0i64)
    .bind(logical_bytes)
    .bind(Option::<Uuid>::None)
    .bind(false)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("artifact fixture");
}

async fn file(
    pool: &SqlitePool,
    id: Uuid,
    user_id: Uuid,
    filename: &str,
    size: i64,
    checksum: Option<&str>,
) {
    // the SDK file store requires the version-chain edge (current_version_id NOT NULL)
    let ver = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO file_versions (id, file_id, version, is_head, blob_version_id, \
         file_size, created_by) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(ver)
    .bind(id)
    .bind(1i64)
    .bind(true)
    .bind(Uuid::new_v4())
    .bind(size)
    .bind("test")
    .execute(pool)
    .await
    .expect("file version fixture");
    sqlx::query(
        "INSERT INTO files (id, user_id, filename, file_size, checksum, current_version_id) \
         VALUES (?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(filename)
    .bind(size)
    .bind(checksum)
    .bind(ver)
    .execute(pool)
    .await
    .expect("file fixture");
}

async fn job(pool: &SqlitePool, id: Uuid, owner: Uuid, status: &str, error: Option<&str>) {
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, status, error, params) VALUES (?,?,?,?,?,?)",
    )
    .bind(id)
    .bind(owner)
    .bind("analysis")
    .bind(status)
    .bind(error)
    .bind("{}")
    .execute(pool)
    .await
    .expect("job fixture");
}

async fn group(pool: &SqlitePool, id: Uuid, name: &str, active: bool) {
    sqlx::query("INSERT INTO groups (id, name, is_active) VALUES (?,?,?)")
        .bind(id)
        .bind(name)
        .bind(active)
        .execute(pool)
        .await
        .expect("group fixture");
}

async fn user_group(pool: &SqlitePool, user_id: Uuid, group_id: Uuid) {
    sqlx::query("INSERT INTO user_groups (user_id, group_id) VALUES (?,?)")
        .bind(user_id)
        .bind(group_id)
        .execute(pool)
        .await
        .expect("user_group fixture");
}

async fn fresh_chain(tag: &str) -> (Scratch, SqlitePool) {
    let scratch = Scratch::new(tag);
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;
    (scratch, pool)
}

// =============================== tests ===============================

/// TEST-28 leg 1 - the list surface: `instr`/`lower` search, page/total
/// agreement, the folder filter and the H-1 current-membership arm.
#[tokio::test]
async fn list_mine_search_and_account_membership() {
    let (_s, pool) = fresh_chain("ds-1").await;
    let owner = user(&pool, "ds_owner").await;
    let acc = account(&pool, owner).await;
    let a = Uuid::new_v4();
    dataset(
        &pool,
        a,
        owner,
        acc,
        "Alpha",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let b = Uuid::new_v4();
    dataset(
        &pool,
        b,
        owner,
        acc,
        "beta",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let c = Uuid::new_v4();
    dataset(
        &pool,
        c,
        owner,
        acc,
        "GAMMA-2",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let foreign = Uuid::new_v4();
    let other = user(&pool, "ds_other").await;
    dataset(
        &pool,
        foreign,
        other,
        account(&pool, other).await,
        "gamma-2",
        "upload",
        serde_json::json!({}),
    )
    .await;

    // mixed-case substring "alp" matches exactly one owned row
    let items = sqlx::query(LIST_MINE_ITEMS)
        .bind(owner)
        .bind(Some("alp"))
        .bind(Option::<Uuid>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("list_mine search");
    assert_eq!(items.len(), 1, "instr/lower substring match");
    assert_eq!(items[0].get::<Uuid, _>(0), a);
    let total: i64 = sqlx::query_scalar(LIST_MINE_TOTAL)
        .bind(owner)
        .bind(Some("alp"))
        .bind(Option::<Uuid>::None)
        .fetch_one(&pool)
        .await
        .expect("total");
    assert_eq!(total, 1, "page and total agree");

    // all owned, no foreign
    let items = sqlx::query(LIST_MINE_ITEMS)
        .bind(owner)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("list_mine all");
    let got: Vec<Uuid> = items.iter().map(|r| r.get::<Uuid, _>(0)).collect();
    assert!(got.contains(&a) && got.contains(&b) && got.contains(&c));
    assert!(!got.contains(&foreign), "foreign dataset never listed");

    // paging
    let page2 = sqlx::query(LIST_MINE_ITEMS)
        .bind(owner)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(2i64)
        .bind(2i64)
        .fetch_all(&pool)
        .await
        .expect("page 2");
    assert_eq!(page2.len(), 2);

    // H-1: an org-account dataset disappears once the owner is removed
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, ?, ?)")
        .bind(org)
        .bind("organization")
        .bind("ds-org")
        .execute(&pool)
        .await
        .expect("org account");
    member(&pool, org, owner, "owner").await;
    let e = Uuid::new_v4();
    dataset(
        &pool,
        e,
        owner,
        org,
        "org-ds",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let before = sqlx::query(LIST_MINE_ITEMS)
        .bind(owner)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("before removal");
    assert!(before.iter().any(|r| r.get::<Uuid, _>(0) == e));
    sqlx::query("DELETE FROM account_members WHERE account_id = ? AND user_id = ?")
        .bind(org)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("removal");
    let after = sqlx::query(LIST_MINE_ITEMS)
        .bind(owner)
        .bind(Option::<String>::None)
        .bind(Option::<Uuid>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("after removal");
    assert!(
        !after.iter().any(|r| r.get::<Uuid, _>(0) == e),
        "removed member must not see the org dataset (H-1)"
    );
}

/// TEST-28 leg 2 - `list_shared`: user share + group-share `= ANY(uuid[])`
/// JSON1 membership (the 32-hex `uuid_list_json` form only; hyphenated and
/// empty lists behave correctly) + the search arm.
#[tokio::test]
async fn list_shared_group_membership_hex_only() {
    let (_s, pool) = fresh_chain("ds-2").await;
    let me = user(&pool, "ds_me").await;
    let other = user(&pool, "ds_other").await;
    let oacc = account(&pool, other).await;
    let d1 = Uuid::new_v4();
    dataset(
        &pool,
        d1,
        other,
        oacc,
        "shared-user",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let d2 = Uuid::new_v4();
    dataset(
        &pool,
        d2,
        other,
        oacc,
        "shared-group",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let g = Uuid::new_v4();
    group(&pool, g, "DS2", true).await;
    user_group(&pool, me, g).await;
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d1)
        .bind("user")
        .bind(me)
        .bind("view")
        .execute(&pool)
        .await
        .expect("user share");
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d2)
        .bind("group")
        .bind(g)
        .bind("edit")
        .execute(&pool)
        .await
        .expect("group share");

    let rows = sqlx::query(LIST_SHARED_ITEMS)
        .bind(me)
        .bind(uuid_json(&[g]))
        .bind(Option::<String>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("shared");
    let got: Vec<Uuid> = rows.iter().map(|r| r.get::<Uuid, _>(0)).collect();
    assert!(got.contains(&d1) && got.contains(&d2));
    assert_eq!(got.len(), 2);

    // the hyphenated spelling never matches (the bind is the 32-hex form)
    let rows = sqlx::query(LIST_SHARED_ITEMS)
        .bind(me)
        .bind(hyp_json(&[g]))
        .bind(Option::<String>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("shared hyphenated");
    assert!(!rows.iter().any(|r| r.get::<Uuid, _>(0) == d2));

    // empty list → only the user share; search narrows
    let rows = sqlx::query(LIST_SHARED_ITEMS)
        .bind(me)
        .bind(uuid_json(&[]))
        .bind(Option::<String>::None)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("empty groups");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<Uuid, _>(0), d1);
    let rows = sqlx::query(LIST_SHARED_ITEMS)
        .bind(me)
        .bind(uuid_json(&[g]))
        .bind(Some("user"))
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("shared search");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<Uuid, _>(0), d1);
}

/// TEST-28 leg 3 - the ARRAY_AGG → json_group_array representative rewrite:
/// the richest-artifact ranking (empty vs non-empty, the key-order tie falling
/// to created_at), the LEFT-JOIN empty-dataset row, the `SUM` i64 totals and
/// the visible-set membership arms.
#[tokio::test]
async fn artifact_summary_representative_ranking() {
    let (_s, pool) = fresh_chain("ds-3").await;
    let owner = user(&pool, "ds_owner").await;
    let acc = account(&pool, owner).await;
    let a = Uuid::new_v4();
    dataset(&pool, a, owner, acc, "A", "upload", serde_json::json!({})).await;
    artifact(
        &pool,
        Uuid::new_v4(),
        a,
        "a1",
        "{}",
        "{}",
        "2026-01-01T00:00:00.000Z",
        10,
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        a,
        "a2",
        r#"{"plain":true}"#,
        "{}",
        "2026-01-02T00:00:00.000Z",
        20,
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        a,
        "a3",
        r#"{"b":2,"a":1}"#,
        "{}",
        "2026-01-03T00:00:00.000Z",
        30,
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        a,
        "a4",
        r#"{"a":1,"b":2}"#,
        "{}",
        "2026-01-04T00:00:00.000Z",
        40,
    )
    .await;
    // empty dataset: the LEFT JOIN yields one row with a NULL group (absence is one thing)
    let b = Uuid::new_v4();
    dataset(&pool, b, owner, acc, "B", "upload", serde_json::json!({})).await;
    let other = user(&pool, "ds_other").await;
    let d = Uuid::new_v4();
    dataset(
        &pool,
        d,
        other,
        account(&pool, other).await,
        "D",
        "upload",
        serde_json::json!({}),
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        d,
        "d1",
        "{}",
        "{}",
        "2026-03-01T00:00:00.000Z",
        3,
    )
    .await;
    let e = Uuid::new_v4();
    dataset(
        &pool,
        e,
        other,
        account(&pool, other).await,
        "E",
        "upload",
        serde_json::json!({}),
    )
    .await;
    artifact(
        &pool,
        Uuid::new_v4(),
        e,
        "e1",
        "{}",
        "{}",
        "2026-04-01T00:00:00.000Z",
        11,
    )
    .await;
    let g = Uuid::new_v4();
    group(&pool, g, "DS3", true).await;

    let rows = sqlx::query(ARTIFACT_SUMMARY)
        .bind(owner)
        .bind(uuid_json(&[]))
        .bind(100i64)
        .bind(100i64)
        .fetch_all(&pool)
        .await
        .expect("summary");
    let ids: Vec<Uuid> = rows.iter().map(|r| r.get::<Uuid, _>(0)).collect();
    assert!(ids.contains(&a) && ids.contains(&b));
    assert!(
        !ids.contains(&d) && !ids.contains(&e),
        "invisible datasets cannot appear"
    );

    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(e)
        .bind("group")
        .bind(g)
        .bind("view")
        .execute(&pool)
        .await
        .expect("group share");
    let rows = sqlx::query(ARTIFACT_SUMMARY)
        .bind(owner)
        .bind(uuid_json(&[g]))
        .bind(100i64)
        .bind(100i64)
        .fetch_all(&pool)
        .await
        .expect("summary");
    let ra = rows
        .iter()
        .find(|r| r.get::<Uuid, _>(0) == a)
        .expect("A row");
    assert_eq!(ra.get::<i64, _>(1), 4, "total_count (SUM cast removal)");
    assert_eq!(ra.get::<i64, _>(2), 100, "total_bytes");
    assert_eq!(
        ra.get::<Option<String>, _>(3).as_deref(),
        Some("data/opaque")
    );
    assert_eq!(ra.get::<i64, _>(4), 4);
    assert_eq!(ra.get::<i64, _>(5), 100);
    assert_eq!(
        ra.get::<String, _>(6),
        "a4",
        "representative = newest of the two canonically-equal non-empty structures \
         (the ORDER BY's only JSON comparison is against the '{}' literal)"
    );
    let rmeta: serde_json::Value =
        serde_json::from_str(ra.get::<String, _>(7).as_str()).expect("meta");
    assert_eq!(rmeta, serde_json::json!({}));
    let rstruct: serde_json::Value =
        serde_json::from_str(ra.get::<String, _>(8).as_str()).expect("structure");
    assert_eq!(rstruct, serde_json::json!({"a":1,"b":2}));

    let rb = rows
        .iter()
        .find(|r| r.get::<Uuid, _>(0) == b)
        .expect("B row");
    assert_eq!(rb.get::<i64, _>(1), 0, "empty dataset counts 0");
    assert_eq!(rb.get::<i64, _>(2), 0);
    assert_eq!(
        rb.get::<Option<String>, _>(3),
        None,
        "no group → all group cols null"
    );
    assert_eq!(rb.get::<Option<String>, _>(6), None);

    let re = rows
        .iter()
        .find(|r| r.get::<Uuid, _>(0) == e)
        .expect("E row");
    assert_eq!(
        re.get::<i64, _>(1),
        1,
        "group share admits the dataset + artifacts"
    );

    // group_cap 0 → no group rows (LEFT JOIN rn <= 0); the dataset row remains
    let rows = sqlx::query(ARTIFACT_SUMMARY)
        .bind(owner)
        .bind(uuid_json(&[g]))
        .bind(100i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("summary cap 0");
    let ra = rows
        .iter()
        .find(|r| r.get::<Uuid, _>(0) == a)
        .expect("A row cap 0");
    assert_eq!(ra.get::<Option<String>, _>(3), None);
}

/// TEST-28 leg 4 - visibility/access: the account-membership union (bare
/// member = read-only floor), user/group shares, the removed-owner (H-1)
/// outcome and `editable_subset`'s alignment with `access`'s `can_edit`.
#[tokio::test]
async fn visibility_access_and_editable_alignment() {
    let (_s, pool) = fresh_chain("ds-4").await;
    let owner = user(&pool, "ds_owner4").await;
    let acc = account(&pool, owner).await;
    let viewer = user(&pool, "ds_viewer").await;
    let editor = user(&pool, "ds_editor").await;
    let mbr = user(&pool, "ds_member").await;
    let admin = user(&pool, "ds_admin").await;
    let stranger = user(&pool, "ds_stranger").await;
    let d = Uuid::new_v4();
    dataset(&pool, d, owner, acc, "vis", "upload", serde_json::json!({})).await;
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("user")
        .bind(viewer)
        .bind("view")
        .execute(&pool)
        .await
        .expect("view share");
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("user")
        .bind(editor)
        .bind("edit")
        .execute(&pool)
        .await
        .expect("edit share");

    let vis = |ds: Uuid, u: Uuid| -> bool {
        sqlx::query_scalar(IS_VISIBLE_TO)
            .bind(ds)
            .bind(u)
            .bind(uuid_json(&[]))
    };
    async fn access_row(pool: &SqlitePool, ds: Uuid, u: Uuid) -> (bool, bool) {
        let row = sqlx::query(ACCESS)
            .bind(ds)
            .bind(u)
            .bind(uuid_json(&[]))
            .fetch_one(pool)
            .await
            .expect("access");
        (row.get::<bool, _>(0), row.get::<bool, _>(1))
    }
    assert!(vis(d, owner).await);
    assert!(vis(d, viewer).await && vis(d, editor).await);
    assert!(!vis(d, stranger).await);
    assert_eq!(access_row(&pool, d, owner).await, (true, true));
    assert_eq!(access_row(&pool, d, stranger).await, (false, false));

    // org-account dataset: member = read-only floor, admin = edit, owner = edit
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, ?, ?)")
        .bind(org)
        .bind("organization")
        .bind("ds-org4")
        .execute(&pool)
        .await
        .expect("org account");
    member(&pool, org, owner, "owner").await;
    member(&pool, org, mbr, "member").await;
    member(&pool, org, admin, "admin").await;
    let d2 = Uuid::new_v4();
    dataset(
        &pool,
        d2,
        owner,
        org,
        "orgds",
        "upload",
        serde_json::json!({}),
    )
    .await;
    assert_eq!(
        access_row(&pool, d2, mbr).await,
        (true, false),
        "bare member: read-only"
    );
    assert_eq!(
        access_row(&pool, d2, admin).await,
        (true, true),
        "account admin: edit"
    );
    assert_eq!(access_row(&pool, d2, owner).await, (true, true));

    // editable_subset agrees with access's can_edit arm per role
    let subset = |u: Uuid, ids: Vec<Uuid>| -> Vec<Uuid> {
        sqlx::query_scalar(EDITABLE_SUBSET)
            .bind(uuid_json(&ids))
            .bind(u)
            .bind(uuid_json(&[]))
    };
    let ids = vec![d, d2];
    let s_owner = subset(owner, ids.clone()).await;
    assert!(s_owner.contains(&d) && s_owner.contains(&d2));
    let s_viewer = subset(viewer, ids.clone()).await;
    assert!(!s_viewer.contains(&d), "viewer cannot edit");
    let s_admin = subset(admin, ids.clone()).await;
    assert!(s_admin.contains(&d2), "org admin edits the org dataset");
    assert!(!s_admin.contains(&d), "org admin is not the personal owner");

    // removed owner: loses the org dataset, keeps the personal one (H-1)
    sqlx::query("DELETE FROM account_members WHERE account_id = ? AND user_id = ?")
        .bind(org)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("removal");
    assert_eq!(access_row(&pool, d2, owner).await, (false, false));
    let s_owner2 = subset(owner, ids.clone()).await;
    assert!(!s_owner2.contains(&d2));
    assert!(s_owner2.contains(&d));
}

/// TEST-28 leg 5 - `list_files`' CASE-derived integration status (job-status
/// override + legacy fallback), `processing_status_map`, the shares upsert and
/// the audience (current members ∪ user share ∪ ACTIVE-group members).
#[tokio::test]
async fn files_derived_status_shares_and_audience() {
    let (_s, pool) = fresh_chain("ds-5").await;
    let owner = user(&pool, "ds_owner5").await;
    let acc = account(&pool, owner).await;
    let d = Uuid::new_v4();
    dataset(
        &pool,
        d,
        owner,
        acc,
        "files",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let f1 = Uuid::new_v4();
    file(&pool, f1, owner, "p.h5ad", 100, Some("sha256:p")).await;
    let f2 = Uuid::new_v4();
    file(&pool, f2, owner, "a.csv", 50, Some("sha256:a")).await;
    let f3 = Uuid::new_v4();
    file(&pool, f3, owner, "b.csv", 60, Some("sha256:b")).await;
    let f4 = Uuid::new_v4();
    file(&pool, f4, owner, "c.csv", 70, Some("sha256:c")).await;
    let f5 = Uuid::new_v4();
    file(&pool, f5, owner, "d.csv", 80, Some("sha256:d")).await;
    let f6 = Uuid::new_v4();
    file(&pool, f6, owner, "e.csv", 90, Some("sha256:e")).await;
    let f7 = Uuid::new_v4();
    file(&pool, f7, owner, "f.csv", 95, Some("sha256:f")).await;
    let j_q = Uuid::new_v4();
    job(&pool, j_q, owner, "queued", None).await;
    let j_r = Uuid::new_v4();
    job(&pool, j_r, owner, "running", None).await;
    let j_c = Uuid::new_v4();
    job(&pool, j_c, owner, "completed", None).await;
    let j_f = Uuid::new_v4();
    job(&pool, j_f, owner, "failed", Some("boom")).await;
    let j_b = Uuid::new_v4();
    job(&pool, j_b, owner, "blocked", None).await;

    async fn link(
        pool: &SqlitePool,
        d: Uuid,
        fid: Uuid,
        ord: i64,
        role: &str,
        status: Option<&str>,
        jid: Option<Uuid>,
    ) {
        sqlx::query(
            "INSERT INTO dataset_files (dataset_id, file_id, ordinal, role, \
                     integration_status, integration_job_id) VALUES (?,?,?,?,?,?)",
        )
        .bind(d)
        .bind(fid)
        .bind(ord)
        .bind(role)
        .bind(status)
        .bind(jid)
        .execute(pool)
        .await
        .expect("link fixture");
    }
    link(&pool, d, f1, 1, "primary", None, None).await;
    link(&pool, d, f2, 2, "supporting", Some("integrated"), None).await;
    link(&pool, d, f3, 3, "supporting", Some("pending"), Some(j_q)).await;
    link(&pool, d, f4, 4, "supporting", Some("running"), Some(j_r)).await;
    link(&pool, d, f5, 5, "supporting", Some("pending"), Some(j_c)).await;
    link(&pool, d, f6, 6, "supporting", Some("pending"), Some(j_f)).await;
    link(&pool, d, f7, 7, "supporting", Some("running"), Some(j_b)).await;

    let rows = sqlx::query(LIST_FILES)
        .bind(d)
        .bind(500i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("list_files");
    assert_eq!(rows.len(), 7);
    let status_of = |rows: &Vec<sqlx::sqlite::SqliteRow>, fid: Uuid| -> String {
        rows.iter()
            .find(|r| r.get::<Uuid, _>(0) == fid)
            .expect("row")
            .get::<Option<String>, _>(6)
            .unwrap_or_default()
    };
    assert_eq!(status_of(&rows, f1), "", "primary: no status");
    assert_eq!(status_of(&rows, f2), "integrated", "legacy stored status");
    assert_eq!(status_of(&rows, f3), "pending");
    assert_eq!(status_of(&rows, f4), "running");
    assert_eq!(status_of(&rows, f5), "integrated");
    assert_eq!(status_of(&rows, f6), "failed");
    assert_eq!(status_of(&rows, f7), "pending", "blocked job → pending");
    assert_eq!(rows[0].get::<String, _>(1), "p.h5ad", "files join");

    // processing_status_map: LEFT JOIN gives the job's status/error
    sqlx::query("UPDATE datasets SET processing_job_id = ? WHERE id = ?")
        .bind(j_f)
        .bind(d)
        .execute(&pool)
        .await
        .expect("processing job");
    let rows = sqlx::query(
        "SELECT d.id as \"id!\", j.status as \"status?\", j.error as \"error?\" \
         FROM datasets d LEFT JOIN jobs j ON j.id = d.processing_job_id \
         WHERE d.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)",
    )
    .bind(uuid_json(&[d, Uuid::new_v4()]))
    .fetch_all(&pool)
    .await
    .expect("status map");
    let found = rows
        .iter()
        .find(|r| r.get::<Uuid, _>(0) == d)
        .expect("d row");
    assert_eq!(found.get::<Option<String>, _>(1).as_deref(), Some("failed"));
    assert_eq!(found.get::<Option<String>, _>(2).as_deref(), Some("boom"));

    // shares upsert (ON CONFLICT DO UPDATE) + audience
    let u2 = user(&pool, "ds_u2").await;
    let u3 = user(&pool, "ds_u3").await;
    let u4 = user(&pool, "ds_u4").await;
    let u5 = user(&pool, "ds_u5").await;
    let u6 = user(&pool, "ds_u6").await;
    let g = Uuid::new_v4();
    group(&pool, g, "DS5", true).await;
    let g2 = Uuid::new_v4();
    group(&pool, g2, "DS5-disabled", false).await;
    user_group(&pool, u4, g).await;
    user_group(&pool, u5, g).await;
    user_group(&pool, u6, g2).await;
    // move the dataset onto an ORG account so the membership arm has two members
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, ?, ?)")
        .bind(org)
        .bind("organization")
        .bind("ds-org5")
        .execute(&pool)
        .await
        .expect("org account");
    member(&pool, org, owner, "owner").await;
    member(&pool, org, u2, "member").await;
    sqlx::query("UPDATE datasets SET account_id = ? WHERE id = ?")
        .bind(org)
        .bind(d)
        .execute(&pool)
        .await
        .expect("re-account");
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("user")
        .bind(u3)
        .bind("view")
        .execute(&pool)
        .await
        .expect("u3 share");
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("group")
        .bind(g)
        .bind("view")
        .execute(&pool)
        .await
        .expect("g share");
    // a DISABLED group is shared too — its members must stay outside the audience
    // (the `g.is_active` JOIN filter)
    sqlx::query("INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) VALUES (?,?,?,?,?)")
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("group")
        .bind(g2)
        .bind("view")
        .execute(&pool)
        .await
        .expect("g2 share");

    let mut got: Vec<Uuid> = sqlx::query_scalar(AUDIENCE_USER_IDS)
        .bind(d)
        .fetch_all(&pool)
        .await
        .expect("audience");
    got.sort();
    let mut want = vec![owner, u2, u3, u4, u5];
    want.sort();
    assert_eq!(
        got, want,
        "audience = members ∪ user share ∪ ACTIVE-group members"
    );

    // removed member leaves the audience (H-1)
    sqlx::query("DELETE FROM account_members WHERE account_id = ? AND user_id = ?")
        .bind(org)
        .bind(u2)
        .execute(&pool)
        .await
        .expect("u2 removal");
    let mut got: Vec<Uuid> = sqlx::query_scalar(AUDIENCE_USER_IDS)
        .bind(d)
        .fetch_all(&pool)
        .await
        .expect("audience");
    got.sort();
    let mut want = vec![owner, u3, u4, u5];
    want.sort();
    assert_eq!(got, want);

    // ADD_SHARE upsert: one row per (dataset, principal_type, principal_id),
    // role updated on conflict
    let row = sqlx::query(ADD_SHARE)
        .bind(Uuid::new_v4())
        .bind(d)
        .bind("user")
        .bind(u3)
        .bind("edit")
        .fetch_one(&pool)
        .await
        .expect("add_share upsert");
    assert_eq!(row.get::<String, _>(4), "edit");
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dataset_shares WHERE dataset_id = ? AND principal_type = 'user' AND principal_id = ?",
    )
    .bind(d)
    .bind(u3)
    .fetch_one(&pool)
    .await
    .expect("share count");
    assert_eq!(count, 1, "upsert updates, never duplicates");
}

/// TEST-28 leg 6 - the folder guard (guarded INSERT + the recheck fallback
/// carrying the SAME membership conjunct), the `DELETE … USING` → EXISTS
/// rewrite and the list-in-folder account-membership arm.
#[tokio::test]
async fn folder_guard_and_delete_using_rewrite() {
    let (_s, pool) = fresh_chain("ds-6").await;
    let owner = user(&pool, "ds_owner6").await;
    let acc = account(&pool, owner).await;
    let stranger = user(&pool, "ds_stranger6").await;
    let d = Uuid::new_v4();
    dataset(
        &pool,
        d,
        owner,
        acc,
        "fold",
        "upload",
        serde_json::json!({}),
    )
    .await;
    let s = Uuid::new_v4();
    dataset(
        &pool,
        s,
        stranger,
        account(&pool, stranger).await,
        "s",
        "upload",
        serde_json::json!({}),
    )
    .await;

    let row = sqlx::query("INSERT INTO dataset_folders (id, owner_id, name) VALUES (?,?,?) RETURNING id, owner_id, name, created_at, updated_at")
        .bind(Uuid::new_v4())
        .bind(owner)
        .bind("F1")
        .fetch_one(&pool)
        .await
        .expect("create_folder");
    let folder: Uuid = row.get(0);

    // guarded INSERT: a foreign dataset inserts 0 rows
    let n = sqlx::query(ADD_TO_FOLDER)
        .bind(folder)
        .bind(s)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("add foreign")
        .rows_affected();
    assert_eq!(n, 0, "foreign dataset refused by the guard");
    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM dataset_folder_members m \
         JOIN dataset_folders fo ON fo.id = m.folder_id \
         JOIN datasets d ON d.id = m.dataset_id \
         WHERE m.folder_id = ? AND m.dataset_id = ? AND fo.owner_id = ? \
         AND d.owner_id = ? \
         AND d.account_id IN (SELECT am.account_id FROM account_members am \
                              WHERE am.user_id = ?))",
    )
    .bind(folder)
    .bind(s)
    .bind(owner)
    .bind(owner)
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("recheck");
    assert!(!is_member, "foreign dataset: recheck false");

    // own dataset: insert 1, re-run → ON CONFLICT DO NOTHING
    let n = sqlx::query(ADD_TO_FOLDER)
        .bind(folder)
        .bind(d)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("add own")
        .rows_affected();
    assert_eq!(n, 1);
    let n2 = sqlx::query(ADD_TO_FOLDER)
        .bind(folder)
        .bind(d)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("add own again")
        .rows_affected();
    assert_eq!(n2, 0, "already member → ON CONFLICT DO NOTHING");

    let rows = sqlx::query(LIST_DATASETS_IN_FOLDER)
        .bind(folder)
        .bind(owner)
        .bind(50i64)
        .bind(0i64)
        .fetch_all(&pool)
        .await
        .expect("in folder");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].get::<Uuid, _>(0), d);

    // DELETE … USING → the EXISTS rewrite: owner removes its own member only
    let n = sqlx::query(REMOVE_FROM_FOLDER)
        .bind(folder)
        .bind(d)
        .bind(owner)
        .execute(&pool)
        .await
        .expect("remove")
        .rows_affected();
    assert_eq!(n, 1);
    let n2 = sqlx::query(REMOVE_FROM_FOLDER)
        .bind(folder)
        .bind(d)
        .bind(stranger)
        .execute(&pool)
        .await
        .expect("remove foreign")
        .rows_affected();
    assert_eq!(n2, 0, "another user's folder refused (EXISTS guard)");
}
