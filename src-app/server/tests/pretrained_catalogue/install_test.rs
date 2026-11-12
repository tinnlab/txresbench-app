//! TEST-PC-07 + TEST-PC-08 — the install route over the real spawned
//! server: a fixture asset packed by `pack_model_txr.py` (the ONLY writer of
//! fixture `.txr` bytes — the cross-boundary proof the store's reader
//! accepts) installed from the bundled dir (zero network), the store row +
//! the verified resolve shape, the tampered-bundle refusal (409 +
//! quarantine + no row), and the module-shape grep half (install is
//! provision-only — no execution, no sandbox, INV-6).

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::common::{TestOptions, TestServer};

use super::*;

/// The pack fixture's pinned piped results (pack_model_test.rs pins the same
/// numbers — a change here is a format change with the store's reader).
/// `pub(super)`: the hygiene suite's TEST-PC-13 install leg (the store row's
/// licence == the entry's) reuses the same pinned bytes.
pub(super) const FIXTURE_BYTES: u64 = 1555;
pub(super) const FIXTURE_SHA: &str =
    "fadf29c0dbbfbbb39c94aaad7fb5e300f14313a1e663494225acb21b96fa9d44";

const FX_001: &str = "fx-rule-001";
const FX_002: &str = "fx-rule-002";

/// Pack the committed synthetic fixture through the REAL packer, verify the
/// pinned size + sha256, and write the asset into `bundled_dir` under its
/// release name.
pub(super) fn pack_fixture(bundled_dir: &std::path::Path, name: &str) -> Vec<u8> {
    let out = std::process::Command::new("python3")
        .arg(repo_root().join("scripts/pretrained-catalogue/pack_model_txr.py"))
        .args([
            "--tree",
            repo_root()
                .join("scripts/pretrained-catalogue/fixtures/pack/tree")
                .to_str()
                .expect("utf-8"),
            "--facts",
            repo_root()
                .join("scripts/pretrained-catalogue/fixtures/pack/facts.json")
                .to_str()
                .expect("utf-8"),
            "--out",
            &bundled_dir.join(name).display().to_string(),
        ])
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap_or_else(|e| panic!("pack: spawn failed: {e}"));
    assert!(
        out.status.success(),
        "pack failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report = String::from_utf8_lossy(&out.stdout);
    let size = report
        .lines()
        .find_map(|l| l.strip_prefix("size_bytes: ").map(|v| v.parse::<u64>().expect("size")))
        .unwrap_or_else(|| panic!("no size line: {report}"));
    let sha = report
        .lines()
        .find_map(|l| l.strip_prefix("sha256: ").map(|v| v.trim().to_string()))
        .unwrap_or_else(|| panic!("no sha line: {report}"));
    assert_eq!(size, FIXTURE_BYTES, "the pinned container size");
    assert_eq!(sha, FIXTURE_SHA, "the pinned container sha256");
    std::fs::read(bundled_dir.join(name)).expect("read the packed asset")
}

/// The bundled-dir fixture: a good `fx-rule-001@1.0.0.txr` and a
/// SAME-SIZE byte-flipped `fx-rule-002@1.0.0.txr` (the size check passes,
/// the sha256 does not — INV-2's refusal path).
async fn install_fixture() -> (TestServer, FixtureHttpServer, PathBuf) {
    let scratch = std::env::temp_dir().join(format!(
        "pc-install-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let bundled_dir = scratch.join("pretrained-bundled");
    std::fs::create_dir_all(&bundled_dir).expect("bundled dir");
    let good = pack_fixture(&bundled_dir, &format!("{FX_001}@1.0.0.txr"));
    let tampered: Vec<u8> = good.iter().copied().rev().collect();
    assert_eq!(tampered.len(), good.len(), "same-size tamper");
    std::fs::write(bundled_dir.join(format!("{FX_002}@1.0.0.txr")), &tampered).expect("tamper");

    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![
            fixture_entry(
                FX_001,
                "fx-pretrained-rule",
                2,
                true,
                "http://127.0.0.1:1/assets/unused.txr",
                true,
                FIXTURE_BYTES,
                FIXTURE_SHA,
            ),
            fixture_entry(
                FX_002,
                "fx-pretrained-rule",
                2,
                true,
                "http://127.0.0.1:1/assets/unused.txr",
                true,
                FIXTURE_BYTES,
                FIXTURE_SHA,
            ),
        ]))
        .expect("fixture catalogue serializes"),
        vec![],
    )
    .await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        pretrained_bundled_dir: Some(bundled_dir.clone()),
        ..Default::default()
    })
    .await;
    (server, fx, bundled_dir)
}

/// TEST-PC-07: the bundled install (INV-8's zero-network source) — 200 with
/// `source: "bundled"` + the store row (provenance pretrained,
/// pretrained_catalogue_id, licence, method_version, env digests recorded
/// from the header — INV-7) and the verified resolve shape whose tree_sha256
/// re-verifies; a second install of the same (id, version) is idempotent
/// (the same model_id, no second row).
#[tokio::test]
async fn bundled_install_records_the_store_row_and_resolves() {
    let (server, fx, _bundled_dir) = install_fixture().await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let body: Value = resp.json().await.expect("refresh json");
    assert_eq!(body["origin"], "live");

    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_001}/install")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("install");
    assert_eq!(resp.status().as_u16(), 200, "bundled install -> 200");
    let body: Value = resp.json().await.expect("install json");
    assert_eq!(body["status"], "installed");
    assert_eq!(body["source"], "bundled");
    assert_eq!(body["catalogue_id"], FX_001);
    assert_eq!(body["version"], "1.0.0");
    assert_eq!(body["licence"], "CC0 1.0 (synthetic fixture)");
    assert_eq!(body["size_bytes"], FIXTURE_BYTES);
    let model_id = body["model_id"]
        .as_str()
        .expect("model_id")
        .to_string();

    // Idempotency: the same (id, version) again answers the same row.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_001}/install")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("reinstall");
    assert_eq!(resp.status().as_u16(), 200);
    let again: Value = resp.json().await.expect("reinstall json");
    assert_eq!(again["model_id"], model_id, "the existing row");

    // The store row (the REST seam — the module never reads the tables): the
    // pretrained provenance + recorded facts.
    let resp = server
        .client
        .get(server.api_url("/txr/models?provenance=pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("inventory");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("inventory json");
    let rows = body["models"].as_array().expect("models");
    assert_eq!(rows.len(), 1, "exactly one pretrained row");
    let row = &rows[0];
    assert_eq!(row["id"], model_id);
    assert_eq!(row["provenance"], "pretrained");
    assert_eq!(row["pretrained_catalogue_id"], FX_001);
    assert_eq!(row["pretrained_catalogue_version"], "1.0.0");
    assert_eq!(row["licence"], "CC0 1.0 (synthetic fixture)");
    assert_eq!(row["method_id"], "fx-pretrained-rule");
    assert_eq!(row["method_version"], "1.0.0");

    // INV-7: the env digests are the header's recorded values, never
    // re-derived (facts.json's fixture values) — the detail's recorded env.
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/models/{model_id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    assert_eq!(resp.status().as_u16(), 200);
    let detail: Value = resp.json().await.expect("detail json");
    assert_eq!(
        detail["env"]["base_digest"],
        "abababababababababababababababababababababababababababababababab"
    );
    assert_eq!(
        detail["env"]["layer_digest"],
        "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
    );

    // The verified reuse shape (PROV-EE-9): resolve re-verifies and the
    // tree_sha256 recomputes over the store's own tree dir.
    let resp = server
        .client
        .post(server.api_url("/txr/models/resolve"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [model_id]}))
        .send()
        .await
        .expect("resolve");
    assert_eq!(resp.status().as_u16(), 200, "resolve -> 200");
    let body: Value = resp.json().await.expect("resolve json");
    let assets = body["assets"].as_array().expect("assets");
    assert_eq!(assets.len(), 1);
    let asset = &assets[0];
    assert_eq!(asset["model_id"], model_id);
    assert_eq!(asset["method_id"], "fx-pretrained-rule");
    assert_eq!(asset["method_version"], "1.0.0");
    assert_eq!(asset["contract"], "2.0");
    let host_dir = PathBuf::from(asset["host_dir"].as_str().expect("host_dir"));
    let recomputed =
        txresbench::modules::sandbox::stack::tree_sha256(&host_dir).expect("tree digest");
    assert_eq!(
        asset["tree_sha256"], recomputed,
        "the resolve digest re-verifies over the store tree"
    );
    drop(fx);
}

/// TEST-PC-07's refusal arm: a byte-flipped bundled file (same size — the
/// size gate passes, the sha256 does not) → 409 PRETRAINED_VERIFY_FAILED,
/// the file is quarantined, and NO store row exists.
#[tokio::test]
async fn tampered_bundle_is_409_and_never_imports() {
    let (server, fx, bundled_dir) = install_fixture().await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);

    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_002}/install")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("tampered install");
    assert_eq!(resp.status().as_u16(), 409, "tampered bundle -> 409");
    let body: Value = resp.json().await.expect("tampered json");
    assert_eq!(
        super::super::model_store::error_code(&body),
        "PRETRAINED_VERIFY_FAILED"
    );

    // The quarantine is the flipped file renamed aside (a best-effort move —
    // the 409 is the answer either way).
    let good = bundled_dir.join(format!("{FX_002}@1.0.0.txr"));
    assert!(!good.exists(), "the tampered file is moved aside");
    assert!(bundled_dir.join(format!("{FX_002}@1.0.0.txr.rejected")).exists());

    // No store row — the bytes never reached the store (INV-2).
    let resp = server
        .client
        .get(server.api_url("/txr/models?provenance=pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("inventory");
    let body: Value = resp.json().await.expect("inventory json");
    assert_eq!(body["models"].as_array().expect("models").len(), 0);
    drop((fx, bundled_dir));
}

/// TEST-PC-08 (INV-6, grep half): the install path is provision-only — the
/// module's source never executes a model and never touches the sandbox
/// (grep over the module's shipped files; the execution path is the engine's
/// own reuse mode driven by `resolve`, tested engine-side).
#[test]
fn install_path_is_provision_only() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/pretrained_catalogue");
    let mut sources = String::new();
    for name in ["mod.rs", "catalogue.rs", "downloader.rs", "install.rs", "bundled.rs", "routes.rs"] {
        let text = std::fs::read_to_string(dir.join(name))
            .unwrap_or_else(|e| panic!("read {name}: {e}"));
        sources.push_str(&text);
        sources.push('\n');
    }
    assert!(!sources.contains("run_method"), "no method execution");
    assert!(!sources.contains("sandbox::"), "no sandbox import");
}
