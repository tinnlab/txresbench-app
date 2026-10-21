//! TEST-2 (ITEM-20) [acceptance] [invariant: INV-1] + TEST-26 (ITEM-22) — the two
//! guards that make the artifact-model's ENFORCEMENT section mechanical rather than
//! aspirational.
//!
//! ── TEST-2 — the server never opens a byte for meaning ──────────────────────────
//! INV-1 is a prose invariant, and prose does not survive a future agent being asked
//! to "just decode the first chunk server-side". The mechanical form is: no crate that
//! can parse a scientific array/table format may appear in the server's RESOLVED
//! dependency graph. You cannot decode what you cannot link.
//!
//! `scripts/check-no-format-crates.sh` is the single implementation (it also runs in
//! `just check-invariants` and can be run by hand); this test is the Rust-tier runner
//! for it, PLUS the two things a runner has to add or it is worth nothing:
//!   * a NEGATIVE CONTROL proving the matcher actually matches (a guard whose regex
//!     never fires reports PASS forever);
//!   * an assertion that the families the DESIGN names are still on the denylist, so
//!     a re-pinned "clean-up" edit that quietly drops `arrow` fails a TEST, not just
//!     a hash comparison.
//!
//! **Expected state on this branch: GREEN.** ITEM-12 (delete `serve_core` + the Arrow
//! serve wire) and ITEM-13 (delete `tiledb_serve`) have landed, so `arrow`/`arrow-ipc`
//! are gone from the resolved graph AND from `[workspace.dependencies]` — verify with
//! `scripts/check-no-format-crates.sh` (exits 0) or `grep '^name = "arrow' Cargo.lock`
//! (no match). It deliberately carries no skip attribute: a suppressed acceptance test
//! is a green light over an unmet invariant.
//!
//! *(This header read "**Expected state on this branch:** RED … `arrow`/`arrow-ipc` are
//! direct dependencies today" until 2026-07-31. That was false in the very commit that
//! added this file — `2751dac5` deleted the Arrow wire and this guard in one change — so
//! the `[acceptance]`/INV-1 anchor documented the opposite of what it measured, and a
//! reader auditing INV-1 from the anchor would have concluded the invariant was unmet
//! while the guard was proving it met. The expected state is now stated as something
//! runnable rather than as a remembered date.)*
//!
//! ── TEST-26 — a guard cannot be weakened in silence ─────────────────────────────
//! Every guard in `scripts/` asserts something about the code; nothing asserted
//! anything about the guards. The cheapest way past any of them is to edit the guard.
//! `scripts/check-guard-integrity.sh` pins each guard's bytes in a committed manifest;
//! this test proves the pin BITES — tampering with a guard's contents must fail the
//! check — and that the two dodges around it (delete the guard, or copy-and-gut it
//! under a new name) fail too.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

// ── local scaffolding ───────────────────────────────────────────────────────────
// `TmpRepo` is duplicated (minimally) in `tests/domain_surface/derived_vocabulary_test.rs`;
// see the note there. Independent scaffolding beats coupling two unrelated suites.

/// `<repo>` — `CARGO_MANIFEST_DIR` is `<repo>/src-app/server`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("CARGO_MANIFEST_DIR is <repo>/src-app/server")
        .to_path_buf()
}

struct TmpRepo {
    root: PathBuf,
}

impl TmpRepo {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("cyto-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&root).expect("create fixture root");
        let st = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .expect("git must be available to run a repo-rooted guard");
        assert!(st.success(), "git init failed in {}", root.display());
        Self { root }
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn copy_in(&self, src: &Path, rel: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
        fs::copy(src, &p)
            .unwrap_or_else(|e| panic!("copy {} -> {}: {e}", src.display(), p.display()));
    }
}

impl Drop for TmpRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Run a guard script with `bash`, from `dir`, with optional extra env.
fn run(dir: &Path, script: &str, env: &[(&str, &str)]) -> (bool, String) {
    let mut cmd = Command::new("bash");
    cmd.arg(script).current_dir(dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .unwrap_or_else(|e| panic!("spawn `bash {script}` in {}: {e}", dir.display()));
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.success(), text)
}

const DEP_GUARD: &str = "scripts/check-no-format-crates.sh";
const INTEGRITY_GUARD: &str = "scripts/check-guard-integrity.sh";
const MANIFEST: &str = "scripts/guard-hashes.txt";

// ════════════════════════════════════════════════════════════════════════════
//  TEST-2 — no format-parsing crate is linkable into the server
// ════════════════════════════════════════════════════════════════════════════

#[test]
fn the_server_dependency_graph_has_no_format_parsing_crate() {
    let (ok, out) = run(&repo_root(), DEP_GUARD, &[]);
    assert!(
        ok,
        "INV-1: the server stores and serves — it never opens a byte for meaning. A \
         format-parsing crate is resolvable in its dependency graph, which is the one \
         way that invariant can be broken without anyone writing a decoder:\n{out}"
    );
    // A guard that read an empty graph would also find no offenders. Pin the positives.
    assert!(
        out.contains("PASS") && out.contains("cargo metadata:") && out.contains("Cargo.lock:"),
        "the guard must report BOTH reads and their sizes, so an empty graph is \
         visible rather than indistinguishable from a clean one:\n{out}"
    );
}

#[test]
fn the_dependency_guard_actually_matches_what_is_present() {
    // NEGATIVE CONTROL. `CYTO_DEPGUARD_EXTRA_DENY` is ADD-only — it can make the guard
    // stricter and never laxer — so it is safe to leave in the script and is the only
    // honest way to prove the matcher fires. `serde` is unquestionably in the graph.
    let (ok, out) = run(
        &repo_root(),
        DEP_GUARD,
        &[("CYTO_DEPGUARD_EXTRA_DENY", "serde")],
    );
    assert!(
        !ok,
        "with `serde` added to the denied families the guard MUST fail. If it passes, \
         its matcher does not match and every green run so far meant nothing:\n{out}"
    );
    assert!(
        out.contains("serde") && out.contains("denied family: serde"),
        "the failure must name the crate AND the family that denied it:\n{out}"
    );
    // Both independent reads must see it — if only one does, the other is not reading.
    assert!(
        out.contains("cargo-metadata") && out.contains("Cargo.lock"),
        "both reads (cargo metadata + the lockfile) must report the hit:\n{out}"
    );
}

#[test]
fn the_denylist_still_covers_the_families_the_design_names() {
    // §0.3 Enforcement: "no format-parsing crate in the server's dependency graph",
    // with zarr / parquet / arrow / hdf5 / tiledb named. Hash-pinning (ITEM-22) makes a
    // silent edit impossible; this makes a DELIBERATE edit that drops one fail a test.
    let text = fs::read_to_string(repo_root().join(DEP_GUARD)).expect("guard readable");
    let families = text
        .split("DENY_FAMILIES='")
        .nth(1)
        .and_then(|s| s.split('\'').next())
        .expect("DENY_FAMILIES block present in the guard");
    for want in ["zarr", "parquet", "arrow", "hdf5", "tiledb"] {
        assert!(
            families.split_whitespace().any(|f| f == want),
            "the design names `{want}` as a format-parsing family; it is no longer on \
             the denylist:\n{families}"
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TEST-26 — tampering with a guard fails the integrity check
// ════════════════════════════════════════════════════════════════════════════

/// A fixture holding the real guards + the committed manifest, so the tamper is done on a
/// COPY and the working tree is never dirtied.
///
/// **The extension set here must equal `check-guard-integrity.sh`'s `GUARD_GLOBS`.** It read
/// `.sh` only, so when the globs widened to cover `scripts/check-*.mjs` (a guard is worth
/// nothing if it can be gutted in a diff nobody reads, whatever language it is written in)
/// every clean copy was missing three pinned files and read as three DELETED guards. The
/// fixture is what tells this suite what "the real set" is, so a fixture that models a
/// narrower set than the guard does is the same hard-coded-list mistake one layer down.
fn integrity_fixture() -> (TmpRepo, Vec<String>) {
    let repo = TmpRepo::new("guard-integrity");
    let src_scripts = repo_root().join("scripts");
    let mut names = Vec::new();
    for e in fs::read_dir(&src_scripts).expect("scripts/ readable") {
        let e = e.expect("dir entry");
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("check-") && (name.ends_with(".sh") || name.ends_with(".mjs")) {
            repo.copy_in(&e.path(), &format!("scripts/{name}"));
            names.push(name);
        }
    }
    repo.copy_in(&repo_root().join(MANIFEST), MANIFEST);
    names.sort();
    (repo, names)
}

#[test]
fn a_clean_copy_of_the_guards_passes_integrity() {
    let (repo, names) = integrity_fixture();
    assert!(
        names.len() >= 5,
        "the fixture copied only {} guard(s); it is not exercising the real set",
        names.len()
    );
    let (ok, out) = run(repo.root(), INTEGRITY_GUARD, &[]);
    assert!(
        ok,
        "an untouched copy of the committed guards must match the committed hashes. \
         If this fails, `scripts/guard-hashes.txt` is stale — re-pin it in the same \
         commit as the guard change: `scripts/check-guard-integrity.sh --update`\n{out}"
    );
    assert!(out.contains("PASS: all"), "expected a PASS line:\n{out}");
}

#[test]
fn tampering_with_a_guard_fails_it_against_the_committed_hash() {
    let (repo, names) = integrity_fixture();
    // Tamper with EVERY guard in turn — a check that only notices the one guard the
    // test author happened to pick is the same hard-coded-list mistake ITEM-21 exists
    // to remove.
    for name in &names {
        let (repo2, _) = integrity_fixture();
        let path = repo2.root().join("scripts").join(name);
        let mut body = fs::read_to_string(&path).expect("guard readable");
        // The realistic weakening: a short-circuit exit before anything is scanned.
        body.push_str("\nexit 0  # \"temporarily\" disabled\n");
        fs::write(&path, &body).expect("tamper");

        let (ok, out) = run(repo2.root(), INTEGRITY_GUARD, &[]);
        assert!(
            !ok,
            "editing `{name}` must fail the integrity check — otherwise every other \
             guard is one line away from being disabled in silence:\n{out}"
        );
        assert!(
            out.contains(name),
            "the failure must NAME the guard that changed:\n{out}"
        );
        assert!(
            out.contains("pinned:") && out.contains("on disk:"),
            "the failure must show the pinned vs on-disk hashes:\n{out}"
        );
        assert!(
            out.contains("--update"),
            "the failure must say how to re-pin a DELIBERATE change:\n{out}"
        );
    }
    drop(repo);
}

#[test]
fn deleting_a_guard_fails_integrity() {
    let (repo, names) = integrity_fixture();
    let victim = names.first().expect("at least one guard").clone();
    fs::remove_file(repo.root().join("scripts").join(&victim)).expect("delete");
    let (ok, out) = run(repo.root(), INTEGRITY_GUARD, &[]);
    assert!(!ok, "a deleted guard must fail the check:\n{out}");
    assert!(out.contains(&victim), "the failure must name it:\n{out}");
    assert!(
        out.contains("GONE"),
        "the failure must say it is gone:\n{out}"
    );
}

#[test]
fn the_rename_dodge_fails_integrity() {
    // Copy a guard to a new name, gut the copy, point the runner at it. Only a
    // default-deny "every guard-shaped file must be pinned" check notices.
    let (repo, names) = integrity_fixture();
    let src = repo
        .root()
        .join("scripts")
        .join(names.first().expect("a guard"));
    fs::write(
        repo.root().join("scripts/check-totally-legitimate.sh"),
        "#!/usr/bin/env bash\nexit 0\n",
    )
    .expect("plant the copy");
    assert!(src.is_file());

    let (ok, out) = run(repo.root(), INTEGRITY_GUARD, &[]);
    assert!(
        !ok,
        "an UNPINNED guard-shaped file must fail — the manifest is default-deny, not \
         an allow-list of the files somebody remembered:\n{out}"
    );
    assert!(
        out.contains("check-totally-legitimate.sh") && out.contains("UNPINNED"),
        "the failure must name the unpinned file:\n{out}"
    );
}

#[test]
fn the_integrity_guard_pins_itself() {
    // If the verifier is not in its own manifest, gutting the verifier is free.
    let manifest = fs::read_to_string(repo_root().join(MANIFEST)).expect("manifest readable");
    assert!(
        manifest.contains(INTEGRITY_GUARD),
        "`{INTEGRITY_GUARD}` must pin its own bytes:\n{manifest}"
    );
    for g in [DEP_GUARD, "scripts/check-derived-vocabulary.sh"] {
        assert!(
            manifest.contains(g),
            "`{g}` is not pinned in {MANIFEST}; run \
             `scripts/check-guard-integrity.sh --update`"
        );
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  TEST-2b — INV-1 AMENDED: the decode allowance is SCOPED to the gather module
// ════════════════════════════════════════════════════════════════════════════
//
// The owner amended INV-1 (DEC-23) after this branch measured that a serve-time gather
// cannot be done without decoding: the shard index addresses 4096-element CHUNKS rather
// than rows, the payload is a DEFLATE stream with no positional index, and `shuffle`
// strides an element's bytes across the whole chunk. The amendment is deliberately narrow:
// **the gather may decode the one chain the writer emits, and nothing else may decode
// anything.**
//
// A narrowed guard that stopped guarding would be indistinguishable from a deleted one, so
// the scope rule gets the same treatment every other guard here gets — a control that
// plants the violation and requires a FAIL, and a positive control requiring the allowed
// case to PASS. Without the second, a guard that failed on everything would satisfy the
// first.
//
// Both drive the REAL script through its `CYTO_DEPGUARD_SCAN_ROOT` seam, so they test the
// shipped guard rather than a re-implementation of its rule.

/// A minimal server source tree under `<tmp>/src-app/server/src`, with one file planted.
fn planted_tree(tag: &str, rel_path: &str, body: &str) -> TmpRepo {
    let repo = TmpRepo::new(tag);
    let p = repo
        .root()
        .join("src-app/server/src")
        .join(rel_path.trim_start_matches('/'));
    fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
    fs::write(&p, body).expect("write planted file");
    repo
}

const DECODER_USE: &str =
    "use flate2::read::GzDecoder;\nfn d(b: &[u8]) -> GzDecoder<&[u8]> { GzDecoder::new(b) }\n";

/// Decoders written against crates that are ALREADY LINKABLE and pass both halves of the
/// crate guard.
///
/// The first version of the scope check named `flate2` and its types, which bounded a
/// narrower rule than the amendment states: `miniz_oxide`, `zstd` and `brotli` are in
/// `Cargo.lock` today and are deliberately legal as general byte-stream codecs, so a decoder
/// written against any of them satisfied every check while sitting anywhere in the tree.
/// Each of these must be refused outside the gather module.
const OTHER_DECODERS: &[(&str, &str)] = &[
    (
        "miniz_oxide",
        "fn d(b: &[u8]) { let _ = miniz_oxide::inflate::decompress_to_vec(b); }\n",
    ),
    ("zstd", "fn d(b: &[u8]) { let _ = zstd::decode_all(b); }\n"),
    (
        "brotli",
        "fn d(b: &[u8]) { let _ = brotli::Decompressor::new(b, 4096); }\n",
    ),
    ("libflate", "use libflate::gzip::Decoder;\nfn d() {}\n"),
];

/// **THE CONTROL.** A decoder imported OUTSIDE the gather module must FAIL the guard.
#[test]
fn a_decoder_outside_the_gather_module_is_refused() {
    let repo = planted_tree("depscope-bad", "modules/workstore/data_api.rs", DECODER_USE);
    let (ok, out) = run(
        &repo_root(),
        DEP_GUARD,
        &[(
            "CYTO_DEPGUARD_SCAN_ROOT",
            repo.root().to_str().expect("utf-8 path"),
        )],
    );
    assert!(
        !ok,
        "INV-1 as amended allows decoding in the GATHER module and nowhere else. A \
         `flate2` decoder planted in `data_api.rs` was not refused, which means the \
         amendment bought the whole server the right to open bytes rather than the one \
         path the owner decided on:\n{out}"
    );
    assert!(
        out.contains("data_api.rs"),
        "the refusal must NAME the offending file — a guard that fails without saying \
         where sends the next person to read the whole tree:\n{out}"
    );
}

/// **THE POSITIVE CONTROL.** The same decoder INSIDE the gather module must PASS.
///
/// Without this, a scope rule that refused every file would satisfy the control above while
/// making the allowance unusable — a guard that fails on everything is not evidence that it
/// discriminates.
#[test]
fn the_same_decoder_inside_the_gather_module_is_allowed() {
    let repo = planted_tree(
        "depscope-ok",
        "modules/workstore/gather_decode.rs",
        DECODER_USE,
    );
    let (ok, out) = run(
        &repo_root(),
        DEP_GUARD,
        &[(
            "CYTO_DEPGUARD_SCAN_ROOT",
            repo.root().to_str().expect("utf-8 path"),
        )],
    );
    assert!(
        ok,
        "the gather module is the ONE place the amendment allows a decoder; refusing it \
         here would make the guard prohibit what the owner permitted:\n{out}"
    );
    assert!(
        out.contains("decode scope"),
        "the guard must SAY it ran the scope check, or a green run cannot be told apart \
         from one where the seam pointed at nothing:\n{out}"
    );
}

/// **AUDIT FINDING 11 — the scope rule must reach every LINKABLE decompressor, not one crate.**
///
/// The amendment is "the GATHER may decode the writer's chain, and nothing else may decode
/// anything". What is scoped is the ACT, so a check that only knows `flate2` enforces a rule
/// nobody wrote: `miniz_oxide`, `zstd` and `brotli` are already resolvable and legal, and a
/// decoder written against any of them would have passed.
#[test]
fn a_decoder_written_against_any_linkable_crate_is_refused_outside_the_gather_module() {
    for (name, body) in OTHER_DECODERS {
        let repo = planted_tree(
            &format!("depscope-{name}"),
            "modules/workstore/data_api.rs",
            body,
        );
        let (ok, out) = run(
            &repo_root(),
            DEP_GUARD,
            &[(
                "CYTO_DEPGUARD_SCAN_ROOT",
                repo.root().to_str().expect("utf-8 path"),
            )],
        );
        assert!(
            !ok,
            "a `{name}` decoder outside the gather module was NOT refused. It is linkable \
             today and passes the crate denylist by design, so the scope check is the only \
             thing standing between the amendment and 'the server may decode':\n{out}"
        );
        assert!(
            out.contains("data_api.rs"),
            "{name}: the refusal must name the file:\n{out}"
        );
    }
}

/// **…and the scanned tree is every crate that links into the server, not one directory.**
///
/// The check scanned `src-app/server/src` while the amendment says "nowhere else". A sibling
/// workspace crate compiles into the same binary, so a decoder there was out of scope for the
/// guard and in scope for the invariant.
#[test]
fn a_decoder_in_a_sibling_workspace_crate_is_refused_too() {
    let repo = TmpRepo::new("depscope-sibling");
    let p = repo.root().join("src-app/some-other-crate/src/lib.rs");
    fs::create_dir_all(p.parent().expect("parent")).expect("mkdir -p");
    fs::write(&p, DECODER_USE).expect("write planted file");

    let (ok, out) = run(
        &repo_root(),
        DEP_GUARD,
        &[(
            "CYTO_DEPGUARD_SCAN_ROOT",
            repo.root().to_str().expect("utf-8 path"),
        )],
    );
    assert!(
        !ok,
        "a decoder in a SIBLING crate under src-app/*/src links into the same server binary \
         and must be refused — scanning one directory bounded the guard more narrowly than \
         the invariant it enforces:\n{out}"
    );
    assert!(
        out.contains("some-other-crate"),
        "the refusal must name it:\n{out}"
    );
}
