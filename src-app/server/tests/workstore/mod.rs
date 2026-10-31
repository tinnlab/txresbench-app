//! Workstore integration tests (P1 · ITEM-16) — the full production path: a real
//! spawned server + real Postgres + a real content-addressed store on disk.
//!
//! Seeding: P1 has no artifact-CREATE HTTP endpoint (ingest is P3's internal job
//! hook), so tests seed via the lib's own repositories against the server's
//! per-test DB pool, and write blobs under the server's `<data_dir>/workstore`
//! so the SERVER's data-plane routes serve them end-to-end.

use std::collections::HashSet;

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::catalog::ArtifactFilter;
use cytoanalyst::modules::workstore::gc::GcSweeper;
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;
use cytoanalyst::modules::workstore::object_store::{ContentKey, LocalFsStore, ObjectStore};
use cytoanalyst::modules::workstore::partition::StoreClaim;

use crate::common::TestServer;

// The `[acceptance]` spine — one suite per DESIGN INVARIANT (§0.3 "The two
// invariants" + the Concepts table). Each asserts the design's promise rather than
// the implementation's behaviour, so it can fail on "implementation ≠ design":
//   * TEST-1  INV-1  `serve_opaque_test`       — the server never opens a byte for meaning
//                                                 (amended DEC-23: except the gather, in one module).
//   * TEST-2  INV-1  `dependency_guard_test`   — …and cannot, per the dependency graph.
//   * TEST-3  INV-2  `explicit_no_default_test`— absence is an error, never an implied `{}`.
//   * TEST-4  INV-3  `axis_identity_test`      — an axis IS its key artifact; the name is a label.
//   * TEST-5  INV-4  `member_path_test`        — one row, one directory; members are paths.
mod axis_identity_test;
// `status = 'ready'` records that INGEST succeeded, not that the bytes are still in the
// store — the READ-ONLY report that can say so, and the guard that it stays read-only.
mod blob_presence_test;
// The AUTHORIZATION test for the byte plane: `require_artifact_read` is the sole
// gate on `GET /artifacts/{id}[/data[/{*member}]]`, and since ITEM-12 deleted
// `/read` that plane is the only read surface there is. Both tenancy arms (project
// role; dataset owner ∪ user-shares ∪ group-shares) are covered, because replacing
// the gate's body with `Ok(())` used to leave the whole suite green.
mod artifact_read_authz_test;
// TEST-2 (ITEM-20) + TEST-26 (ITEM-22): the ENFORCEMENT guards. Source/graph-only —
// no server, no DB.
mod conformance_gate_test;
// The READ half of the gate `conformance_gate_test` proves the WRITE half of: the
// `failed` status it writes must change what the byte plane serves, what a job may
// consume, and what defines an axis — while leaving the row visible + deletable, which
// is the owner's only remedy (ITEM-18 / DEC-12).
mod conformance_read_half_test;
mod dependency_guard_test;
mod detach_chain_test;
mod detach_refusal_test;
mod explicit_no_default_test;
mod hidden_representation_test;
mod member_path_test;
// TEST-30/31/47 (ITEM-28..31): the GIN index behind INV-2's "indexed catalog match" — that
// the migration APPLIES (the CREATE INDEX CONCURRENTLY / -- no-transaction tripwire, which
// fails at BOOT and which nothing at compile time sees), what on_axis returns across both
// tenancy arms, and that the SQL filter is a strict SUPERSET of what the client offers.
mod membership_index_test;
mod modality_serve_test;
mod open_kinds_serve_test;
mod schema_shape_test;
mod seed_debug_test;
// Admin settings surface (issue #54): GC policy + ingest size caps, GET/PUT + read-at-use.
mod settings_test;
// THE SEAM TEST — a stage-1-PRODUCED alignment read by this stage's resolver. The test that
// did not exist while two successive recipe shapes shipped green, because every other fixture
// on this side spoke this side's own dialect at both ends.
mod alignment_seam_test;
// The reference fixtures regenerate-and-compare, like the parity fixture — they went stale
// silently when stage 1 inverted the emitter's flags and nothing noticed.
mod stage1_fixture_drift_test;
// ITEM-45/ITEM-50 — the backfill, its dry-run (the SAME code path with write=false), and the
// dependent count that can say it cannot answer. Every fixture seeds all three buckets.
mod ownership_backfill_test;
// ITEM-49 — who can see a row carrying BOTH scopes, now that the backfill created seven.
mod dual_scope_visibility_test;
mod gathered_chain_test;
mod gather_scale_test;
mod gathered_gc_test;
mod gathered_fixture_test;
mod virtual_row_shape_test;
// THE ACCEPTANCE tier for the creator: a REAL `embedding-integrate` run through the runner in
// the real sandbox. Rootfs-gated with a recorded self-skip; `just test-sandbox` sets
// CYTO_TEST_NO_SKIP=1, which turns that skip into a hard failure.
mod creator_real_run_test;
mod serve_opaque_test;
mod zarr_store_test;
// virtual-dataset-mask Stage A (ITEM-1 / ITEM-2) — the mask's storage constraints and the
// recipe's nullable-alignment source-count rule, enforced in the database.
mod mask_storage_test;
mod masked_categorical_test;
mod masked_serve_test;
mod masked_sparse_column_test;
mod masked_string_test;
mod recipe_nullability_test;
// virtual-dataset-mask Stage D (ITEM-10 / ITEM-15) — attribution-by-digest, the
// attached-served-direct rule, and the identity-fast-path equivalence proof. `vdm_fixtures`
// holds the shared source/mask/gathered builders these suites drive the resolver with.
mod attached_artifact_direct_test;
mod identity_fast_path_test;
mod mask_axis_attribution_test;
mod filter_vd_test;
// #157 (epic #151) — INV-6's acceptance: what a filter carries for a SPATIALLY-imported
// dataset. Separate from `filter_vd_test` on purpose — that file's P2 header licenses its
// #203 tests to be REWRITTEN when #203 lands, and these must survive it (they pin a design
// invariant, and its 2-D fixture names its member `values`, which is the one name that makes
// the defect silent instead of loud on the real Visium shape).
mod spatial_filter_vd_test;
mod vdm_fixtures;
mod vdm_phase8_citations;
// T2 — ObjectStore S3/GCS backend (epic compute-storage). The storage-meter delta test runs
// on the default profile (local_fs); the cloud contract fixture is `saas`-only (it links the
// real `object_store`-backed `S3Store`) and runs against T1's cloud-sim.
mod storage_meter_test;
#[cfg(feature = "saas")]
mod s3_contract_test;
// #61 — the two-store data-migration ENGINE acceptance suite against a REAL cloud store
// (local-fs → floci S3): copy+verify moves every blob, the source stays intact, a
// forced content-hash mismatch halts, dual-read serves an un-migrated blob, and verify_all
// (the retire gate) refuses a corrupt/incomplete destination. `saas`-only, floci-gated.
#[cfg(feature = "saas")]
mod migration_engine_floci_test;
// #64 — the LIVE hot-cutover suite. `cutover_old_config_test` is the DEC-5 encrypted-old-config
// SECURITY anchor (DB-only, no cloud-sim); `cutover_floci_test` proves the write-during-migration
// no-loss + the cloud restart-resume rebuild against a REAL cloud store. Both `saas`-only.
#[cfg(feature = "saas")]
mod cutover_old_config_test;
#[cfg(feature = "saas")]
mod cutover_floci_test;
// #65 — abandon a verified migration + revert to the OLD store. `migration_abandon_test` is the
// DB + local-fs data-integrity core (no-loss, fail-closed, 409-cleared); `migration_abandon_floci_test`
// proves the same over a REAL second store. Both `saas`-only.
#[cfg(feature = "saas")]
mod migration_abandon_test;
#[cfg(feature = "saas")]
mod migration_abandon_floci_test;

/// #158 — the byte plane, asked the block-aligned spans a browser TIFF reader emits.
mod range_block_alignment_test;
// NOTE (artifact-model ITEM-13): `tiledb_route_test` — the live native-TileDB serve
// lane — was DELETED with the `tiledb_serve` module and its Cargo feature. The
// removal is asserted by `tests/tiledb_serve/` (TEST-19).
//
// NOTE (artifact-model ITEM-12): three suites went with `serve_core.rs` + `GET /read`.
// They were not "tests that stopped passing" — they were the specification of a surface
// the design deletes, so keeping them would have pinned the thing INV-1 forbids:
//   * `read_arrow_test`         — the Selection→Arrow contract (ETag/304/selection grammar).
//   * `all_channel_serve_test`  — "every viz channel decodes off /read", the S5b
//                                 retirement-precondition checklist for the wires /read
//                                 replaced. Its successor is the FE's own suite plus
//                                 `ui/tests/e2e/workstore/zarr-read-path.spec.ts`, because
//                                 the channels are now decoded in the browser.
//   * a third suite              — server-side JSON→Arrow transcode of a columnar
//                                 annotation blob. Its file name is in the deletion
//                                 commit rather than here: spelling it would re-add the
//                                 domain token the INV-5 census just cleared from this
//                                 file, and the guard is right that a comment is not a
//                                 reason to hold vocabulary.
// What they proved that still MATTERS — a CSC column and a dense stat matrix are
// readable end-to-end — is re-asserted over the surviving byte plane by
// `read_csc_column`/`read_dense_f32` below and in `open_kinds_serve_test`. `/read` itself
// answering 404 is TEST-18, in `zarr_store_test`.

// --------------------------- shared helpers ---------------------------

async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/app/setup/admin"))
        .json(&json!({
            "username": "admin", "email": "admin@cyto.test",
            "password": "adminPassw0rd!", "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 201);
    let body: Value = resp.json().await.expect("setup json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token")
        .to_string()
}

/// Create a Users-group member; returns their (id, bearer token).
async fn create_member_token(server: &TestServer, admin: &str, username: &str) -> (Uuid, String) {
    let r = server
        .client
        .post(server.api_url("/users"))
        .bearer_auth(admin)
        .json(&json!({ "username": username, "email": format!("{username}@cyto.test"), "password": "memberPassw0rd!" }))
        .send()
        .await
        .expect("create user");
    assert!(r.status().is_success(), "create member: {}", r.status());
    let created: Value = r.json().await.expect("user json");
    let uid = Uuid::parse_str(created["id"].as_str().expect("user id")).unwrap();
    let login = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "memberPassw0rd!" }))
        .send()
        .await
        .expect("login member");
    let b: Value = login.json().await.expect("login json");
    let token = b["access_token"].as_str().or_else(|| b["token"].as_str()).expect("member token").to_string();
    (uid, token)
}

async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
    let r = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(r.status().as_u16(), 201, "create project");
    let s: Value = r.json().await.expect("project json");
    Uuid::parse_str(s["id"].as_str().expect("project id")).unwrap()
}

async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// A LocalFsStore rooted at the SERVER's workstore blob dir, so blobs written
/// here are what the server's data-plane serves.
fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(server.data_dir().join("workstore"))
}

fn new_artifact(project_id: Uuid, output_id: &str, object_key: &str, multifile: bool) -> NewArtifact {
    NewArtifact {
        project_id: Some(project_id), // ITEM-23: project/dataset scope now nullable
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "single-cell/expression".to_string(),
        object_key: Some(object_key.to_string()),
        is_multifile: multifile,
        content_hash: format!("sha256:{}", "0".repeat(64)),
        structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
        meta: serde_json::json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    }
}

// --------------------------- TEST-6: catalog CRUD ---------------------------

#[tokio::test]
async fn test6_catalog_crud_and_idempotent_natural_key() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "cat crud").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    let a = repo.insert_artifact(&new_artifact(sid, "expression", "sha256:aaa", false)).await.unwrap();
    assert_eq!(a.status, "ready");
    // Re-insert on the SAME natural key (project,run,output) is idempotent (upsert).
    let mut same = new_artifact(sid, "expression", "sha256:bbb", false);
    same.run_id = a.run_id;
    let a2 = repo.insert_artifact(&same).await.unwrap();
    assert_eq!(a2.id, a.id, "same natural key upserts the same row");
    assert_eq!(
        a2.object_key.as_deref(),
        Some("sha256:bbb"),
        "upsert updated the object_key"
    );

    let all = repo.list_by_project(sid, &ArtifactFilter::default(), None).await.unwrap();
    assert_eq!(all.len(), 1, "idempotent: one row, not two");

    repo.set_status(a.id, "failed").await.unwrap();
    assert_eq!(
        repo.get_any_status(a.id).await.unwrap().unwrap().status,
        "failed"
    );

    // A source artifact (run_id NULL) coexists.
    let mut src = new_artifact(sid, "source", "sha256:ccc", false);
    src.run_id = None;
    repo.insert_artifact(&src).await.unwrap();
    assert_eq!(repo.list_by_project(sid, &ArtifactFilter::default(), None).await.unwrap().len(), 2);

    assert!(repo.delete(a.id).await.unwrap());
}

/// A dataset-scoped artifact (ITEM-23): `project_id` NULL, `dataset_id` set — the
/// shape an h5ad import produces. `datatype` is `single-cell/expression` so the
/// workbench launcher can gate `cell.filter` (which `accepts` that type) on it.
fn new_dataset_artifact(dataset_id: Uuid, output_id: &str, object_key: &str) -> NewArtifact {
    NewArtifact {
        project_id: None,
        dataset_id: Some(dataset_id),
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "single-cell/expression".to_string(),
        object_key: Some(object_key.to_string()),
        is_multifile: false,
        content_hash: format!("sha256:{}", "0".repeat(64)),
        structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
        meta: serde_json::json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    }
}

// -------- REGRESSION: attached-dataset artifacts surface in the project catalog --------

/// An IMPORTED dataset's `single-cell/expression` (dataset-scoped, `project_id` NULL)
/// must appear in the project's catalog once the dataset is ATTACHED — otherwise the
/// workbench's `producedTypeIds` stays empty and `cell.filter` never lights up in the
/// launcher. `list_by_project` (project-scoped only) deliberately excludes it; the
/// workbench data-plane (`list_for_project_scope` + `GET /catalog`) must include it.
#[tokio::test]
async fn attached_dataset_artifacts_appear_in_project_catalog() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "attach-catalog").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // Create a dataset and ATTACH it to the project (the M:N junction row).
    let ds: Value = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&token)
        .json(&json!({ "name": "imported.h5ad" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dataset_id = Uuid::parse_str(ds["id"].as_str().unwrap()).unwrap();
    let att = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{dataset_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(att.status().as_u16(), 200, "attach dataset to project");

    // Seed a dataset-scoped `single-cell/expression` artifact (the import output shape).
    let art = repo
        .insert_artifact(&new_dataset_artifact(dataset_id, "expression", "sha256:exp"))
        .await
        .unwrap();
    assert!(art.project_id.is_none(), "import artifact is dataset-scoped");

    // Project-scoped listing does NOT see it (documents the pre-fix behavior).
    let project_only = repo.list_by_project(sid, &ArtifactFilter::default(), None).await.unwrap();
    assert!(
        project_only.is_empty(),
        "list_by_project is project-scoped and must not return the dataset artifact"
    );

    // The workbench scope DOES include the attached dataset's artifact.
    let scoped = repo.list_for_project_scope(sid, &ArtifactFilter::default(), None).await.unwrap();
    assert_eq!(scoped.len(), 1, "attached-dataset artifact is in the workbench scope");
    assert_eq!(scoped[0].datatype, "single-cell/expression");

    // And it surfaces over the real `GET /catalog` (what drives `producedTypeIds`).
    let cat: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let types: HashSet<&str> =
        cat["artifacts"].as_array().unwrap().iter().map(|a| a["datatype"].as_str().unwrap()).collect();
    assert!(
        types.contains("single-cell/expression"),
        "catalog must expose the attached dataset's single-cell/expression → cell.filter lights up; got {types:?}"
    );
}

/// The two PROJECT READS must describe the SAME artifact set.
///
/// ── Why this exists ─────────────────────────────────────────────────────────
///
/// The workbench has two project-wide reads and they answer different questions:
/// `GET /projects/{id}/catalog` is the OVERVIEW (bare `Artifact` rows + the axes),
/// `GET /projects/{id}/artifacts` is the LIST (`ListedArtifact` — the same row PLUS
/// the provenance-derived `source_dataset_id`). Only the second can answer "which
/// dataset did this come from", which is what every axis-scoped input control is
/// scoped by, so the input pickers resolve against the LIST.
///
/// That swap is only safe if the two reads return the same ROWS. They do — both
/// handlers call `list_for_project_scope` and both `retain(|a| !a.hidden)` — but
/// "both call the same function today" is a fact about the current code, not a
/// pinned invariant: either handler could later gain a filter, a pagination default,
/// or a project-scoped-only query, and the failure mode is SILENT AND TOTAL. Every
/// picker in every declarative view would simply stop offering the dataset-derived
/// artifacts, which on a real project is nearly all of them, while the overview kept
/// showing them and the UI kept rendering a control.
///
/// It cannot be pinned client-side. A jsdom tier can hold the row TYPE honest (it can
/// be typed as the generated wire type), but not which ROWS the SQL returns — that is
/// decided in the database, so the assertion belongs where both endpoints actually run.
///
/// The seeded shape is the one that discriminates: a DATASET-SCOPED artifact
/// (`project_id` NULL, `dataset_id` set — the import output shape, ITEM-23) reachable
/// only through the `project_datasets` union, plus a project-scoped one. A read that
/// dropped the union would still return the project-scoped row and look alive.
#[tokio::test]
async fn catalog_and_list_reads_describe_the_same_artifact_set() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "read parity").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // A dataset, ATTACHED, carrying a dataset-scoped artifact (import output shape).
    let ds: Value = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&token)
        .json(&json!({ "name": "read-parity source" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dataset_id = Uuid::parse_str(ds["id"].as_str().unwrap()).unwrap();
    let att = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{dataset_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(att.status().as_u16(), 200, "attach dataset to project");

    let from_dataset = repo
        .insert_artifact(&new_dataset_artifact(dataset_id, "expression", "sha256:parity-ds"))
        .await
        .unwrap();
    assert!(from_dataset.project_id.is_none(), "the discriminating row is dataset-scoped");
    let from_project = repo
        .insert_artifact(&new_artifact(sid, "expression", "sha256:parity-proj", false))
        .await
        .unwrap();

    let ids = |v: &Value| -> HashSet<String> {
        let arr = if v.is_array() { v.as_array() } else { v["artifacts"].as_array() };
        arr.expect("an artifact array")
            .iter()
            .map(|a| a["id"].as_str().expect("artifact id").to_string())
            .collect()
    };
    let get = |path: String| {
        let client = server.client.clone();
        let url = server.api_url(&path);
        let token = token.clone();
        async move { client.get(url).bearer_auth(&token).send().await.unwrap().json::<Value>().await.unwrap() }
    };

    let catalog = get(format!("/projects/{sid}/catalog")).await;
    let list = get(format!("/projects/{sid}/artifacts")).await;
    let (cat_ids, list_ids) = (ids(&catalog), ids(&list));

    assert_eq!(
        cat_ids, list_ids,
        "the catalog overview and the artifact LIST must describe the same set — the input          pickers resolve against the list and everything else reads the overview; a divergence          means a control silently offers a different world than the pane it sits in.
           only in catalog: {:?}
  only in list: {:?}",
        cat_ids.difference(&list_ids).collect::<Vec<_>>(),
        list_ids.difference(&cat_ids).collect::<Vec<_>>()
    );

    // POSITIVE CONTROL. Equality of two EMPTY sets is also equality, and a read that
    // returned nothing at all would satisfy the assertion above while being maximally
    // broken. Name the two rows that must be in there — in particular the dataset-scoped
    // one, which only the `project_datasets` union reaches.
    for (what, id) in [("dataset-scoped", from_dataset.id), ("project-scoped", from_project.id)] {
        assert!(
            list_ids.contains(&id.to_string()),
            "the {what} artifact must be in the LIST read (the one every input picker resolves against)"
        );
        assert!(
            cat_ids.contains(&id.to_string()),
            "the {what} artifact must be in the CATALOG read"
        );
    }

    // The provenance field that is the whole reason the pickers read this endpoint.
    //
    // Scoped to the DATASET-DERIVED row, deliberately. `source_dataset_id` is a lineage
    // walk, and a bare project-scoped seed legitimately resolves to NO source dataset —
    // asserting it over EVERY row is a false invariant (this assertion was written that
    // way first and the project-scoped row failed it, correctly). What the axis-scoped
    // controls actually require is narrower and true: an artifact that came from a
    // dataset must SAY which dataset, because `siblingsOnAxis` scopes candidates by
    // exactly that field and yields nothing when it is absent — a null here is a dead
    // control, not a missing label.
    let listed_ds = list
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"].as_str() == Some(&from_dataset.id.to_string()))
        .expect("the dataset-scoped artifact is in the list read");
    assert_eq!(
        listed_ds["source_dataset_id"].as_str(),
        Some(dataset_id.to_string().as_str()),
        "a dataset-derived artifact must carry its source dataset on the LIST read — every \
         axis-scoped control anchored on it is scoped by this field and offers nothing without it"
    );
    // And the OVERVIEW cannot carry it: its row type is the bare artifact record. That is
    // the asymmetry the pickers' read choice turns on, so it is pinned rather than assumed.
    let cat_ds = catalog["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"].as_str() == Some(&from_dataset.id.to_string()))
        .expect("the dataset-scoped artifact is in the catalog read");
    assert!(
        cat_ds.get("source_dataset_id").is_none(),
        "the catalog OVERVIEW row is the bare artifact record; if it ever gains \
         source_dataset_id, the pickers may read either endpoint and this test should say so"
    );
}

/// The LIST read must say **WHO PRODUCED** each artifact.
///
/// ── Why this exists ─────────────────────────────────────────────────────────
///
/// A metadata column carries no trace of the analysis that wrote it: `datatype`,
/// `structure` and `meta` all describe the COLUMN, and every producer that writes a
/// column of that shape writes the same declaration. The row carries `run_id`, which
/// answers "which execution" and never "which analysis" — so a form asking whether a
/// name is taken **by someone else** had nothing to compare against and had to refuse
/// its own previous output alongside a genuine foreign collision. `generator_id` is
/// that missing fact: a JOIN onto the producing run's provenance, derived on the LIST
/// read exactly like `source_dataset_id` beside it.
///
/// Three arms, because two of them are the ones a consumer must be able to tell apart:
/// a run WITH recorded provenance names its analysis; a run WITHOUT it, and an artifact
/// with no run at all, both answer NULL — "not attributable", which a consumer reads as
/// *not mine* rather than as any particular producer.
#[tokio::test]
async fn list_read_carries_the_producing_analysis() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "producer provenance").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // A run WITH provenance, and an artifact it produced.
    let recorded_run = Uuid::new_v4();
    sqlx::query!(
        r#"INSERT INTO provenance_run_repro (run_id, project_id, kind, generator_id)
             VALUES ($1, $2, 'compute', 'pkg.thing')"#,
        recorded_run,
        sid,
    )
    .execute(&pool)
    .await
    .expect("seed a recorded run");
    let attributed = repo
        .insert_artifact(&NewArtifact {
            run_id: Some(recorded_run),
            ..new_artifact(sid, "attributed", "sha256:producer-a", false)
        })
        .await
        .unwrap();

    // A run with NO provenance row — the fire-and-forget recorder legitimately misses one.
    let unrecorded = repo
        .insert_artifact(&NewArtifact {
            run_id: Some(Uuid::new_v4()),
            ..new_artifact(sid, "unrecorded", "sha256:producer-b", false)
        })
        .await
        .unwrap();

    // No run at all — an import / upload / seeded row.
    let runless = repo
        .insert_artifact(&NewArtifact {
            run_id: None,
            ..new_artifact(sid, "runless", "sha256:producer-c", false)
        })
        .await
        .unwrap();

    let list: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/artifacts")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = list.as_array().expect("an artifact array");
    let find = |id: Uuid| {
        rows.iter()
            .find(|a| a["id"].as_str() == Some(&id.to_string()))
            .unwrap_or_else(|| panic!("artifact {id} is in the list read"))
    };

    assert_eq!(
        find(attributed.id)["generator_id"].as_str(),
        Some("pkg.thing"),
        "an artifact produced by a run with recorded provenance must name the ANALYSIS that \
         produced it — without it no consumer can tell its own previous output from another \
         producer's, and both have to be refused alike"
    );
    // The two NOT-ATTRIBUTABLE arms. They must be null rather than an empty string: `""`
    // is a producer id, and it would match any exclusion set spelled the same way.
    for (what, id) in [
        ("a run with no recorded provenance", unrecorded.id),
        ("an artifact with no producing run", runless.id),
    ] {
        assert!(
            find(id)["generator_id"].is_null(),
            "{what} names no producer, so the field must be NULL — not an empty string, and \
             certainly not somebody else's id"
        );
    }
    // …and the OVERVIEW cannot carry it, exactly as with `source_dataset_id`: its row type
    // is the bare artifact record, so a consumer needing a producer must read the LIST.
    let catalog: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cat_row = catalog["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"].as_str() == Some(&attributed.id.to_string()))
        .expect("the attributed artifact is in the catalog read");
    assert!(
        cat_row.get("generator_id").is_none(),
        "the catalog OVERVIEW row is the bare artifact record; if it ever gains generator_id, \
         a consumer may read either endpoint and this test should say so"
    );
}

// --------------------------- TEST-9: axes ---------------------------

/// artifact-model ITEM-8 / INV-3 — **INVERTED**.
///
/// This slot used to hold `test9_axes_entry_index_and_keys`, which drove
/// `AxesRepository` through `extend_grouped` / `extend_keyed` / `key_index` /
/// `axis_length` / `axis_lengths` and asserted that two axes named `"rows"` and
/// `"genes"` kept independent dense packings in ONE table keyed by
/// `(project_id, axis_name, entry_index)`. It PASSED — and what it certified was
/// precisely what INV-3 forbids: *an axis IS its key artifact; identity is that
/// artifact's `content_hash`, and the axis NAME is a label, never a key.* A test
/// asserting that the name IS the key is a test defending the defect, so it is
/// replaced rather than deleted quietly.
///
/// What replaces it is the removal itself, asserted two ways: the TABLE is gone from
/// the schema, and cardinality is derived from the key artifact's own declaration.
/// (The pure derivation is unit-tested in
/// `workstore::data_api::derive_axes_tests`; this is the schema half.)
#[tokio::test]
async fn test9_axis_entry_table_is_gone_and_axes_derive_from_declarations() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "axes").await;
    let pool = pool_for(&server).await;

    // POSITIVE CONTROL: `artifacts` is still here, so a `to_regclass` of NULL below
    // means "that table is gone", not "this query does not work".
    let artifacts_present: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public.artifacts')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        artifacts_present.is_some(),
        "the catalog table vanished — the absence check below would be vacuous"
    );

    let axis_table: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public.workstore_axis_entry')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        axis_table.is_none(),
        "`workstore_axis_entry` is back. Its PRIMARY KEY and all three of its indexes \
         were keyed on `axis_name`, i.e. the schema asserted that an axis's identity IS \
         its name — the exact inverse of INV-3."
    );

    // And the surviving path: an artifact DECLARES its axis + cardinality in
    // `structure`, and the project catalog reports that, with no axis table involved.
    let repo = CatalogRepository::new(pool.clone());
    // No datatype literal is needed: the derivation reads the DECLARATION
    // (`structure.axis` + `structure.n`), never the datatype.
    let mut declared = new_artifact(sid, "rows_index", "sha256:rowsidx", false);
    declared.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 5 });
    // …and DECLARES that it IS the axis rather than merely naming one. An aligned
    // column declares the same `axis`/`n` pair; `meta.is_axis_index` is the producer
    // saying which of the two this is, and it is the SAME predicate
    // `find_dataset_axis_index` resolves an axis by (one definition, not two).
    declared.meta = json!({ "is_axis_index": true });
    repo.insert_artifact(&declared).await.unwrap();

    let cat: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let axes = cat["axes"].as_array().expect("catalog carries axes");
    assert_eq!(axes.len(), 1, "one declared axis: {axes:?}");
    assert_eq!(axes[0]["name"], "rows");
    assert_eq!(
        axes[0]["length"], 5,
        "cardinality comes from the key artifact's DECLARED `structure.n`, not a COUNT(*)"
    );
    // INV-3: the axis is IDENTIFIED by its key artifact's content hash, and that
    // identity is on the wire — `name` is a label a second axis may share.
    assert!(
        axes[0]["content_hash"].as_str().is_some_and(|h| h.starts_with("sha256:")),
        "the axis carries its key artifact's identity: {axes:?}"
    );
}

// --------------------------- TEST-13/14: ingest ---------------------------

async fn write_manifest(ws: &std::path::Path, manifest: &Value, files: &[(&str, &[u8])]) {
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    tokio::fs::write(outputs.join("manifest.json"), serde_json::to_vec(manifest).unwrap()).await.unwrap();
    // Output files live UNDER `<ws>/outputs/` (the sandbox `/outputs` bind); each
    // `rel` is `/outputs`-relative, matching the manifest `path` fields.
    for (rel, bytes) in files {
        let p = outputs.join(rel);
        tokio::fs::create_dir_all(p.parent().unwrap()).await.unwrap();
        tokio::fs::write(p, bytes).await.unwrap();
    }
}

#[tokio::test]
async fn test13_ingest_manifest_to_catalog_with_merkle() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "ingest").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let ws = server.data_dir().join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "expression", "datatype": "single-cell/expression", "path": "expr.bin", "layout": "chunked-sparse", "role": "primary",
          "structure": { "encoding": "opaque" }, "meta": {} },
        { "id": "qc", "datatype": "report/html", "path": "qc.html", "layout": "opaque", "role": "aux",
          "structure": { "encoding": "opaque", "media_type": "text/html" }, "meta": {} }
    ]});
    write_manifest(&ws, &manifest, &[
        ("expr.bin", b"\x01\x02\x03\x04"),
        ("qc.html", b"<html>qc</html>"),
        ("uncounted.log", b"noise"), // undeclared → NOT promoted
    ]).await;

    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(sid), None, run_id, None, &ws).await.unwrap();
    assert_eq!(rows.len(), 2, "one catalog row per declared output");
    let repo = CatalogRepository::new(pool.clone());
    let listed = repo.list_by_run(sid, run_id).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|a| a.status == "ready"));
    assert!(listed.iter().all(|a| a.content_hash.starts_with("sha256:")), "merkle/blob hash stamped");
    // Undeclared file is NOT a catalog row.
    assert!(!listed.iter().any(|a| a.output_id == "uncounted"));
    // The declared blob is retrievable from the store by its key.
    let expr = listed.iter().find(|a| a.output_id == "expression").unwrap();
    let expr_key = expr
        .object_key
        .as_deref()
        .expect("this fixture artifact stores real bytes");
    let got = store.get(&ContentKey::parse(expr_key)).await.unwrap();
    assert_eq!(got, b"\x01\x02\x03\x04");
}

#[tokio::test]
async fn test14_ingest_is_atomic_on_missing_output() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "ingest atomic").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    let ws = server.data_dir().join(format!("staging-{}", Uuid::new_v4()));
    // Declares a file that does NOT exist → ingest must fail, leaving NO rows. Uses a
    // VALID registered datatype (`report/html`/`opaque`) so P2's ingest typing-validation
    // passes and the failure is unambiguously the MISSING FILE — deterministic whether or
    // not another test in this binary has set the process-wide datatype registry.
    let manifest = json!({ "outputs": [
        { "id": "expression", "datatype": "report/html", "path": "missing.bin", "layout": "opaque", "role": "artifact",
          "structure": { "encoding": "opaque" }, "meta": {} }
    ]});
    write_manifest(&ws, &manifest, &[]).await;
    let run_id = Uuid::new_v4();
    let res = ingest_run_outputs(&pool, &store, Some(sid), None, run_id, None, &ws).await;
    assert!(res.is_err(), "ingest of a missing declared output must fail");
    let repo = CatalogRepository::new(pool);
    assert_eq!(repo.list_by_run(sid, run_id).await.unwrap().len(), 0, "no partial catalog rows");
}

// --------------------------- TEST-15/29: control plane + boot ---------------------------

#[tokio::test]
async fn test15_control_plane_list_and_catalog_over_http() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "control plane").await;
    let pool = pool_for(&server).await;
    // Seed two catalog rows directly in the server's DB. ITEM-8 dropped
    // `workstore_axis_entry`, so there is no separate axis seeding: the FIRST row IS
    // the project's `cells` axis, because it DECLARES that axis and its cardinality in
    // its producer-supplied `structure` (INV-3 — an axis is its key artifact).
    let repo = CatalogRepository::new(pool.clone());
    let mut expr = new_artifact(sid, "expression", "sha256:aa", false);
    expr.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 4 });
    expr.meta = json!({ "is_axis_index": true }); // it IS the axis, not merely aligned to one
    repo.insert_artifact(&expr).await.unwrap();
    repo.insert_artifact(&new_artifact(sid, "embedding", "sha256:bb", false)).await.unwrap();

    // TEST-29: the workstore module registered + store initialized → the route
    // responds 200 (proves init_working_store + route mount at boot).
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/artifacts"))).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200, "control-plane list");
    let items: Value = r.json().await.unwrap();
    assert_eq!(items.as_array().unwrap().len(), 2);

    // Filter by datatype.
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/artifacts?datatype=single-cell/expression"))).bearer_auth(&token).send().await.unwrap();
    let filtered: Value = r.json().await.unwrap();
    assert_eq!(filtered.as_array().unwrap().len(), 2, "both seeded rows share the datatype");

    // Catalog overview carries the project's DECLARED AXES with their cardinalities
    // (the open-axis wire shape that replaced the `(n_cells, n_genes)` scalar pair).
    // Only the first artifact declares an axis, so only `cells` appears — the wire
    // reports the axes the project's KEY ARTIFACTS declare, not a fixed pair of slots,
    // and the second artifact (which declares none) contributes nothing rather than a
    // zero-length entry (INV-2).
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/catalog"))).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let cat: Value = r.json().await.unwrap();
    let axes = cat["axes"].as_array().expect("axes");
    assert_eq!(axes.len(), 1, "one key artifact, one axis: {axes:?}");
    assert_eq!(axes[0]["name"], "rows");
    assert_eq!(axes[0]["length"], 4);
    // INV-3: the entry is keyed by the key artifact's own content hash (a label is not
    // an identity), so it is on the wire alongside the label.
    assert!(
        axes[0]["content_hash"].as_str().is_some_and(|h| !h.is_empty()),
        "the axis identity is served: {axes:?}"
    );
    assert!(cat.get("n_cells").is_none(), "the retired scalar pair is gone from the wire");
    assert!(cat.get("n_genes").is_none(), "the retired scalar pair is gone from the wire");
    assert_eq!(cat["artifacts"].as_array().unwrap().len(), 2);
}

// --------------------------- TEST-29: boot wiring ---------------------------

#[tokio::test]
async fn test29_module_registered_and_store_initialized_at_boot() {
    // Proves `init_working_store` ran + the WorkstoreModule mounted its routes at
    // boot: a fresh project's catalog endpoint responds 200 with an empty axis set (the
    // handler resolved the object store + the axes/catalog repos).
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "boot").await;
    let r = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200, "workstore route live at boot");
    let cat: Value = r.json().await.unwrap();
    assert_eq!(cat["axes"], serde_json::json!([]), "a fresh project has entries on NO axis");
    assert_eq!(cat["artifacts"].as_array().unwrap().len(), 0);
}

// --------------------------- TEST-16: authz ---------------------------

#[tokio::test]
async fn test16_foreign_project_is_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let sid = create_project(&server, &admin, "authz").await;
    let (_outsider_id, outsider) = create_member_token(&server, &admin, "outsider").await;

    // The owner reads the catalog (200).
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/artifacts"))).bearer_auth(&admin).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    // A user with NO access to the project → 404 (invisible, no leak).
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/artifacts"))).bearer_auth(&outsider).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 404, "foreign project is invisible");
    // Unauthenticated → 401.
    let r = server.client.get(server.api_url(&format!("/projects/{sid}/artifacts"))).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 401);
}

// --------------------------- TEST-18: Range/206 serving ---------------------------

#[tokio::test]
async fn test18_range_206_serving_over_http() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "range").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // Seed a single-file blob (32 bytes) + its catalog row.
    let data: Vec<u8> = (0u8..32).collect();
    let key = store.put(&data).await.unwrap();
    let repo = CatalogRepository::new(pool);
    let art = repo.insert_artifact(&new_artifact(sid, "blob", key.as_str(), false)).await.unwrap();

    // Full 200.
    let r = server.client.get(server.api_url(&format!("/artifacts/{}/data", art.id))).bearer_auth(&token).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(r.headers().get("accept-ranges").unwrap(), "bytes");
    assert_eq!(r.bytes().await.unwrap().as_ref(), data.as_slice());

    // Range → 206 with exact bytes + Content-Range (the zarrita/igv pattern).
    let r = server.client.get(server.api_url(&format!("/artifacts/{}/data", art.id))).bearer_auth(&token).header("Range", "bytes=8-11").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 206, "partial content");
    assert_eq!(r.headers().get("content-range").unwrap(), "bytes 8-11/32");
    assert_eq!(r.bytes().await.unwrap().as_ref(), &[8u8, 9, 10, 11]);

    // Unsatisfiable → 416.
    let r = server.client.get(server.api_url(&format!("/artifacts/{}/data", art.id))).bearer_auth(&token).header("Range", "bytes=100-200").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 416);
}

// --------------------- TEST-12: CSC column read, CLIENT-side over byte ranges ---------------------

/// Read ONE column as `(row, value)` pairs out of a HAND-LAID raw little-endian CSC trio:
/// three `Range:` reads against `GET /artifacts/{id}/data/{member}` and a decode on the
/// caller's side. No `/read`, no Selection, no Arrow — the server hands back the bytes it
/// was given.
///
/// WHAT THIS DOES AND DOES NOT CLAIM. The bytes below are laid out by these tests, not by
/// a producer: the real producer (`_lib/cyto_csc.py::write_csc_zarr`) writes a **Zarr v3
/// store** — shuffle + gzip inside a sharding index, declared `{"encoding": "zarr_v3",
/// "kind": "sparse_csc"}` — and the browser decodes it with
/// `artifactReader.ts::readSparseColumn`. Reproducing that container in Rust would be a
/// second decoder implementation in a third language, maintained against a format the
/// server is forbidden to understand.
///
/// It does not need to be reproduced, because of what these tests are about. The subject is
/// the SERVER's range-serving of a multi-file artifact's members, and by INV-1 that is
/// format-blind: the server confines, caps, hashes, stores and serves, and never opens a
/// byte for meaning. Raw bins are therefore a legitimate stand-in — if the server served
/// these correctly it will serve Zarr shards correctly, because it cannot tell the
/// difference. Cross-language parity with the real writer is proved where it belongs, in
/// `ui/src/core/workstore/artifactReader.test.ts`, against fixtures the Python writer
/// produced.
///
/// (An earlier version of this comment claimed these bytes were "exactly what
/// `write_expression_csc` produces" and that the row declared
/// `structure.encoding = "raw_csc_trio"`. Neither is true. `write_expression_csc` delegates
/// to `write_csc_zarr` and has emitted Zarr since ITEM-26/27 — raw bins were its LAST
/// pre-Zarr output and are gone — and nothing in the tree has ever emitted an encoding
/// called `raw_csc_trio`; `new_artifact` declares these rows `opaque`. The fixture is fine;
/// the claim was not.)
///
/// The reads are RANGE-scoped by construction: the whole artifact is never fetched, only
/// `16 + 8·nnz(col)` bytes of it.
async fn read_csc_column(server: &TestServer, token: &str, artifact: Uuid, col: usize) -> Vec<(u32, f32)> {
    let get = |member: &str, from: usize, to_inclusive: usize| {
        let url = server.api_url(&format!("/artifacts/{artifact}/data/{member}"));
        let range = format!("bytes={from}-{to_inclusive}");
        let client = server.client.clone();
        let token = token.to_string();
        async move {
            let r = client.get(url).bearer_auth(token).header("Range", range).send().await.expect("range read");
            assert_eq!(r.status().as_u16(), 206, "a byte range answers 206");
            r.bytes().await.expect("body").to_vec()
        }
    };

    // 1. `indptr[col..=col+1]` — two little-endian i64s, 16 bytes.
    let ptr = get("indptr", col * 8, col * 8 + 15).await;
    let lo = i64::from_le_bytes(ptr[0..8].try_into().unwrap()) as usize;
    let hi = i64::from_le_bytes(ptr[8..16].try_into().unwrap()) as usize;
    if hi <= lo {
        return Vec::new();
    }
    // 2 + 3. `indices[lo..hi]` (u32) and `data[lo..hi]` (f32) — the column's nonzeros.
    let idx = get("indices", lo * 4, hi * 4 - 1).await;
    let val = get("data", lo * 4, hi * 4 - 1).await;
    idx.chunks_exact(4)
        .zip(val.chunks_exact(4))
        .map(|(i, v)| (u32::from_le_bytes(i.try_into().unwrap()), f32::from_le_bytes(v.try_into().unwrap())))
        .collect()
}

/// Read a whole single-file dense `f32` artifact and decode it client-side. The dense twin
/// of [`read_csc_column`]: `GET /artifacts/{id}/data` with no `Range`, little-endian decode
/// here rather than in the server.
async fn read_dense_f32(server: &TestServer, token: &str, artifact: Uuid) -> Vec<f32> {
    let r = server.client.get(server.api_url(&format!("/artifacts/{artifact}/data"))).bearer_auth(token).send().await.expect("dense read");
    assert_eq!(r.status().as_u16(), 200, "whole-artifact read");
    r.bytes().await.expect("body").chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
}

/// The CSC column read: the bespoke `POST /slice` typed-binary route was retired in
/// S5b, and artifact-model ITEM-12 retired its replacement (`GET /read?col=`) too. Both
/// must 404; the column is read over `/data/{member}` byte ranges instead.
#[tokio::test]
async fn test12_sparse_column_slice_over_http() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "slice").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // A 2-gene CSC: indptr [0,2,3]; gene0 rows[0,1] vals[1,2]; gene1 rows[2] val[3].
    let indptr: Vec<u8> = [0i64, 2, 3].iter().flat_map(|v| v.to_le_bytes()).collect();
    let indices: Vec<u8> = [0u32, 1, 2].iter().flat_map(|v| v.to_le_bytes()).collect();
    let data: Vec<u8> = [1.0f32, 2.0, 3.0].iter().flat_map(|v| v.to_le_bytes()).collect();
    let put = store.put_prefix(&[
        ("indptr".into(), indptr),
        ("indices".into(), indices),
        ("data".into(), data),
    ]).await.unwrap();
    let repo = CatalogRepository::new(pool);
    let art = repo.insert_artifact(&new_artifact(sid, "expression", put.object_key.as_str(), true)).await.unwrap();

    // Both retired wires 404.
    let gone = server.client
        .post(server.api_url(&format!("/artifacts/{}/slice", art.id)))
        .bearer_auth(&token)
        .json(&json!({ "kind": "sparse_column", "column": 0 }))
        .send().await.unwrap();
    assert_eq!(gone.status().as_u16(), 404, "the bespoke /slice route is retired");
    let gone = server.client
        .get(server.api_url(&format!("/artifacts/{}/read?col=0", art.id)))
        .bearer_auth(&token)
        .send().await.unwrap();
    assert_eq!(gone.status().as_u16(), 404, "the Selection→Arrow /read route is retired (ITEM-12)");

    // gene column 0 → {row:[0,1], value:[1,2]}, read client-side over byte ranges.
    assert_eq!(read_csc_column(&server, &token, art.id, 0).await, vec![(0, 1.0), (1, 2.0)]);
}

// TEST-19: a three-member CSC artifact is COLUMN-READABLE end-to-end over
// `/data/{member}` byte ranges — proving a matrix is served in the stock build (no feature
// flag) with the SERVER never decoding a byte of it (INV-1).
//
// The members are hand-laid raw bins, NOT the producer's format; see `read_csc_column`'s
// doc comment for why that is the right fixture for a claim about a format-blind server,
// and where the real writer's bytes are decoded instead.
#[tokio::test]
async fn anndata_expression_csc_gene_columns_read_end_to_end() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "expr-read").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);

    // A known 4-row × 3-column matrix, CSC. col0: (r0,5)(r2,7); col1: (r1,3); col2: (r3,9).
    // indptr (i64) = [0,2,3,4]; indices (u32) = [0,2, 1, 3]; data (f32) = [5,7, 3, 9].
    let indptr: Vec<u8> = [0i64, 2, 3, 4].iter().flat_map(|v| v.to_le_bytes()).collect();
    let indices: Vec<u8> = [0u32, 2, 1, 3].iter().flat_map(|v| v.to_le_bytes()).collect();
    let data: Vec<u8> = [5.0f32, 7.0, 3.0, 9.0].iter().flat_map(|v| v.to_le_bytes()).collect();
    let put = store
        .put_prefix(&[("indptr".into(), indptr), ("indices".into(), indices), ("data".into(), data)])
        .await
        .unwrap();
    let repo = CatalogRepository::new(pool);
    let art = repo
        .insert_artifact(&new_artifact(sid, "expression", put.object_key.as_str(), true))
        .await
        .unwrap();

    // Expected (cell, value) pairs per gene column.
    let expected: [&[(u32, f32)]; 3] = [&[(0, 5.0), (2, 7.0)], &[(1, 3.0)], &[(3, 9.0)]];
    for (gene, want) in expected.iter().enumerate() {
        assert_eq!(&read_csc_column(&server, &token, art.id, gene).await, want, "gene {gene} (cell,value) pairs");
    }
}

// --------------------------- TEST-23: project-delete cascade ---------------------------

/// ITEM-8: the cascade is now catalog-ONLY. It used to assert that both the catalog
/// rows AND the project's `workstore_axis_entry` rows disappeared on project delete;
/// with the axis table gone, an axis cascades because its KEY ARTIFACT cascades — so
/// the artifact assertion IS the axis assertion.
#[tokio::test]
async fn test23_project_delete_cascades_catalog_and_axes() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "cascade").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    // The artifact that IS the project's `rows` axis (it DECLARES the axis + its
    // cardinality), so the assertion below covers the axis as well as the catalog.
    let mut axis_key = new_artifact(sid, "rows_index", "sha256:aa", false);
    axis_key.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 3 });
    repo.insert_artifact(&axis_key).await.unwrap();
    assert_eq!(repo.list_by_project(sid, &ArtifactFilter::default(), None).await.unwrap().len(), 1);

    // DELETE the project via HTTP → routes through delete_project_with_extensions →
    // fires the workstore on_project_deleted hook (real server registry).
    let r = server.client.delete(server.api_url(&format!("/projects/{sid}"))).bearer_auth(&token).send().await.unwrap();
    assert!(r.status().is_success(), "project delete: {}", r.status());

    assert_eq!(
        repo.list_by_project(sid, &ArtifactFilter::default(), None).await.unwrap().len(),
        0,
        "catalog rows cascaded — and with the key artifact goes the axis it WAS (INV-3)"
    );
}

// --------------------------- TEST-25: project-scoped sync audience ---------------------------

#[tokio::test]
async fn test25_publish_artifact_fans_to_project_audience() {
    use cytoanalyst::modules::project::scope::project_audience;
    use cytoanalyst::modules::project::ProjectRepository;
    use cytoanalyst::modules::workstore::sync::publish_artifact;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let sid = create_project(&server, &admin, "sync audience").await;
    // Create a collaborator + share the project to their email.
    let (collab_id, collab_token) = create_member_token(&server, &admin, "collab").await;
    let share = server.client.post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "email": "collab@cyto.test", "permission_level": "viewer" }))
        .send().await.unwrap();
    assert!(share.status().is_success(), "share: {}", share.status());
    let share_id = share.json::<Value>().await.unwrap()["id"].as_str().expect("share id").to_string();
    // Collaborator ACCEPTS the share (POST /project-shares/{id}/accept).
    let acc = server.client.post(server.api_url(&format!("/project-shares/{share_id}/accept"))).bearer_auth(&collab_token).send().await.unwrap();
    assert!(acc.status().is_success(), "accept share: {}", acc.status());

    let pool = pool_for(&server).await;
    let repo = ProjectRepository::new(pool.clone());
    // The audience P1 publishes to = owner ∪ accepted recipients (P10 seam).
    let (owner, recipients) = project_audience(&repo, sid)
        .await
        .unwrap()
        .expect("#168: a live project with a current owner has a non-empty audience");
    assert_ne!(owner, Uuid::nil());
    // NON-VACUOUS: the accepted collaborator MUST be in the fan-out audience, so a
    // shared workbench receives the ITEM-13 event.
    assert!(recipients.contains(&collab_id), "accepted collaborator is in the project audience");
    // publish_artifact runs against the real audience without panic (SSE delivery
    // is to the server-process registry; the wire vocabulary is unit-tested).
    publish_artifact(
        &pool,
        sid,
        cytoanalyst::modules::sync::SyncAction::Create,
        Uuid::new_v4(),
        cytoanalyst::modules::sync::Actor::detached(),
    )
    .await;
}

// --------------------- TEST-234: artifact DELETE is edit-gated (not read) ---------------------

/// The `DELETE /projects/{project_id}/artifacts/{id}` endpoint (ITEM-19 entity-lifecycle)
/// is a WRITE and must gate on project EDIT (Owner/Editor), never read. Regression for the
/// blind-audit HIGH finding that a Viewer-shared collaborator could delete artifacts because
/// the handler gated on `require_artifact_read`. Also proves the cross-project guard: an
/// artifact not in the path's project → 404 (an editor of P can't delete Q's artifact).
#[tokio::test]
async fn test234_artifact_delete_requires_edit_not_read() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let sid = create_project(&server, &admin, "delete authz").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // Owner seeds two artifacts.
    let a1 = repo
        .insert_artifact(&new_artifact(sid, "expression", "sha256:d1", false))
        .await
        .unwrap();
    let a2 = repo
        .insert_artifact(&new_artifact(sid, "embedding", "sha256:d2", false))
        .await
        .unwrap();

    // A VIEWER-shared collaborator accepts the share (holds projects::use + Viewer role).
    let (_collab_id, collab) = create_member_token(&server, &admin, "viewer1").await;
    let share = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "email": "viewer1@cyto.test", "permission_level": "viewer" }))
        .send()
        .await
        .unwrap();
    assert!(share.status().is_success(), "share: {}", share.status());
    let share_id = share.json::<Value>().await.unwrap()["id"].as_str().expect("share id").to_string();
    let acc = server
        .client
        .post(server.api_url(&format!("/project-shares/{share_id}/accept")))
        .bearer_auth(&collab)
        .send()
        .await
        .unwrap();
    assert!(acc.status().is_success(), "accept share: {}", acc.status());

    // The viewer CAN read the catalog (200) …
    let r = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/artifacts")))
        .bearer_auth(&collab)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200, "viewer can read");
    // … but DELETE is refused with 403 (read-only), and the artifact survives.
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid}/artifacts/{}", a1.id)))
        .bearer_auth(&collab)
        .send()
        .await
        .unwrap();
    assert_eq!(
        del.status().as_u16(),
        403,
        "a read-only viewer must NOT delete artifacts"
    );
    assert!(
        repo.get_any_status(a1.id).await.unwrap().is_some(),
        "viewer delete was correctly refused"
    );

    // An OUTSIDER with no project access → 404 (no existence oracle).
    let (_outsider_id, outsider) = create_member_token(&server, &admin, "outsider1").await;
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid}/artifacts/{}", a1.id)))
        .bearer_auth(&outsider)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 404, "foreign project is invisible");

    // The OWNER (edit) deletes it → 204, and it's gone.
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid}/artifacts/{}", a1.id)))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 204, "owner (edit) can delete");
    assert!(
        repo.get_any_status(a1.id).await.unwrap().is_none(),
        "artifact removed"
    );

    // Cross-project guard: deleting a2 via a DIFFERENT project's path → 404, a2 survives.
    let sid2 = create_project(&server, &admin, "delete authz 2").await;
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid2}/artifacts/{}", a2.id)))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 404, "artifact not in that project → 404");
    assert!(
        repo.get_any_status(a2.id).await.unwrap().is_some(),
        "cross-project delete refused"
    );
}

// --------------------------- TEST-27: GC shared-blob survival ---------------------------

#[tokio::test]
async fn test27_gc_frees_orphans_but_shared_blobs_survive() {
    use cytoanalyst::modules::project::GcManifest;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid_a = create_project(&server, &token, "gc a").await;
    let sid_b = create_project(&server, &token, "gc b").await;
    let pool = pool_for(&server).await;
    let store = std::sync::Arc::new(server_store(&server));

    // A blob SHARED by two projects (same bytes → same content key → one physical
    // blob, two catalog refs) + an orphan blob referenced by only project A.
    let shared_key = store.put(b"shared expression matrix").await.unwrap();
    let orphan_key = store.put(b"only-in-A orphan").await.unwrap();
    let repo = CatalogRepository::new(pool.clone());
    repo.insert_artifact(&new_artifact(sid_a, "shared", shared_key.as_str(), false)).await.unwrap();
    repo.insert_artifact(&new_artifact(sid_b, "shared", shared_key.as_str(), false)).await.unwrap();
    let orphan_art = repo.insert_artifact(&new_artifact(sid_a, "orphan", orphan_key.as_str(), false)).await.unwrap();

    // Simulate deleting project A's rows: remove the orphan row, then run the
    // post-commit refcount sweep over a manifest that marked BOTH A's blobs.
    repo.delete(orphan_art.id).await.unwrap();
    let mut manifest = GcManifest::for_project(sid_a);
    manifest.mark(shared_key.as_str().to_string(), "catalog");
    manifest.mark(orphan_key.as_str().to_string(), "catalog");

    // This test process is not the server, but it IS the same deployment: adopt
    // the ownership claim the server wrote over the store root it shares with us.
    // `adopt_existing` cannot manufacture ownership — an unclaimed root errors —
    // so this joins the owning catalog rather than bypassing the guard.
    let claim = StoreClaim::adopt_existing(server.data_dir().join("workstore"))
        .expect("the spawned server claimed its blob-store root at boot");
    let sweeper = GcSweeper::new(pool.clone(), store.clone(), claim);
    let report = sweeper.sweep_marked(&manifest).await.unwrap();
    assert_eq!(report.freed, 1, "only the orphan is freed");
    // The shared blob SURVIVES (still referenced by project B) — the dedup guard.
    assert!(store.exists(&shared_key).await.unwrap(), "shared blob survives");
    assert!(!store.exists(&orphan_key).await.unwrap(), "orphan blob is gone");

    // The full standing sweep reaches the same state via live-table re-derivation.
    let keep = sweeper.collect_keep().await.unwrap();
    assert!(keep.contains(shared_key.as_str()));
    assert!(!keep.contains(orphan_key.as_str()));
    let _ = HashSet::<String>::new(); // (keep-set type reference)
}

// ------------- GC: an unenumerable artifact ABANDONS the sweep, and says why -------------

/// The full production path for the sweep's refusal: real catalog rows read by
/// `all_blob_refs`, a real store on disk, the real `GcSweeper::sweep()`.
///
/// A multi-file artifact whose MANIFEST is not in the store cannot have its members
/// named, so the sweep must free nothing — that part is not new and must not change.
/// What this asserts is the OUTCOME of that refusal: the error names the artifact, its
/// `output_id`, its project, and says in the presence report's words that the bytes are
/// not in this store. Before, the whole diagnosis was `Blob not found`, and the standing
/// loop rendered it as `sweep failed; will retry` — a fact about the sweeper on a box
/// where 83 blobs were gone.
///
/// The unit tests in `workstore::gc` drive `sweep_refs` directly and never touch SQL, so
/// this is also what proves `all_blob_refs` actually carries the artifact identity the
/// diagnosis prints: with the id/output_id/project columns dropped from that query, the
/// unit tests stay green and this one fails.
#[tokio::test]
async fn gc_sweep_abandons_and_names_the_artifact_whose_manifest_is_absent() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "gc diagnosis").await;
    let pool = pool_for(&server).await;
    let store = std::sync::Arc::new(server_store(&server));
    let repo = CatalogRepository::new(pool.clone());

    // A genuine orphan: referenced by no row, so a sweep that RAN would free it.
    let orphan = store.put(b"referenced by nobody at all").await.unwrap();
    // A live multi-file artifact whose manifest blob was never written — the incident's
    // shape: the catalog row is `ready`, the bytes are not here.
    let ghost = format!("sha256:{}", "b".repeat(64));
    let broken = repo
        .insert_artifact(&new_artifact(sid, "expression_matrix", &ghost, true))
        .await
        .unwrap();

    let claim = StoreClaim::adopt_existing(server.data_dir().join("workstore"))
        .expect("the spawned server claimed its blob-store root at boot");
    let sweeper = GcSweeper::new(pool.clone(), store.clone(), claim);

    let err = sweeper
        .sweep()
        .await
        .expect_err("a store with an unenumerable live artifact must not be swept");
    let msg = err.to_string();

    assert!(
        msg.contains(&broken.id.to_string()),
        "the diagnosis must name the artifact whose members it could not enumerate: {msg}"
    );
    assert!(
        msg.contains("expression_matrix"),
        "…by the id its producer gave it: {msg}"
    );
    assert!(
        msg.contains(&sid.to_string()),
        "…and the project whose bytes-presence report lists the rest: {msg}"
    );
    assert!(
        msg.contains("not in this store"),
        "…in the presence report's vocabulary, not a second one: {msg}"
    );
    assert!(
        msg.contains("NOTHING was reclaimed"),
        "…stating the consequence, which is the half an operator could not previously \
         infer from `sweep failed`: {msg}"
    );

    // The refusal itself is unchanged: an unattributable store frees nothing.
    assert!(
        store.exists(&orphan).await.unwrap(),
        "a sweep that cannot enumerate one artifact must not free ANY blob"
    );
    // …and it condemned nothing either. The row is untouched and still readable.
    let still = repo
        .get_any_status(broken.id)
        .await
        .unwrap()
        .expect("row survives");
    assert_eq!(
        still.status, "ready",
        "a storage observation is not a verdict on the artifact; the sweep writes no status"
    );

    // CONTROL, on the very same sweeper: with the broken row gone the sweep runs and
    // frees the orphan. Without it, every assertion above would hold just as well for a
    // sweeper that had stopped working entirely.
    repo.delete(broken.id).await.unwrap();
    let report = sweeper.sweep().await.expect("an enumerable catalog sweeps");
    assert!(
        report.scanned > 0,
        "the control must actually walk the store: {report:?}"
    );
}

// --------------------------- TEST-17: axis-index datatype filter is DATA ---------------------------

/// TEST-17 [covers: DEC-12 + artifact-model ITEM-8] — `find_dataset_axis_index`
/// resolves the per-axis KEY ARTIFACT via the caller-resolved metadata-column FAMILY
/// id-set bound as `datatype = ANY($n)` (pure SQL, NO `metadata-column` literal), plus
/// the producer's own two DECLARATIONS: `meta.is_axis_index` and `structure.axis`.
///
/// It used to key on `output_id = '<axis>_index'` — a lookup key SYNTHESIZED from the
/// axis NAME, which INV-3 forbids (*the axis NAME is a label, never a key*). This test
/// now seeds the key artifact under an `output_id` that is NOT `<axis>_index`, and a
/// plain non-key column that IS at `cells_index`, so it fails if the name-derived
/// lookup ever comes back.
///
/// **What this test does NOT establish.** Passing `"rows"` here is the label acting as a
/// SELECTOR, which is legitimate and is all this case is about — the datatype/declaration
/// PREDICATES are the subject. It says nothing about INV-3's identity rule, because every
/// case below has at most one candidate: a lookup that returns the only matching row
/// cannot show whether the resolver keys on identity or merely picks first. The case that
/// does — a label matching TWO distinct key artifacts, where the retired
/// `ORDER BY created_at DESC LIMIT 1` silently answered with the newest — is
/// `axis_identity_test::test4_a_label_that_names_two_axes_is_refused_not_resolved_by_recency`,
/// with the pure decision unit-tested in
/// `workstore::catalog::repository::resolve_axis_key_artifact_tests`.
///
/// The family is DATA: the union of every type carrying the `metadata-column-family`
/// capability + its `descendants_inclusive` (so a contributed subtype resolves for
/// free). A non-family artifact making the same declaration is NOT returned — the
/// datatype predicate is active.
#[tokio::test]
async fn test17_axis_index_datatype_filter_is_capability_derived() {
    use cytoanalyst::modules::datatype::DatatypeRegistry;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "axis-index filter").await;
    let dataset_id =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "axis-ds").await).unwrap();
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool);

    // The DATA-resolved allow-set: the metadata-column family (capability carriers +
    // their subtypes) — exactly what `sandbox/inputs.rs::axis_index_datatype_allow`
    // resolves. No datatype-id literal appears in this test's PRODUCTION path.
    let reg = DatatypeRegistry::build_from_embedded().expect("merged registry builds");
    let mut allow: Vec<String> = reg
        .types_with_capability("metadata-column-family")
        .into_iter()
        .flat_map(|id| reg.descendants_inclusive(&id))
        .collect();
    allow.sort();
    allow.dedup();
    assert!(
        allow.contains(&"metadata-column".to_string()),
        "the family base type is resolved from the capability (DATA), not a literal"
    );

    // Seed the artifact that IS the axis (an import converter's contract output).
    // ITEM-8: it is found by what its producer DECLARED — `meta.is_axis_index` plus
    // `structure.axis` — NOT by an `output_id` synthesized from the axis name. The
    // `output_id` below is deliberately NOT the `<axis>_index` convention, which is
    // the whole point: under INV-3 the name is a label, so an artifact that SAYS it
    // is the axis resolves whatever it happens to be called.
    let mut idx = new_artifact(sid, "an-arbitrarily-named-output", "single:sha256:idx", false);
    idx.dataset_id = Some(dataset_id);
    idx.datatype = "metadata-column".to_string();
    idx.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 4 });
    idx.meta = json!({ "is_axis_index": true, "name": "cells_index" });
    let idx = repo.insert_artifact(&idx).await.unwrap();

    // A NON-family artifact making the SAME declaration — proves the datatype
    // predicate is active (a raw expression matrix is not an axis key artifact).
    let mut wrong = new_artifact(sid, "genes_index", "single:sha256:wrong", false);
    wrong.dataset_id = Some(dataset_id);
    wrong.datatype = "single-cell/expression".to_string();
    wrong.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "genes", "n": 9 });
    wrong.meta = json!({ "is_axis_index": true });
    repo.insert_artifact(&wrong).await.unwrap();

    // A family artifact that declares the right axis but does NOT declare itself a key
    // artifact — the `is_axis_index` predicate is active, not decorative.
    let mut plain_column = new_artifact(sid, "cells_index", "single:sha256:plain", false);
    plain_column.dataset_id = Some(dataset_id);
    // The SAME family datatype as the key artifact — taken from the row already
    // inserted, so this case adds no hardcoded domain id of its own.
    plain_column.datatype = idx.datatype.clone();
    plain_column.structure = json!({ "encoding": "zarr_v3", "kind": "table", "axis": "rows", "n": 4 });
    plain_column.meta = json!({ "name": "pct_flagged" });
    repo.insert_artifact(&plain_column).await.unwrap();

    // The family artifact resolves via the ANY($n) filter + the two declarations.
    let found = repo
        .find_dataset_axis_index(dataset_id, "rows", &allow)
        .await
        .unwrap()
        .expect("the metadata-column axis key artifact resolves via the family allow-set");
    assert_eq!(
        found.id, idx.id,
        "the DECLARED key artifact resolves — even though its `output_id` is not \
         `<axis>_index`, and even though a plain column at exactly that `output_id` \
         also declares the same axis"
    );
    assert_eq!(found.datatype, "metadata-column");

    // The non-family artifact declaring the `genes` axis is NOT returned — its
    // datatype is outside the resolved family allow-set (the predicate discriminates).
    let none = repo.find_dataset_axis_index(dataset_id, "genes", &allow).await.unwrap();
    assert!(none.is_none(), "a non-family datatype declaring an axis index is filtered out");

    // An empty allow-set (registry-absent degrade) matches nothing — never over-broad.
    let empty = repo.find_dataset_axis_index(dataset_id, "rows", &[]).await.unwrap();
    assert!(empty.is_none(), "an empty allow-set resolves nothing (= ANY(empty))");
}
