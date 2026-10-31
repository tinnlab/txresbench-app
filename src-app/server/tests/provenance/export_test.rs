//! TEST-21 — the export HTTP path end-to-end: `POST /provenance/export {project_id,
//! target, scope}` → 200 {export_id}; `GET /provenance/export/{id}` streams a
//! valid, non-empty `application/zip`. (Bundle member composition is covered by
//! the unit tests; here we assert the real HTTP path + a valid zip.)

use super::*;
use std::path::{Path, PathBuf};
use cytoanalyst::modules::workstore::object_store::sha256_hex as cyto_sha256_hex;

#[tokio::test]
async fn export_builds_and_downloads_a_zip() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "export project").await;

    // Record a run so the export has a closure to walk.
    let run = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run_id = run["run_id"].as_str().expect("run_id").to_string();

    // Build the bundle (single-run scope).
    let build = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target": run_id, "scope": "single" }))
        .send()
        .await
        .expect("build export");
    assert_eq!(build.status().as_u16(), 200, "export build is 200");
    let body: Value = build.json().await.expect("export json");
    let export_id = body["export_id"].as_str().expect("export_id");

    // Download it → application/zip, valid PK magic, non-empty.
    let dl = server
        .client
        .get(server.api_url(&format!("/provenance/export/{export_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("download export");
    assert_eq!(dl.status().as_u16(), 200, "download is 200");
    let ct = dl
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    assert_eq!(ct, "application/zip", "content-type is application/zip");
    let bytes = dl.bytes().await.expect("zip bytes");
    assert!(bytes.len() > 4, "bundle is non-empty");
    assert_eq!(&bytes[..4], b"PK\x03\x04", "valid zip local-file-header magic");
}

// TEST-13 [ITEM-7, ITEM-8] — the two OUT-OF-APP trust surfaces, asserted on the
// REAL bundle bytes: `manifest.json` (the RO-Crate metadata) carries a
// `FormalParameter` naming the filtered column, and `methods.md` prose states what
// was filtered on. Covers BOTH sources: a PROMOTED run (params column) and a
// PRE-promotion run whose column holds only `{seed, language, arch}` and whose
// science therefore comes from the re-run spec (DEC-9) — neither may present
// runtime metadata as science.
#[tokio::test]
async fn the_exported_crate_documents_what_was_filtered_on() {
    use crate::dataset::hardening_common::{
        download_zip, export_bundle, insert_run, run_template, unzip_store, used_edge,
    };

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "crate predicate project").await;
    let pool = pool_for(&server).await;

    // (a) A promoted `cell.filter` run recorded by the production recorder.
    let promoted = record_filter_run(&pool, project_id, root_id).await;

    // (b) A PRE-promotion run: the legacy `{seed, language, arch}` params column,
    //     with its real science only in the stashed re-run spec.
    let legacy_id = Uuid::new_v4();
    let mut legacy = run_template(legacy_id, Some(project_id), None);
    legacy.generator_id = "cell.filter".into();
    legacy.params = json!({ "seed": 0, "language": "python", "arch": "x86_64" });
    legacy.rerun_spec_json = Some(json!({
        "language": "python",
        "params": { "criteria": [{ "column": "n_genes_by_counts", "control": "range", "min": 250 }], "label": "legacy" },
    }));
    legacy.inputs_json = json!([used_edge("expression", "artifact", Some(root_id), &root_hash)]);
    insert_run(&pool, &legacy).await;

    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let members = unzip_store(&zip);
    let text = |name: &str| -> String {
        members
            .iter()
            .find(|(n, _)| n.ends_with(name))
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .unwrap_or_else(|| panic!("bundle member {name}"))
    };

    // Both runs are in the exported closure.
    let manifest = text("manifest.json");
    assert!(manifest.contains(&promoted.to_string()), "the promoted run is in the crate");
    assert!(manifest.contains(&legacy_id.to_string()), "the pre-promotion run is in the crate");

    // ITEM-7 — FormalParameters name the science from BOTH sources…
    assert!(manifest.contains("FormalParameter"), "params render as FormalParameters");
    assert!(manifest.contains("pct_counts_mito"), "the promoted run's filtered column: {manifest}");
    assert!(manifest.contains("n_genes_by_counts"), "the legacy run's science via the fallback");
    // …and never the runtime metadata, from either source.
    assert!(!manifest.contains("\"name\": \"language\""), "`language` is never a FormalParameter");
    assert!(!manifest.contains("\"name\": \"arch\""), "`arch` is never a FormalParameter");

    // ITEM-8 — the prose states what was filtered on, for both runs.
    let methods = text("methods.md");
    assert!(methods.contains("pct_counts_mito ≤ 10"), "promoted run's predicate in prose: {methods}");
    assert!(methods.contains("n_genes_by_counts ≥ 250"), "legacy run's predicate in prose: {methods}");
    // Each committed column IS its run's label, verbatim (filter package 0.9.0, a62c3d80).
    assert!(
        methods.contains("labelled `lowqc`") && methods.contains("labelled `legacy`"),
        "both mask columns are named by their labels, verbatim: {methods}"
    );
    assert!(
        !methods.contains("keep_lowqc") && !methods.contains("keep_legacy"),
        "…and never as a `keep_`-prefixed column, which no run commits: {methods}"
    );
    assert!(!methods.contains("x86_64"), "prose never names runtime metadata");
}

// F2-15 / F2-16 / F2-17 / F2-18 — the four honesty defects, asserted on the REAL
// exported bundle bytes (real HTTP → real assembler → real zip), not on a unit
// fixture:
//
//   F2-15  methods.md narrated `params.criteria` ALONE, so a `gate` allow-list, a
//          `cells` input-slot allow-list and a seeded `max_cells` RANDOM subsample
//          — all of which the kernel intersects into the committed mask — were
//          silently absent, and the prose claimed more kept cells than ran.
//   F2-16  a step whose code blob is missing/empty got a COMMENT stub that run.sh
//          still executed: `Reproduce capsule complete.` / EXIT=0 / zero outputs.
//   F2-17  the export never consulted readiness, shipped no verdict, and asserted
//          unconditionally that the bundle "contains everything needed to re-run".
//   F2-18  run.sh never compared the regenerated outputs to the recorded hashes.
#[tokio::test]
async fn the_bundle_states_every_mask_term_and_its_own_reproducibility_gaps() {
    use crate::dataset::hardening_common::{
        download_zip, export_bundle, insert_run, run_template, store_code, unzip_store, used_edge,
    };

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "bundle honesty project").await;
    let pool = pool_for(&server).await;

    // (A) A `cell.filter` run whose committed mask is criteria AND a cell-set INPUT
    //     SLOT AND a `gate` allow-list, THEN a seeded random down-sample.
    let filter_id = Uuid::new_v4();
    let mut filter = run_template(filter_id, Some(project_id), None);
    filter.generator_id = "cell.filter".into();
    filter.rerun_spec_json = Some(json!({
        "language": "python",
        "params": {
            "criteria": [{ "column": "n_genes_by_counts", "control": "range", "min": 500 }],
            "gate": ["c1", "c2", "c3"],
            "max_cells": 2,
            "label": "gated",
        },
    }));
    filter.inputs_json = json!([
        used_edge("expression", "artifact", Some(root_id), &root_hash),
        used_edge("cells", "artifact", None, &format!("sha256:{}", "b".repeat(64))),
    ]);
    insert_run(&pool, &filter).await;

    // (B) A run whose captured code is a ZERO-BYTE blob — the reachable form of "the
    //     bundle cannot include this step's code". It used to yield a capsule that
    //     ran it and exited 0 having computed nothing.
    let ghost_sha = store_code(&pool, "", "python").await;
    let ghost_id = Uuid::new_v4();
    let mut ghost = run_template(ghost_id, Some(project_id), None);
    ghost.code_sha256 = Some(ghost_sha.clone());
    ghost.env_rootfs_sha256 = Some("deadbeef".into());
    ghost.inputs_json = json!([used_edge("expression", "artifact", Some(root_id), &root_hash)]);
    insert_run(&pool, &ghost).await;

    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let find = |name: &str| -> Option<String> {
        members
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
    };
    let text = |name: &str| -> String {
        find(name).unwrap_or_else(|| {
            panic!("bundle member {name}; members = {:?}", members.iter().map(|(n, _)| n).collect::<Vec<_>>())
        })
    };

    // ---- F2-15: methods.md states EVERY contributor to the committed mask ----
    let methods = text("methods.md");
    assert!(methods.contains("n_genes_by_counts ≥ 500"), "the criterion: {methods}");
    assert!(methods.contains("allow-list of 3 cells"), "the `gate` allow-list: {methods}");
    assert!(methods.contains("`cells` input slot"), "the input-slot allow-list: {methods}");
    assert!(methods.contains("at most 2 cells"), "the down-sample cap: {methods}");
    assert!(methods.contains("SEEDED RANDOM"), "…stated to be a RANDOM subsample: {methods}");
    // The committed column IS the label, verbatim (filter package 0.9.0, a62c3d80).
    assert!(methods.contains("labelled `gated`"), "the committed mask column: {methods}");
    assert!(
        !methods.contains("keep_gated"),
        "…and never as a `keep_`-prefixed column, which no run commits: {methods}"
    );

    // ---- F2-16: the un-includable code becomes a stub that REFUSES to run ----
    let stub = members
        .iter()
        .filter(|(n, _)| n.starts_with("scripts/"))
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .find(|s| s.contains("PROVENANCE GAP"))
        .expect("a hard-failing stub script for the un-includable code blob");
    assert!(stub.contains("sys.exit(1)"), "the stub exits NON-ZERO: {stub}");
    assert!(stub.contains(&ghost_id.to_string()), "it names the run: {stub}");
    assert!(!stub.contains("# code blob"), "never the old comment-only stub: {stub}");

    let gaps = text("PROVENANCE-GAPS.md");
    assert!(gaps.contains(&ghost_id.to_string()), "the gap names the run: {gaps}");

    // ---- F2-17: the readiness verdict TRAVELS IN THE BUNDLE and is honest ----
    let readiness: Value = serde_json::from_str(&text("readiness.json")).expect("readiness.json");
    assert_eq!(readiness["ready"], json!(false), "this closure cannot reproduce: {readiness}");
    assert_eq!(readiness["flags"]["code_captured"], json!(false), "{readiness}");
    let ghost_verdict = readiness["runs"]
        .as_array()
        .expect("runs")
        .iter()
        .find(|r| r["run_id"] == json!(ghost_id.to_string()))
        .expect("the ghost run's per-run verdict");
    assert_eq!(ghost_verdict["code_captured"], json!(false), "{ghost_verdict}");
    assert!(
        readiness["gaps"].as_array().expect("gaps").iter().any(|g| g
            .as_str()
            .is_some_and(|s| s.starts_with("code_captured:") && s.contains(&ghost_id.to_string()))),
        "the gap names the flag AND the run: {readiness}"
    );

    let readme = text("REPRODUCING.md");
    assert!(
        !readme.contains("contains everything needed to re-run"),
        "an unchecked completeness claim must never ship: {readme}"
    );
    assert!(readme.contains("INCOMPLETE PROVENANCE"), "{readme}");
    assert!(readme.contains("code_captured"), "the failing condition is named: {readme}");

    // ---- F2-18: the capsule actually compares its outputs, and says what that proves ----
    let verify = text("verify_outputs.sh");
    assert!(verify.contains("WHAT A `REPRODUCED` VERDICT PROVES"), "{verify}");
    assert!(verify.contains("WHAT IT DOES NOT PROVE"), "{verify}");
    // ROUND-4 (R3F-02/R3-24): the exit status is DERIVED from the per-step
    // executability class, not from a single accumulated `$RC`. A mismatch exits 1;
    // "nothing was checkable, and nothing ever could be" exits 0 with a stated
    // reason; "something was runnable here and was not run" exits 1.
    assert!(verify.contains("NOT REPRODUCED:"), "a mismatch is named: {verify}");
    assert!(
        verify.contains("never executable") && verify.contains("this host did not execute it"),
        "the two skip classes are distinguished: {verify}"
    );
    assert!(verify.contains("exit 1"), "a real failure exits non-zero: {verify}");
    let run_sh = text("run.sh");
    assert!(
        run_sh.contains("bash \"$HERE/verify_outputs.sh\""),
        "run.sh's last act is the comparison: {run_sh}"
    );
    assert!(
        run_sh.contains("not a reproducibility verdict"),
        "the bare `Reproduce capsule complete.` line is disclaimed: {run_sh}"
    );
}

// ─────────────────────── ROUND-4b capsule-verdict harness ────────────────────────

/// Write an exported bundle's members into a fresh temp dir, optionally
/// pre-populating per-step `work/NN/outputs` files, so the generated scripts can be
/// EXECUTED exactly as a third party would run them.
fn stage_bundle(members: &[(String, Vec<u8>)], outputs_on_disk: &[(String, &str)]) -> PathBuf {
    use std::io::Write as _;
    let dir = std::env::temp_dir().join(format!("cyto-capsule-{}", Uuid::new_v4()));
    let staged: Vec<(&String, Vec<u8>)> = members
        .iter()
        .map(|(n, b)| (n, b.clone()))
        .chain(outputs_on_disk.iter().map(|(n, s)| (n, s.as_bytes().to_vec())))
        .collect();
    for (name, bytes) in staged {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir bundle dir");
        std::fs::File::create(&p).expect("create member").write_all(&bytes).expect("write member");
    }
    dir
}

/// Run a staged capsule script under bash and return `(exit code, stdout, stderr)`.
/// The EXIT CODE is what `REPRODUCING.md` tells the reader is the verdict, so it is
/// observed, never inferred.
fn run_capsule_script(dir: &Path, script: &str) -> (Option<i32>, String, String) {
    let out = std::process::Command::new("bash")
        .arg(dir.join(script))
        .current_dir(dir)
        .output()
        .expect("bash is required to run the generated capsule scripts");
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

/// The `work/NN` dir the generated verifier expects a given run's regenerated
/// outputs in (parsed out of the emitted `verify_step 'NN' '<run>' 'work/NN' …` line,
/// so the test never has to guess the topological index).
fn work_dir_for(verify_sh: &str, run_id: Uuid) -> String {
    let needle = format!("'{run_id}'");
    for line in verify_sh.lines() {
        if line.starts_with("verify_step ") && line.contains(&needle) {
            let start = line.find("'work/").unwrap_or_else(|| panic!("no work dir in {line}"));
            let rest = &line[start + 1..];
            return rest[..rest.find('\'').expect("closing quote")].to_string();
        }
    }
    panic!("no verify_step line for run {run_id} in:\n{verify_sh}");
}

/// Seed `project` with a run + one recorded OUTPUT artifact, returning the run id.
/// `env`/`code` control the step's EXECUTABILITY class: both `Some` → a runnable
/// step (`verify_step`); either `None` → a `never`-executable step (`skip_step`).
async fn seed_run_with_output(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
    root_hash: &str,
    env: Option<&str>,
    code: Option<String>,
    output_hash: &str,
) -> Uuid {
    use crate::dataset::hardening_common::{insert_run, run_template, seed_artifact, used_edge};
    let run_id = Uuid::new_v4();
    let mut r = run_template(run_id, Some(project_id), None);
    r.env_rootfs_sha256 = env.map(str::to_string);
    r.code_sha256 = code;
    r.inputs_json = json!([used_edge("expression", "artifact", None, root_hash)]);
    r.rerun_spec_json = Some(json!({
        "language": "python",
        "params": { "criteria": [{ "column": "n_genes_by_counts", "control": "range", "min": 1 }] },
    }));
    insert_run(pool, &r).await;
    seed_artifact(
        pool,
        Some(project_id),
        None,
        Some(run_id),
        "out",
        output_hash,
        "single-cell/expression",
        false)
    .await;
    run_id
}

/// ROUND-4b / R4B-03 — **the capsule's VERDICT, executed.**
///
/// The integration coverage of the capsule asserted only that certain STRINGS appear
/// in the generated `verify_outputs.sh`. The verdict is shell CONTROL FLOW over
/// per-step executability counters, so a regression in the arm order — which is
/// exactly what round 4 shipped — left every one of those string assertions green.
/// `REPRODUCING.md` tells the reader "its exit status is the verification verdict",
/// so this test drives the REAL exported scripts under bash and asserts on the REAL
/// exit code and the human-readable verdict line, for every arm:
///
/// | arm | closure | on-disk outputs | expected |
/// |---|---|---|---|
/// | (a) | one never-executable step | none | exit 0, `never executable` |
/// | (b) | one executable step | none | exit 1, `this host did not execute them` |
/// | (c) | one executable step | matching | exit 0, `REPRODUCED:` |
/// | (d) | one executable step | wrong | exit 1, `NOT REPRODUCED:` |
/// | (e) | (c) + (a) | matching | exit 0, `PARTIALLY VERIFIED` |
/// | (f) | (d) + (a) | wrong | exit 1, `NOT REPRODUCED:` |
/// | (h) | one executable step, recorded hash = regex metacharacters | any | exit 1, `NOT REPRODUCED:` |
///
/// RED ON REVERT: restore round 4's arm order (the `CHECKED -gt 0` block above the
/// `UNVERIFIED_HOST` block) and a mixed capsule exits 0 where it must exit 1.
///
/// ROUND-6 / A4 — arm (h). `verify_step` compared with `grep -qx -- "$h"`, a BASIC
/// REGULAR EXPRESSION match, not a fixed-string one. A recorded hash of 64 `.`
/// characters is the BRE "any 64 characters", so it matched the sha256 of whatever
/// the step actually produced and the capsule printed `OK` / `REPRODUCED` / exit 0
/// for an output that was never regenerated. `-qxF` compares the recorded hash
/// literally.
#[tokio::test]
async fn the_exported_capsules_exit_code_is_its_reproducibility_verdict() {
    use crate::dataset::hardening_common::{download_zip, export_bundle, store_code, unzip_store};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // The bytes an executed step is supposed to regenerate, and their recorded hash.
    let regenerated = "regenerated bytes\n";
    let out_hash = format!("sha256:{}", cyto_sha256_hex(regenerated.as_bytes()));
    let never_out = format!("sha256:{}", "b".repeat(64));
    let code = store_code(&pool, "print('step')\n", "python").await;

    // Three closures, one per arm family.
    let (p_exec, _, root) =
        create_project_with_artifact(&server, &admin, "capsule verdict — executable").await;
    let exec_run =
        seed_run_with_output(&pool, p_exec, &root, Some("deadbeef"), Some(code.clone()), &out_hash)
            .await;

    let (p_never, _, root_n) =
        create_project_with_artifact(&server, &admin, "capsule verdict — never executable").await;
    seed_run_with_output(&pool, p_never, &root_n, None, None, &never_out).await;

    let (p_mixed, _, root_m) =
        create_project_with_artifact(&server, &admin, "capsule verdict — mixed").await;
    let mixed_exec =
        seed_run_with_output(&pool, p_mixed, &root_m, Some("deadbeef"), Some(code.clone()), &out_hash)
            .await;
    seed_run_with_output(&pool, p_mixed, &root_m, None, None, &never_out).await;

    // (g) TWO executable steps, only one of which this host ran — the mixture the
    //     round-4 arm order got wrong (an unrelated success downgraded the unrun
    //     step's exit 1 to a "PARTIALLY VERIFIED" exit 0).
    let (p_partial, _, root_p) =
        create_project_with_artifact(&server, &admin, "capsule verdict — half-run").await;
    let ran_here =
        seed_run_with_output(&pool, p_partial, &root_p, Some("deadbeef"), Some(code.clone()), &out_hash)
            .await;
    seed_run_with_output(&pool, p_partial, &root_p, Some("deadbeef"), Some(code.clone()), &never_out).await;

    // (h) ROUND-6 / A4 — an executable step whose RECORDED output hash is made of
    //     regex metacharacters (64 `.`). Under a BRE match it matches the sha256 of
    //     ANY regenerated file; only a fixed-string compare rejects it.
    let meta_out = format!("sha256:{}", ".".repeat(64));
    let (p_meta, _, root_meta) =
        create_project_with_artifact(&server, &admin, "capsule verdict — metachar hash").await;
    let meta_run =
        seed_run_with_output(&pool, p_meta, &root_meta, Some("deadbeef"), Some(code), &meta_out)
            .await;

    let fetch = |project: Uuid| {
        let server = &server;
        let admin = &admin;
        async move {
            let id = export_bundle(server, admin, project, None, "project").await;
            unzip_store(&download_zip(server, admin, &id).await)
        }
    };
    let exec_members = fetch(p_exec).await;
    let never_members = fetch(p_never).await;
    let mixed_members = fetch(p_mixed).await;
    let partial_members = fetch(p_partial).await;
    let meta_members = fetch(p_meta).await;

    let member = |members: &Vec<(String, Vec<u8>)>, name: &str| -> String {
        members
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .unwrap_or_else(|| panic!("bundle member {name}"))
    };

    // run.sh's last act really is the verifier. `run.sh` itself is PARSED, not run:
    // executing it needs the pinned rootfs, and it is the verifier it delegates to
    // that owns the verdict (which is what the arms below execute for real).
    let run_sh_dir = stage_bundle(&exec_members, &[]);
    let parse = std::process::Command::new("bash")
        .arg("-n")
        .arg(run_sh_dir.join("run.sh"))
        .output()
        .expect("bash -n");
    assert!(parse.status.success(), "run.sh must parse: {}", String::from_utf8_lossy(&parse.stderr));
    let _ = std::fs::remove_dir_all(&run_sh_dir);
    assert!(
        member(&exec_members, "run.sh").contains("bash \"$HERE/verify_outputs.sh\""),
        "run.sh delegates the verdict to the verifier"
    );

    let exec_wd = work_dir_for(&member(&exec_members, "verify_outputs.sh"), exec_run);
    let mixed_wd = work_dir_for(&member(&mixed_members, "verify_outputs.sh"), mixed_exec);
    let partial_wd = work_dir_for(&member(&partial_members, "verify_outputs.sh"), ran_here);
    let meta_wd = work_dir_for(&member(&meta_members, "verify_outputs.sh"), meta_run);

    // Each arm: stage the bundle, drive `verify_outputs.sh`, read the REAL exit code.
    let arms: Vec<(&str, &Vec<(String, Vec<u8>)>, Vec<(String, &str)>, i32, &str)> = vec![
        ("(a) nothing was ever executable", &never_members, vec![], 0, "never executable"),
        ("(b) this host could not run it", &exec_members, vec![], 1, "this host did not execute them"),
        (
            "(c) ran and MATCHED",
            &exec_members,
            vec![(format!("{exec_wd}/outputs/o.txt"), regenerated)],
            0,
            "REPRODUCED: all 1 recorded output hashes regenerated byte-identically.",
        ),
        (
            "(d) ran and MISMATCHED",
            &exec_members,
            vec![(format!("{exec_wd}/outputs/o.txt"), "wrong bytes")],
            1,
            "NOT REPRODUCED:",
        ),
        (
            "(e) a mixture of (c) and (a)",
            &mixed_members,
            vec![(format!("{mixed_wd}/outputs/o.txt"), regenerated)],
            0,
            "PARTIALLY VERIFIED",
        ),
        (
            "(f) a mixture of (d) and (a)",
            &mixed_members,
            vec![(format!("{mixed_wd}/outputs/o.txt"), "wrong bytes")],
            1,
            "NOT REPRODUCED:",
        ),
        // The arm-ORDER case. Alone, (b) exits 1; mixed with a success, round 4
        // reported "PARTIALLY VERIFIED" and exited 0.
        (
            "(g) a mixture of (c) and (b)",
            &partial_members,
            vec![(format!("{partial_wd}/outputs/o.txt"), regenerated)],
            1,
            "this host did not execute them",
        ),
        // ROUND-6 / A4: the step DID run and produced a file; its sha256 is not the
        // recorded hash. `grep -qx` treated the recorded 64 dots as a BRE and matched
        // it anyway → `OK` / `REPRODUCED` / exit 0.
        (
            "(h) a recorded hash of regex metacharacters",
            &meta_members,
            vec![(format!("{meta_wd}/outputs/o.txt"), regenerated)],
            1,
            "NOT REPRODUCED:",
        ),
    ];
    for (arm, members, on_disk, want_code, want_text) in arms {
        let dir = stage_bundle(members, &on_disk);
        let (code, stdout, stderr) = run_capsule_script(&dir, "verify_outputs.sh");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            code,
            Some(want_code),
            "{arm}: the capsule's exit status IS its verdict.\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert!(
            stdout.contains(want_text) || stderr.contains(want_text),
            "{arm}: the verdict must say {want_text:?}.\nstdout: {stdout}\nstderr: {stderr}"
        );
        // A mismatch must dominate, and "nothing checkable" must never be dressed up
        // as a verified success.
        if want_code == 1 {
            assert!(
                !stdout.contains("REPRODUCED: all") && !stdout.contains("PARTIALLY VERIFIED"),
                "{arm}: a failing capsule must not print a success verdict.\nstdout: {stdout}"
            );
        }
        if arm.starts_with("(a)") {
            assert!(
                !stderr.contains("NOT REPRODUCED"),
                "{arm}: a provenance-only closure is not an irreproducible one.\nstderr: {stderr}"
            );
        }
    }
}

/// ROUND-4b / R4B-01 — **a root with no BYTES, on a real exported bundle.**
///
/// `seed_root_artifact` writes the catalog row but no blob, so the export's
/// object-store `get` FAILS: `data/<hash>` is never written and the capsule aborts at
/// `stage_input`. Round 4 threaded only the UNKNOWN-SOURCE arm into the verdict, and
/// this root's row EXISTS — so it landed in `manifest_roots`, passed
/// `.all(|r| !r.content_hash.is_empty())`, and the bundle shipped `ready: true,
/// gaps: []` plus REPRODUCING.md's "passes every condition".
///
/// The closure here is a NON-COMPUTE run precisely so every other flag legitimately
/// passes: `roots_have_provenance` is the only thing that can redden it.
///
/// RED BEFORE THE FIX: `readiness.json` = `{"ready": true, ..., "gaps": []}` and
/// REPRODUCING.md contains "passes every condition", over a bundle with no `data/`
/// member at all.
#[tokio::test]
async fn a_root_whose_bytes_are_absent_reddens_the_exported_readiness() {
    use crate::dataset::hardening_common::{
        download_zip, export_bundle, insert_run, run_template, unzip_store, used_edge,
    };

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, _root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "byte-less root project").await;
    let pool = pool_for(&server).await;

    // A selection run: seed set, no code by design, no rootfs by design, checksummed
    // inputs, no processor params by design → all five RUN flags pass.
    let run_id = Uuid::new_v4();
    let mut r = run_template(run_id, Some(project_id), None);
    r.kind = "selection".into();
    r.generator_id = "cell.select".into();
    r.inputs_json = json!([used_edge("expression", "artifact", None, &root_hash)]);
    insert_run(&pool, &r).await;

    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let names: Vec<&String> = members.iter().map(|(n, _)| n).collect();
    let text = |name: &str| -> String {
        members
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .unwrap_or_else(|| panic!("bundle member {name}; members = {names:?}"))
    };

    // The premise: the root's bytes really are absent from the bundle.
    let bare = root_hash.strip_prefix("sha256:").unwrap_or(&root_hash);
    assert!(
        !names.iter().any(|n| n.starts_with("data/") && n.contains(bare)),
        "the fixture must actually have NO bytes for its root: {names:?}"
    );

    let readiness: Value = serde_json::from_str(&text("readiness.json")).expect("readiness.json");
    assert_eq!(
        readiness["flags"]["roots_have_provenance"],
        json!(false),
        "a root with no bytes must redden its own flag: {readiness}"
    );
    assert_eq!(
        readiness["ready"],
        json!(false),
        "…and the bundle is NOT ready — the capsule aborts at stage_input: {readiness}"
    );
    // Every other flag is genuinely satisfied, so this isolates the fix.
    for flag in ["seeds_set", "env_pinned", "inputs_checksummed", "code_captured", "params_captured"] {
        assert_eq!(readiness["flags"][flag], json!(true), "{flag} is unaffected: {readiness}");
    }

    let gaps: Vec<String> = readiness["gaps"]
        .as_array()
        .expect("gaps")
        .iter()
        .map(|g| g.as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(gaps.len(), 1, "one false flag, one bullet (R4B-09 symmetry): {gaps:?}");
    let line = &gaps[0];
    assert!(line.starts_with("roots_have_provenance:"), "{line}");
    assert!(line.contains(&root_hash), "the gap names the hash: {line}");
    assert!(line.contains("stage_input"), "…and the consequence: {line}");
    assert!(
        line.contains("could not read") || line.contains("no source") || line.contains("bytes"),
        "…and WHY the bytes are missing: {line}"
    );

    let readme = text("REPRODUCING.md");
    assert!(
        !readme.contains("passes every condition"),
        "an unchecked completeness claim must never ship over a byte-less root: {readme}"
    );
    assert!(readme.contains("INCOMPLETE PROVENANCE"), "{readme}");
    assert!(readme.contains(&root_hash), "the README names the byte-less root: {readme}");
}

/// TEST-24 [ITEM-19, ITEM-20] — **the origin survives into the out-of-app trust
/// deliverable**, on the REAL exported bundle bytes.
///
/// Three carriers, because a mark that reaches only one of them is the "seen at the
/// moment of choosing" disclaimer this change exists to replace:
///  * the bundle-root `inputs.json` (the manifest a reader opens first);
///  * the per-step `$STEP/inputs/inputs.json` inside `run.sh` (what the capsule
///    actually stages — the two were duplicate `json!` literals, so a fact added to
///    one and missed in the other is the exact drift this asserts against);
///  * `methods.md`, which must NAME the auto-bound slot in prose, since a reader
///    of the methods text is not going to read the JSON.
///
/// The reviewed input is the control in both directions: it must NOT be described as
/// automatic, and the input that recorded NO origin must carry no `bound_by` key at
/// all — never `"user"`, which would claim a review that never happened (DEC-7).
#[tokio::test]
async fn the_exported_bundle_states_which_inputs_nobody_reviewed() {
    use crate::dataset::hardening_common::{
        download_zip, export_bundle, insert_run, run_template, store_code, unzip_store, used_edge,
    };

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "binding origin bundle").await;
    let pool = pool_for(&server).await;

    // One run with three inputs: one the system bound, one a person picked, one that
    // recorded no origin at all (the shape recorded before this change).
    let with_origin = |slot: &str, origin: Option<&str>| {
        let mut e = used_edge(slot, "artifact", Some(root_id), &root_hash);
        if let Some(o) = origin {
            e["bound_by"] = json!(o);
        }
        e
    };
    let run_id = Uuid::new_v4();
    let mut run = run_template(run_id, Some(project_id), None);
    run.code_sha256 = Some(store_code(&pool, "print('step')\n", "python").await);
    run.env_rootfs_sha256 = Some("deadbeef".into());
    run.inputs_json = json!([
        with_origin("guessed", Some("auto")),
        with_origin("picked", Some("user")),
        with_origin("unstated", None),
    ]);
    insert_run(&pool, &run).await;

    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let text = |pred: &dyn Fn(&str) -> bool, what: &str| -> String {
        members
            .iter()
            .find(|(n, _)| pred(n))
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .unwrap_or_else(|| {
                panic!("bundle member {what}; members = {:?}", members.iter().map(|(n, _)| n).collect::<Vec<_>>())
            })
    };

    // The ROOT manifest and the PER-STEP document must agree, so both are read.
    let root_inputs: Value =
        serde_json::from_str(&text(&|n| n == "inputs.json", "inputs.json")).expect("inputs.json");
    let root_entries = root_inputs["steps"][0]["inputs"].as_array().expect("root inputs array");
    let entry = |entries: &[Value], slot: &str| -> Value {
        entries
            .iter()
            .find(|e| e["slot"] == json!(slot))
            .unwrap_or_else(|| panic!("an entry for slot {slot}: {entries:?}"))
            .clone()
    };

    assert_eq!(entry(root_entries, "guessed")["bound_by"], json!("auto"), "{root_entries:?}");
    assert_eq!(entry(root_entries, "picked")["bound_by"], json!("user"), "{root_entries:?}");
    assert!(
        entry(root_entries, "unstated").get("bound_by").is_none(),
        "an input that recorded no origin must carry NO key — `user` here would claim a \
         review nobody performed: {root_entries:?}"
    );

    // The per-step `inputs.json` is written by `run.sh` as a heredoc, so it is read
    // out of the generated script rather than off disk (the capsule has not been run).
    let run_sh = text(&|n| n == "run.sh", "run.sh");
    let step_doc = run_sh
        .split("cat > \"$STEP/inputs/inputs.json\"")
        .nth(1)
        .expect("run.sh writes a per-step inputs.json");
    let step_json: Value = serde_json::from_str(
        step_doc
            .split_once('\n')
            .expect("heredoc body")
            .1
            .split("\nCYTO_INPUTS_JSON")
            .next()
            .expect("heredoc terminator"),
    )
    .unwrap_or_else(|e| panic!("the per-step inputs.json parses ({e}): {step_doc}"));
    let step_entries = step_json["inputs"].as_array().expect("per-step inputs array");
    assert_eq!(entry(step_entries, "guessed")["bound_by"], json!("auto"), "{step_entries:?}");
    assert_eq!(entry(step_entries, "picked")["bound_by"], json!("user"), "{step_entries:?}");
    assert!(
        entry(step_entries, "unstated").get("bound_by").is_none(),
        "…and the per-step document agrees with the root manifest: {step_entries:?}"
    );

    // methods.md names the auto-bound slot IN PROSE, and only that one.
    let methods = text(&|n| n.ends_with("methods.md"), "methods.md");
    assert!(
        methods.contains("`guessed`") && methods.contains("bound automatically"),
        "the prose must name the slot nobody reviewed: {methods}"
    );
    assert!(
        methods.contains("no one reviewed the choice"),
        "…and state the consequence, not just the mechanism: {methods}"
    );
    assert!(
        !methods.contains("`picked`") && !methods.contains("`unstated`"),
        "a reviewed input — and an input with no recorded origin — get no such sentence: {methods}"
    );
}

// ════════════════════════════════════════════════════════════════════════════
//  #145 — the export is the ONE consumer that genuinely wants STORED bytes
// ════════════════════════════════════════════════════════════════════════════

/// **`fetch.txt`'s transfer size is the STORED byte count, not the logical one.**
///
/// Task #145 split one byte column into two, because five of six consumers were asking a
/// LOGICAL question ("how big is this data") of a STORAGE number ("bytes in the object
/// store"). Those five moved to `logical_bytes`. This one did not, and must not: the
/// export size cap decides whether bytes fit in a zip, and `fetch.txt` tells a reader how
/// many bytes they are about to download. Both are questions about the object store, and
/// answering them with a logical size would cap on bytes that are not being transferred
/// and promise a download length that does not match the blob.
///
/// So this is the NEGATIVE control for the whole change. The fixture makes the two
/// quantities differ by a wide, unmistakable margin (1 KiB stored, 8 MiB logical), which
/// is what stops it passing under both readings — with the pre-#145 fixture, where every
/// artifact's stored size equalled its logical size, this assertion would have been true
/// no matter which column `bundle.rs` read, and would have proved nothing.
///
/// Mutation killed: swapping `a.stored_bytes` for `a.logical_bytes` in either `fetch.txt`
/// line or in the cap arithmetic of `provenance::export::bundle`.
#[tokio::test]
async fn the_export_transfer_manifest_reports_stored_bytes_not_logical_bytes() {
    use cytoanalyst::modules::workstore::catalog::{CatalogRepository, NewArtifact};
    use crate::dataset::hardening_common::{download_zip, unzip_store};

    const STORED: i64 = 1024;
    const LOGICAL: i64 = 8 * 1024 * 1024;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "export stored-bytes").await;
    let pool = pool_for(&server).await;

    // A MULTI-FILE artifact takes the `fetch.txt` branch unconditionally (there is no
    // single blob to embed), so the line is reachable without having to drive the
    // deployment's size cap — and the size it prints is the one under test.
    let content_hash = format!("sha256:{}", "c".repeat(64));
    let root_id = CatalogRepository::new(pool.clone())
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id),
            dataset_id: None,
            run_id: None,
            output_id: "upload".to_string(),
            datatype: "data/opaque".to_string(),
            object_key: Some(content_hash.clone()),
            is_multifile: true,
            content_hash: content_hash.clone(),
            structure: json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: STORED,
            // Deliberately NOT equal to `stored_bytes`. Nothing else in the tree makes
            // these differ for a stored artifact, so the divergence is manufactured here
            // for exactly this assertion.
            logical_bytes: Some(LOGICAL),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("seed multifile root artifact")
        .id;

    let run = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run_id = run["run_id"].as_str().expect("run_id").to_string();

    let build = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target": run_id, "scope": "single" }))
        .send()
        .await
        .expect("build export");
    assert_eq!(build.status().as_u16(), 200, "export build is 200");
    let body: Value = build.json().await.expect("export json");
    let export_id = body["export_id"].as_str().expect("export_id").to_string();

    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let fetch_txt = members
        .iter()
        .find(|(n, _)| n == "fetch.txt")
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .expect("the bundle carries fetch.txt for a multi-file artifact");

    let line = fetch_txt
        .lines()
        .find(|l| l.contains(&content_hash) || l.contains("data/"))
        .unwrap_or_else(|| panic!("no transfer line in fetch.txt:\n{fetch_txt}"));

    assert!(
        line.ends_with(&format!("\t{STORED}")),
        "fetch.txt must report the STORED byte count ({STORED}); it reported: {line:?}"
    );
    assert!(
        !line.ends_with(&format!("\t{LOGICAL}")),
        "fetch.txt reported the LOGICAL size ({LOGICAL}) — the export was silently switched \
         to the display quantity, so its cap now measures bytes it is not transferring: \
         {line:?}"
    );
}

// TEST-11 / TEST-12 — the REPAIRED narrator, asserted on the REAL exported bundle bytes
// rather than on a unit fixture (#131 / #77).
//
// Every defect below was reproduced against THIS code path before the repair, by
// rendering a SHIPPED manifest. Three things were wrong in one sentence, in the
// out-of-app trust deliverable: a literal `{…}` placeholder; a false accusation about a
// run that applies no predicate at all; and the ENTIRE declared `note:` — the caveat a
// package author writes because the result is easy to over-read — silently absent. The
// Data-and-Code-Availability paragraph additionally claimed environment digests "are
// shipped in this reproducibility bundle" while printing none.
//
// The SUBJECT is derived from the shipped manifests at run time (the first declaration
// that carries a `note:` and declares no constraint-producing role), never hardcoded:
// hardcoding one would (a) go stale the moment that package is renamed and (b) put a
// package id and its vocabulary into an app-surface test file for no gain. The
// derivation also makes the test self-selecting for exactly the defect shape.
#[tokio::test]
async fn the_exported_methods_text_carries_no_placeholder_no_false_accusation_and_its_note() {
    use crate::dataset::hardening_common::unzip_store;
    use crate::dataset::hardening_common::{
        download_zip, export_bundle, insert_run, run_template, used_edge,
    };
    use cytoanalyst::modules::extensions::types::{
        ExtensionManifest, MethodsNarration, MethodsParamRole,
    };
    use serde_json::Value;

    // ── pick the subject off disk ───────────────────────────────────────────────
    let declares_a_predicate = |m: &MethodsNarration| {
        m.params.values().any(|r| {
            matches!(
                r,
                MethodsParamRole::PredicateList
                    | MethodsParamRole::ThresholdList
                    | MethodsParamRole::OpaquePredicate
                    | MethodsParamRole::AllowList
            )
        }) || m.allow_list_slots.iter().any(|s| !s.trim().is_empty())
    };
    let pkg_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&pkg_dir)
        .expect("read the packages dir")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .collect();
    dirs.sort();
    let mut subject: Option<(String, MethodsNarration)> = None;
    for d in dirs {
        let mf = d.join("manifest.yaml");
        if !mf.exists() {
            continue;
        }
        let parsed: ExtensionManifest =
            serde_norway::from_str(&std::fs::read_to_string(&mf).expect("read manifest"))
                .expect("the shipped manifest parses");
        for a in parsed.contributes.analyses {
            let Some(m) = a.methods.clone() else { continue };
            let has_note = m.note.as_deref().map(|n| !n.trim().is_empty()).unwrap_or(false);
            // The label param is what the placeholder resolves through.
            let has_label =
                m.params.values().any(|r| matches!(r, MethodsParamRole::OutputLabel));
            if has_note && has_label && !declares_a_predicate(&m) && subject.is_none() {
                subject = Some((a.id.clone(), m));
            }
        }
    }
    let (analysis_id, narration) = subject.expect(
        "the shipped tree must declare at least one analysis with a `note:`, a label \
         param and NO constraint-producing role — that combination IS the defect shape, \
         and without it this test proves nothing",
    );
    let label_param = narration
        .params
        .iter()
        .find(|(_, r)| matches!(r, MethodsParamRole::OutputLabel))
        .map(|(k, _)| k.clone())
        .expect("checked above");
    let note = narration.note.as_deref().expect("checked above").trim().to_string();

    // ── record a run of it and export ──────────────────────────────────────────
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "methods narrator project").await;
    let pool = pool_for(&server).await;

    const RUN_LABEL: &str = "run_label_x";
    const ENV_DIGEST: &str = "sha256:feedfacefeedface";
    const UNDECLARED_PARAM: &str = "some_future_knob";

    // Record a value for EVERY declared param, not only the label. The subject is chosen
    // from disk, so a package added later becomes this test's subject — and one whose
    // `commits` also interpolates a `narrated_value` would fail to render its clause under
    // a label-only param set, reddening this file for an author who never touched it.
    // Feeding every declared param makes the test independent of WHICH subject it picks.
    let mut science = serde_json::Map::new();
    for (key, role) in &narration.params {
        let value = match role {
            MethodsParamRole::PredicateList => json!([{ "column": "c", "min": 1 }]),
            MethodsParamRole::ThresholdList => json!([{ "metric": "m", "min": 1 }]),
            MethodsParamRole::OpaquePredicate => json!({ "gt": [{ "col": "c" }, 1] }),
            MethodsParamRole::AllowList => json!(["a", "b"]),
            MethodsParamRole::SubsampleCap => json!(5),
            MethodsParamRole::Seed => json!(0),
            MethodsParamRole::OutputLabel => json!(RUN_LABEL),
            MethodsParamRole::NarratedValue => json!("7"),
        };
        science.insert(key.clone(), value);
    }
    science.insert(UNDECLARED_PARAM.to_string(), json!(1.0));
    assert!(
        science.contains_key(&label_param),
        "the label param must be among the recorded science params"
    );

    let run_id = Uuid::new_v4();
    let mut run = run_template(run_id, Some(project_id), None);
    run.generator_id = analysis_id.clone();
    run.generator_version = "0.1.0".into();
    run.env_rootfs_sha256 = Some(ENV_DIGEST.into());
    run.params = json!({ "seed": 0, "language": "python", "arch": "x86_64" });
    run.rerun_spec_json = Some(json!({
        "language": "python",
        "params": Value::Object(science),
    }));
    run.inputs_json = json!([used_edge("expression", "artifact", Some(root_id), &root_hash)]);
    insert_run(&pool, &run).await;

    let export_id = export_bundle(&server, &admin, project_id, None, "project").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let methods = members
        .iter()
        .find(|(n, _)| n.ends_with("methods.md"))
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .expect("the bundle carries methods.md");

    // #131a — NO unsubstituted placeholder reaches the deliverable, and the value it
    // could not previously land actually lands.
    assert!(
        !methods.contains('{') && !methods.contains('}'),
        "a placeholder leaked into the exported methods.md:\n{methods}"
    );
    assert!(
        methods.contains(RUN_LABEL),
        "the recorded label is narrated, not deleted:\n{methods}"
    );

    // #131b — no FALSE accusation for an analysis that applies no predicate.
    assert!(
        !methods.contains("no criteria were recorded"),
        "`{analysis_id}` applies NO predicate, yet the export accuses the run of hiding \
         one:\n{methods}"
    );

    // #131 note trap — the declared caveat SURVIVES, on an analysis that narrates zero
    // constraints. (Compared against the manifest's own text, so it cannot be satisfied
    // by a lookalike sentence.)
    assert!(
        methods.contains(&note),
        "`{analysis_id}`'s declared `note:` — the honest part — was dropped from the \
         export.\nexpected: {note}\ngot:\n{methods}"
    );

    // #77 — the captured environment digest is PRINTED, not merely asserted to ship.
    assert!(
        methods.contains(ENV_DIGEST),
        "the recorded environment digest is never shown to the reader:\n{methods}"
    );

    // …and the never-drop guarantee is intact: an undeclared param is still disclosed.
    assert!(
        methods.contains("NOT narrated here") && methods.contains(UNDECLARED_PARAM),
        "an undeclared param must still be disclosed by name:\n{methods}"
    );
}
