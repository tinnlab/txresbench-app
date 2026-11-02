//! The `dataset` + `drafts` + `provenance` chain invariants — TESTS.md
//! TEST-18, the ITEM-11 per-item test.
//!
//! TEST-18 as written in TESTS.md: "asserts: dataset/drafts/provenance
//! chains apply; the `jsonb`-comparison rewrites (`json(a) <> json(b)`
//! defeats key-order drift for the representative-artifact select) return
//! identical rows to the PG semantics on a fixture; `RETURNING` inserts
//! round-trip."
//!
//! What THIS item pins beyond the shared harness's 57-file leg:
//!
//!   * the `datasets` source-vocabulary widening landed IN ORDER (the
//!     baseline's two values -> `integrate` by 202608040005 -> `filter`
//!     by 202608040011), each via the rebuild procedure, with the two
//!     json-extract idempotency partial-unique indexes live;
//!   * the `datasets_integrate_declares_alignment` CHECK truth table —
//!     the row guard is what matters (JSON null refused, "" refused,
//!     absent key refused, non-empty admitted, upload/promote exempt);
//!   * the `json(a) <> json(b)` representative-artifact rewrite is
//!     KEY-ORDER-SAFE (the ORDER BY's only JSON comparison is against the
//!     `'{}'` literal) AND the engine's non-canonicalization fact is pinned
//!     (SQLite's json()/jsonb() preserve object key order — DEC-8's
//!     "jsonb() canonical form" premise does NOT hold for equality, a
//!     node-level finding; see DRIFT-1 ITEM-11);
//!   * the drafts freeze surface: status vocabulary, freeze-job mapping
//!     (FK cascade on both ends), lineage fork edges + version positivity;
//!   * the provenance settings singleton + bounds, the
//!     _COALESCE-blob-unique referencing-dedup, the dataset-cascade.
//!   `RETURNING` inserts round-trip on each group (the repository macro
//!   shape the ITEM-21/22/23 query ports use).

use super::apply_chain::{apply_chain, compose_sqlite_chain, Scratch};
use sqlx::Row;

/// TEST-18 (dataset leg): the source vocabulary + the two idempotency
/// partial-unique indexes and the declare-alignment CHECK's truth table.
#[tokio::test]
async fn dataset_chain_source_vocabulary_and_idempotency_hold() {
    let scratch = Scratch::new("item11-dataset");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'ds-owner', 'ds@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner user");
    let tenant = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'dsprobe')")
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("org account");

    // --- the final 4-value source vocabulary (the two rebuilds) ----------
    let schema_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'datasets'")
            .fetch_one(&pool)
            .await
            .expect("datasets schema");
    assert!(
        schema_sql.contains("source IN ('upload','promote','integrate','filter')"),
        "the rebuilt source CHECK carries the final vocabulary: {schema_sql}"
    );
    assert!(
        schema_sql.contains("datasets_integrate_declares_alignment"),
        "the declare-alignment CHECK survived both rebuilds: {schema_sql}"
    );

    // --- one integrate dataset per alignment_run_id(JSON-extract index) --
    let integrate_md = r#"{"alignment_run_id":"ar-1","alignment":{"artifact_id":"art-1"}}"#;
    let run_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES (?, 'ds-1', ?, ?, ?, 'integrate') RETURNING id",
    )
    .bind(run_id)
    .bind(owner)
    .bind(tenant)
    .bind(integrate_md)
    .fetch_one(&pool)
    .await
    .expect("first integrate row");
    let err = sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES (?, 'ds-dup', ?, ?, ?, 'integrate')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(owner)
    .bind(tenant)
    .bind(integrate_md)
    .execute(&pool)
    .await
    .expect_err("a second integrate dataset for the same alignment run is the duplicated-row race");
    assert!(
        err.to_string().contains("datasets_one_per_alignment_run"),
        "the idempotency guard names the index: {err}"
    );
    // the same run id on a DIFFERENT source is untouched by the partial index
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES (?, 'move-on', ?, ?, ?, 'upload')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(owner)
    .bind(tenant)
    .bind(integrate_md)
    .execute(&pool)
    .await
    .expect("an upload row with the same metadata is untouched (partial index)");

    // --- declare-alignment CHECK: the boundary where truth matters --------
    // JSON null: `->>` yields SQL NULL in PG; `json_extract` yields SQL NULL
    // here — both say "not declared". The `json_type`-existence variant
    // would call this PRESENT and let the invisible edge through.
    for (label, md) in [
        (
            "json-null",
            r#"{"alignment":{"artifact_id":null},"alignment_run_id":"x"}"#,
        ),
        (
            "empty-string",
            r#"{"alignment":{"artifact_id":""},"alignment_run_id":"x"}"#,
        ),
        ("missing-key", r#"{"alignment_run_id":"x"}"#),
        (
            "wrong-shape",
            r#"{"alignment":"oops","alignment_run_id":"x"}"#,
        ),
    ] {
        let err = sqlx::query(
            "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
             VALUES (?, 'bad', ?, ?, ?, 'integrate')",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(owner)
        .bind(tenant)
        .bind(md)
        .execute(&pool)
        .await
        .expect_err(label);
        assert!(
            err.to_string()
                .contains("datasets_integrate_declares_alignment"),
            "{label}: the CHECK must name the constraint: {err}"
        );
    }
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES (?, 'declared', ?, ?, ?, 'integrate')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(owner)
    .bind(tenant)
    .bind(r#"{"alignment_run_id":"ar-2","alignment":{"artifact_id":"art-2"}}"#)
    .execute(&pool)
    .await
    .expect("a declared integrate row is admitted");

    // --- RETURNING round-trip (the repository's macro query shape) -------
    let id = uuid::Uuid::new_v4();
    let back: (uuid::Uuid, String, String) = sqlx::query_as(
        "INSERT INTO datasets (id, name, owner_id, account_id, source) \
         VALUES (?, 'ret-ds', ?, ?, 'upload') \
         RETURNING id, name, metadata",
    )
    .bind(id)
    .bind(owner)
    .bind(tenant)
    .fetch_one(&pool)
    .await
    .expect("RETURNING insert");
    assert_eq!(back.0, id);
    assert_eq!(back.1, "ret-ds");
    assert_eq!(back.2, "{}", "jsonb -> JSON text, default {{}}");
    let typeof_id: String = sqlx::query_scalar("SELECT typeof(id) FROM datasets WHERE id = ?")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("typeof");
    assert_eq!(typeof_id, "blob", "uuid -> 16-byte BLOB");
}

/// TEST-18 (representative-artifact select): the `json(a) <> json(b)`
/// rewrite's key-order safety. The PG select is
/// `(ARRAY_AGG(output_id ORDER BY structure <> '{}'::jsonb DESC,
/// meta <> '{}'::jsonb DESC, created_at DESC, output_id, id))[1]` — "the
/// richest artifact is representative"; the SQLite rewrite orders by
/// `json(x) <> json('{}')` on the DEC-8 JSON-text columns.
///
/// ENGINE MEASUREMENT (this test): SQLite 3.46's `json()` AND `jsonb()`
/// both PRESERVE object key order — neither is a canonical form able to
/// equate key-order variants (`json('{"b":2,"a":1}') = json('{"a":1,"b":2}')`
/// is FALSE on the bundled engine; the assertion below pins that fact so a
/// later query-port item cannot rely on the TESTS.md/DEC-8 "canonical
/// jsonb()" premise for EQUALITY). The representative select is nevertheless
/// KEY-ORDER-SAFE: its only JSON comparison is against the empty-object
/// LITERAL `'{}'` — a value-order-independent comparison — and after the
/// `<> '{}'` split, the tie between the key-order variants falls to
/// `created_at DESC` exactly as PG's jsonb-equality tiebreak falls to the
/// same ordering (PG would also rank a3 == a4 and pick a4 by created_at).
/// The fixture's answer on both engines is therefore a4; ITEM-21's query
/// rewrite must never compare two non-empty JSON values with `json()`/
/// `jsonb()` equality (recorded in DRIFT-1 ITEM-11).
#[tokio::test]
async fn representative_artifact_canonical_comparison_defeats_key_order_drift() {
    let scratch = Scratch::new("item11-representative");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'rep-owner', 'r@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner user");
    let tenant = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'repprobe')")
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("org account");
    let ds = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO datasets (id, name, owner_id, account_id) VALUES (?, 'rep-ds', ?, ?)")
        .bind(ds)
        .bind(owner)
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("dataset row");

    // Four artifacts of one dataset, ranked by the select's ORDER BY.
    // a1: empty structure + empty meta, earliest
    // a2: non-empty structure (but NOT gathered-from — a plain object), middle
    // a3/a4: semantically equal non-empty structures, DIFFERENT key order
    let insert_artifact = |output_id: &'static str,
                           structure: &'static str,
                           meta: &'static str,
                           created_at: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, \
                 structure, meta, role, dataset_id, created_at) \
                 VALUES (?, ?, 'data/opaque', 'obj/rep', 'sha256:rep', ?, ?, 'artifact', ?, ?) \
                 RETURNING id",
            )
            .bind(uuid::Uuid::new_v4())
            .bind(output_id)
            .bind(structure)
            .bind(meta)
            .bind(ds)
            .bind(created_at)
            .fetch_one(&pool)
            .await
            .expect("artifact row");
        }
    };
    insert_artifact("a1", "{}", "{}", "2026-01-01T00:00:00.000Z").await;
    insert_artifact("a2", r#"{"plain":true}"#, "{}", "2026-01-02T00:00:00.000Z").await;
    insert_artifact("a3", r#"{"b":2,"a":1}"#, "{}", "2026-01-03T00:00:00.000Z").await;
    insert_artifact("a4", r#"{"a":1,"b":2}"#, "{}", "2026-01-04T00:00:00.000Z").await;

    // The engine truth, pinned so the query-port items see it: SQLite's
    // JSON functions do NOT canonicalize object key order (measured; both
    // json() and jsonb() preserve it). The representative select is safe
    // anyway — see the doc comment.
    for (fn_name, expr) in [
        ("json", "SELECT json(?) = json(?)"),
        ("jsonb", "SELECT jsonb(?) = jsonb(?)"),
    ] {
        let equal: i64 = sqlx::query_scalar(expr)
            .bind(r#"{"b":2,"a":1}"#)
            .bind(r#"{"a":1,"b":2}"#)
            .fetch_one(&pool)
            .await
            .expect("json equality");
        assert_eq!(
            equal, 0,
            "{fn_name}() must NOT equate key-order variants (the engine preserves key order;              a canonical form would return 1)"
        );
    }

    // The group-ranked aggregate: the representative is the row the PG
    // jsonb ORDER BY would pick — non-empty structure DESC wins, and of
    // the two canonically-equal non-empty structures the newer one wins.
    let representative: String = sqlx::query_scalar(
        "SELECT json_extract(json_group_array(output_id ORDER BY \
             jsonb(structure) <> jsonb('{}') DESC, \
             jsonb(meta) <> jsonb('{}') DESC, \
             created_at DESC, output_id, id), '$[0]') \
         FROM artifacts WHERE dataset_id = ?",
    )
    .bind(ds)
    .fetch_one(&pool)
    .await
    .expect("representative select");
    assert_eq!(
        representative, "a4",
        "the representative artifact matches the PG jsonb ranking (newest of the non-empty pair)"
    );

    // The FULL ordering, asserted directly.
    let order: Vec<String> = sqlx::query_scalar(
        "SELECT output_id FROM artifacts WHERE dataset_id = ? \
         ORDER BY jsonb(structure) <> jsonb('{}') DESC, \
                  jsonb(meta) <> jsonb('{}') DESC, \
                  created_at DESC, output_id, id",
    )
    .bind(ds)
    .fetch_all(&pool)
    .await
    .expect("full order");
    assert_eq!(
        order,
        vec!["a4", "a3", "a2", "a1"],
        "key drift must not reorder: a3/a4 are canonically equal, so created_at decides"
    );
}

/// TEST-18 (drafts leg): the freeze surface — status vocabulary, the
/// freeze-job mapping (FK cascades both ways), the lineage fork edges, and
/// a RETURNING insert.
#[tokio::test]
async fn drafts_freeze_surface_holds() {
    let scratch = Scratch::new("item11-drafts");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'draft-owner', 'd@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner user");
    let tenant = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'draftprobe')")
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("org account");
    let project = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, 'draft-proj', ?)",
    )
    .bind(project)
    .bind(owner)
    .bind(tenant)
    .execute(&pool)
    .await
    .expect("project row");

    // --- draft + RETURNING (the repository's macro shape) ----------------
    let draft_id = uuid::Uuid::new_v4();
    let back: (uuid::Uuid, String, Option<uuid::Uuid>) = sqlx::query_as(
        "INSERT INTO drafts (id, kind, project_id, data) VALUES (?, 'probe::doc', ?, '{}') \
         RETURNING id, status, frozen_artifact_id",
    )
    .bind(draft_id)
    .bind(project)
    .fetch_one(&pool)
    .await
    .expect("draft RETURNING insert");
    assert_eq!(back.0, draft_id);
    assert_eq!(back.1, "open", "status defaults to open");
    assert_eq!(back.2, None::<uuid::Uuid>, "no frozen artifact yet");

    // status vocabulary CHECK
    let err = sqlx::query("UPDATE drafts SET status = 'abandoned' WHERE id = ?")
        .bind(draft_id)
        .execute(&pool)
        .await
        .expect_err("status must be CHECKed");
    assert!(
        err.to_string().contains("drafts_status_check"),
        "status CHECK names the constraint: {err}"
    );

    // --- freeze-job mapping: FK cascades both ways -----------------------
    let job = sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, status) VALUES (?, ?, 'probe', 'queued') \
         RETURNING id",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("job row");
    let job_id: uuid::Uuid = job.get(0);
    sqlx::query(
        "INSERT INTO draft_freeze_jobs (job_id, draft_id, content_hash) VALUES (?, ?, 'h1')",
    )
    .bind(job_id)
    .bind(draft_id)
    .execute(&pool)
    .await
    .expect("freeze mapping row");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM draft_freeze_jobs")
        .fetch_one(&pool)
        .await
        .expect("mapping count");
    assert_eq!(n, 1);
    // the job GC DELETE cascades the mapping
    sqlx::query("DELETE FROM jobs WHERE id = ?")
        .bind(job_id)
        .execute(&pool)
        .await
        .expect("job delete");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM draft_freeze_jobs")
        .fetch_one(&pool)
        .await
        .expect("mapping count after job delete");
    assert_eq!(n, 0, "the mapping dies with its job (FK CASCADE)");
    // a bogus draft_id is refused (FK live on DML)
    let err = sqlx::query(
        "INSERT INTO draft_freeze_jobs (job_id, draft_id, content_hash) VALUES (?, '00000000-0000-0000-0000-000000000000', 'h')",
    )
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect_err("bogus draft_id must be refused");
    assert!(
        err.to_string().contains("FOREIGN KEY"),
        "draft FK live: {err}"
    );

    // --- lineage: version CHECK + creation ------------------------------
    let art = sqlx::query(
        "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, \
         meta, role, dataset_id) VALUES (?, 'freeze-art', 'data/opaque', 'obj/fa', 'sha256:fa', \
         '{}', '{}', 'artifact', NULL) RETURNING id",
    )
    .bind(uuid::Uuid::new_v4())
    .fetch_one(&pool)
    .await
    .expect("artifact row");
    let art_id: uuid::Uuid = art.get(0);
    sqlx::query(
        "INSERT INTO draft_artifact_lineage (artifact_id, draft_id, version) VALUES (?, ?, 1)",
    )
    .bind(art_id)
    .bind(draft_id)
    .execute(&pool)
    .await
    .expect("first freeze lineage row");
    // The fork CHILD is its own artifact row (the FK is live on DML — a
    // lineage row cannot point at an artifact that does not exist).
    let child_artifact = sqlx::query(
        "INSERT INTO artifacts (id, output_id, datatype, object_key, content_hash, structure, \
         meta, role, dataset_id) VALUES (?, 'freeze-art-2', 'data/opaque', 'obj/fa2', 'sha256:fa2', \
         '{}', '{}', 'artifact', NULL) RETURNING id",
    )
    .bind(uuid::Uuid::new_v4())
    .fetch_one(&pool)
    .await
    .expect("child artifact row");
    let child: uuid::Uuid = child_artifact.get(0);
    let err = sqlx::query(
        "INSERT INTO draft_artifact_lineage (artifact_id, draft_id, parent_artifact_id, version) \
         VALUES (?, ?, ?, 0)",
    )
    .bind(child)
    .bind(draft_id)
    .bind(art_id)
    .execute(&pool)
    .await
    .expect_err("version 0 must be refused");
    assert!(
        err.to_string()
            .contains("draft_artifact_lineage_version_positive"),
        "version CHECK names the constraint: {err}"
    );
    sqlx::query(
        "INSERT INTO draft_artifact_lineage (artifact_id, draft_id, parent_artifact_id, version) \
         VALUES (?, ?, ?, 2)",
    )
    .bind(child)
    .bind(draft_id)
    .bind(art_id)
    .execute(&pool)
    .await
    .expect("fork edge (version 2)");

    // project DELETE cascades the draft AND its lineage rows
    sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(project)
        .execute(&pool)
        .await
        .expect("project delete");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts")
        .fetch_one(&pool)
        .await
        .expect("drafts count");
    assert_eq!(n, 0, "an abandoned draft dies with its project");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM draft_artifact_lineage")
        .fetch_one(&pool)
        .await
        .expect("lineage count");
    assert_eq!(n, 0, "the lineage dies with its draft");
}

/// TEST-18 (provenance leg): the settings singleton + bounds, the
/// zero-blob COALESCE referencing-dedup, the dataset-cascade, and a
/// RETURNING insert.
#[tokio::test]
async fn provenance_settings_and_dedup_hold() {
    let scratch = Scratch::new("item11-provenance");
    let merged = compose_sqlite_chain(scratch.path());
    let (pool, _migrator) = apply_chain(&merged, &scratch.path().join("scratch.sqlite")).await;

    // --- provenance_settings: singleton + the GC knobs + bounds ----------
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_settings")
        .fetch_one(&pool)
        .await
        .expect("settings count");
    assert_eq!(n, 1, "the singleton is seeded exactly once");
    let (interval, digests, tolerance, retention): (i64, i64, f64, i64) = sqlx::query_as(
        "SELECT rootfs_gc_interval_secs, rootfs_cache_max_digests, \
                verify_default_tolerance, export_retention_days FROM provenance_settings",
    )
    .fetch_one(&pool)
    .await
    .expect("settings row");
    assert_eq!(interval, 21600, "the GC sweep default is 6 h");
    assert_eq!(digests, 4, "the cache cap default is 4");
    assert_eq!(tolerance, 0.99, "verify tolerance default");
    assert_eq!(retention, 30, "export retention default");
    let err = sqlx::query("UPDATE provenance_settings SET rootfs_gc_interval_secs = 30")
        .execute(&pool)
        .await
        .expect_err("the 60 s floor must refuse");
    assert!(
        err.to_string().contains("CHECK constraint failed"),
        "the interval floor refuses: {err}"
    );
    // the `id` singleton pin (the boolean PK port)
    let err = sqlx::query("INSERT INTO provenance_settings (id) VALUES (2)")
        .execute(&pool)
        .await
        .expect_err("a second settings row must be refused");
    assert!(
        err.to_string().contains("provenance_settings_id_check"),
        "the singleton pin names the constraint: {err}"
    );

    // --- reference-resource dedup: the COALESCE zero-blob unique ---------
    let owner = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, email) VALUES (?, 'prov-owner', 'p@x.io')")
        .bind(owner)
        .execute(&pool)
        .await
        .expect("owner user");
    let tenant = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name) VALUES (?, 'organization', 'provprobe')")
        .bind(tenant)
        .execute(&pool)
        .await
        .expect("org account");
    let project = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO projects (id, owner_id, name, account_id) VALUES (?, ?, 'prov-proj', ?)",
    )
    .bind(project)
    .bind(owner)
    .bind(tenant)
    .execute(&pool)
    .await
    .expect("project row");
    sqlx::query(
        "INSERT INTO provenance_reference_resources (id, project_id, kind, name, content_hash) \
         VALUES (?, ?, 'paper', 'p1', 'sha256:p1')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(project)
    .execute(&pool)
    .await
    .expect("project-scoped reference");
    // same (kind, hash, project) is a duplicate (COALESCE blob is the key)
    let err = sqlx::query(
        "INSERT INTO provenance_reference_resources (id, project_id, kind, name, content_hash) \
         VALUES (?, ?, 'paper', 'p2', 'sha256:p1')",
    )
    .bind(uuid::Uuid::new_v4())
    .bind(project)
    .execute(&pool)
    .await
    .expect_err("same project + kind + hash must be refused");
    assert!(
        err.to_string().contains("provenance_reference_dedup"),
        "the dedup unique names the index: {err}"
    );
    // same (kind, hash) WITHOUT a project is a DIFFERENT identity (zero blob)
    sqlx::query(
        "INSERT INTO provenance_reference_resources (id, kind, name, content_hash) \
         VALUES (?, 'paper', 'p3', 'sha256:p1')",
    )
    .bind(uuid::Uuid::new_v4())
    .execute(&pool)
    .await
    .expect("the unscoped reference is distinct from the project-scoped one");

    // --- run_repro dataset-cascade --------------------------------------
    let ds = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id) VALUES (?, 'prov-ds', ?, ?)",
    )
    .bind(ds)
    .bind(owner)
    .bind(tenant)
    .execute(&pool)
    .await
    .expect("dataset row");
    let run_id = uuid::Uuid::new_v4();
    let back: (uuid::Uuid, String, String, String) = sqlx::query_as(
        "INSERT INTO provenance_run_repro (run_id, project_id, kind, dataset_id) \
         VALUES (?, ?, 'probe', ?) RETURNING run_id, status, params, inputs_json",
    )
    .bind(run_id)
    .bind(project)
    .bind(ds)
    .fetch_one(&pool)
    .await
    .expect("run repro RETURNING insert");
    assert_eq!(back.0, run_id);
    assert_eq!(back.1, "recorded", "status default");
    assert_eq!(back.2, "{}", "params jsonb -> JSON text");
    assert_eq!(back.3, "[]", "inputs_json jsonb -> JSON text");
    sqlx::query("DELETE FROM datasets WHERE id = ?")
        .bind(ds)
        .execute(&pool)
        .await
        .expect("dataset delete");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_run_repro")
        .fetch_one(&pool)
        .await
        .expect("run repro count");
    assert_eq!(n, 0, "the dataset cascade removes the run-repro record");
}
