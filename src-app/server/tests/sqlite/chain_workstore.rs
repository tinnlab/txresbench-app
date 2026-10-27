//! The `workstore` chain invariants — TESTS.md TEST-16, the ITEM-9
//! per-item test.
//!
//! TEST-16 as written in TESTS.md: "the `workstore` chain applies; ciphertext
//! columns are `BLOB`-typed and the AES-GCM `encrypt_secret`/
//! `decrypt_secret` round-trip (compat mode: `storage_key` unset ⇒ PUT
//! refused, env fallback), with NO `pgcrypto`/`pgp_sym_*` calls traced (the
//! framework's `secret.rs` sqlite branch)."
//!
//! The D02 amendment (PLAN.md "Amendment — owner decision D02",
//! DECISIONS.md D02, OWNER-DECISIONS.md) supersedes the AES-GCM half: the
//! secret feature stays DORMANT — no cipher is built by this node and the
//! `secret.rs` sqlite branch is a later item's surface — so there is no
//! round-trip to assert here. What THIS item pins instead:
//!
//!   * the chain applies from scratch (the shared harness's 39-file leg also
//!     proves it, but the workstore group gets its own table-set + column
//!     assertions);
//!   * the ciphertext columns are `BLOB`-typed (bytea -> BLOB, DEC-8);
//!   * NO `pgcrypto` / `pgp_sym_*` anywhere in executable SQL of the 19
//!     ported files (the extension reference is dropped by construction;
//!     the D02 stance is recorded in the port notes);
//!   * the artifact model's port constructs behave: the two rebuilds'
//!     named CHECKs (bytes_or_recipe, alignment_or_single_source), the
//!     natural-key UNIQUE, the one-mask partial index, the FK cascade;
//!   * the object-store cutover family's row semantics: the
//!     one-active partial-unique index, the widened phase set, the
//!     cutover flag + src_config_ciphertext BLOB;
//!   * the meter ledger (AUTOINCREMENT surrogate + reason CHECK).

use sqlx::Row;

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};

/// The workstore staged dir relative to the server manifest, for the
/// pgcrypto-absence trace.
fn workstore_staged_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations-sqlite/workstore")
}

/// The declared column list of a table, in the chain's order (PRAGMA
/// table_xinfo: cid, name, type; hidden columns excluded).
async fn columns(pool: &sqlx::SqlitePool, table: &str) -> Vec<(i64, String, String)> {
    let rows = sqlx::query(&format!("PRAGMA table_xinfo('{table}')"))
        .fetch_all(pool)
        .await
        .unwrap_or_else(|e| panic!("table_xinfo {table}: {e}"));
    rows.iter()
        .filter(|r| r.get::<i64, _>(6) == 0)
        .map(|r| (r.get(0), r.get::<String, _>(1), r.get::<String, _>(2)))
        .collect()
}

/// TEST-16 (ITEM-9): the workstore table set + the port's schema contract —
/// artifacts carries the twenty-column final shape in the chain's order with
/// the DEC-8 types, the ciphertext columns are BLOB-typed, the settings
/// singleton + upload-limit bounds hold, and neither `pgcrypto` nor
/// `pgp_sym_*` appears in executable SQL of the nineteen ported files.
#[tokio::test]
async fn workstore_schema_and_pgcrypto_absence_hold() {
    let scratch = Scratch::new("workstore-schema");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- the workstore table set (6 final tables; axis_entry was created by
    // the baseline and DROPPED by 202608040002, in this chain like in PG) ---
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' \
         AND name NOT LIKE '_sqlx%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .expect("sqlite_master");
    for table in [
        "artifacts",
        "storage_meter",
        "workstore_settings",
        "infra_object_store",
        "infra_compute",
        "object_store_migration",
    ] {
        assert!(
            names.contains(&table.to_string()),
            "workstore table {table} exists"
        );
    }
    assert!(
        !names.contains(&"workstore_axis_entry".to_string()),
        "workstore_axis_entry is dropped by 202608040002"
    );

    // --- artifacts: the 20-column final shape, PG column order, DEC-8 types
    let cols = columns(&pool, "artifacts").await;
    let expected: Vec<(&str, &str)> = vec![
        ("id", "BLOB"),
        ("project_id", "BLOB"),
        ("run_id", "BLOB"),
        ("output_id", "TEXT"),
        ("datatype", "TEXT"),
        ("object_key", "TEXT"),
        ("is_multifile", "INTEGER"),
        ("content_hash", "TEXT"),
        ("status", "TEXT"),
        ("stored_bytes", "INTEGER"),
        ("created_by", "BLOB"),
        ("created_at", "TEXT"),
        ("updated_at", "TEXT"),
        ("dataset_id", "BLOB"),
        ("hidden", "INTEGER"),
        ("representation_of", "BLOB"),
        ("structure", "TEXT"),
        ("meta", "TEXT"),
        ("role", "TEXT"),
        ("logical_bytes", "INTEGER"),
    ];
    let got: Vec<(&str, &str)> = cols
        .iter()
        .map(|(_, n, t)| (n.as_str(), t.as_str()))
        .collect();
    assert_eq!(
        got, expected,
        "artifacts column set/order/types (stored_bytes from the 040007 rename)"
    );
    // The surviving CHECKs are named inline (the 040004 + 040010 rebuilds).
    let schema_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'artifacts'")
            .fetch_one(&pool)
            .await
            .expect("artifacts schema");
    for constraint in [
        "artifacts_bytes_or_recipe",
        "artifacts_recipe_alignment_or_single_source",
    ] {
        assert!(
            schema_sql.contains(constraint),
            "artifacts schema carries {constraint}: {schema_sql}"
        );
    }

    // --- ciphertext columns are BLOB (bytea -> BLOB, DEC-8 map) ----------
    let infra_obj: Vec<(String, String)> = columns(&pool, "infra_object_store")
        .await
        .into_iter()
        .map(|(_, n, t)| (n, t))
        .collect();
    for col in ["access_key_ciphertext", "secret_key_ciphertext"] {
        let t = infra_obj
            .iter()
            .find(|(n, _)| n == col)
            .unwrap_or_else(|| panic!("infra_object_store.{col} exists"))
            .1
            .clone();
        assert_eq!(t, "BLOB", "infra_object_store.{col} is BLOB-typed");
    }
    let infra_cmp: Vec<(String, String)> = columns(&pool, "infra_compute")
        .await
        .into_iter()
        .map(|(_, n, t)| (n, t))
        .collect();
    for col in ["kubeconfig_ciphertext", "token_ciphertext"] {
        let t = infra_cmp
            .iter()
            .find(|(n, _)| n == col)
            .unwrap_or_else(|| panic!("infra_compute.{col} exists"))
            .1
            .clone();
        assert_eq!(t, "BLOB", "infra_compute.{col} is BLOB-typed");
    }
    let osm: Vec<(String, String)> = columns(&pool, "object_store_migration")
        .await
        .into_iter()
        .map(|(_, n, t)| (n, t))
        .collect();
    let t = osm
        .iter()
        .find(|(n, _)| n == "src_config_ciphertext")
        .expect("object_store_migration.src_config_ciphertext exists")
        .1
        .clone();
    assert_eq!(t, "BLOB", "src_config_ciphertext is BLOB-typed");

    // --- workstore_settings singleton + bounds + the 202609020010 knobs ---
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workstore_settings")
        .fetch_one(&pool)
        .await
        .expect("workstore_settings");
    assert_eq!(rows, 1, "singleton seeded exactly once (ON CONFLICT seed)");
    let err = sqlx::query("INSERT INTO workstore_settings (id) VALUES (2)")
        .execute(&pool)
        .await
        .expect_err("a second workstore_settings row must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "singleton pin names a CHECK refusal: {err}"
    );
    let err = sqlx::query("UPDATE workstore_settings SET max_output_file_bytes = 1")
        .execute(&pool)
        .await
        .expect_err("ingest OOM floor must refuse");
    assert!(err.to_string().contains("CHECK constraint failed"), "{err}");
    let err = sqlx::query("UPDATE workstore_settings SET max_multifile_total_bytes = 1")
        .execute(&pool)
        .await
        .expect_err("total < single-file cap is degenerate (total_ge_file)");
    assert!(err.to_string().contains("CHECK constraint failed"), "{err}");
    let err = sqlx::query("UPDATE workstore_settings SET max_upload_parts = 0")
        .execute(&pool)
        .await
        .expect_err("upload part cap floor must refuse");
    assert!(err.to_string().contains("CHECK constraint failed"), "{err}");
    let (body, parts): (i64, i64) =
        sqlx::query_as("SELECT max_upload_body_bytes, max_upload_parts FROM workstore_settings")
            .fetch_one(&pool)
            .await
            .expect("upload knobs");
    assert_eq!(
        (body, parts),
        (68_719_476_736, 1024),
        "compiled-constant defaults"
    );

    // --- pgcrypto / pgp_sym_* absence in executable SQL ------------------
    let mut exe = String::new();
    for entry in std::fs::read_dir(workstore_staged_dir()).expect("staged workstore dir") {
        let path = entry.expect("entry").path();
        if path.extension().and_then(|s| s.to_str()) != Some("sql") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("read staged file");
        for line in text.lines() {
            if !line.trim_start().starts_with("--") {
                exe.push_str(line);
                exe.push('\n');
            }
        }
    }
    let files: Vec<String> = std::fs::read_dir(workstore_staged_dir())
        .expect("staged workstore dir")
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".sql"))
        .collect();
    assert_eq!(files.len(), 19, "the workstore group ships 19 files");
    assert!(
        !exe.to_ascii_lowercase().contains("pgp_sym"),
        "no pgp_sym_* in executable SQL: {exe}"
    );
    assert!(
        !exe.to_ascii_lowercase().contains("pgcrypto"),
        "no pgcrypto call in executable SQL: {exe}"
    );
}

/// TEST-16 row semantics: the artifact model's port constructs behave like
/// the Postgres chain's — stored-xor-gathered, the natural-key UNIQUE, the
/// one-mask-per-dataset partial index, the multi-source alignment CHECK,
/// the FK cascade, and the logical-bytes column.
#[tokio::test]
async fn artifact_model_invariants_hold() {
    let scratch = Scratch::new("workstore-artifacts");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // Project + dataset parent fixtures. ITEM-10's REAL `projects` table
    // landed (strict NOT NULLs — id/owner_id/name — and the owner FK to
    // users), so the project row needs a users row; `datasets` is still
    // the ITEM-11 stub, but ITEM-10's 202608040013 ADDs `account_id …
    // CHECK (account_id IS NOT NULL)` + a REFERENCES to the real accounts
    // table, so the dataset row needs an accounts fixture (an org row —
    // the personal_has_user CHECK).
    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'fixture', 'fixture@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("users fixture row");
    let tenant = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'fixture')")
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("accounts fixture row (the ITEM-10 real table)");
    let proj = uuid::Uuid::new_v4();
    let ds = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, 'fixture', ?)",
    )
    .bind(proj)
    .bind(owner)
    .bind(tenant)
    .execute(&pool)
    .await
    .expect("project fixture row (the ITEM-10 real table — 013's account_id CHECK)");
    sqlx::query("INSERT INTO datasets (id, account_id) VALUES (?, ?)")
        .bind(ds)
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("dataset fixture row (stub + the 013 account_id column)");

    let insert_artifact = |id: uuid::Uuid,
                           output_id: &str,
                           object_key: Option<&str>,
                           structure: &str| {
        let pool = pool.clone();
        let output_id = output_id.to_string();
        let structure = structure.to_string();
        let object_key = object_key.map(|s| s.to_string());
        async move {
            sqlx::query(
                "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, meta, role) \
                 VALUES (?, ?, 'data/opaque', ?, 'sha256:probe', ?, '{}', 'artifact')",
            )
            .bind(id)
            .bind(output_id)
            .bind(object_key)
            .bind(structure)
            .execute(&pool)
            .await
        }
    };

    // --- stored / gathered / both / neither (artifacts_bytes_or_recipe) ---
    insert_artifact(uuid::Uuid::new_v4(), "stored", Some("obj/stored"), "{}")
        .await
        .expect("stored artifact: key + no recipe");
    insert_artifact(
        uuid::Uuid::new_v4(),
        "gathered",
        None,
        r#"{"gathered_from":{"sources":["s1"],"mask_artifact_id":"m"}}"#,
    )
    .await
    .expect("gathered artifact: no key + recipe");
    let err = insert_artifact(
        uuid::Uuid::new_v4(),
        "both",
        Some("obj/both"),
        r#"{"gathered_from":{"sources":["s1"]}}"#,
    )
    .await
    .expect_err("both key and recipe is the incoherent combination");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "bytes_or_recipe refuses key+recipe: {err}"
    );
    let err = insert_artifact(uuid::Uuid::new_v4(), "neither", None, "{}")
        .await
        .expect_err("neither key nor recipe is unreadable");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "bytes_or_recipe refuses neither: {err}"
    );

    // --- natural key UNIQUE (COALESCE-of-NULLs → the zero-uuid blob) ------
    insert_artifact(uuid::Uuid::new_v4(), "dup-key", Some("obj/dup-1"), "{}")
        .await
        .expect("first row with the natural key");
    let err = insert_artifact(uuid::Uuid::new_v4(), "dup-key", Some("obj/dup-2"), "{}")
        .await
        .expect_err("the second artifact with the same natural key must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "natural key surfaces as UNIQUE: {err}"
    );

    // --- one mask per dataset (partial unique on role='mask') ------------
    let mask = sqlx::query(
        "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, meta, role, dataset_id, hidden) \
         VALUES (?, 'mask-1', 'data/opaque', 'obj/mask', 'sha256:mask', '{}', '{}', 'mask', ?, 1)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(ds)
    .execute(&pool)
    .await
    .expect("first mask");
    assert_eq!(mask.rows_affected(), 1);
    let err = sqlx::query(
        "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, meta, role, dataset_id, hidden) \
         VALUES (?, 'mask-2', 'data/opaque', 'obj/mask2', 'sha256:mask2', '{}', '{}', 'mask', ?, 1)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(ds)
    .execute(&pool)
    .await
    .expect_err("a second mask of the same dataset must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "one-mask guard surfaces as UNIQUE: {err}"
    );
    // The partial guard must NOT constrain a role='artifact' row of the same
    // dataset (the gathered columns are many).
    insert_artifact_with_dataset(&pool, "artifact-ds", ds).await;

    // --- multi-source gather must declare its alignment (040010 CHECK) ----
    let err = insert_artifact(
        uuid::Uuid::new_v4(),
        "no-align",
        None,
        r#"{"gathered_from":{"sources":["a","b"]}}"#,
    )
    .await
    .expect_err("a 2-source gather without alignment must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "alignment guard refuses: {err}"
    );
    insert_artifact(
        uuid::Uuid::new_v4(),
        "with-align",
        None,
        r#"{"gathered_from":{"sources":["a","b"],"alignment_artifact_id":"align"}}"#,
    )
    .await
    .expect("2-source gather with alignment commits");

    // --- FK cascade on project delete (declared inline in the rebuild) ---
    let cascaded = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO artifacts (id, project_id, output_id, datatype, object_key, content_hash, structure, meta, role) \
         VALUES (?, ?, 'cascade-me', 'data/opaque', 'obj/c', 'sha256:c', '{}', '{}', 'artifact')",
    )
    .bind(cascaded)
    .bind(proj)
    .execute(&pool)
    .await
    .expect("project-scoped artifact");
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(proj)
        .execute(&pool)
        .await
        .expect("delete project");
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE id = ?")
        .bind(cascaded)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(left, 0, "artifacts cascade with their project");

    // --- logical_bytes is the second byte quantity (040007) --------------
    let stored_id = uuid::Uuid::new_v4();
    insert_artifact(stored_id, "bytes", Some("obj/bytes"), "{}")
        .await
        .expect("bytes artifact");
    let (stored, logical): (i64, Option<i64>) =
        sqlx::query_as("SELECT stored_bytes, logical_bytes FROM artifacts WHERE id = ?")
            .bind(stored_id)
            .fetch_one(&pool)
            .await
            .expect("byte quantities");
    assert_eq!(stored, 0, "stored_bytes is the object-store quantity");
    assert_eq!(logical, None, "logical_bytes is NULL = genuinely unknown");
    sqlx::query("UPDATE artifacts SET logical_bytes = 42 WHERE id = ?")
        .bind(stored_id)
        .execute(&pool)
        .await
        .expect("set logical bytes");
}

/// A `role='artifact'` row belonging to the given (stub) dataset — the
/// many-rows side of the one-mask index: the partial guard must not
/// constrain it.
async fn insert_artifact_with_dataset(pool: &sqlx::SqlitePool, output_id: &str, ds: uuid::Uuid) {
    sqlx::query(
        "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, meta, role, dataset_id) \
         VALUES (?, ?, 'data/opaque', 'obj/ads', 'sha256:ads', '{}', '{}', 'artifact', ?)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(output_id)
    .bind(ds)
    .execute(pool)
    .await
    .expect("artifact row on the same dataset as a mask");
}

/// Insert an object-store migration row with an app-bound uuid id and the
/// given phase (the phase grammar's probe point).
async fn insert_migration(
    pool: &sqlx::SqlitePool,
    phase: &str,
) -> sqlx::Result<sqlx::sqlite::SqliteQueryResult> {
    sqlx::query(
        "INSERT INTO object_store_migration (id, src_backend, dst_backend, phase) \
         VALUES (?, 'local', 's3', ?)",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(phase)
    .execute(pool)
    .await
}

/// TEST-16 row semantics: the object-store cutover family + the meter
/// ledger — the id must be app-bound (no SQL-side UUID default), the
/// one-active partial unique index allows the transitions the PG file
/// documents (a `verified` row does NOT block a fresh migration), the
/// widened phase set accepts `abandoned`, the cutover flag + ciphertext
/// column round-trip as INTEGER/BLOB, and the meter's AUTOINCREMENT
/// surrogate + reason CHECK hold.
#[tokio::test]
async fn object_store_cutover_family_and_meter_hold() {
    let scratch = Scratch::new("workstore-cutover");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- id: BLOB, NO SQL-side default (app binds Uuid::new_v4()) --------
    let m1 = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO object_store_migration (id, src_backend, dst_backend, phase) \
         VALUES (?, 'local', 's3', 'pending')",
    )
    .bind(m1)
    .execute(&pool)
    .await
    .expect("migration insert with app-bound id");
    let back: uuid::Uuid = sqlx::query_scalar("SELECT id FROM object_store_migration WHERE id = ?")
        .bind(m1)
        .fetch_one(&pool)
        .await
        .expect("read back");
    assert_eq!(back, m1, "uuid round-trips through the blob PRIMARY KEY");
    let storage: String = sqlx::query_scalar("SELECT typeof(id) FROM object_store_migration")
        .fetch_one(&pool)
        .await
        .expect("typeof");
    assert_eq!(storage, "blob", "id is a 16-byte blob literal");

    // --- one-active partial unique: the index key is the CONSTANT 1, so
    // exactly one RUNNING row exists; `verified` is deliberately NOT in the
    // index (a completed copy awaiting retire must not block a fresh move) --
    // m1 completes: verified leaves the running set.
    sqlx::query("UPDATE object_store_migration SET phase = 'verified' WHERE id = ?")
        .bind(m1)
        .execute(&pool)
        .await
        .expect("m1 verified");
    // A fresh migration is allowed while a verified one awaits retire.
    insert_migration(&pool, "pending")
        .await
        .expect("verified does not block a fresh migration");
    // A second RUNNING row is refused.
    let err = insert_migration(&pool, "pending")
        .await
        .expect_err("a second running migration must be refused");
    assert!(
        err.to_string().contains("UNIQUE"),
        "one-active guard surfaces as UNIQUE: {err}"
    );

    // --- phase vocabulary: the CHECK refuses a bogus value; the 290130
    // widened set ACCEPTS `abandoned` (the #65 path: abandon a VERIFIED
    // migration) and keeps the terminal set ------------------------------
    let err = insert_migration(&pool, "bogus")
        .await
        .expect_err("bogus phase must be refused");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "phase CHECK refuses: {err}"
    );
    let n = sqlx::query("UPDATE object_store_migration SET phase = 'abandoned' WHERE id = ?")
        .bind(m1)
        .execute(&pool)
        .await
        .expect("abandoned accepted after the 290130 widen");
    assert_eq!(n.rows_affected(), 1);
    let running: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM object_store_migration WHERE phase IN ('pending','copying','verifying')",
    )
    .fetch_one(&pool)
    .await
    .expect("running count");
    assert_eq!(running, 1, "the abandoned row left the running set");

    // --- cutover flag + src_config_ciphertext: INTEGER 0/1 + BLOB --------
    insert_migration(&pool, "verified")
        .await
        .expect("a row in the verified-awaiting-retire state");
    let cut = sqlx::query(
        "UPDATE object_store_migration SET cutover = 1, \
         src_config_ciphertext = X'01020304' WHERE phase = 'verified'",
    )
    .execute(&pool)
    .await
    .expect("cutover set");
    assert_eq!(cut.rows_affected(), 1);
    let (flag, cipher_len): (i64, i64) = sqlx::query_as(
        "SELECT cutover, length(src_config_ciphertext) FROM object_store_migration \
         WHERE phase = 'verified'",
    )
    .fetch_one(&pool)
    .await
    .expect("cutover row");
    assert_eq!(flag, 1, "cutover is INTEGER 0/1");
    assert_eq!(cipher_len, 4, "ciphertext column carries blob bytes");

    // --- the three indexes exist (one-active UNIQUE, created_at, cutover)
    let idx: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'object_store_migration'",
    )
    .fetch_all(&pool)
    .await
    .expect("indexes");
    for name in [
        "object_store_migration_one_active",
        "object_store_migration_created_at_idx",
        "object_store_migration_cutover_idx",
    ] {
        assert!(
            idx.contains(&name.to_string()),
            "index {name} exists: {idx:?}"
        );
    }

    // --- storage_meter: AUTOINCREMENT id + reason CHECK ------------------
    sqlx::query(
        "INSERT INTO storage_meter (content_hash, delta_bytes, reason) \
         VALUES ('sha256:m1', 10, 'ingest')",
    )
    .execute(&pool)
    .await
    .expect("meter ingest delta");
    let (id, n): (i64, i64) = sqlx::query_as(
        "SELECT id, count(*) FROM storage_meter WHERE content_hash = 'sha256:m1' GROUP BY id",
    )
    .fetch_one(&pool)
    .await
    .expect("meter row");
    assert!(id >= 1, "AUTOINCREMENT surrogate assigned: {id}");
    assert_eq!(n, 1);
    let err = sqlx::query(
        "INSERT INTO storage_meter (content_hash, delta_bytes, reason) \
         VALUES ('sha256:m2', -10, 'bogus')",
    )
    .execute(&pool)
    .await
    .expect_err("reason vocabulary must be enforced");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "reason CHECK refuses: {err}"
    );
}
