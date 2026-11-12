//! The `#[cfg(debug_assertions)]` e2e seed engine (`POST /api/projects/{id}/_debug/seed`).
//!
//! It had NO test of any kind before this file: the six subject-specific routes it replaced
//! were driven only from Playwright specs, three of which are env-/fixture-gated OFF by
//! default, so most of the surface was unexercised by any suite that routinely runs.
//!
//! These tests pin the ENGINE — the part that is now generic — and deliberately assert
//! nothing about any particular subject area: the datatype ids below are arbitrary strings
//! the request supplies, which is precisely the property the engine is supposed to have.
//! (The driver arm needs a host scientific-python stack + a real binary fixture, so it stays
//! with the Playwright specs that own those fixtures; the plan-interpretation paths it shares
//! with the inline arm — scopes, encodings, error mapping — are covered here.)
//!
//! ASSERTION DISCIPLINE. Every rejection case below asserts the response's `error_code`, not
//! just its 4xx status: the engine has eight distinct 400s, so a status-only assertion passes
//! for the wrong reason whenever a request trips a DIFFERENT guard than the one the case is
//! named for. Each rejection is paired with a NEGATIVE CONTROL — a request that differs only
//! in the field under test and trips a different, named guard — so the test proves the engine
//! discriminates rather than merely refusing. (The `driver_file` confinement rule reaches its
//! filesystem read only with a real driver output directory; that arm is exercised directly by
//! `data_api.rs`'s in-source `seed_guard_tests`, which build one with a `tempdir`.)

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::workstore::object_store::{sha256_hex, ContentKey, ObjectStore};

use super::{create_member_token, create_project, setup_admin};
use crate::common::TestServer;

/// POST a plan (+ optional raw `input` part) to the seed engine.
async fn post_seed(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    plan: Value,
    input: Option<Vec<u8>>,
) -> reqwest::Response {
    let mut form = reqwest::multipart::Form::new().text("plan", plan.to_string());
    if let Some(bytes) = input {
        form = form.part(
            "input",
            reqwest::multipart::Part::bytes(bytes).file_name("input.bin"),
        );
    }
    server
        .client
        .post(server.api_url(&format!("/projects/{project_id}/_debug/seed")))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("seed request")
}

/// POST a plan expected to be REFUSED; returns the machine-readable `error_code` after pinning
/// the status. Asserting the code (not just the status) is what makes a rejection case
/// non-vacuous — the engine answers 400 from eight different guards.
async fn seed_error_code(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    plan: Value,
    input: Option<Vec<u8>>,
    expect_status: u16,
) -> String {
    let r = post_seed(server, token, project_id, plan, input).await;
    let status = r.status().as_u16();
    let body: Value = r.json().await.expect("error json");
    assert_eq!(status, expect_status, "unexpected status; body = {body}");
    body["error_code"]
        .as_str()
        .expect("an error_code on every refusal")
        .to_string()
}

fn seeded_id(body: &Value, output_id: &str) -> Uuid {
    let id = body["artifacts"]
        .as_array()
        .expect("artifacts array")
        .iter()
        .find(|a| a["output_id"] == output_id)
        .unwrap_or_else(|| panic!("no seeded artifact `{output_id}` in {body}"))["id"]
        .as_str()
        .expect("artifact id");
    Uuid::parse_str(id).expect("uuid")
}

/// The project's artifact listing (the row as the catalog actually stored it).
async fn list_artifacts(server: &TestServer, token: &str, project: Uuid) -> Vec<Value> {
    let listed: Value = server
        .client
        .get(server.api_url(&format!("/projects/{project}/artifacts")))
        .bearer_auth(token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list json");
    listed.as_array().expect("array").clone()
}

fn listed_row<'a>(rows: &'a [Value], output_id: &str) -> &'a Value {
    rows.iter()
        .find(|a| a["output_id"] == output_id)
        .unwrap_or_else(|| panic!("no row `{output_id}` in the listing"))
}

/// Fetch an artifact's stored bytes over the Tier-1 data plane (the same path the FE reads).
async fn fetch_bytes(server: &TestServer, token: &str, id: Uuid) -> Vec<u8> {
    let r = server
        .client
        .get(server.api_url(&format!("/artifacts/{id}/data")))
        .bearer_auth(token)
        .send()
        .await
        .expect("data request");
    assert_eq!(r.status().as_u16(), 200, "artifact bytes must serve");
    r.bytes().await.expect("bytes").to_vec()
}

/// Fetch ONE named member of a multi-member blob.
async fn fetch_member(server: &TestServer, token: &str, id: Uuid, member: &str) -> Vec<u8> {
    let r = server
        .client
        .get(server.api_url(&format!("/artifacts/{id}/data/{member}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("member request");
    assert_eq!(
        r.status().as_u16(),
        200,
        "named member `{member}` must serve"
    );
    r.bytes().await.expect("member bytes").to_vec()
}

/// The engine inserts exactly what the plan describes, frames each encoding on the wire the
/// FE typed-array readers expect, persists the plan's `datatype` + its two producer
/// DECLARATIONS (`structure`/`meta`) verbatim, and serves the bytes back through the real
/// data plane.
///
/// artifact-model ITEM-7 dropped `shape`/`params`/`covered_axes`/`storage_layout` from the
/// artifact row, and the seed plan lost the matching keys with them: `structure` (how to
/// decode) + `meta` (what it means) are the whole declaration surface a fixture has now.
/// The verbatim-persistence property is unchanged — only which fields carry it.
#[tokio::test]
async fn seed_engine_materializes_a_planned_artifact_set() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed engine").await;

    let plan = json!({
        "artifacts": [
            {
                "output_id": "doc",
                // An arbitrary caller-supplied type id: the engine never interprets it.
                "datatype": "some/opaque-record",
                "structure": { "encoding": "json", "rows": 3 },
                "meta": { "who": "the caller" },
                "content": { "encoding": "json", "value": { "k": [1, 2, 3] } }
            },
            {
                "output_id": "values",
                "datatype": "numeric-column",
                "content": { "encoding": "f32", "values": [1.0, 2.5, -3.0] }
            },
            {
                "output_id": "rowids",
                "datatype": "row-subset",
                "content": { "encoding": "u32", "values": [0, 1, 7] }
            },
            {
                "output_id": "sparse",
                "datatype": "sparse-matrix",
                "content": {
                    "encoding": "members",
                    "members": [
                        { "name": "indptr", "encoding": "i64", "values": [0, 2] },
                        { "name": "data", "encoding": "f32", "values": [1.0, 2.0] }
                    ]
                }
            }
        ]
    });

    let r = post_seed(&server, &token, project, plan, None).await;
    assert_eq!(r.status().as_u16(), 200, "seed must succeed");
    let body: Value = r.json().await.expect("seed json");
    assert!(
        body["dataset_id"].is_null(),
        "no `dataset` in the plan → no dataset row"
    );
    assert!(
        body["manifest"].is_null(),
        "no `driver` in the plan → no manifest"
    );
    assert_eq!(body["artifacts"].as_array().expect("artifacts").len(), 4);

    // JSON payload round-trips verbatim.
    let doc = fetch_bytes(&server, &token, seeded_id(&body, "doc")).await;
    let parsed: Value = serde_json::from_slice(&doc).expect("json blob");
    assert_eq!(parsed["k"], json!([1, 2, 3]));

    // f32 / u32 frame little-endian, exactly the wire the FE readers decode.
    let values = fetch_bytes(&server, &token, seeded_id(&body, "values")).await;
    assert_eq!(values.len(), 12);
    let decoded: Vec<f32> = values
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(decoded, vec![1.0f32, 2.5, -3.0]);

    let rowids = fetch_bytes(&server, &token, seeded_id(&body, "rowids")).await;
    let decoded: Vec<u32> = rowids
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(decoded, vec![0u32, 1, 7]);

    // A multi-member blob serves per NAMED member (the `put_prefix` manifest path), and EACH
    // member keeps its own encoding's framing — not just the one member that happens to be
    // fetched first.
    let sparse = seeded_id(&body, "sparse");
    let indptr = fetch_member(&server, &token, sparse, "indptr").await;
    let decoded: Vec<i64> = indptr
        .chunks_exact(8)
        .map(|c| i64::from_le_bytes(c.try_into().expect("8 bytes")))
        .collect();
    assert_eq!(decoded, vec![0i64, 2], "the i64 member frames as i64");
    let data = fetch_member(&server, &token, sparse, "data").await;
    let decoded: Vec<f32> = data
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(decoded, vec![1.0f32, 2.0], "the f32 member frames as f32");

    // The plan's METADATA is stored, not just its bytes: `datatype` and the two producer
    // declarations are caller data and must survive verbatim onto the catalog row.
    let rows = list_artifacts(&server, &token, project).await;
    let doc = listed_row(&rows, "doc");
    assert_eq!(doc["datatype"], "some/opaque-record");
    assert_eq!(
        doc["structure"],
        json!({ "encoding": "json", "rows": 3 }),
        "the plan's `structure` is persisted verbatim"
    );
    assert_eq!(
        doc["meta"],
        json!({ "who": "the caller" }),
        "the plan's `meta` is persisted verbatim"
    );
    assert_eq!(doc["is_multifile"], json!(false));

    // ITEM-7 (INVERSE pin): the four dropped columns must not reappear on the catalog
    // wire — including via a seed plan that still spells them.
    for dropped in ["shape", "params", "covered_axes", "storage_layout"] {
        assert!(
            doc.get(dropped).is_none(),
            "`{dropped}` came back to the catalog row (ITEM-7 dropped it)"
        );
    }

    let sparse_row = listed_row(&rows, "sparse");
    assert_eq!(
        sparse_row["is_multifile"],
        json!(true),
        "a `members` blob is multi-file"
    );
    assert_eq!(
        sparse_row["structure"],
        json!({ "encoding": "opaque", "origin": "seed" }),
        "an omitted `structure` is DECLARED opaque by the engine — the truthful statement \
         about bytes it was handed, not an empty object standing in for an absent one"
    );
    assert_eq!(
        sparse_row["meta"],
        json!({ "origin": "seed" }),
        "an omitted `meta` gets the engine's default marker"
    );
}

/// A plan may create the `datasets` row + project link, and scope each artifact to the
/// project, the dataset, or both — the three shapes the catalog supports.
///
/// Visibility in the project listing alone does NOT prove the scopes were honored (all three
/// scopes are listed there, so a build that ignored `scope` entirely would pass that check).
/// The discriminating assertion is on the stored `project_id`/`dataset_id` PAIR of each row.
#[tokio::test]
async fn seed_engine_creates_a_dataset_and_honors_every_scope() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed scopes").await;

    let plan = json!({
        "dataset": { "name": "planned dataset", "datatype": "some/container" },
        "artifacts": [
            { "output_id": "p", "datatype": "t", "scope": "project",
              "content": { "encoding": "input" } },
            { "output_id": "d", "datatype": "t", "scope": "dataset",
              "content": { "encoding": "input" } },
            { "output_id": "b", "datatype": "t", "scope": "both",
              "content": { "encoding": "input" } },
            // No `scope` at all → the `project` default.
            { "output_id": "def", "datatype": "t",
              "content": { "encoding": "input" } }
        ]
    });
    let r = post_seed(
        &server,
        &token,
        project,
        plan,
        Some(b"raw fixture bytes".to_vec()),
    )
    .await;
    assert_eq!(r.status().as_u16(), 200);
    let body: Value = r.json().await.expect("seed json");
    let dataset_id = body["dataset_id"]
        .as_str()
        .expect("a `dataset` plan creates the row")
        .to_string();

    // The `input` part is stored verbatim.
    assert_eq!(
        fetch_bytes(&server, &token, seeded_id(&body, "p")).await,
        b"raw fixture bytes".to_vec()
    );

    // The project-scope listing includes the project-scoped rows AND, via the
    // `project_datasets` link, the dataset-scoped one (ITEM-23).
    let rows = list_artifacts(&server, &token, project).await;
    let ids: Vec<&str> = rows
        .iter()
        .filter_map(|a| a["output_id"].as_str())
        .collect();
    for want in ["p", "d", "b", "def"] {
        assert!(
            ids.contains(&want),
            "scope `{want}` must be visible in the project scope: {ids:?}"
        );
    }

    // …and each row carries the tenancy PAIR its scope names — the part visibility can't show.
    let project_s = json!(project.to_string());
    let dataset_s = json!(dataset_id);
    for (output_id, want_project, want_dataset) in [
        ("p", &project_s, &Value::Null),
        ("d", &Value::Null, &dataset_s),
        ("b", &project_s, &dataset_s),
        ("def", &project_s, &Value::Null),
    ] {
        let row = listed_row(&rows, output_id);
        assert_eq!(&row["project_id"], want_project, "`{output_id}`.project_id");
        assert_eq!(&row["dataset_id"], want_dataset, "`{output_id}`.dataset_id");
    }
}

/// A malformed or unsatisfiable plan is a 4xx that NAMES the problem in a machine-readable
/// `error_code`. Each case is paired with a control that differs ONLY in the field under test,
/// so a case cannot pass by tripping a neighbouring guard.
#[tokio::test]
async fn seed_engine_rejects_unsatisfiable_plans() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed rejects").await;

    // ── a dataset scope with no `dataset` in the plan ───────────────────────────────────────
    let scoped = |scope: &str| {
        json!({ "artifacts": [
            { "output_id": "x", "datatype": "t", "scope": scope,
              "content": { "encoding": "json", "value": {} } }
        ]})
    };
    assert_eq!(
        seed_error_code(&server, &token, project, scoped("dataset"), None, 400).await,
        "SEED_NO_DATASET"
    );
    assert_eq!(
        seed_error_code(&server, &token, project, scoped("both"), None, 400).await,
        "SEED_NO_DATASET",
        "`both` needs the dataset too"
    );
    // CONTROL: the identical plan at `project` scope needs no dataset and succeeds.
    let r = post_seed(&server, &token, project, scoped("project"), None).await;
    assert_eq!(
        r.status().as_u16(),
        200,
        "the project scope needs no `dataset`"
    );

    // ── `{"encoding":"input"}` with no `input` part ─────────────────────────────────────────
    let wants_input = json!({ "artifacts": [
        { "output_id": "i", "datatype": "t", "content": { "encoding": "input" } }
    ]});
    assert_eq!(
        seed_error_code(&server, &token, project, wants_input.clone(), None, 400).await,
        "SEED_NO_INPUT"
    );
    // An EMPTY input part is refused the same way (the guard is on emptiness, not presence).
    assert_eq!(
        seed_error_code(
            &server,
            &token,
            project,
            wants_input.clone(),
            Some(Vec::new()),
            400
        )
        .await,
        "SEED_NO_INPUT"
    );
    // CONTROL: the same plan WITH bytes succeeds.
    let r = post_seed(&server, &token, project, wants_input, Some(b"x".to_vec())).await;
    assert_eq!(
        r.status().as_u16(),
        200,
        "the same plan with an `input` part must succeed"
    );

    // ── an unknown driver id ────────────────────────────────────────────────────────────────
    let code = seed_error_code(
        &server,
        &token,
        project,
        json!({ "driver": "not-a-driver", "artifacts": [] }),
        Some(b"x".to_vec()),
        400,
    )
    .await;
    assert_eq!(code, "SEED_UNKNOWN_DRIVER");

    // ── a driver-file reference OUTSIDE the driver's output directory (path confinement) ────
    // The confinement rule is a property of the NAME, so it is checked before the engine looks
    // at whether a driver ran. Asserting the code is what makes this case real: the same
    // request also has no driver, and a status-only assertion would pass identically if the
    // engine never checked the name at all (see the control below).
    let driver_file = |file: &str| {
        json!({ "artifacts": [
            { "output_id": "x", "datatype": "t",
              "content": { "encoding": "driver_file", "file": file } }
        ]})
    };
    for escape in [
        "../../etc/passwd",
        "..",
        "sub/dir.json",
        "/etc/passwd",
        "a\\b.json",
        "",
    ] {
        assert_eq!(
            seed_error_code(&server, &token, project, driver_file(escape), None, 400).await,
            "SEED_BAD_DRIVER_FILE",
            "`{escape}` must be refused as unconfined, not as some other fault"
        );
    }
    // CONTROL: a plain, confined file name reaches the NEXT guard and reports a DIFFERENT
    // problem. This is the assertion that proves the loop above is not just observing
    // "driver_file always 400s".
    assert_eq!(
        seed_error_code(
            &server,
            &token,
            project,
            driver_file("report.json"),
            None,
            400
        )
        .await,
        "SEED_NO_DRIVER",
        "a confined name is refused for the absence of a driver, not for its name"
    );

    // ── a `{"$manifest": …}` reference that resolves to nothing (fails CLOSED) ──────────────
    let code = seed_error_code(
        &server,
        &token,
        project,
        json!({ "artifacts": [
            { "output_id": "x", "datatype": "t",
              "structure": { "encoding": "json", "rows": { "$manifest": "row_count" } },
              "content": { "encoding": "json", "value": {} } }
        ]}),
        None,
        400,
    )
    .await;
    assert_eq!(
        code, "SEED_UNKNOWN_MANIFEST_KEY",
        "an unresolvable manifest reference must be refused, NOT silently resolved to null"
    );

    // ── a nested member that is itself multi-member ─────────────────────────────────────────
    let code = seed_error_code(
        &server,
        &token,
        project,
        json!({ "artifacts": [
            { "output_id": "x", "datatype": "t", "content": { "encoding": "members", "members": [
                { "name": "outer", "encoding": "members", "members": [] }
            ]}}
        ]}),
        None,
        400,
    )
    .await;
    assert_eq!(code, "SEED_NESTED_MEMBERS");

    // ── a plan that is not valid JSON ───────────────────────────────────────────────────────
    let form = reqwest::multipart::Form::new().text("plan", "{ not json");
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{project}/_debug/seed")))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .expect("bad plan");
    assert_eq!(r.status().as_u16(), 400, "a malformed plan must 400");
    let body: Value = r.json().await.expect("error json");
    assert_eq!(body["error_code"], "SEED_BAD_PLAN");

    // ── no `plan` part at all ───────────────────────────────────────────────────────────────
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{project}/_debug/seed")))
        .bearer_auth(&token)
        .multipart(reqwest::multipart::Form::new().text("unrelated", "ignored"))
        .send()
        .await
        .expect("no plan");
    assert_eq!(r.status().as_u16(), 400);
    let body: Value = r.json().await.expect("error json");
    assert_eq!(body["error_code"], "SEED_NO_PLAN");
}

/// The three payloads of the atomicity plan below, as the engine frames them (a `json`
/// content is stored as `serde_json::to_vec` of its value). Deliberately DISTINCT: the
/// store is content-addressed, so equal payloads would collapse to ONE physical blob and
/// a "the blob is gone" assertion could be satisfied by some other entry's bytes.
fn atomicity_payload(entry: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "entry": entry })).expect("payload")
}

/// The plan the atomicity test runs TWICE. The second artifact asks for a `dataset` scope,
/// so the plan is unsatisfiable — UNLESS the plan also declares a `dataset`. `with_dataset`
/// is therefore the ONLY difference between the refused run and its positive control.
fn atomicity_plan(with_dataset: bool) -> Value {
    let mut plan = json!({ "artifacts": [
        { "output_id": "first", "datatype": "t",
          "content": { "encoding": "json", "value": { "entry": "first-before-the-fault" } } },
        { "output_id": "second", "datatype": "t", "scope": "dataset",
          "content": { "encoding": "json", "value": { "entry": "second-the-offender" } } },
        { "output_id": "third", "datatype": "t",
          "content": { "encoding": "json", "value": { "entry": "third-after-the-fault" } } }
    ]});
    if with_dataset {
        plan["dataset"] = json!({ "name": "atomicity dataset", "datatype": "some/container" });
    }
    plan
}

/// Whether the SERVER's content-addressed blob store physically holds these bytes — the
/// blob half of atomicity, which the artifact listing cannot show. A rolled-back row with
/// its bytes still on disk is a leak, and a DB-only transaction would look atomic while
/// producing exactly that.
async fn blob_is_stored(server: &TestServer, bytes: &[u8]) -> bool {
    super::server_store(server)
        .exists(&ContentKey::from_hex(&sha256_hex(bytes)))
        .await
        .expect("stat the blob store")
}

/// The project's datasets (the `dataset` half of a plan — created outside the artifact
/// loop, so it needs its own observation).
async fn list_project_datasets(server: &TestServer, token: &str, project: Uuid) -> Vec<Value> {
    let listed: Value = server
        .client
        .get(server.api_url(&format!("/projects/{project}/datasets")))
        .bearer_auth(token)
        .send()
        .await
        .expect("list datasets")
        .json()
        .await
        .expect("datasets json");
    listed
        .get("datasets")
        .or_else(|| listed.get("items"))
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| listed.as_array().cloned())
        .unwrap_or_else(|| panic!("unexpected datasets listing shape: {listed}"))
}

/// A REFUSED seed plan is a true NO-OP. The engine resolves the WHOLE plan before its
/// first side effect, so a plan that faults anywhere leaves nothing behind: no catalog row
/// for the entries BEFORE the offending one, no `datasets` row, and — the half a listing
/// cannot show — no blob bytes in the content-addressed store. The refusal still NAMES the
/// offending entry (`SEED_NO_DATASET` on `second`); what changed is that being third in
/// line no longer means being committed.
///
/// (This inverts a test that previously PINNED the partial-write behaviour: the engine
/// walked the plan writing as it went, so `first` stayed committed after a 400. That is
/// the nondeterminism this suite cannot afford — a spec author gets a 400, fixes the plan,
/// re-posts, and the project already holds rows from the failed attempt.)
///
/// EVERY absence below is measured against a DEMONSTRATED presence: the second half runs
/// the byte-identical plan with a `dataset` declared — the one field the refusal turns on —
/// and observes each of the same three artifacts, each of the same three blobs, and the
/// dataset row. Without that control the whole test would pass on an engine that writes
/// nothing at all.
#[tokio::test]
async fn seed_engine_refusal_is_atomic_and_names_the_offending_entry() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed atomic").await;

    let first = atomicity_payload("first-before-the-fault");
    let second = atomicity_payload("second-the-offender");
    let third = atomicity_payload("third-after-the-fault");

    // ── the refused run ─────────────────────────────────────────────────────────────────
    let code =
        seed_error_code(&server, &token, project, atomicity_plan(false), None, 400).await;
    assert_eq!(code, "SEED_NO_DATASET", "the refusal still names the offending entry's fault");

    let ids: Vec<String> = list_artifacts(&server, &token, project)
        .await
        .iter()
        .filter_map(|a| a["output_id"].as_str().map(str::to_string))
        .collect();
    assert!(
        !ids.contains(&"first".to_string()),
        "the entry BEFORE the fault must NOT be committed (this is the fix): {ids:?}"
    );
    assert!(!ids.contains(&"second".to_string()), "the offending entry itself is not inserted");
    assert!(!ids.contains(&"third".to_string()), "nothing AFTER the fault is inserted: {ids:?}");
    assert!(ids.is_empty(), "a refused plan leaves the project exactly as it found it: {ids:?}");

    // The blob half: no row means nothing, if the bytes are still on disk.
    for (label, bytes) in [("first", &first), ("second", &second), ("third", &third)] {
        assert!(
            !blob_is_stored(&server, bytes).await,
            "a refused plan must leave no `{label}` bytes in the blob store"
        );
    }

    // ── the same plan, minus the fault: the positive control ────────────────────────────
    let r = post_seed(&server, &token, project, atomicity_plan(true), None).await;
    assert_eq!(r.status().as_u16(), 200, "the identical plan WITH a `dataset` must succeed");
    let body: Value = r.json().await.expect("seed json");
    assert!(
        body["dataset_id"].as_str().is_some(),
        "the control creates the dataset row the refused run must not have created"
    );

    let ids: Vec<String> = list_artifacts(&server, &token, project)
        .await
        .iter()
        .filter_map(|a| a["output_id"].as_str().map(str::to_string))
        .collect();
    for want in ["first", "second", "third"] {
        assert!(
            ids.contains(&want.to_string()),
            "the control must commit `{want}` — otherwise the absences above are vacuous: {ids:?}"
        );
    }
    for (label, bytes) in [("first", &first), ("second", &second), ("third", &third)] {
        assert!(
            blob_is_stored(&server, bytes).await,
            "the control must STORE `{label}`'s bytes — otherwise the blob absences above prove \
             nothing about the store, only that these payloads are never written"
        );
    }
}

/// The `dataset` row is inside the transaction too. It is created BEFORE the artifact loop,
/// so a plan that faults in the loop used to leave an orphan `datasets` row + project link
/// behind even when not one artifact landed. The fault here (`{"encoding":"input"}` with no
/// `input` part) is deliberately a DIFFERENT guard from the scope test above, so the two
/// cases cannot both be passing on one accidentally-shared short-circuit.
#[tokio::test]
async fn seed_engine_refusal_rolls_back_the_dataset_row() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed dataset atomic").await;

    let plan = |name: &str| {
        json!({
            "dataset": { "name": name, "datatype": "some/container" },
            "artifacts": [
                { "output_id": "needs-input", "datatype": "t",
                  "content": { "encoding": "input" } }
            ]
        })
    };

    assert_eq!(
        seed_error_code(&server, &token, project, plan("orphan dataset"), None, 400).await,
        "SEED_NO_INPUT"
    );
    assert!(
        list_project_datasets(&server, &token, project).await.is_empty(),
        "a refused plan must not leave its `datasets` row + project link behind"
    );
    assert!(
        list_artifacts(&server, &token, project).await.is_empty(),
        "…nor any artifact"
    );

    // CONTROL: the identical plan WITH the `input` part commits both halves, so the
    // emptiness above is about the rollback, not about the listing never showing anything.
    let r = post_seed(
        &server,
        &token,
        project,
        plan("committed dataset"),
        Some(b"fixture bytes".to_vec()),
    )
    .await;
    assert_eq!(r.status().as_u16(), 200, "the same plan WITH an `input` part must succeed");
    let names: Vec<String> = list_project_datasets(&server, &token, project)
        .await
        .iter()
        .filter_map(|d| d["name"].as_str().map(str::to_string))
        .collect();
    assert_eq!(
        names,
        vec!["committed dataset".to_string()],
        "exactly the committed dataset — the refused run's row is not among them"
    );
    assert_eq!(list_artifacts(&server, &token, project).await.len(), 1);
}

/// A fault AFTER the writes have happened rolls BOTH halves back — the rows through the
/// transaction, the bytes through a compensating free.
///
/// This is the case the two tests above cannot reach: every fault a plan can provoke is
/// caller data, caught during the pure resolution phase before the first write, so those
/// tests exercise "never written" rather than "written and undone". The
/// `_debug_fail_after_write` seam aborts once every blob is stored, the `datasets` row is
/// inserted and every artifact row is inserted — the maximal partial state — so the
/// transaction and the blob rollback are each load-bearing here and each independently
/// falsifiable: drop the transaction and the rows survive; drop the compensating free and
/// the bytes survive.
#[tokio::test]
async fn seed_engine_rolls_back_rows_and_blobs_on_a_post_write_fault() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed post-write fault").await;

    let payload = atomicity_payload("written-then-rolled-back");
    let plan = |fail: bool| {
        json!({
            "dataset": { "name": "rolled-back dataset", "datatype": "some/container" },
            "artifacts": [
                { "output_id": "rolled-back", "datatype": "t", "scope": "both",
                  "content": { "encoding": "json", "value": { "entry": "written-then-rolled-back" } } }
            ],
            "_debug_fail_after_write": fail
        })
    };

    // The abort happens strictly AFTER `store.put` — so this is a real "written, then
    // undone", not a "never attempted".
    assert_eq!(
        seed_error_code(&server, &token, project, plan(true), None, 500).await,
        "SYSTEM_INTERNAL_ERROR"
    );
    assert!(
        list_artifacts(&server, &token, project).await.is_empty(),
        "the artifact rows inserted before the fault must roll back with the transaction"
    );
    assert!(
        list_project_datasets(&server, &token, project).await.is_empty(),
        "so must the `datasets` row + project link"
    );
    assert!(
        !blob_is_stored(&server, &payload).await,
        "and the bytes ALREADY stored must be compensate-freed — a transaction alone would \
         leave these orphaned on disk while looking atomic"
    );

    // CONTROL: the byte-identical plan without the injected fault commits all three, so
    // each absence above is a rollback rather than a path that never writes.
    let r = post_seed(&server, &token, project, plan(false), None).await;
    assert_eq!(r.status().as_u16(), 200, "the same plan without the fault must succeed");
    let ids: Vec<String> = list_artifacts(&server, &token, project)
        .await
        .iter()
        .filter_map(|a| a["output_id"].as_str().map(str::to_string))
        .collect();
    assert_eq!(ids, vec!["rolled-back".to_string()], "the control commits the row");
    assert_eq!(
        list_project_datasets(&server, &token, project).await.len(),
        1,
        "the control commits the dataset row"
    );
    assert!(
        blob_is_stored(&server, &payload).await,
        "the control STORES these exact bytes — which is what makes the freed-blob \
         assertion above about the rollback and not about the payload"
    );
}

/// The seed route carries the SAME authorization posture as every mutating workstore
/// handler: unauthenticated → 401, and a project the caller cannot edit → 404 (never the row).
///
/// The cross-USER case is the one that matters: a random UUID 404s for the trivial reason that
/// no such project exists, so it would pass with no ownership check at all. The discriminating
/// case is a project that DOES exist, seeded by its owner, refused to a different real user.
#[tokio::test]
async fn seed_engine_is_permission_and_ownership_gated() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed authz").await;
    let plan = json!({ "artifacts": [
        { "output_id": "x", "datatype": "t", "content": { "encoding": "json", "value": {} } }
    ]});

    let form = reqwest::multipart::Form::new().text("plan", plan.to_string());
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{project}/_debug/seed")))
        .multipart(form)
        .send()
        .await
        .expect("unauth seed");
    assert_eq!(r.status().as_u16(), 401, "unauthenticated seed must 401");

    // A project that does not exist.
    let r = post_seed(&server, &token, Uuid::new_v4(), plan.clone(), None).await;
    assert_eq!(r.status().as_u16(), 404, "a nonexistent project must 404");

    // A project that DOES exist, owned by someone else: still 404 — never 403 (which would
    // confirm the row exists) and never 200.
    let (_uid, other) = create_member_token(&server, &token, "seed-outsider").await;
    let r = post_seed(&server, &other, project, plan.clone(), None).await;
    assert_eq!(
        r.status().as_u16(),
        404,
        "another user's project must 404 — the engine must not confirm the row exists"
    );

    // …and nothing was written into it.
    assert!(
        list_artifacts(&server, &token, project).await.is_empty(),
        "a refused cross-user seed must leave the project untouched"
    );

    // CONTROL: the OWNER's identical request succeeds, so the 404 above is about the caller,
    // not about the plan.
    let r = post_seed(&server, &token, project, plan, None).await;
    assert_eq!(
        r.status().as_u16(),
        200,
        "the owner's identical plan must succeed"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  A SEEDED RUN — so "this artifact came from this analysis" is expressible
// ════════════════════════════════════════════════════════════════════════════
//
// `ListedArtifact::generator_id` is DERIVED: a join from `artifacts.run_id` to
// `provenance_run_repro.generator_id`. The seed path set `run_id: None` unconditionally, so
// every seeded artifact was unattributable — and a `job.result` slice that narrows by
// producer (which closes a real shadowing defect, and must not be dropped to make a test
// pass) matched nothing and resolved empty before reaching a read.
//
// That left a SHARED resolver's contract testable only at unit level. This is the same shape
// as `status` two rounds ago: **a seed that cannot express a state means the state has no
// end-to-end test.**
//
// The plan expresses the RUN rather than an artifact-level `generator_id`, because the join
// is what production actually has — one run node, one `generator_id`, every output of that
// run pointing at it. An artifact-level field could only be honoured by writing a provenance
// row no real run wrote.

/// A seeded run makes `generator_id` observable end to end, through the real derive path.
#[tokio::test]
async fn a_seeded_run_attributes_its_artifacts_to_an_analysis() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed run attribution").await;

    let plan = json!({
        "run": { "generator_id": "pkg.thing" },
        "artifacts": [{
            "output_id": "fused", "datatype": "data/opaque",
            "content": { "encoding": "json", "value": { "hello": 1 } }
        }]
    });
    let r = post_seed(&server, &token, project, plan, None).await;
    assert_eq!(r.status().as_u16(), 200, "{:?}", r.text().await);

    let items = list_artifacts(&server, &token, project).await;
    assert_eq!(items.len(), 1, "one seeded artifact: {items:?}");
    assert_eq!(
        items[0]["generator_id"], json!("pkg.thing"),
        "the derived attribution must come back on the listing — this is the join \
         (artifacts.run_id → provenance_run_repro.generator_id) that a producer-narrowing \
         resolver reads: {items:?}"
    );
    assert!(
        items[0]["run_id"].as_str().is_some(),
        "and the artifact must actually carry the run, not merely report a name: {items:?}"
    );
}

/// **The control.** Omitting `run` leaves the previous behaviour byte-for-byte.
///
/// Without this, a change that stamped every seeded row with some run would satisfy the test
/// above while silently making every existing fixture attributable — which is a different
/// statement about eight other suites' data.
#[tokio::test]
async fn a_plan_without_a_run_is_unattributable_exactly_as_before() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed run default").await;

    let plan = json!({
        "artifacts": [{
            "output_id": "plain", "datatype": "data/opaque",
            "content": { "encoding": "json", "value": {} }
        }]
    });
    let r = post_seed(&server, &token, project, plan, None).await;
    assert_eq!(r.status().as_u16(), 200);

    let items = list_artifacts(&server, &token, project).await;
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]["generator_id"], Value::Null,
        "an artifact naming no run is NOT ATTRIBUTABLE, which is a different statement from \
         naming a producer and must not be collapsed into one: {items:?}"
    );
    assert_eq!(items[0]["run_id"], Value::Null);
}

/// A blank `generator_id` is refused rather than stored.
///
/// The column defaults to `''` and the derive path reads blank as absent, so seeding one
/// would express the very absence the field exists to fill — silently, and only visible to
/// whoever later wondered why their narrowing matched nothing.
#[tokio::test]
async fn a_seeded_run_with_a_blank_generator_id_is_refused() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "seed run blank").await;

    let code = seed_error_code(
        &server,
        &token,
        project,
        json!({
            "run": { "generator_id": "   " },
            "artifacts": [{
                "output_id": "x", "datatype": "data/opaque",
                "content": { "encoding": "json", "value": {} }
            }]
        }),
        None,
        400,
    )
    .await;
    assert_eq!(code, "SEED_RUN_GENERATOR");
}
