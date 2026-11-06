//! TEST-PC-12 + TEST-PC-16 + TEST-PC-26 — the pretrained-catalogue generator
//! (ITEM-2; `scripts/pretrained-catalogue/gen_pretrained_catalogue.py`).
//!
//! The generator is a build-time Python tool, so its unit matrix lives in its
//! `--selftest` (TEST-PC-12's gate refusals — controlled access, undeclared
//! sources, empty licence, the GENIE record-id pattern, non-64-hex sha256,
//! unfrozen methods, missing env entries — plus TEST-PC-16's
//! changed-asset-under-version refusal and TEST-PC-26's parity/hygiene
//! matrix) and is driven from here like the packer's (TEST-PC-10/11).
//!
//! The fixtures are synthetic (marker ids `fx-*`, tiny opaque trees); nothing
//! is a real model, method or patient fact. The real-mode legs need
//! `/data/share/pbya/sigtrans` (`SIGTRANS_ROOT`) — they print a line and
//! return when that tree is absent.

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

fn generator() -> PathBuf {
    repo_root().join("scripts/pretrained-catalogue/gen_pretrained_catalogue.py")
}

fn fixture(rel: &str) -> PathBuf {
    repo_root().join("scripts/pretrained-catalogue/fixtures/gen").join(rel)
}

fn run_generator(args: &[&str]) -> std::process::Output {
    let out = Command::new("python3")
        .arg(generator())
        .args(args)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .unwrap_or_else(|e| panic!("generator spawn failed: {e}"));
    out
}

fn assert_ok(args: &[&str], what: &str) -> std::process::Output {
    let out = run_generator(args);
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

/// TEST-PC-12/16/26's matrix lives in the generator's `--selftest`: the good
/// fixture registry passes the gate; every refusal shape refuses with its
/// code naming the entry (controlled access, undeclared source, empty
/// licence, GENIE pattern, sha256 format, unfrozen published-rule method,
/// missing env entry, changed asset under its version); the assembled
/// document is the PROV-PC-1 shape (research_notice, asset fields, env
/// digests, needs, transfer aggregates, licence resolution) and is free of
/// policy violations.
#[test]
fn generator_selftest_passes() {
    let out = assert_ok(&["--selftest"], "generator --selftest");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("self-test OK"),
        "the generator self-test must end OK:\n{text}"
    );
}

/// TEST-PC-26 (PROV-PC-1 parity + hygiene): the committed fixture expectations
/// are byte-identical to a fresh fixture generation (catalogue, bundled
/// manifest and the served copy) — the generator is deterministic.
#[test]
fn generator_check_parity_on_fixtures() {
    assert_ok(&["--fixtures", "--check"], "generator --fixtures --check");
}

/// TEST-PC-12's driven behavior: `--check-restricted` on the all-open fixture
/// registry exits 0, and on the refusal registry exits 1 naming each refusing
/// entry with its code.
#[test]
fn generator_gate_exit_codes() {
    let out = assert_ok(&["--fixtures", "--check-restricted"], "good registry gate");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("gate: OK (3 entries)"), "gate output: {text}");

    let out = run_generator(&[
        "--fixtures",
        "--manifest",
        fixture("manifest-refusals.tsv").to_str().expect("utf-8"),
        "--check-restricted",
    ]);
    assert_eq!(out.status.code(), Some(1), "the refusal registry exits 1");
    let text = String::from_utf8_lossy(&out.stdout);
    for expect in [
        ("ASSET_CHANGED_UNDER_VERSION", "fx-rule-001"),
        ("ACCESS_CONTROLLED", "fx-controlled-001"),
        ("SOURCE_UNDECLARED", "fx-undeclared-001"),
        ("LICENCE_EMPTY", "fx-nolicence-001"),
        ("SOURCE_GENIE", "fx-genie-001"),
        ("ASSET_SHA256_FORMAT", "fx-nonhex-001"),
        ("PUBLISHED_RULE_NOT_FROZEN", "fx-notfrozen-001"),
        ("ENV_ENTRY_MISSING", "fx-envless-001"),
    ] {
        assert!(
            text.contains(expect.0) && text.contains(expect.1),
            "missing refusal {} naming {} in:\n{text}",
            expect.0,
            expect.1,
        );
    }
}

/// The real-mode gate + parity legs against the committed catalogue and the
/// benchmark tree (`SIGTRANS_ROOT`); they need the tree on this host.
#[test]
fn generator_real_mode_gate_and_parity() {
    let sigtrans = std::env::var("SIGTRANS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/data/share/pbya/sigtrans"));
    if !sigtrans.join("dev/code/manifest/methods.csv").exists() {
        eprintln!("SKIP: SIGTRANS_ROOT tree absent ({})", sigtrans.display());
        return;
    }
    assert_ok(&["--check-restricted"], "real-mode gate");
    assert_ok(&["--check"], "real-mode parity");
}
