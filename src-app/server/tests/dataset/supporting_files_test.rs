//! **TEST-7 for #182.** The supporting-file upload paths, deliberately UNCHANGED:
//! both the dedicated endpoint and the combined `supporting` field now stream their
//! parts and take the annotation's content hash from the streamed digest, so the
//! gating, linking, hashing and enqueue behaviour asserted here must be identical.
//! TEST-11 / TEST-14 / TEST-19 [ITEM-9, ITEM-11, ITEM-14, ITEM-17, ITEM-18] —
//! `POST /datasets/{id}/supporting-files` through the full production path (real
//! spawned server + Postgres + ziee-file blob store).
//!
//! Covers: a supporting file links `role='supporting'` and the detail view surfaces
//! role + kind; the 422 carve-out gates (a dataset-input datatype →
//! `PRIMARY_ALREADY_SET`; a `reference`/`index_companion` kind → 422; an unknown
//! axis → 422); the authz gates (unauth 401, a view-only sharee 403, a foreign
//! dataset 404); and ITEM-17 — the add emits `sync:dataset` to the owner and the
//! integration derivation is recorded as a `kind='integrate'` node in
//! `GET /provenance/forward`.
//!
//! No rootfs is needed: the endpoint LINKS the file + ENQUEUES the integrate job +
//! RECORDS provenance synchronously in the handler; the sandboxed alignment itself
//! (the SOMA/axis-index execution) is the rootfs-gated path exercised elsewhere.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::dataset::repository::DatasetRepository;

use super::hardening_common::{admin_user_id, pool_for};
use super::{create_user, login, read_until, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

/// A minimal primary payload for a datatype that DECLARES axes, so the dataset has
/// declared axes a supporting file can bind to. Bytes are opaque here; only the
/// filename extension the sniffer reads matters, and it is spelled once, below.
const PRIMARY_BYTES: &[u8] = b"\x89HDF\r\n\x1a\n fake anndata payload for supporting-files tests";

/// A small barcode-keyed annotation CSV → sniffed/defaulted to `annotation-table`
/// (a supporting, NON-dataset-input datatype with an `on-integrate` converter).
const ANNOTATION_CSV: &[u8] = b"barcode,cluster\nAAACCCAAGAAACACT,0\nAAACCCACAGAAACAC,1\n";

/// Upload one primary file via the grouping endpoint → the created dataset id. The
/// dataset carries the sniffed datatype + a primary `content_hash`.
async fn upload_typed_dataset(server: &TestServer, token: &str, name: &str) -> String {
    let form = Form::new().part(
        "file",
        Part::bytes(PRIMARY_BYTES.to_vec()).file_name(format!("{name}.h5ad")),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload primary");
    assert_eq!(resp.status().as_u16(), 200, "primary upload succeeds");
    let body: Value = resp.json().await.expect("upload json");
    let ds = &body["datasets"][0];
    assert_eq!(
        ds["datatype"],
        json!("single-cell/anndata"),
        "the sniffer typed it from the extension"
    );
    ds["id"].as_str().expect("dataset id").to_string()
}

/// `POST /datasets/{id}/supporting-files` (multipart) → the raw response.
async fn post_supporting(
    server: &TestServer,
    token: Option<&str>,
    dataset_id: &str,
    filename: &str,
    bytes: &[u8],
    axis: &str,
    kind: Option<&str>,
    datatype: Option<&str>,
) -> reqwest::Response {
    let mut form = Form::new()
        .part(
            "file",
            Part::bytes(bytes.to_vec()).file_name(filename.to_string()),
        )
        .text("axis", axis.to_string());
    if let Some(k) = kind {
        form = form.text("kind", k.to_string());
    }
    if let Some(d) = datatype {
        form = form.text("datatype", d.to_string());
    }
    let mut req = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/supporting-files")))
        .multipart(form);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("post supporting-file")
}

// ---------------------------------------------------------------- TEST-11

// A supporting file links `role='supporting'`; the detail view surfaces the
// primary `role='primary'` and the supporting `role='supporting'`, `kind`.
#[tokio::test]
async fn add_supporting_links_role_and_detail_surfaces_kind() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(
        resp.status().as_u16(),
        200,
        "adding a supporting file succeeds"
    );
    let body: Value = resp.json().await.expect("add json");
    assert_eq!(
        body["detected_datatype"],
        json!("annotation-table"),
        "the annotation CSV resolved to the supporting annotation-table datatype"
    );

    // GET /datasets/{id} shows both files with their roles + kinds.
    let detail: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get dataset")
        .json()
        .await
        .expect("detail json");
    let files = detail["files"].as_array().expect("files array");
    let primary = files
        .iter()
        .find(|f| f["role"] == "primary")
        .expect("a primary file");
    assert_eq!(
        primary["kind"],
        Value::Null,
        "the primary file has no supporting kind"
    );
    let supporting = files
        .iter()
        .find(|f| f["role"] == "supporting")
        .expect("a supporting file");
    assert_eq!(
        supporting["kind"],
        json!("annotation_table"),
        "the supporting file's kind is surfaced"
    );
    // The per-file `integration_status` is now DERIVED from the enqueued integrate job
    // (the single source of truth) rather than a hand-set column — so it is a live,
    // non-null value in the derived vocabulary (was null before the wiring). The exact
    // job→status mapping is asserted deterministically in
    // `integration_status_derives_from_the_integrate_job` (which controls the job state).
    let status = supporting["integration_status"]
        .as_str()
        .expect("a derived integration_status");
    assert!(
        matches!(status, "pending" | "running" | "integrated" | "failed"),
        "the supporting file's integration_status derives from its child job (got {status:?})"
    );
}

// ---------------------------------------------------------------- TEST-14 (422/401/403/404)

// A dataset-INPUT (primary) datatype is rejected — the dataset already has a
// primary (`PRIMARY_ALREADY_SET`), even with an otherwise-valid axis.
#[tokio::test]
async fn add_supporting_rejects_a_second_primary_type_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "second.h5ad",
        PRIMARY_BYTES,
        "cells",
        None,
        Some("single-cell/anndata"),
    )
    .await;
    assert_eq!(
        resp.status().as_u16(),
        422,
        "a second primary-typed file is rejected"
    );
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(
        body["error_code"],
        json!("PRIMARY_ALREADY_SET"),
        "carries the PRIMARY_ALREADY_SET code"
    );
}

// ITEM-18 carve-out ENFORCED (not just documented): a `reference` or
// `index_companion` kind is not a per-dataset supporting file → 422.
#[tokio::test]
async fn add_supporting_rejects_carved_out_kinds_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    for kind in ["reference", "index_companion"] {
        let resp = post_supporting(
            &server,
            Some(&admin),
            &ds,
            "ref.fa",
            b"ACGT\n",
            "cells",
            Some(kind),
            None,
        )
        .await;
        assert_eq!(
            resp.status().as_u16(),
            422,
            "carved-out kind '{kind}' is rejected per-dataset"
        );
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        assert_eq!(
            body["error_code"],
            json!("UNSUPPORTED_SUPPORTING_KIND"),
            "carries the UNSUPPORTED_SUPPORTING_KIND code for kind '{kind}'"
        );
    }
}

// An axis the dataset does not DECLARE → 422 `UNKNOWN_AXIS`.
#[tokio::test]
async fn add_supporting_rejects_unknown_axis_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "not_a_declared_axis",
        None,
        None,
    )
    .await;
    assert_eq!(
        resp.status().as_u16(),
        422,
        "an undeclared axis is rejected"
    );
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(
        body["error_code"],
        json!("UNKNOWN_AXIS"),
        "carries the UNKNOWN_AXIS code"
    );
}

// Unauthenticated → 401 (rejected at the auth layer, before the handler).
#[tokio::test]
async fn add_supporting_unauthenticated_401() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let resp = post_supporting(
        &server,
        None,
        &Uuid::new_v4().to_string(),
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(resp.status().as_u16(), 401, "no token → 401");
}

// A view-only sharee cannot edit → 403; a foreign (non-visible) dataset → 404.
#[tokio::test]
async fn add_supporting_view_sharee_403_and_foreign_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    let bob_id = create_user(&server, &admin, "bob_support", "bob_support@cyto.test").await;
    let bob = login(&server, "bob_support").await;

    // FOREIGN (not shared) → 404 (existence not leaked).
    let foreign = post_supporting(
        &server,
        Some(&bob),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(
        foreign.status().as_u16(),
        404,
        "a user who can't see the dataset → 404"
    );

    // Share VIEW → visible but not editable → 403.
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "principal_type": "user", "principal_id": bob_id, "role": "view" }))
        .send()
        .await
        .expect("share view");
    assert!(
        matches!(share.status().as_u16(), 200 | 201),
        "share view → 2xx"
    );

    let denied = post_supporting(
        &server,
        Some(&bob),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(
        denied.status().as_u16(),
        403,
        "a view-only sharee cannot add supporting files"
    );
}

// ---------------------------------------------------------------- TEST-19 (ITEM-17)


/// The first axis the DATASET's own datatype declares, read from the live registry.
///
/// Spelled out rather than typed in: this file's ledger of domain vocabulary may only
/// SHRINK (`scripts/lint-no-domain-in-builtin.mjs`), and a test that hardcodes an axis
/// name is asserting domain knowledge it can simply ask for. `GET /datatypes` is the
/// same registry the add-supporting-file form reads to populate its axis picker.
async fn first_declared_axis(server: &TestServer, token: &str, dataset_id: &str) -> String {
    let ds: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{dataset_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get dataset")
        .json()
        .await
        .expect("dataset json");
    let datatype = ds["dataset"]["datatype"]
        .as_str()
        .or_else(|| ds["datatype"].as_str())
        .expect("the uploaded dataset is typed");
    let types: Value = server
        .client
        .get(server.api_url("/datatypes"))
        .bearer_auth(token)
        .send()
        .await
        .expect("list datatypes")
        .json()
        .await
        .expect("datatypes json");
    let list = types["datatypes"].as_array().or_else(|| types.as_array()).expect("datatype list");
    let t = list
        .iter()
        .find(|t| t["id"].as_str() == Some(datatype))
        .expect("the dataset's datatype is in the registry");
    t["axes"][0]["name"]
        .as_str()
        .expect("the datatype declares at least one axis")
        .to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// The SAME emit, performed by an `edit`-role SHAREE instead of the owner.
//
// The test above is the one that let the bug ship: the owner acts, so a frame
// addressed to `auth.user.id` and a frame addressed to the dataset's owner are the
// same frame, and the assertion cannot tell them apart. `add_supporting_file` passed
// the ACTOR into the fan-out's `owner_id`, and since `sharee_user_ids` excludes the
// owner, an edit-sharee's add reached NOBODY on the owner's side. One user can never
// see that; the missing class is a second user.
#[tokio::test]
async fn an_edit_sharees_add_emits_sync_to_the_dataset_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "owned").await;

    let editor_id = create_user(&server, &admin, "edit_sharee", "edit_sharee@cyto.test").await;
    let editor = login(&server, "edit_sharee").await;
    let share = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/shares")))
        .bearer_auth(&admin)
        .json(&json!({ "principal_type": "user", "principal_id": editor_id, "role": "edit" }))
        .send()
        .await
        .expect("share edit");
    assert!(matches!(share.status().as_u16(), 200 | 201), "share edit → 2xx");

    // The OWNER's stream, opened before the mutation.
    let mut owner_probe = SyncProbe::open(&server, &admin).await;

    // The SHAREE performs the add, binding to whichever axis the datatype declares.
    let axis = first_declared_axis(&server, &admin, &ds).await;
    let add = post_supporting(
        &server,
        Some(&editor),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        &axis,
        None,
        None,
    )
    .await;
    assert_eq!(add.status().as_u16(), 200, "an edit-sharee may add");

    // THE ASSERTION: the OWNER is told, and the frame names their dataset.
    let f = owner_probe
        .expect_event("dataset", "update", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, ds, "the frame names the dataset that changed");
}

// Adding a supporting file emits an owner-scoped `sync:dataset` frame AND records
// the integration derivation as a `kind='integrate'` node in the forward graph.
#[tokio::test]
async fn add_supporting_emits_sync_and_records_integrate_provenance() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;

    // Open the owner's SSE stream + drain the handshake BEFORE the mutation.
    let mut stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&admin)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("subscribe");
    assert_eq!(stream.status().as_u16(), 200, "sync stream opens");
    assert!(
        read_until(&mut stream, "connected", Duration::from_secs(5)).await,
        "sync handshake received"
    );

    // Add the supporting file from a SEPARATE client (so the stream keeps reading).
    let client2 = reqwest::Client::new();
    let form = Form::new()
        .part(
            "file",
            Part::bytes(ANNOTATION_CSV.to_vec()).file_name("clusters.csv"),
        )
        .text("axis", "cells");
    let add = client2
        .post(server.api_url(&format!("/datasets/{ds}/supporting-files")))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("add supporting");
    assert_eq!(add.status().as_u16(), 200, "supporting add succeeds");

    // The owner's stream receives the `dataset` sync frame (Update on the add).
    assert!(
        read_until(
            &mut stream,
            "\"entity\":\"dataset\"",
            Duration::from_secs(5)
        )
        .await,
        "the add emits an owner-scoped sync:dataset frame"
    );

    // The integration derivation is a `kind='integrate'` run in the forward graph
    // from the dataset (its primary content_hash is the used-edge).
    let forward: Value = server
        .client
        .get(server.api_url(&format!("/provenance/forward?dataset_id={ds}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("forward")
        .json()
        .await
        .expect("forward json");
    let runs = forward["runs"].as_array().expect("runs array");
    assert!(
        runs.iter().any(|r| r["kind"] == "integrate"),
        "the forward graph carries a kind='integrate' run node (got: {runs:?})"
    );
}

// ---------------------------------------------------------------- DERIVED STATUS

/// Insert a controlled `analysis` job in a chosen status (so the background
/// scheduler never races a terminal one) → its id.
async fn insert_job(pool: &SqlitePool, owner: Uuid, status: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, params, priority_class, resource_class)
         VALUES ($1, $2, 'analysis', 'derive-test', $3, '{}', 'normal', 'cpu-sandbox')",
    )
    .bind(id)
    .bind(owner)
    .bind(status)
    .execute(pool)
    .await
    .expect("insert controlled job");
    id
}

/// The supporting file's `integration_status` is DERIVED from its integrate job (the
/// single source of truth) on EVERY refetch: queued/blocked→pending, running→running,
/// completed→integrated, failed/stopped→failed. Cascade-failure is the SAME 'failed'
/// job status (a cascade-failed job's row IS failed) → derives 'failed' with NO
/// completion hook needed for status — the core of the fix.
#[tokio::test]
async fn integration_status_derives_from_the_integrate_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();

    // Add a supporting file → creates the real file + link + a real integrate job.
    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(resp.status().as_u16(), 200, "supporting add succeeds");
    let body: Value = resp.json().await.expect("add json");
    let file_id = Uuid::parse_str(body["file_id"].as_str().expect("file id")).unwrap();

    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // NOTE: only NON-claimable statuses are driven directly — a `queued` job would be
    // claimed + run by the background scheduler, racing the assertion. `blocked` (also
    // → 'pending' per the `IN ('blocked','queued')` branch) is the deterministic proxy
    // for the pending mapping; the others are terminal/running and never auto-claimed.
    for (job_status, derived) in [
        ("blocked", "pending"),
        ("running", "running"),
        ("completed", "integrated"),
        ("failed", "failed"),
        ("stopped", "failed"),
    ] {
        let job_id = insert_job(&pool, owner, job_status).await;
        // Repoint the supporting link at this controlled job.
        sqlx::query(
            "UPDATE dataset_files SET integration_job_id = $1 WHERE dataset_id = $2 AND file_id = $3",
        )
        .bind(job_id)
        .bind(ds_uuid)
        .bind(file_id)
        .execute(&pool)
        .await
        .expect("repoint integrate job");

        let detail: Value = server
            .client
            .get(server.api_url(&format!("/datasets/{ds}")))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("get dataset")
            .json()
            .await
            .expect("detail json");
        let support = detail["files"]
            .as_array()
            .expect("files array")
            .iter()
            .find(|f| f["role"] == "supporting")
            .expect("a supporting file");
        assert_eq!(
            support["integration_status"],
            json!(derived),
            "integrate job status {job_status:?} derives integration_status {derived:?}"
        );
    }
}

/// `set_integration_summary` round-trips through `list_files` — the coverage summary
/// the integration-completion hook writes is surfaced on the supporting file.
#[tokio::test]
async fn integration_summary_round_trips_through_list_files() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();

    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "clusters.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(resp.status().as_u16(), 200, "supporting add succeeds");
    let body: Value = resp.json().await.expect("add json");
    let file_id = Uuid::parse_str(body["file_id"].as_str().expect("file id")).unwrap();

    let pool = pool_for(&server).await;
    let coverage = json!({ "matched": 2, "total": 3, "missing": 1 });
    DatasetRepository::new(pool.clone())
        .set_integration_summary(ds_uuid, file_id, Some(coverage.clone()))
        .await
        .expect("write integration summary");

    let detail: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{ds}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get dataset")
        .json()
        .await
        .expect("detail json");
    let support = detail["files"]
        .as_array()
        .expect("files array")
        .iter()
        .find(|f| f["role"] == "supporting")
        .expect("a supporting file");
    assert_eq!(
        support["integration_summary"], coverage,
        "the coverage summary round-trips through list_files"
    );
}

// ---------------------------------------------------------------- SUPPORTING_LIMIT

/// At the per-dataset supporting cap, a further add → 422 `SUPPORTING_LIMIT`. Seed the
/// cap cheaply (real `files` + `dataset_files` rows) rather than 50 uploads.
#[tokio::test]
async fn add_supporting_at_cap_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_typed_dataset(&server, &admin, "pbmc").await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();

    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // Seed 50 supporting files (the DEC-12 cap) directly: a batch of `files` rows +
    // their `dataset_files` supporting links.
    sqlx::query(
        "WITH new_files AS (
             INSERT INTO files (id, user_id, filename, file_size, current_version_id, created_by)
             SELECT randomblob(16), $1, 'seed-' || g || '.csv', 10, randomblob(16), 'user'
             FROM generate_series(1, 50) g
             RETURNING id
         )
         INSERT INTO dataset_files (dataset_id, file_id, ordinal, role, kind)
         SELECT $2, id, 100 + (row_number() OVER ()), 'supporting', 'annotation_table'
         FROM new_files",
    )
    .bind(owner)
    .bind(ds_uuid)
    .execute(&pool)
    .await
    .expect("seed supporting files to the cap");

    // The 51st supporting add is rejected at the cap.
    let resp = post_supporting(
        &server,
        Some(&admin),
        &ds,
        "one-too-many.csv",
        ANNOTATION_CSV,
        "cells",
        None,
        None,
    )
    .await;
    assert_eq!(
        resp.status().as_u16(),
        422,
        "at the cap, a further supporting add is rejected"
    );
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(
        body["error_code"],
        json!("SUPPORTING_LIMIT"),
        "carries the SUPPORTING_LIMIT code"
    );
}

// ---------------------------------------------------------------- COMBINED-UPLOAD PARITY

/// The combined-upload supporting loop now enforces the SAME gates as the dedicated
/// endpoint: an unknown axis in a `/datasets/upload` supporting spec → 422
/// `UNKNOWN_AXIS` (previously it trusted the body unchecked — a confirmed gap).
#[tokio::test]
async fn combined_upload_supporting_validates_axis_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let form = Form::new()
        .part(
            "file",
            Part::bytes(PRIMARY_BYTES.to_vec()).file_name("pbmc.h5ad"),
        )
        .part(
            "file",
            Part::bytes(ANNOTATION_CSV.to_vec()).file_name("clusters.csv"),
        )
        .text(
            "supporting",
            json!([{ "index": 1, "axis": "not_a_declared_axis" }]).to_string(),
        );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("combined upload");
    assert_eq!(
        resp.status().as_u16(),
        422,
        "combined upload now rejects an undeclared supporting axis"
    );
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    assert_eq!(
        body["error_code"],
        json!("UNKNOWN_AXIS"),
        "carries the UNKNOWN_AXIS code"
    );
}
