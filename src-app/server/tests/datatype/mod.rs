//! P2 datatype-system integration tests (TEST-19..26). Real `TestServer` + per-test
//! DB. HTTP-path tests hit the spawned server (which boots the module graph → the
//! registry is built there); the direct `ingest_run_outputs` test builds the
//! registry in THIS (test-binary) process so the wired validation actually fires.

#![allow(clippy::bool_assert_comparison)]

// The sniffer's cross-side agreement checks (no DB, no spawned server) — see that
// file's header for the divergence they exist to prevent.
mod cross_side_test;

use std::sync::Arc;

use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use cytoanalyst::modules::datatype::registry::{set_global_registry, DatatypeRegistry};
use cytoanalyst::modules::datatype::types::TypeSelector;
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;
use cytoanalyst::modules::workstore::object_store::LocalFsStore;

use crate::common::TestServer;

// The seeded Users group id (holds `projects::use`); a restricted user is stripped
// from it (mirrors the e2e `_helpers.createRestrictedUser`).
const USERS_GROUP_ID: &str = "79668b78-16ff-4d3f-80e6-afdbb3236dc9";

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
    tokenof(&body)
}

fn tokenof(body: &Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token")
        .to_string()
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

/// Create a Users-group member; returns their bearer token.
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
    let token = login(server, username, "memberPassw0rd!").await;
    (uid, token)
}

async fn login(server: &TestServer, username: &str, password: &str) -> String {
    let r = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .expect("login");
    let b: Value = r.json().await.expect("login json");
    tokenof(&b)
}

/// Strip a user from the Users group so they lack `projects::use` (the deny case).
async fn strip_users_group(server: &TestServer, admin: &str, user_id: Uuid) {
    let r = server
        .client
        .delete(server.api_url(&format!("/groups/{user_id}/{USERS_GROUP_ID}/remove")))
        .bearer_auth(admin)
        .send()
        .await
        .expect("remove from group");
    assert!(r.status().is_success(), "strip group: {}", r.status());
}

async fn pool_for(server: &TestServer) -> PgPool {
    PgPoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(server.data_dir().join("workstore"))
}

fn new_artifact(project_id: Uuid, output_id: &str, datatype: &str) -> NewArtifact {
    NewArtifact {
        project_id: Some(project_id), // ITEM-23: project/dataset scope now nullable
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: datatype.to_string(),
        object_key: Some(format!("sha256:{}", "0".repeat(64))),
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

// --------------------------- TEST-19: /api/datatypes ---------------------------

#[tokio::test]
async fn test19_datatypes_introspection_returns_seed_lattice() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let r = server
        .client
        .get(server.api_url("/datatypes"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /datatypes");
    assert_eq!(r.status().as_u16(), 200);
    let types: Value = r.json().await.expect("json");
    let arr = types.as_array().expect("array");
    let ids: Vec<&str> = arr.iter().filter_map(|d| d["id"].as_str()).collect();
    assert!(ids.contains(&"data"));
    assert!(ids.contains(&"matrix"));
    assert!(ids.contains(&"single-cell/expression"));
    assert!(ids.contains(&"report/html"));
    // The lattice edge + capabilities are dumped (the FE mirror reads these).
    let expr = arr
        .iter()
        .find(|d| d["id"] == "single-cell/expression")
        .unwrap();
    assert_eq!(expr["extends"], "matrix");
    assert!(expr["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c == "has-obs"));
}

// --------- INV-5: a served axis carries IDENTITY ONLY --------------------------------------

// This replaces `test19b_datatypes_expose_axes_annotations_from_manifest`, which asserted the
// OPPOSITE contract — that a manifest's per-axis column forecast (`axes[].annotations`, with
// `pct_mito`'s declared type + capability) survived the manifest → `/api/datatypes` round-trip.
// The forecast is deleted, so the test certifying it is deleted with it. This holds the
// removal at the SERVED boundary: whatever a manifest declares, the API hands the client an
// axis of `{name, key_label}`, and WHICH columns exist is read from the artifacts that landed.
//
// KEY ORDER IS NOT PART OF THE CONTRACT — sort BOTH sides. `serde_json::Map` is a `BTreeMap`
// (`preserve_order` is enabled nowhere in this workspace — `serde_json`'s entry in
// `Cargo.lock` has no `indexmap` dependency), so a served object's keys come out ALPHABETICAL,
// never in declaration order. Asserting the DECLARATION order made this test UNSATISFIABLE:
// it failed `left: ["key_label","name"] right: ["name","key_label"]` on the first datatype
// carrying an axis. Since it is the REPLACEMENT for the deleted
// `test19b_datatypes_expose_axes_annotations_from_manifest`, INV-5's SERVED boundary had no
// working guard at all while it was red. The sorted comparison pins the property that is
// actually claimed — the key SET — and survives the map implementation changing under it.
// (Same defect, same fix, as `datatype/mod.rs::axis_identity_carries_no_column_forecast`.)
#[tokio::test]
async fn test19b_served_axes_carry_identity_only() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let r = server
        .client
        .get(server.api_url("/datatypes"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /datatypes");
    assert_eq!(r.status().as_u16(), 200);
    let types: Value = r.json().await.expect("json");

    let mut checked = 0usize;
    let mut with_axes: Vec<&str> = Vec::new();
    for dt in types.as_array().expect("datatypes array") {
        let axes = dt["axes"].as_array().cloned().unwrap_or_default();
        if !axes.is_empty() {
            with_axes.push(dt["id"].as_str().unwrap_or("<unnamed>"));
        }
        for axis in &axes {
            let obj = axis.as_object().expect("axis object");
            let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
            keys.sort_unstable();
            assert_eq!(
                keys,
                vec!["key_label", "name"],
                "datatype `{}` served an axis with a non-identity field — a column forecast \
                 re-entering through the served contract (INV-5)",
                dt["id"],
            );
            checked += 1;
        }
    }
    // NON-VACUITY. An empty `axes` array on every datatype satisfies the loop above without
    // executing it once, so the guard must FAIL rather than pass trivially — and it must fail
    // loudly enough to be read as "the registry stopped serving axes", not as a flake. Two
    // numbers are pinned, not one: at least one axis was inspected, AND a BROAD share of the
    // lattice still declares axes. `checked > 0` alone is satisfied by a registry that has
    // collapsed to a single stray axis-carrying type, which is exactly the state this guard
    // needs to catch. The floor is deliberately well under the ~15 that carry axes today, so
    // it survives ordinary lattice edits and only fires on a collapse. Stated as a COUNT
    // rather than a list of ids: this file is scanned for domain vocabulary, and a count
    // pins the property without spelling the lattice out a second time.
    assert!(
        checked > 0,
        "no datatype served ANY axis — the per-axis assertion above was vacuous"
    );
    assert!(
        with_axes.len() >= 10,
        "only {} datatype(s) served any axis ({with_axes:?}) — far below the lattice's usual \
         count, so this test no longer covers the types INV-5 is about",
        with_axes.len()
    );
}

// --------------------------- TEST-20: subtype-filtered artifact query ---------------------------

#[tokio::test]
async fn test20_subtypes_of_filter_selects_matrix_family() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "subtype filter").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool);
    // Seed one of each: a matrix-family (expression), a tabular (clustering), an opaque.
    repo.insert_artifact(&new_artifact(sid, "expr", "single-cell/expression"))
        .await
        .unwrap();
    repo.insert_artifact(&new_artifact(sid, "clust", "clustering"))
        .await
        .unwrap();
    repo.insert_artifact(&new_artifact(sid, "rep", "report/html"))
        .await
        .unwrap();

    // subtypes_of=matrix → only the expression artifact (is_a matrix); NOT clustering/report.
    let r = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/artifacts?subtypes_of=matrix")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(r.status().as_u16(), 200);
    let items: Value = r.json().await.unwrap();
    let dts: Vec<&str> = items
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["datatype"].as_str())
        .collect();
    assert_eq!(
        dts,
        vec!["single-cell/expression"],
        "only the matrix-family artifact"
    );

    // Capability filter: has-obs → the expression artifact ONLY (not clustering/report).
    let r = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/artifacts?capability=has-obs")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    let items: Value = r.json().await.unwrap();
    let dts: Vec<&str> = items
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|a| a["datatype"].as_str())
        .collect();
    assert_eq!(
        dts,
        vec!["single-cell/expression"],
        "has-obs selects exactly the expression artifact"
    );
}

// --------------------------- TEST-21: per-artifact catalog view ---------------------------

#[tokio::test]
async fn test21_artifact_catalog_is_registry_enriched() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "catalog view").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool);
    let a = repo
        .insert_artifact(&new_artifact(sid, "expr", "single-cell/expression"))
        .await
        .unwrap();

    let r = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/catalog", a.id)))
        .bearer_auth(&token)
        .send()
        .await
        .expect("catalog");
    assert_eq!(r.status().as_u16(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["unknown"], false);
    assert_eq!(v["datatype"]["id"], "single-cell/expression");
    assert_eq!(v["artifact"]["id"], a.id.to_string());
    // Viewers resolve UP the lattice (matrix-grid inherited from `matrix`).
    let viewers: Vec<&str> = v["viewers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|x| x["view_kind_id"].as_str())
        .collect();
    assert!(
        viewers.contains(&"matrix-grid"),
        "matrix-family viewer inherited"
    );
    assert!(v["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c == "has-obs"));
    // artifact-model ITEM-14 (INVERSE pin — it holds the REMOVAL): the catalog view
    // used to publish `selector_tiers` + `default_tier`, telling the FE which
    // TRANSPORT each selector used. ITEM-12 left one transport
    // (`/artifacts/{id}/data[/{*member}]` serves byte ranges, the client decodes), so
    // the tier system was a constant dressed as a decision and §0.3 lists it under
    // Deleted. This asserts it stays gone rather than coming back with the next
    // `selector_map`-shaped idea.
    let view = v.as_object().expect("catalog view object");
    for dropped in ["selector_tiers", "default_tier"] {
        assert!(
            !view.contains_key(dropped),
            "`{dropped}` came back to the artifact catalog view (ITEM-14)"
        );
    }

    // Fail-soft: a row with an unknown datatype yields a generic view, not a 500.
    let unk = repo
        .insert_artifact(&new_artifact(sid, "mystery", "single-cell/expression"))
        .await
        .unwrap();
    sqlx::query!(
        "UPDATE artifacts SET datatype = 'ghost/type' WHERE id = $1",
        unk.id
    )
    .execute(&pool_for(&server).await)
    .await
    .unwrap();
    let r = server
        .client
        .get(server.api_url(&format!("/artifacts/{}/catalog", unk.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["unknown"], true, "unknown datatype is fail-soft");
    assert!(v["datatype"].is_null());
}

// --------------------------- TEST-22: ingest validation (fan-out) ---------------------------

#[tokio::test]
async fn test22_ingest_validates_each_output_against_registry() {
    // The registry must exist in THIS process for the DIRECT ingest call to
    // validate (the direct call runs in the test binary, not the server subprocess).
    // Build the MERGED registry (roots ∪ manifest-contributed domain types), exactly
    // as boot does — `single-cell/expression` etc. live in contributed manifests now,
    // so `build_from_slice` alone (roots-only) would fail to validate them.
    set_global_registry(Arc::new(DatatypeRegistry::build_from_embedded().unwrap()));

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "ingest validate").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool.clone());

    // Valid manifest — two typed outputs land as `ready` rows (fan-out).
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let manifest = json!({ "outputs": [
        { "id": "expression", "datatype": "single-cell/expression", "path": "expr.bin", "layout": "chunked-sparse", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "primary" },
        { "id": "qc", "datatype": "report/html", "path": "qc.html", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "aux" }
    ]});
    write_manifest(
        &ws,
        &manifest,
        &[("expr.bin", b"\x01\x02"), ("qc.html", b"<html/>")],
    )
    .await;
    let run_ok = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, Some(sid), None, run_ok, None, &ws)
        .await
        .expect("valid ingest");
    assert_eq!(rows.len(), 2, "one typed row per declared output");

    // Unknown datatype → the WHOLE ingest fails (422) and inserts ZERO rows.
    let ws2 = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let bad = json!({ "outputs": [
        { "id": "x", "datatype": "not-a-real/type", "path": "x.bin", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
    ]});
    write_manifest(&ws2, &bad, &[("x.bin", b"data")]).await;
    let run_bad = Uuid::new_v4();
    let res = ingest_run_outputs(&pool, &store, Some(sid), None, run_bad, None, &ws2).await;
    assert!(res.is_err(), "unknown datatype must fail ingest");
    assert_eq!(
        repo.list_by_run(sid, run_bad).await.unwrap().len(),
        0,
        "atomic — no partial rows"
    );

    // An ABSTRACT datatype is likewise rejected.
    let ws3 = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    let abstract_m = json!({ "outputs": [
        { "id": "m", "datatype": "matrix", "path": "m.bin", "layout": "chunked-dense", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
    ]});
    write_manifest(&ws3, &abstract_m, &[("m.bin", b"data")]).await;
    let run_abs = Uuid::new_v4();
    assert!(
        ingest_run_outputs(&pool, &store, Some(sid), None, run_abs, None, &ws3)
            .await
            .is_err(),
        "abstract datatype rejected"
    );
    assert_eq!(repo.list_by_run(sid, run_abs).await.unwrap().len(), 0);
}

async fn write_manifest(ws: &std::path::Path, manifest: &Value, files: &[(&str, &[u8])]) {
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .await
    .unwrap();
    // Output files live UNDER `<ws>/outputs/` (the sandbox `/outputs` bind); each
    // `rel` is `/outputs`-relative, matching the manifest `path` fields.
    for (rel, bytes) in files {
        let p = outputs.join(rel);
        tokio::fs::create_dir_all(p.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(p, bytes).await.unwrap();
    }
}

// --------------------------- TEST-23: sniff endpoint + upload ---------------------------

#[tokio::test]
async fn test23_sniff_endpoint_and_dataset_upload_detect_type() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // POST /api/datatypes/sniff — a .h5mu is detected as `single-cell/multimodal`.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"\x00multimodal".to_vec()).file_name("results.h5mu"),
    );
    let r = server
        .client
        .post(server.api_url("/datatypes/sniff"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("sniff");
    assert_eq!(r.status().as_u16(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["datatype"], "single-cell/multimodal");

    // An unrecognized blob → null (the FE shows "unknown"), not an error.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"\x00\x01".to_vec()).file_name("mystery.xyz"),
    );
    let r = server
        .client
        .post(server.api_url("/datatypes/sniff"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    assert!(v["datatype"].is_null());

    // The dataset upload records the detected datatype on its response.
    let created = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&token)
        .json(&json!({ "name": "d1", "description": "" }))
        .send()
        .await
        .unwrap();
    let ds: Value = created.json().await.unwrap();
    let did = ds["id"].as_str().unwrap();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"\x00mm".to_vec()).file_name("m.h5mu"),
    );
    let up = server
        .client
        .post(server.api_url(&format!("/datasets/{did}/upload")))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(up.status().as_u16(), 200, "upload");
    let upv: Value = up.json().await.unwrap();
    assert_eq!(
        upv["detected_datatype"], "single-cell/multimodal",
        "upload records the sniffed type"
    );
}

// --------------------------- TEST-24: open-model anti-regression ---------------------------

#[tokio::test]
async fn test24_datatype_column_is_open_text_no_enum_check_fk() {
    let server = TestServer::spawn().await;
    let _ = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // `storage_layout` LEFT this loop: artifact-model ITEM-7 DROPPED the column, so a
    // `fetch_one` for it would now panic on an empty row set — i.e. this test would fail
    // for a reason that has nothing to do with the open-model property it names.
    // `datatype` is the column the property is actually about (the open, registry-validated
    // type id), and the drop is pinned separately by
    // `workstore::test9_axis_entry_table_is_gone_and_axes_derive_from_declarations` and the
    // inverse wire pins in `catalog::models`.
    for col in ["datatype"] {
        let row = sqlx::query!(
            r#"SELECT data_type as "data_type!" FROM information_schema.columns
               WHERE table_name = 'artifacts' AND column_name = $1"#,
            col,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.data_type, "text", "{col} must be plain TEXT (no enum)");

        // No CHECK or FK constraint on the artifacts table references this column.
        let cnt = sqlx::query!(
            r#"SELECT count(*) as "n!" FROM pg_constraint c
               JOIN pg_class t ON c.conrelid = t.oid
               WHERE t.relname = 'artifacts' AND c.contype IN ('c','f')
                 AND pg_get_constraintdef(c.oid) ILIKE $1"#,
            format!("%{col}%"),
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            cnt.n, 0,
            "{col} must have no CHECK/FK constraint (open model)"
        );
    }
}

// --------------------------- TEST-25: authz (deny path) ---------------------------

#[tokio::test]
async fn test25_new_routes_require_projects_use() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let sid = create_project(&server, &admin, "authz").await;

    // 401 unauthenticated on every new route.
    for path in [
        "/datatypes".to_string(),
        format!("/artifacts/{}/catalog", Uuid::new_v4()),
    ] {
        let r = server
            .client
            .get(server.api_url(&path))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 401, "unauth GET {path}");
    }
    let r = server
        .client
        .post(server.api_url("/datatypes/sniff"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 401, "unauth POST sniff");
    let r = server
        .client
        .post(server.api_url("/datatypes/convert?from=file/csv&to=de"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 401, "unauth POST convert");

    // 403 for an authenticated user LACKING projects::use.
    let (uid, _tok) = create_member_token(&server, &admin, "restricted1").await;
    strip_users_group(&server, &admin, uid).await;
    let restricted = login(&server, "restricted1", "memberPassw0rd!").await;
    for path in ["/datatypes", &format!("/projects/{sid}/artifacts")] {
        let r = server
            .client
            .get(server.api_url(path))
            .bearer_auth(&restricted)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 403, "restricted GET {path}");
    }
    // The write routes (sniff/convert) also 403 for a user lacking projects::use.
    let r = server
        .client
        .post(server.api_url("/datatypes/convert?from=file/csv&to=de"))
        .bearer_auth(&restricted)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 403, "restricted POST convert");
}

// --------------------------- TEST-26: dataset seam intact ---------------------------

#[tokio::test]
async fn test26_dataset_cascade_seam_intact_and_typed() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "dataset seam").await;

    // Create a dataset, attach it to the project, upload a sniffable file (typed).
    let ds: Value = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&token)
        .json(&json!({ "name": "seam", "description": "" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let did = ds["id"].as_str().unwrap();
    let attach = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/datasets/{did}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert!(
        attach.status().is_success(),
        "attach dataset: {}",
        attach.status()
    );

    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"\x00mm".to_vec()).file_name("t.h5mu"),
    );
    let up: Value = server
        .client
        .post(server.api_url(&format!("/datasets/{did}/upload")))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        up["detected_datatype"], "single-cell/multimodal",
        "dataset upload is typed (sniff)"
    );

    // Delete the project → the dataset project-extension seam fires. Under the
    // owner-corrected M:N model (DEC-4; `dataset/project_extension::on_project_deleted`),
    // deleting a project DETACHES its datasets (the `project_datasets` junction row is
    // removed via the FK cascade) but does NOT delete the owner-scoped dataset — it
    // survives in the owner's library (a dataset may belong to many projects). This
    // corrects the pre-M:N assumption that the dataset itself cascaded.
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid}")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert!(
        del.status().is_success(),
        "delete project: {}",
        del.status()
    );
    let pool = pool_for(&server).await;
    let did_uuid = Uuid::parse_str(did).unwrap();
    // The junction row is gone (the detach seam fired) …
    let links = sqlx::query!(
        r#"SELECT count(*) as "n!" FROM project_datasets WHERE dataset_id = $1"#,
        did_uuid
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .n;
    assert_eq!(
        links, 0,
        "project delete detached the dataset (junction seam fired)"
    );
    // … while the owner-scoped dataset SURVIVES (M:N — not deleted with the project).
    let n = sqlx::query!(
        r#"SELECT count(*) as "n!" FROM datasets WHERE id = $1"#,
        did_uuid
    )
    .fetch_one(&pool)
    .await
    .unwrap()
    .n;
    assert_eq!(
        n, 1,
        "the owner-scoped dataset survives the project delete (M:N)"
    );
}

// --------------------------- TEST-33: convert route — no registered converters ---------------------------

// DEC-8: `de`'s former `file/csv`/`file/tsv` → `de` converter refs were DANGLING
// (the `from` types were never seeded datatypes) and are DROPPED when `de` moves to
// the contributed `single-cell-types` package. No datatype registers a `ConverterRef`
// any longer, so the generic `/datatypes/convert` route resolves NO pair → 400
// NO_CONVERTER. (The host-lite csv→columnar conversion LOGIC is untouched + still
// unit-tested in `datatype/convert.rs`; only the registry registration of it went
// away with the dangling `from` refs.)
#[tokio::test]
async fn test33_convert_route_has_no_registered_converters_after_de_ref_drop() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // csv→de is no longer a REGISTERED converter (DEC-8) → 400 NO_CONVERTER.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"gene,logfc\nCD8A,2.5\nFOXP3,-1.0".to_vec())
            .file_name("de.csv"),
    );
    let r = server
        .client
        .post(server.api_url("/datatypes/convert?from=file/csv&to=de"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("convert");
    assert_eq!(
        r.status().as_u16(),
        400,
        "csv→de converter ref was dropped (DEC-8) → the route no longer resolves it"
    );

    // A genuinely-unregistered pair likewise → 400 NO_CONVERTER.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(b"x".to_vec()).file_name("x.bin"),
    );
    let r = server
        .client
        .post(server.api_url("/datatypes/convert?from=nope&to=nothing"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 400, "no such converter");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-22 [ITEM-5 · INV-7] — NO-REGRESSION: the in-tree processor packages
// contribute the FULL single-cell domain lattice through the boot
// `build_from_embedded()` path, and `is_a` edges + `viewers_for` (incl. the
// inherited `matrix-grid`/`table`/`report`) reproduce the `f56299d` domain lattice
// EXACTLY after the Slice-2 strip. The collision guard stays fail-loud.
#[test]
fn test22_merged_registry_reproduces_the_domain_lattice_no_regression() {
    let reg = DatatypeRegistry::build_from_embedded().expect("boot merge builds");

    // The merged lattice is 26: the 6 universal roots ∪ 20 contributed types. The loops
    // below assert every root plus a 15-id SUBSET of the contributed types — a subset,
    // not the whole bundle: the supporting type and the 3 zero-core open kinds are only
    // covered by the golden-lattice test, and one type from the main package is in
    // neither list here.
    //
    // The prose used to claim "= 22" and to read as though the 15 ids WERE the whole
    // contributed set. Both were stale; nothing failed, because the loops assert
    // presence of ids they themselves name, so the bundle can grow without this test
    // noticing. Treat the count above as documentation to re-derive, not as a fact.
    for root in [
        "data",
        "data/opaque",
        "tabular",
        "matrix",
        "report/html",
        "file/upload",
    ] {
        assert!(reg.get(root).is_some(), "root `{root}` present");
    }
    for domain in [
        "single-cell/expression",
        "single-cell/counts",
        "single-cell/normalized",
        "single-cell/protein",
        "single-cell/atac",
        "single-cell/modality",
        "single-cell/multimodal",
        "single-cell/anndata",
        "single-cell/matrix-mtx",
        "embedding",
        "clustering",
        "metadata-column",
        "report/qc",
        "sequence/fastq",
    ] {
        assert!(
            reg.get(domain).is_some(),
            "domain type `{domain}` contributed"
        );
    }

    // is_a edges reproduce the f56299d lattice (the Galaxy subtyping rule).
    for (sub, sup, want) in [
        ("single-cell/expression", "matrix", true),
        ("single-cell/expression", "data", true),
        ("single-cell/counts", "single-cell/expression", true),
        ("single-cell/protein", "single-cell/expression", true),
        ("single-cell/atac", "single-cell/expression", true),
        ("single-cell/modality", "single-cell/expression", true),
        ("single-cell/multimodal", "data", true),
        ("single-cell/multimodal", "matrix", false), // a container, not a matrix
        ("single-cell/matrix-mtx", "data", true),
        ("single-cell/matrix-mtx", "matrix", false), // raw trio, not a queryable matrix
        ("embedding", "matrix", true),
        ("clustering", "tabular", true),
        ("report/qc", "report/html", true),
        ("report/qc", "data", true),
        ("sequence/fastq", "data", true),
    ] {
        assert_eq!(reg.is_a(sub, sup), want, "is_a({sub}, {sup})");
    }

    // viewers_for resolves UP the lattice — inherited matrix-grid/table/report travel.
    let vf = |id: &str| -> Vec<String> {
        reg.viewers_for(id)
            .iter()
            .map(|v| v.view_kind_id.clone())
            .collect()
    };
    assert_eq!(
        vf("single-cell/expression"),
        vec!["matrix-grid", "table"],
        "expression inherits matrix-grid+table"
    );
    // A second matrix-family type asserting the IDENTICAL inherited list used to sit here,
    // for the type artifact-model ITEM-38 removed. Not re-pointed at another id: the line
    // above already pins "a concrete matrix subtype inherits matrix-grid+table", and a
    // duplicate of it costs a hardcoded domain id for no additional coverage.
    assert_eq!(
        vf("embedding"),
        vec!["embedding-scatter", "matrix-grid", "table"],
        "embedding own scatter + inherited"
    );
    assert_eq!(vf("clustering"), vec!["table"], "clustering inherits table");
    assert_eq!(
        vf("report/qc"),
        vec!["qc-review", "report"],
        "qc-review own + inherited report"
    );
    assert!(
        vf("single-cell/matrix-mtx").is_empty(),
        "raw mtx trio inherits no viewer (extends data)"
    );

    // The single-cell PRIMARY datatypes carry their cells/genes axes INLINE (the
    // former boot axis-overlay is deleted).
    for id in ["single-cell/anndata", "single-cell/matrix-mtx"] {
        let names: Vec<String> = reg.axes_for(id).iter().map(|a| a.name.clone()).collect();
        assert_eq!(
            names,
            vec!["cells", "genes"],
            "{id} carries cells+genes axes inline"
        );
    }

    // The collision guard is still fail-loud: a manifest datatype colliding with a
    // core root aborts the merge (a manifest may extend the lattice, never shadow it).
    let collide = cytoanalyst::modules::datatype::types::Datatype {
        id: "matrix".into(),
        extends: Some("data".into()),
        title: "collide".into(),
        description: String::new(),
        schema: serde_json::json!({}),
        storage: cytoanalyst::modules::datatype::types::StorageSpec {
            layout: cytoanalyst::modules::datatype::types::LayoutKind::OpaqueAsIs,
            format: "any".into(),
            file_layout: cytoanalyst::modules::datatype::types::FileLayout::Single,
        },
        capabilities: vec![],
        axes: vec![],
        entity_axis: None,
        arrays: vec![],
        labels: Default::default(),
        viewers: vec![],
        ingest: None,
        input_requirements: None,
        converters: vec![],
        is_abstract: false,
    };
    let err = DatatypeRegistry::build_merged(vec![collide])
        .err()
        .expect("a manifest id colliding with a core root must fail the merge");
    assert!(err.contains("collides"), "collision is fail-loud: {err}");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-50 [ITEM-38] — the RETIRED lossless multi-file store type is gone from the
// VOCABULARY, not merely from the producer.
//
// ITEM-27 deleted the OUTPUT (it was the CSR→CSC transpose buffer the CSC trio was
// streamed back out of, never a second product). The TYPE survived in the contributed
// manifest, and a registered datatype nothing on earth can produce is the same defect
// class as a guard whose witness file was deleted: it validates, `/api/datatypes`
// advertises it, a converter or an artifact picker can still OFFER it — and it resolves
// to nothing. So this asserts the id is absent from BOTH halves of the vocabulary (the
// built registry AND the manifests the registry is built from), and that a lattice query
// naming it resolves to nothing rather than to a producerless type.
//
// The NEGATIVE CONTROL is load-bearing: every assertion below is an ABSENCE, and an
// absence is also what a collapsed registry, a manifest that stopped parsing, or a
// dropped contribution look like. So each half is paired with a still-registered
// sibling that MUST resolve. Without the control this test passes just as loudly on a
// registry containing nothing at all.
/// The one id this test names. A test asserting a SPECIFIC id is absent has to spell it;
/// everything else it needs is derived, so this is the only domain literal the case costs.
const RETIRED_STORE_DATATYPE: &str = "single-cell/soma";

/// The NEGATIVE CONTROL's subject, DERIVED rather than named: the alphabetically-first
/// CONCRETE datatype that (a) the merged registry knows, (b) the roots-only code slice
/// does NOT — i.e. one a manifest contributed — and (c) `is_a` the same parent the retired
/// type extended. Deriving it is not just census hygiene: a hardcoded sibling stops being
/// a control the moment IT is renamed or retired (it starts failing for its own reasons),
/// whereas this one tracks whatever the contribution actually ships.
fn live_contributed_sibling(reg: &DatatypeRegistry) -> String {
    let roots: std::collections::HashSet<String> = DatatypeRegistry::build_from_slice()
        .expect("roots-only slice builds")
        .all()
        .iter()
        .map(|d| d.id.clone())
        .collect();
    let mut ids: Vec<String> = reg
        .all()
        .iter()
        .filter(|d| !d.is_abstract && !roots.contains(&d.id) && d.id != RETIRED_STORE_DATATYPE)
        .filter(|d| reg.is_a(&d.id, "matrix"))
        .map(|d| d.id.clone())
        .collect();
    ids.sort();
    ids.into_iter().next().expect(
        "negative control: the merged registry must contain at least ONE contributed concrete \
         matrix subtype — if it does not, every absence this test asserts is satisfied by a \
         collapsed registry rather than by the removal",
    )
}

#[test]
fn test50_the_retired_store_datatype_is_absent_from_registry_and_manifests() {
    let reg = DatatypeRegistry::build_from_embedded().expect("boot merge builds");
    // The control's subject — derived, and its very existence is the first control.
    let live = live_contributed_sibling(&reg);

    // ── (1) the built registry ────────────────────────────────────────────────
    assert!(
        reg.get(RETIRED_STORE_DATATYPE).is_none(),
        "`{RETIRED_STORE_DATATYPE}` is still registered — a datatype NOTHING can produce",
    );
    assert!(
        reg.get(&live).is_some(),
        "negative control: `{live}` must still resolve — an empty/collapsed registry would \
         satisfy every absence above for the wrong reason",
    );

    // ── (2) a lattice query naming it resolves to NOTHING ─────────────────────
    // `is_a` in both directions, and the `subtypes_of` allow-list the artifact listing
    // filter is built from (`descendants_inclusive`) — the ways a caller can name a
    // datatype and get an answer.
    assert!(
        !reg.is_a(RETIRED_STORE_DATATYPE, "matrix"),
        "an unknown id must not resolve UP the lattice",
    );
    assert!(
        !reg.is_a(RETIRED_STORE_DATATYPE, "data"),
        "an unknown id must not resolve to the root either",
    );
    // `?subtypes_of=<id>` expands through `descendants_inclusive`, which ECHOES the id it
    // was handed (`vec![id]` + proper descendants) whether or not the registry knows it. So
    // the allow-list is not empty, and the meaningful assertion is that it names NO
    // REGISTERED TYPE. Downstream that list becomes `datatype = ANY($5)`
    // (`catalog::repository::list_by_project`), so a query naming the retired id selects
    // exactly zero rows. Asserting `.is_empty()` here would assert something FALSE about a
    // helper this item never touched.
    let allow = reg.descendants_inclusive(RETIRED_STORE_DATATYPE);
    assert!(
        allow.iter().all(|d| reg.get(d).is_none()),
        "`?subtypes_of=<retired>` must expand to NO registered type: {allow:?}",
    );
    assert!(
        !reg.descendants_inclusive("matrix")
            .iter()
            .any(|d| d == RETIRED_STORE_DATATYPE),
        "the retired id must not reappear as a SUBTYPE of the parent it used to extend",
    );
    // The picker path: `matches()` rejects an unknown datatype outright, and no registered
    // datatype satisfies a selector naming the retired id — so a picker built from either
    // side offers nothing.
    let retired_sel = TypeSelector {
        subtypes_of: Some(RETIRED_STORE_DATATYPE.into()),
        ..Default::default()
    };
    assert!(
        reg.all()
            .iter()
            .all(|dt| !reg.matches(&dt.id, &retired_sel)),
        "no registered datatype may satisfy a selector naming the retired id",
    );
    assert!(
        !reg.matches(RETIRED_STORE_DATATYPE, &TypeSelector::default()),
        "the retired id does not even satisfy the empty (match-any-KNOWN-type) selector",
    );
    assert!(
        reg.viewers_for(RETIRED_STORE_DATATYPE).is_empty(),
        "an unknown id inherits no viewer, so no picker can render it",
    );
    // controls: the same queries all answer for the derived live sibling.
    assert!(
        reg.is_a(&live, "matrix"),
        "negative control: is_a resolves for `{live}`"
    );
    assert!(
        reg.descendants_inclusive(&live).contains(&live),
        "negative control: subtypes_of expands for a live id",
    );
    assert!(
        reg.descendants_inclusive("matrix")
            .iter()
            .any(|d| *d == live),
        "negative control: the live sibling IS a subtype of `matrix`",
    );
    assert!(
        !reg.viewers_for(&live).is_empty(),
        "negative control: viewers resolve for `{live}`"
    );

    // ── (3) every contributed manifest ────────────────────────────────────────
    // Scanned from SOURCE, over EVERY package (not just the one that declared it): the
    // registry half above proves the merged result, but a manifest still declaring the id
    // would put it back the moment that package is re-extracted, and an already-provisioned
    // deployment reconciles per-package. Comments are NOT stripped — the id must be gone
    // from the manifests entirely, which is why the changelog note describing the removal is
    // worded without it.
    let processors = src_app_dir().join("packages");
    let mut scanned = 0usize;
    let mut sibling_seen = false;
    for entry in std::fs::read_dir(&processors)
        .unwrap_or_else(|e| panic!("read {}: {e}", processors.display()))
    {
        let manifest = entry.expect("dir entry").path().join("manifest.yaml");
        if !manifest.is_file() {
            continue;
        }
        scanned += 1;
        let src = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("read {}: {e}", manifest.display()));
        assert!(
            !src.contains(RETIRED_STORE_DATATYPE),
            "{} still names the retired id — a stale extracted copy would re-contribute a \
             producerless datatype",
            manifest.display(),
        );
        sibling_seen |= src.contains(&live);
    }
    // controls: the walk read manifests, and it can SEE a declared id (so the absence above
    // is not "read nothing" or "matched nothing").
    assert!(
        scanned >= 5,
        "negative control: the manifest walk found only {scanned} package(s)"
    );
    assert!(
        sibling_seen,
        "negative control: no scanned manifest declares `{live}` — the walk is reading the \
         wrong files, so its absence findings mean nothing",
    );
}

/// Helper mirroring `dataset/mod.rs`'s: the `src-app/` root, for source-level scans.
fn src_app_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server dir has a parent")
        .to_path_buf()
}
