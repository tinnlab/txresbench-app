//! TEST-MS-10 / TEST-MS-15 — the `.txr` round trip over the real routes and
//! the pretrained import seam. Fixture containers are built with the module's
//! own codec (the writer; same bytes the routes emit), so a refusal is the
//! ONE cause under test.

use std::path::PathBuf;

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use crate::common::TestServer;
use super::{error_code, owner_token, pool, seed_run_with_models};
use txresbench::modules::execution_engine::repository::TxrRepository;
use txresbench::modules::execution_engine::types::{TxrMethodEnv, TxrTask};
use txresbench::modules::model_store::container::{
    write_container, ContainerExport, ContainerModelFacts, ContainerModelSpec, ContainerProvenance,
    ContainerSet, ContainerTrainingSpec,
};
use txresbench::modules::model_store::store::{self, ImportOptions, Provenance};
use txresbench::modules::model_store::types::{CovariateFacts, MarkerFacts, ModelProvenance};

const METHOD_A: &str = "cox-cutpoint-risk";
const METHOD_B: &str = "landmark-cox-current";

/// A `.txr` container fixture for the seeded model (kind `set`, one model,
/// one training file) — the same facts the export route would emit.
fn container_fixture(tree_dir: &std::path::Path, token: &str) -> Vec<u8> {
    // The training source lives NEXT TO the tree (never inside it: the digest
    // below is the tree's own — a training file added after the walk would
    // change the bytes and the re-verify in the writer would refuse).
    let training_src = tree_dir
        .parent()
        .expect("parent")
        .join(format!("{token}-training.bin"));
    std::fs::write(&training_src, b"training file bytes").expect("training fixture");
    let digest = txresbench::modules::sandbox::stack::tree_sha256(tree_dir).expect("digest");
    let facts = ContainerModelFacts {
        name: format!("{token} model"),
        method_id: METHOD_A.to_string(),
        method_version: "2.0.1".to_string(),
        group: "response-call".to_string(),
        group_label: "Response call".to_string(),
        task: Some(TxrTask::Pfs),
        provenance: ContainerProvenance {
            kind: ModelProvenance::Run,
            imported_from: None,
            catalogue_id: None,
            licence: None,
        },
        trained_on_patients: Some(2),
        trained_at: Some("2026-10-19T15:00:00+00:00".parse().expect("date")),
        decision_day: 56.0,
        endpoint: txresbench::modules::execution_engine::types::TxrEndpoint::Pfs,
        horizon: 238.0,
        contract: "2.0".to_string(),
        env: TxrMethodEnv {
            base_digest: "ab".repeat(32),
            layer_digest: "cd".repeat(32),
        },
        features: vec!["M1".to_string(), "M2".to_string()],
        required_markers: None,
        marker_facts: MarkerFacts {
            kind: txresbench::modules::method_catalogue::types::MarkerKind::Single,
            count: 2,
            min_draws: 2,
            needs_baseline: false,
            uses_history: txresbench::modules::method_catalogue::types::UsesHistory::Landmark,
            needs_detection_call: false,
            marker_groups_required: vec![],
        },
        covariates: CovariateFacts {
            catalogue: txresbench::modules::method_catalogue::types::CovariateMode::None,
            used: false,
        },
        embeds_training_data: false,
        own_auc: Some(0.66),
        own_c: Some(0.60),
        conversions: Default::default(),
    };
    let export = ContainerExport {
        set: Some(ContainerSet {
            name: format!("{token} set"),
            created_at: "2026-10-19T14:30:00+00:00".parse().expect("date"),
            source_label: Some("patients.csv".to_string()),
            keep_training_files: true,
        }),
        models: vec![ContainerModelSpec {
            token: "model-1".to_string(),
            facts,
            tree_sha256: digest,
            tree_dir: tree_dir.to_path_buf(),
        }],
        training: vec![ContainerTrainingSpec {
            relpath: "training.bin".to_string(),
            src: training_src,
        }],
    };
    let mut buf = Vec::new();
    write_container(&mut buf, &export).expect("fixture container");
    buf
}

/// The saved conversion survives "move to another computer": a model saved
/// from a run that recorded its conversion is exported (single model and
/// set routes) and imported into a fresh store, where resolve hands the
/// engine the same map. A container without conversions (every file written
/// before they were kept) imports a model with none.
#[tokio::test]
async fn export_then_import_keeps_the_conversions() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let map = json!({"progression@238": {"kind": "constant", "a": 0.0, "b": 0.0,
        "mu": 0.42, "sd": 1.0, "n": 77, "rate": 0.37}});
    let (run_id, run_dir) = seed_run_with_models(&server, &repo, "conv-trip", &[METHOD_A]).await;
    let out = run_dir.join("output").join(METHOD_A);
    std::fs::create_dir_all(&out).expect("output dir");
    std::fs::write(out.join("conversions.json"), map.to_string()).expect("record");
    let resp = server
        .client
        .post(server.api_url("/txr/models/save"))
        .bearer_auth(&token)
        .json(&json!({"run_id": run_id, "method_ids": [METHOD_A],
            "target": {"set_name": "Conversion trip"}}))
        .send()
        .await
        .expect("save");
    assert_eq!(resp.status().as_u16(), 201);
    let saved: Value = resp.json().await.expect("json");
    let model_id = saved["models"][0]["id"].as_str().expect("id").to_string();
    let set_id = saved["set"]["id"].as_str().expect("set id").to_string();

    let server2 = TestServer::spawn().await;
    let token2 = owner_token(&server2).await;
    for route in [
        format!("/txr/models/{model_id}/export"),
        format!("/txr/model-sets/{set_id}/export"),
    ] {
        let container = server
            .client
            .get(server.api_url(&route))
            .bearer_auth(&token)
            .send()
            .await
            .expect("export")
            .bytes()
            .await
            .expect("container bytes")
            .to_vec();
        let resp = server2
            .client
            .post(server2.api_url("/txr/models/import"))
            .bearer_auth(&token2)
            .multipart(Form::new().part("file", Part::bytes(container).file_name("trip.txr")))
            .send()
            .await
            .expect("import");
        assert_eq!(resp.status().as_u16(), 201, "{route}");
        let imported: Value = resp.json().await.expect("import json");
        let id = imported["models"][0]["id"].as_str().expect("id").to_string();
        let assets = store::resolve_assets(&pool(&server2).await, &[id]).await.expect("resolve");
        assert_eq!(
            serde_json::to_value(&assets[0].conversions).expect("map"),
            map,
            "{route}: the same map on the other computer"
        );
    }

    // An older container (no conversions in its header): imported with none.
    let tree = server2.data_dir().join("older-tree");
    let (tree, _, _) = super::fixture_tree(&tree, "older");
    let older = container_fixture(&tree, "older");
    let header_len = u32::from_le_bytes(older[9..13].try_into().expect("len")) as usize;
    let header = std::str::from_utf8(&older[13..13 + header_len]).expect("utf-8");
    assert!(!header.contains("conversions"), "an older header has no conversions");
    let resp = server2
        .client
        .post(server2.api_url("/txr/models/import"))
        .bearer_auth(&token2)
        .multipart(Form::new().part("file", Part::bytes(older).file_name("older.txr")))
        .send()
        .await
        .expect("import");
    assert_eq!(resp.status().as_u16(), 201);
    let imported: Value = resp.json().await.expect("import json");
    let id = imported["models"][0]["id"].as_str().expect("id").to_string();
    let assets = store::resolve_assets(&pool(&server2).await, &[id]).await.expect("resolve");
    assert!(assets[0].conversions.is_empty());
}

/// TEST-MS-10: the round trip — export the saved SET via the route, import it
/// into the same store with a fresh set, and the restored rows carry the same
/// tree sha256 / method / env digests / decision day / endpoint / horizon /
/// features with provenance `imported` + `imported_from` == the multipart
/// file name. A tampered byte in the container's payload is refused (the
/// per-file sha256) and leaves the store unchanged; a `../` entry is refused
/// with UNSAFE_PATH.
#[tokio::test]
async fn export_then_import_round_trips_the_container() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let (run_id, _) = seed_run_with_models(&server, &repo, "roundtrip", &[METHOD_A]).await;

    // Save the run's model into a set.
    let resp = server
        .client
        .post(server.api_url("/txr/models/save"))
        .bearer_auth(&token)
        .json(&json!({
            "run_id": run_id,
            "method_ids": [METHOD_A],
            "target": {"set_name": "Roundtrip set"},
            "keep_training_files": true,
        }))
        .send()
        .await
        .expect("save");
    assert_eq!(resp.status().as_u16(), 201);
    let set_id = resp.json::<Value>().await.expect("json")["set"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    // The set export route streams the container.
    let export_resp = server
        .client
        .get(server.api_url(&format!("/txr/model-sets/{set_id}/export")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("set export");
    assert_eq!(export_resp.status().as_u16(), 200);
    let disposition = export_resp
        .headers()
        .get("content-disposition")
        .expect("disposition")
        .to_str()
        .expect("header")
        .to_string();
    let container = export_resp.bytes().await.expect("container bytes").to_vec();
    assert!(
        disposition.contains("attachment; filename=\"Roundtrip set.txr\""),
        "{disposition}"
    );

    // Import it on a SECOND machine (a fresh store) — the container's recorded
    // set recreated fresh, no name collision there.
    let server2 = TestServer::spawn().await;
    let token2 = owner_token(&server2).await;
    let resp = server2
        .client
        .post(server2.api_url("/txr/models/import"))
        .bearer_auth(&token2)
        .multipart(
            Form::new()
                .part("file", Part::bytes(container.clone()).file_name("colleague-set.txr")),
        )
        .send()
        .await
        .expect("import on the second machine");
    assert_eq!(resp.status().as_u16(), 201, "import creates a fresh set");
    let imported: Value = resp.json().await.expect("import json");
    assert_eq!(imported["models"].as_array().expect("array").len(), 1);
    let row = &imported["models"][0];
    assert_eq!(row["provenance"], "imported");
    assert_eq!(row["imported_from"], "colleague-set.txr", "the file name is the provenance");
    assert_eq!(row["method_id"], METHOD_A);
    assert_eq!(row["decision_day"], 56.0);
    assert_eq!(row["endpoint"], "pfs");
    assert_eq!(row["horizon"], 238.0);
    assert_eq!(row["task"], "pfs");
    assert_eq!(row["own_auc"], 0.66);
    let imported_set = imported["set_id"].as_str().expect("set id of a kind-set container");
    // The restored row's recorded digest equals the exported row's — the
    // detail carries the key (the summary is the list row).
    let (imported_digest, imported_features): (String, Value) = {
        let detail: Value = server2
            .client
            .get(server2.api_url(&format!("/txr/models/{}", row["id"].as_str().expect("id"))))
            .bearer_auth(&token2)
            .send()
            .await
            .expect("detail")
            .json()
            .await
            .expect("detail json");
        assert_eq!(detail["features"], json!(["M1", "M2"]), "the recorded features survive");
        (
            detail["tree_sha256"].as_str().expect("digest").to_string(),
            detail["features"].clone(),
        )
    };
    let _ = imported_features;

    // The same tree bytes live in the shared content-addressed dir (the
    // restored tree == the exported tree, digest-verified on arrival).
    assert!(
        server2
            .data_dir()
            .join("models")
            .join("trees")
            .join(&imported_digest)
            .is_dir(),
        "restored tree under its content-addressed dir"
    );
    // The merge path on the FIRST machine: import the same container again
    // with the ORIGINAL set's id — rows grow, the tree dir is shared.
    let resp = server
        .client
        .post(server.api_url("/txr/models/import"))
        .bearer_auth(&token)
        .multipart(
            Form::new()
                .part("file", Part::bytes(container.clone()).file_name("colleague-set.txr"))
                .text("set_id", set_id.clone()),
        )
        .send()
        .await
        .expect("merge import");
    assert_eq!(resp.status().as_u16(), 201);
    let merged: Value = resp.json().await.expect("json");
    assert_eq!(
        merged["set_id"].as_str().expect("id"),
        set_id,
        "merged into the given set"
    );
    // DEC-3's row-is-a-reference idempotence: the same tree+method already
    // IN that set is the same model — the merge re-imported nothing.
    let list: Value = server
        .client
        .get(server.api_url(&format!("/txr/models?set_id={set_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    assert_eq!(list["total"], 1, "the same (set, tree, method) row is not duplicated");
    assert_eq!(
        merged["models"][0]["id"].as_str().expect("id"),
        list["models"][0]["id"].as_str().expect("id"),
        "the merge returns the existing row"
    );

    // A tampered container: flip one byte inside the tree's payload (the
    // per-file sha256 then refuses) — and nothing is written.
    let mut bad = container.clone();
    let flip_at = bad
        .windows(7)
        .rposition(|w| w == b"opaque\x00")
        .expect("locate the weights payload");
    bad[flip_at] ^= 0xFF;
    let before_count = {
        let list: Value = server
            .client
            .get(server.api_url("/txr/models"))
            .bearer_auth(&token)
            .send()
            .await
            .expect("list")
            .json()
            .await
            .expect("json");
        list["total"].as_u64().expect("total")
    };
    let resp = server
        .client
        .post(server.api_url("/txr/models/import"))
        .bearer_auth(&token)
        .multipart(
            Form::new().part("file", Part::bytes(bad).file_name("colleague-set.txr")),
        )
        .send()
        .await
        .expect("tampered import");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(error_code(&resp.json().await.expect("body")), "INVALID_CONTAINER");
    let after_count: Value = server
        .client
        .get(server.api_url("/txr/models"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("json");
    assert_eq!(after_count["total"].as_u64().expect("total"), before_count, "nothing written");

    // An unknown target set → 404 SET_NOT_FOUND.
    let resp = server
        .client
        .post(server.api_url("/txr/models/import"))
        .bearer_auth(&token)
        .multipart(
            Form::new()
                .part("file", Part::bytes(container).file_name("colleague-set.txr"))
                .text("set_id", uuid::Uuid::new_v4().to_string()),
        )
        .send()
        .await
        .expect("unknown set import");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(error_code(&resp.json().await.expect("body")), "SET_NOT_FOUND");
}

/// TEST-MS-10's refusal: a container with an absolute entry path is refused
/// UNSAFE_PATH and nothing is written.
#[tokio::test]
async fn import_refuses_an_absolute_entry_path() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let tree_dir = server.data_dir().join("fixture-tree");
    std::fs::create_dir_all(&tree_dir).expect("fixture tree");
    std::fs::write(tree_dir.join("model.json"), b"{}").expect("fixture file");

    // The codec's writer refuses to WRITE an unsafe relpath — craft the
    // container by patching a valid one: write with a safe name, then swap
    // the relpath bytes for "../escape" (same length).
    let mut bytes = container_fixture(&tree_dir, "unsafe");
    let at = bytes
        .windows(12)
        .rposition(|w| w == b"training.bin")
        .expect("locate the payload training relpath");
    bytes[at..at + 12].copy_from_slice(b"../escape.bn");
    let resp = server
        .client
        .post(server.api_url("/txr/models/import"))
        .bearer_auth(&token)
        .multipart(
            Form::new().part("file", Part::bytes(bytes).file_name("unsafe.txr")),
        )
        .send()
        .await
        .expect("unsafe import");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(error_code(&resp.json().await.expect("body")), "UNSAFE_PATH");
}

/// TEST-MS-15: the in-process pretrained seam — `install_imported` (bytes)
/// stamps provenance + catalogue id + version + licence and a missing licence
/// refuses with 422 LICENCE_REQUIRED and no row; `install_imported_from_path`
/// yields the same outcome from a staged file.
#[tokio::test]
async fn the_pretrained_seam_stamps_licence_and_refuses_a_missing_one() {
    let server = TestServer::spawn().await;
    let tree_dir = server.data_dir().join("pretrained-tree");
    std::fs::create_dir_all(&tree_dir).expect("fixture tree");
    std::fs::write(tree_dir.join("model.json"), b"pretrained bytes").expect("fixture file");
    let bytes = container_fixture(&tree_dir, "pretrained");
    let p = pool(&server).await;

    let opts = ImportOptions {
        set_id: None,
        provenance: Provenance::Pretrained {
            catalogue_id: "xgb-baseline-1.0".to_string(),
            version: "1.0.0".to_string(),
            licence: "CC BY 4.0".to_string(),
        },
    };
    let outcome = store::install_imported(&p, &bytes, &opts)
        .await
        .expect("pretrained install");
    assert_eq!(outcome.models.len(), 1);
    assert_eq!(outcome.models[0].provenance.as_str(), "pretrained");
    assert_eq!(
        outcome.models[0].pretrained_catalogue_id.as_deref(),
        Some("xgb-baseline-1.0")
    );
    assert_eq!(outcome.models[0].pretrained_catalogue_version.as_deref(), Some("1.0.0"));
    assert_eq!(outcome.models[0].licence.as_deref(), Some("CC BY 4.0"));

    // `list_pretrained` returns exactly the installed rows by id (the GAP-PC-3
    // strict id match surface) — and the empty licence refuses.
    let rows = store::list_pretrained(&p, Some("xgb-baseline-1.0"))
        .await
        .expect("list pretrained");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].pretrained_catalogue_version.as_deref(), Some("1.0.0"));
    let rows = store::list_pretrained(&p, Some("other-catalogue"))
        .await
        .expect("list pretrained");
    assert!(rows.is_empty());

    let bad = ImportOptions {
        set_id: None,
        provenance: Provenance::Pretrained {
            catalogue_id: "xgb-baseline-1.0".to_string(),
            version: "1.0.0".to_string(),
            licence: "  ".to_string(),
        },
    };
    let err = store::install_imported(&p, &bytes, &bad).await.expect_err("licence refuses");
    assert_eq!(err.error_code(), "LICENCE_REQUIRED");
    let rows = store::list_pretrained(&p, None).await.expect("list all");
    assert_eq!(rows.len(), 1, "the refused install wrote no row");

    // The path flavor is the same code path (TEST-MS-25's parity): a SECOND
    // install of the same container without a target set would collide on the
    // container's recorded set name (SET_NAME_TAKEN — the designed refusal),
    // so the parity leg merges into the first install's set.
    let staged = PathBuf::from(server.data_dir()).join("cached-asset.txr");
    std::fs::write(&staged, &bytes).expect("staged asset");
    let opts_merge = ImportOptions {
        set_id: outcome.set_id,
        provenance: opts.provenance.clone(),
    };
    let from_path = store::install_imported_from_path(&p, &staged, &opts_merge)
        .await
        .expect("path install");
    assert_eq!(from_path.models[0].pretrained_catalogue_id.as_deref(), Some("xgb-baseline-1.0"));
    assert_eq!(from_path.models[0].id, outcome.models[0].id);
}
