//! TEST-15 (ITEM-7) — promote a `role='artifact'` workstore output to a new
//! owner-scoped txresbench-file Dataset, through the full production path (real spawned
//! server + real Postgres + a real content-addressed object store on disk).
//!
//! Asserts: byte-preserving copy (the new dataset's `content_hash` == the source
//! artifact's), `source='promote'` + `source_artifact_id`, a recorded
//! `kind='promote'` provenance run node (dataset-scoped, pinning the source
//! artifact's used-edge), a `role='intermediate'` output → 422 `NOT_PROMOTABLE`, a
//! non-dataset-input datatype → 422, and artifact-read gating (a user without
//! access → 404; unauthenticated → 401).
//!
//! **The role gate was briefly absent and is restored here.** It used to read
//! `artifacts.params.role`; artifact-model ITEM-7 dropped `params`, the gate lost
//! its input, and `promote_rejects_intermediate_role` was DELETED rather than
//! inverted — so a rule that had been enforced silently stopped being, with a green
//! suite. `role` is now a first-class `artifacts` column (migration
//! `…0003_artifact_role.sql`), written at ingest from the manifest's declared role,
//! and this test is a real assertion against it again, not a recorded narrowing.

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::NewArtifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::object_store::{LocalFsStore, ObjectStore};

use super::{create_dataset, create_user, login, setup_admin};
use crate::common::TestServer;

/// A pool against the spawned server's per-test DB (for direct catalog seeding +
/// the run-node assertion the REST surface has no endpoint for).
async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// A store rooted at the SERVER's workstore blob dir, so a blob written here is
/// readable by the spawned server (mirrors `tests/workstore::server_store`).
fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(server.data_dir().join("workstore"))
}

/// Seed a DATASET-scoped artifact backed by a REAL blob in the server's store.
/// Returns `(artifact_id, content_hash)`. `content_hash == object_key` = the
/// blob's `sha256:<hex>` (so a byte-preserving promote yields an identical hash).
async fn seed_dataset_artifact(
    server: &TestServer,
    dataset_id: Uuid,
    bytes: &[u8],
) -> (Uuid, String) {
    seed_dataset_artifact_role(server, dataset_id, bytes, "artifact").await
}

/// A dataset-INPUT-typed artifact at an explicit `role` — for the DEC-8 role gate,
/// where the datatype must stay CONSTANT across the two cases or the 422 is not
/// attributable to the role.
///
/// The datatype is named ONCE, in [`DATASET_INPUT_DATATYPE`], rather than spelled at
/// each call site: `domain_surface`'s noun census is shrink-only over test-tier domain
/// literals, and a new test is not a licence to raise the ceiling.
async fn seed_dataset_artifact_role(
    server: &TestServer,
    dataset_id: Uuid,
    bytes: &[u8],
    role: &str,
) -> (Uuid, String) {
    seed_dataset_artifact_typed(server, dataset_id, bytes, DATASET_INPUT_DATATYPE, role).await
}

/// A datatype the upload pipeline can expand into a full dataset (so the promote
/// passes the dataset-input gate). The one place this suite names one.
const DATASET_INPUT_DATATYPE: &str = "single-cell/anndata";

/// As [`seed_dataset_artifact`] but with an explicit `datatype` + `role` — for
/// exercising the dataset-input gate (a component-typed artifact must be rejected)
/// and the DEC-8 role gate (an `intermediate` output must be rejected).
async fn seed_dataset_artifact_typed(
    server: &TestServer,
    dataset_id: Uuid,
    bytes: &[u8],
    datatype: &str,
    role: &str,
) -> (Uuid, String) {
    let store = server_store(server);
    let key = store.put(bytes).await.expect("put blob");
    let content_hash = key.as_str().to_string();
    let pool = pool_for(server).await;
    let art = CatalogRepository::new(pool)
        .insert_artifact(&NewArtifact {
            project_id: None,
            dataset_id: Some(dataset_id), // owner-processing scope (ITEM-23)
            run_id: Some(Uuid::new_v4()), // a produced (run-linked) artifact
            output_id: "processed".to_string(),
            datatype: datatype.to_string(),
            object_key: Some(content_hash.clone()),
            is_multifile: false,
            content_hash: content_hash.clone(),
            structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: serde_json::json!({}),
            role: role.to_string(),
            stored_bytes: bytes.len() as i64,
            logical_bytes: Some(bytes.len() as i64),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed dataset-scoped artifact");
    (art.id, content_hash)
}

#[tokio::test]
async fn promote_artifact_creates_byte_preserving_dataset_and_records_provenance() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A source dataset the artifact is scoped to (owner = admin, DEC-5 processing).
    let src_ds_id = Uuid::parse_str(&create_dataset(&server, &admin, "src").await).unwrap();

    let bytes = b"cell,gene_a,gene_b\ncell_1,3,7\ncell_2,0,4\n".to_vec();
    let (artifact_id, content_hash) = seed_dataset_artifact(&server, src_ds_id, &bytes).await;

    // Promote it.
    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": artifact_id, "name": "PBMC filtered" }))
        .send()
        .await
        .expect("promote");
    assert_eq!(resp.status().as_u16(), 201, "promote succeeds");
    let v: Value = resp.json().await.unwrap();
    assert_eq!(v["source"], "promote", "new dataset source=promote");
    assert_eq!(
        v["source_artifact_id"],
        artifact_id.to_string(),
        "back-pointer to the source artifact"
    );
    assert_eq!(
        v["content_hash"], content_hash,
        "byte-preserving: content_hash == source artifact hash"
    );
    assert_eq!(v["name"], "PBMC filtered");
    assert_eq!(v["files"].as_array().unwrap().len(), 1, "one linked file");
    let new_ds_id = Uuid::parse_str(v["id"].as_str().unwrap()).unwrap();

    // A kind='promote' provenance run node was recorded — dataset-scoped to the
    // NEW dataset (project_id NULL), pinning the source artifact's content hash.
    let pool = pool_for(&server).await;
    let row = sqlx::query_as::<_, (String, Option<Uuid>, Option<Uuid>, String)>(
        "SELECT kind, project_id, dataset_id, inputs_json
           FROM provenance_run_repro WHERE kind = 'promote' AND dataset_id = $1",
    )
    .bind(new_ds_id)
    .fetch_one(&pool)
    .await
    .expect("a kind='promote' run node was recorded");
    assert_eq!(row.0, "promote");
    assert!(
        row.1.is_none(),
        "a promote node is dataset-scoped (project_id NULL)"
    );
    assert_eq!(row.2, Some(new_ds_id), "scoped to the promoted dataset");
    let edges: Value = serde_json::from_str(&row.3).expect("inputs_json");
    assert_eq!(
        edges[0]["content_hash"], content_hash,
        "the promote used-edge pins the source artifact's content hash"
    );

    // The promote re-ran the ingest→expand pipeline: a dataset-scoped on-ingest
    // convert job was enqueued for the promoted (dataset-input) dataset, exactly
    // like an upload — instead of the old inert single-blob promote.
    // Job tenancy scope lives in the `job_scope` table (a 'dataset' scope row per
    // owner-processing job), not a column on `jobs`.
    let convert_jobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs j JOIN job_scope s ON s.job_id = j.id
          WHERE s.scope_kind = 'dataset' AND s.scope_id = $1 AND j.job_type = 'analysis'",
    )
    .bind(new_ds_id)
    .fetch_one(&pool)
    .await
    .expect("count convert jobs");
    assert_eq!(
        convert_jobs, 1,
        "promote enqueued the on-ingest convert job (expand pipeline)"
    );

    // The promoted dataset shows in the promoter's library.
    let mine: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        mine["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == v["id"]),
        "the promoted dataset appears in the owner's library"
    );
}

/// The DEC-8 role gate, restored. A `role='intermediate'` output is produced for
/// visualization, not for export, so it is not promotable → 422 `NOT_PROMOTABLE`.
///
/// The artifact is otherwise FULLY promotable — a dataset-input datatype, single-file,
/// owned by the caller, and the identical fixture
/// `promote_artifact_creates_byte_preserving_dataset_and_records_provenance` promotes
/// successfully. Only `role` differs, so the 422 is attributable to the role gate and
/// to nothing else; asserting the `error_code` (not just the status) is what keeps it
/// from silently passing on the NEXT gate down if this one is ever removed again.
#[tokio::test]
async fn promote_rejects_intermediate_role() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let src_ds_id = Uuid::parse_str(&create_dataset(&server, &admin, "src").await).unwrap();
    let bytes = b"viz-only bytes".to_vec();
    let (artifact_id, _) =
        seed_dataset_artifact_role(&server, src_ds_id, &bytes, "intermediate").await;

    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": artifact_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        422,
        "a role='intermediate' output is not promotable"
    );
    let v: Value = resp.json().await.unwrap();
    assert_eq!(
        v["error_code"], "NOT_PROMOTABLE",
        "refused BY THE ROLE GATE — a different code means some other gate caught it \
         and the role gate is absent again"
    );

    // POSITIVE CONTROL: the same bytes, same datatype, same owner, same everything —
    // except `role='artifact'` — promote fine. Without this the assertion above would
    // hold just as well against a promote endpoint that refused everything.
    let (promotable_id, _) =
        seed_dataset_artifact_role(&server, src_ds_id, &bytes, "artifact").await;
    let ok = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": promotable_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        ok.status().as_u16(),
        201,
        "the SAME artifact at role='artifact' promotes — only the role differs"
    );
}

#[tokio::test]
async fn promote_rejects_non_dataset_input_datatype() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let src_ds_id = Uuid::parse_str(&create_dataset(&server, &admin, "src").await).unwrap();
    // A single-file COMPONENT: `data/opaque` is a piece INSIDE a dataset, not a dataset
    // INPUT the upload pipeline can expand — so promoting it is 422 NOT_A_DATASET_INPUT
    // (it passes the single-file gate and is caught here). It used to be the retired
    // lossless-store type, removed by artifact-model ITEM-38; any registered non-input
    // type exercises the same branch, and the universal root does it without pinning this
    // test to a contributed domain id.
    let (artifact_id, _) = seed_dataset_artifact_typed(
        &server,
        src_ds_id,
        b"component bytes",
        "data/opaque",
        "artifact",
    )
    .await;

    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": artifact_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        422,
        "a component-typed artifact is not promotable"
    );
    let v: Value = resp.json().await.unwrap();
    assert_eq!(
        v["error_code"], "NOT_A_DATASET_INPUT",
        "gated by the dataset-input rule"
    );
}

#[tokio::test]
async fn promote_is_gated_by_artifact_read() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // Admin owns the source dataset the artifact is scoped to.
    let src_ds_id = Uuid::parse_str(&create_dataset(&server, &admin, "src").await).unwrap();
    let (artifact_id, _) = seed_dataset_artifact(&server, src_ds_id, b"secret bytes").await;

    // A second user with NO access to the source dataset → the artifact is
    // invisible → 404 (no existence oracle).
    create_user(&server, &admin, "mallory", "mallory@txresbench.test").await;
    let mallory = login(&server, "mallory").await;
    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&mallory)
        .json(&json!({ "artifact_id": artifact_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a user without artifact-read cannot promote"
    );

    // Unauthenticated → 401.
    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .json(&json!({ "artifact_id": artifact_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "unauthenticated → 401");
}

/// **ITEM-18 / DEC-12 — the READ half of the conformance gate, at the surface where
/// forgetting it costs the most.**
///
/// Promote is byte-preserving: it re-ingests the artifact's bytes into txresbench-file as a new
/// owner-scoped Dataset. A `datasets` row carries no conformance status, so an artifact
/// the gate condemned, once promoted, is LAUNDERED permanently — the flag stays behind on
/// the artifact while the copy that outlives it (and that every later analysis reads)
/// carries nothing at all. This is the one refusal on this handler that cannot be
/// recovered from after the fact.
///
/// Same artifact id in both legs: it promotes at `ready`, and the byte-identical row
/// refuses once condemned. Only `status` differs, so the 409 is attributable to the
/// conformance gate and not to the role gate, the datatype gate, or the fixture.
#[tokio::test]
async fn promote_refuses_a_condemned_artifact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let src_ds_id = Uuid::parse_str(&create_dataset(&server, &admin, "src").await).unwrap();
    // Subject-matter-free bytes on purpose: `domain_surface`'s noun census is a
    // SHRINK-ONLY ratchet over test-tier domain literals, and a new test is not a licence
    // to raise the ceiling. Nothing here reads the payload — only that it round-trips.
    let bytes = b"col_a,col_b\nrow_1,3\n".to_vec();

    // POSITIVE LEG FIRST: this exact fixture is promotable, so the refusal below is a
    // CHANGE and not the state of an artifact that could never have promoted anyway.
    let (ok_id, _) = seed_dataset_artifact(&server, src_ds_id, &bytes).await;
    let ok = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": ok_id, "name": "promotable" }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 201, "the ready fixture promotes");

    // NEGATIVE LEG: an identical artifact, condemned by the same repository call the gate
    // uses (`conformance::apply_verdict` → `set_status(id, STATUS_FAILED)`).
    let (bad_id, _) = seed_dataset_artifact(&server, src_ds_id, &bytes).await;
    let flipped = CatalogRepository::new(pool_for(&server).await)
        .set_status(
            bad_id,
            txresbench::modules::jobs::conformance::STATUS_FAILED,
        )
        .await
        .expect("set_status");
    assert!(flipped, "the fixture row exists to be condemned");

    let resp = server
        .client
        .post(server.api_url("/datasets/promote"))
        .bearer_auth(&admin)
        .json(&json!({ "artifact_id": bad_id, "name": "should not exist" }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        409,
        "a condemned artifact must not be promoted — 409 (the row exists and is \
         readable), not 404 and not 201"
    );
    let v: Value = resp.json().await.unwrap();
    assert_eq!(
        v["error_code"],
        txresbench::modules::workstore::consume::ERR_NOT_CONFORMING,
        "refused BY THE CONFORMANCE GATE — another code means a different gate caught it \
         and this one is absent"
    );

    // …and no dataset was minted under the attempted name. A 409 that still wrote the
    // row would launder the condemnation exactly as before, with a red status code.
    let list: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&admin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = list["items"]
        .as_array()
        .expect("dataset list page ({ items, total })")
        .iter()
        .filter_map(|d| d["name"].as_str())
        .collect();
    assert!(
        !names.contains(&"should not exist"),
        "the refused promote minted nothing; got {names:?}"
    );
    assert!(
        names.contains(&"promotable"),
        "positive control: the successful promote IS in this list, so the absence above \
         is not an empty listing"
    );
}
