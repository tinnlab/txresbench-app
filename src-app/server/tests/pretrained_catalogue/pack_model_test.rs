//! TEST-PC-10 + TEST-PC-11 — the pretrained-catalogue packer (ITEM-1;
//! `scripts/pretrained-catalogue/pack_model_txr.py`).
//!
//! TEST-PC-10 (integration): the packer's .txr output is byte-stable across
//! two runs, reports its own size + sha256, passes its own `--verify`, and
//! is accepted by the store's reader (`read_container_bytes`: magic, the
//! header facts, the framed entries, per-entry sha256, the PROV-SS-3 tree
//! digest, the empty training block, the end magic) — the same bytes then
//! import cleanly through the in-process seam (`install_imported`) and land
//! as a row with the pretrained provenance + licence.
//!
//! TEST-PC-11 (unit tier): the packer's `--selftest` refusal matrix (unsafe
//! relpaths, non-regular tree files, missing or empty facts fields, licence
//! handling — every refusal writes nothing) lives in the packer and is
//! driven from here so CI's plain Rust test run exercises it.
//!
//! The fixtures are a TINY SYNTHETIC tree — opaque bytes that mean nothing,
//! never content from a real use of the app.

use std::path::{Path, PathBuf};
use std::process::Command;

use txresbench::modules::model_store::container::{
    read_container_bytes, ContainerHeader, ContainerKind, END_MAGIC, MAGIC,
};
use txresbench::modules::model_store::store::{self, ImportOptions, Provenance};
use txresbench::modules::model_store::types::{ModelProvenance, ModelStoreLimits};

use crate::common::TestServer;
use super::pool;

/// The repo root (`CARGO_MANIFEST_DIR` is `src-app/server`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// The committed synthetic fixture tree + facts.
fn fixture(rel: &str) -> PathBuf {
    repo_root().join("scripts/pretrained-catalogue/fixtures/pack").join(rel)
}

fn run_packer(args: &[&str], what: &str) -> std::process::Output {
    let out = Command::new("python3")
        .arg(repo_root().join("scripts/pretrained-catalogue/pack_model_txr.py"))
        .args(args)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap_or_else(|e| panic!("{what}: spawn failed: {e}"));
    if !out.status.success() {
        panic!(
            "{what}: exit {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    out
}

/// The packer's two stdout lines: `size_bytes: N` + `sha256: <hex>`.
fn parse_report(stdout: &[u8]) -> (u64, String) {
    let text = String::from_utf8(stdout.to_vec()).expect("stdout is utf-8");
    let mut size = None;
    let mut sha = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("size_bytes: ") {
            size = Some(rest.parse::<u64>().expect("size parses"));
        } else if let Some(rest) = line.strip_prefix("sha256: ") {
            sha = Some(rest.trim().to_string());
        }
    }
    (size.unwrap_or_else(|| panic!("no size line in: {text}")), sha.unwrap_or_else(|| panic!("no sha line in: {text}")))
}

/// Pack the committed fixture into `dst` and return the bytes + the report.
fn pack_fixture(dst: &Path) -> (Vec<u8>, u64, String) {
    let out = run_packer(
        &[
            "--tree",
            fixture("tree").to_str().expect("utf-8"),
            "--facts",
            fixture("facts.json").to_str().expect("utf-8"),
            "--out",
            dst.to_str().expect("utf-8"),
        ],
        "pack the fixture",
    );
    assert!(out.stderr.is_empty(), "pack prints nothing to stderr");
    let (size, sha) = parse_report(&out.stdout);
    let bytes = std::fs::read(dst).expect("read the packed container");
    (bytes, size, sha)
}

/// The fixture's pinned pack results — the packer is deterministic, so the
/// bytes of the committed fixture are a fixed contract: a change here is a
/// format change with the store's reader, not an incidental drift.
const FIXTURE_BYTES: u64 = 1555;
const FIXTURE_SHA: &str = "fadf29c0dbbfbbb39c94aaad7fb5e300f14313a1e663494225acb21b96fa9d44";

/// TEST-PC-10 (layout + reader acceptance; the determinism leg is the next
/// test).
#[test]
fn packer_output_layout_and_reader_accepted() {
    let scratch = std::env::temp_dir().join(format!("pc-pack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).expect("scratch dir");

    let first = scratch.join("first.txr");
    let (bytes, size, sha) = pack_fixture(&first);
    assert_eq!(size, FIXTURE_BYTES, "the pinned container size");
    assert_eq!(sha, FIXTURE_SHA, "the pinned container sha256");
    assert_eq!(bytes.len() as u64, size, "the reported size is the real size");

    // The byte layout: leading magic, u32 header length, header JSON (the
    // store's OWN types parse it — the anti-drift boundary), framed entries,
    // u64 zero training count, end magic, nothing after.
    assert_eq!(&bytes[..MAGIC.len()], &MAGIC, "leading magic");
    assert_eq!(&bytes[bytes.len() - END_MAGIC.len()..], &END_MAGIC, "end magic");
    let header_len = u32::from_le_bytes(
        bytes[MAGIC.len()..MAGIC.len() + 4]
            .try_into()
            .expect("header length"),
    ) as usize;
    let header_bytes = &bytes[MAGIC.len() + 4..MAGIC.len() + 4 + header_len];
    let header: ContainerHeader =
        serde_json::from_slice(header_bytes).expect("the store's header type parses");
    assert_eq!(header.format_version, 1);
    assert_eq!(header.kind, ContainerKind::Model);
    assert!(header.set.is_none(), "a single-model container has no set block");
    assert!(header.training.is_none(), "no training block");
    assert_eq!(header.models.len(), 1);
    let model = &header.models[0];
    assert_eq!(model.token, "fx-rule-001");
    assert_eq!(model.facts.name, "Fx pretrained rule");
    assert_eq!(model.facts.method_id, "fx-pretrained-rule");
    assert_eq!(model.facts.method_version, "1.0.0");
    assert_eq!(model.facts.group, "response-call");
    assert_eq!(model.facts.group_label, "Response call");
    assert_eq!(model.facts.decision_day, 56.0);
    assert_eq!(model.facts.horizon, 238.0);
    assert_eq!(model.facts.contract, "2.0");
    assert_eq!(model.facts.env.base_digest, "ab".repeat(32));
    assert_eq!(model.facts.env.layer_digest, "cd".repeat(32));
    assert_eq!(model.facts.provenance.kind, ModelProvenance::Pretrained);
    assert_eq!(
        model.facts.provenance.catalogue_id.as_deref(),
        Some("fx-rule-001")
    );
    assert_eq!(
        model.facts.provenance.licence.as_deref(),
        Some("CC0 1.0 (synthetic fixture)")
    );
    assert!(model.facts.required_markers.is_some(), "the marker rule is carried");
    assert!(!model.facts.embeds_training_data);
    // The header's tree digest IS the engine's own digest of the same tree
    // (the Python port pin vs the Rust implementer — the load-bearing cross).
    let expected_digest =
        txresbench::modules::sandbox::stack::tree_sha256(&fixture("tree")).expect("digest");
    assert_eq!(model.tree_sha256, expected_digest, "packer digest == engine digest");
    // size_bytes is the SUM of the tree files (the payload), not the whole
    // container — the store's reader reconciles it against the framed bytes.
    let tree_size: u64 = std::fs::metadata(fixture("tree/manifest.json"))
        .expect("manifest size")
        .len()
        + std::fs::metadata(fixture("tree/weights/tree-01.bin"))
            .expect("weights size")
            .len();
    assert_eq!(model.size_bytes, tree_size);
}

/// TEST-PC-10's determinism leg: two runs of the packer are byte-equal, and
/// `--verify` + `--selftest` both pass on the committed fixture.
#[test]
fn packer_runs_are_byte_equal_and_verify_passes() {
    let scratch = std::env::temp_dir().join(format!("pc-verify-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).expect("scratch dir");

    let first = scratch.join("a.txr");
    let second = scratch.join("b.txr");
    let (bytes_a, size_a, sha_a) = pack_fixture(&first);
    let (bytes_b, size_b, sha_b) = pack_fixture(&second);
    assert_eq!(bytes_a, bytes_b, "two runs are byte-equal");
    assert_eq!((size_a, &sha_a), (size_b, &sha_b));

    // `--verify` re-opens the same file and reports the same size + sha256.
    let out = run_packer(&["--verify", first.to_str().expect("utf-8")], "verify");
    assert!(out.stderr.is_empty(), "verify prints nothing to stderr");
    let (vsize, vsha) = parse_report(&out.stdout);
    assert_eq!((vsize, vsha), (size_a, sha_a));

    // TEST-PC-11's refusal matrix runs as the packer's own selftest.
    let out = run_packer(&["--selftest"], "selftest");
    assert!(out.status.success(), "the packer selftest passes");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("all checks passed"), "selftest summary: {text}");
}

/// TEST-PC-10's second half: the packer's bytes import cleanly through the
/// store's in-process seam and land as a pretrained row.
#[tokio::test]
async fn packer_output_imports_through_the_store_seam() {
    let server = TestServer::spawn().await;
    let p = pool(&server).await;

    let staged = server.data_dir().join("packer-fixture.txr");
    let (bytes, ..) = pack_fixture(&staged);

    // The reader seam itself (byte-level acceptance, no server needed).
    let staging = server.data_dir().join("reader-staging");
    let restored = read_container_bytes(&bytes, &staging, ModelStoreLimits::MAX_CONTAINER_BYTES)
        .expect("the store's reader accepts the packer's bytes");
    assert_eq!(restored.models.len(), 1);
    assert_eq!(restored.models[0].token, "fx-rule-001");
    assert!(restored.training.is_empty());
    assert!(restored.models[0].dir.join("manifest.json").is_file());
    assert!(restored.models[0].dir.join("weights").join("tree-01.bin").is_file());

    // The install seam: a pretrained import stamps id + version + licence.
    let opts = ImportOptions {
        set_id: None,
        provenance: Provenance::Pretrained {
            catalogue_id: "fx-rule-001".to_string(),
            version: "1.0.0".to_string(),
            licence: "CC0 1.0 (synthetic fixture)".to_string(),
        },
    };
    let outcome = store::install_imported(&p, &bytes, &opts)
        .await
        .expect("the import accepts the packer's bytes");
    assert_eq!(outcome.models.len(), 1);
    assert_eq!(outcome.models[0].provenance.as_str(), "pretrained");
    assert_eq!(
        outcome.models[0].pretrained_catalogue_id.as_deref(),
        Some("fx-rule-001")
    );
    assert_eq!(
        outcome.models[0].pretrained_catalogue_version.as_deref(),
        Some("1.0.0")
    );
    assert_eq!(
        outcome.models[0].licence.as_deref(),
        Some("CC0 1.0 (synthetic fixture)")
    );

    let rows = store::list_pretrained(&p, Some("fx-rule-001"))
        .await
        .expect("list the installed rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].pretrained_catalogue_version.as_deref(), Some("1.0.0"));
}

/// The packer's optional `conversions` (the package's `model.conversions`)
/// reach the store: the reader accepts them in the header, a pretrained
/// install stores them and resolve hands them to the engine — so a
/// pretrained model of a method without its own probability gives chances.
/// The committed fixture (no conversions) keeps its pinned bytes (the
/// layout test above).
#[tokio::test]
async fn packer_conversions_reach_the_store() {
    use txresbench::modules::execution_engine::predictions::Conversions;
    use txresbench::modules::rootfs;

    let server = TestServer::spawn().await;
    let p = pool(&server).await;
    let _g = rootfs::scoped_data_root(server.data_dir());

    let mut facts: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture("facts.json")).expect("read the fixture facts"),
    )
    .expect("the fixture facts parse");
    let map = serde_json::json!({
        "progression@238": {"kind": "logistic", "a": -0.4, "b": 1.7, "mu": 0.9,
                            "sd": 0.35, "n": 120, "rate": 0.4},
        "no_response": {"kind": "constant", "a": 0.0, "b": 0.0, "mu": 0.0,
                        "sd": 1.0, "n": 64, "rate": 0.25},
    });
    facts["conversions"] = map.clone();
    let facts_path = server.data_dir().join("facts-with-conversions.json");
    std::fs::write(&facts_path, facts.to_string()).expect("write the facts");
    let out = server.data_dir().join("packer-conversions.txr");
    let report = run_packer(
        &[
            "--tree",
            fixture("tree").to_str().expect("utf-8"),
            "--facts",
            facts_path.to_str().expect("utf-8"),
            "--out",
            out.to_str().expect("utf-8"),
        ],
        "pack with conversions",
    );
    let (size, _) = parse_report(&report.stdout);
    assert_ne!(size, FIXTURE_BYTES, "the header grew by the conversions");
    let bytes = std::fs::read(&out).expect("the packed container");

    let want: Conversions = serde_json::from_value(map).expect("the map parses");
    let restored = read_container_bytes(
        &bytes,
        &server.data_dir().join("conv-staging"),
        ModelStoreLimits::MAX_CONTAINER_BYTES,
    )
    .expect("the store's reader accepts the conversions");
    assert_eq!(restored.models[0].header.facts.conversions, want);

    let outcome = store::install_imported(
        &p,
        &bytes,
        &ImportOptions {
            set_id: None,
            provenance: Provenance::Pretrained {
                catalogue_id: "fx-rule-001".to_string(),
                version: "1.0.0".to_string(),
                licence: "CC0 1.0 (synthetic fixture)".to_string(),
            },
        },
    )
    .await
    .expect("the pretrained install accepts them");
    let assets = store::resolve_assets(&p, &outcome.model_ids)
        .await
        .expect("resolve the installed model");
    assert_eq!(assets[0].conversions, want, "the engine receives the packed map");

    // A bad map never leaves the packer (and writes nothing).
    facts["conversions"] = serde_json::json!({"progression": {"kind": "logistic", "a": 0,
        "b": 1, "mu": 0, "sd": 1, "n": 3, "rate": 0.5}});
    std::fs::write(&facts_path, facts.to_string()).expect("write the facts");
    let refused = server.data_dir().join("refused.txr");
    let res = Command::new("python3")
        .arg(repo_root().join("scripts/pretrained-catalogue/pack_model_txr.py"))
        .args([
            "--tree",
            fixture("tree").to_str().expect("utf-8"),
            "--facts",
            facts_path.to_str().expect("utf-8"),
            "--out",
            refused.to_str().expect("utf-8"),
        ])
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .expect("spawn the packer");
    assert!(!res.status.success());
    assert!(
        String::from_utf8_lossy(&res.stderr).contains("ERROR FACTS_BAD_CONVERSION"),
        "{}",
        String::from_utf8_lossy(&res.stderr)
    );
    assert!(!refused.exists(), "a refusal writes nothing");
}
