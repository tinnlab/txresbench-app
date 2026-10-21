//! TEST-70 [ITEM-25, ITEM-21] — reproducibility readiness (negative). Readiness
//! flags a chain as NOT reproducible BEFORE an export can be trusted, when a
//! required env digest is unobtainable (GC'd / never present) or a code blob is
//! missing. Surfaced on `GET /provenance/graph` (`readiness.{env_pinned,
//! code_captured,ready}`) and in the capsule's `environments.json` (`obtainable`).

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn readiness_flags_unobtainable_env_and_missing_code() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "readiness project").await;
    let pool = pool_for(&server).await;

    let h_root = h(1);
    let root = seed_artifact(
        &pool,
        Some(project),
        None,
        None,
        "upload",
        &h_root,
        "single-cell/expression",
        false)
    .await;

    // (a) A run pinned to an env digest that is NOT obtainable (never
    // extracted/served/operator-placed → effectively GC'd) but WITH captured code.
    let gcd_digest = "d".repeat(64); // valid hex, not the embedded digest, not cached
    let run_env = Uuid::new_v4();
    let mut r = run_template(run_env, Some(project), None);
    r.env_rootfs_sha256 = Some(gcd_digest.clone());
    r.code_sha256 = Some(store_code(&pool, "print('x')\n", "python").await);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;

    let g = get_graph(&server, &admin, project, Some(run_env)).await;
    let rd = &g["readiness"];
    assert_eq!(
        rd["env_pinned"],
        json!(false),
        "an unobtainable pinned env → env_pinned false"
    );
    assert_eq!(
        rd["code_captured"],
        json!(true),
        "code IS captured (isolating the env failure)"
    );
    assert_eq!(
        rd["ready"],
        json!(false),
        "the chain is flagged NOT reproducible (GC'd env)"
    );

    // The export SURFACES the unobtainable env (obtainable:false) so a consumer
    // knows it cannot be reproduced before trusting the capsule.
    let export_id = export_bundle(&server, &admin, project, Some(run_env), "single").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let env_txt = members
        .iter()
        .find(|(n, _)| n == "environments.json")
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .unwrap();
    assert!(
        env_txt.contains(&gcd_digest),
        "environments.json records the pinned digest"
    );
    assert!(
        env_txt.contains("\"obtainable\": false") || env_txt.contains("\"obtainable\":false"),
        "the unobtainable env is flagged obtainable:false in the capsule"
    );

    // (b) A COMPUTE run with no code recorded at all → code_captured false.
    //
    // ROUND-4b (R4B-10): this leg was RED because `code_captured_flag`'s `None` arm
    // returned true unconditionally, on the rationale "a manual node captured no
    // code by design". `run_template` builds a `kind='compute'` run, and a compute
    // run executes code by definition — its capsule step is emitted by
    // `render_step` as `no captured code (not executed; manual step)` and computes
    // nothing, so a green `code_captured` asserted a capture that never happened.
    // The rationale was real but describes NON-compute runs; leg (d) pins that.
    let run_nocode = Uuid::new_v4();
    let mut r = run_template(run_nocode, Some(project), None);
    r.code_sha256 = None; // no captured code
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;

    let g = get_graph(&server, &admin, project, Some(run_nocode)).await;
    let rd = &g["readiness"];
    assert_eq!(
        rd["code_captured"],
        json!(false),
        "a missing code blob → code_captured false"
    );
    assert_eq!(
        rd["ready"],
        json!(false),
        "the chain is flagged NOT reproducible (missing code)"
    );

    // (c) THE REAL NEGATIVE the checklist exists to catch — a run that DOES record a
    // `code_sha256`, whose blob carries no usable bytes. This is the "ghost blob"
    // case: the hash makes the run look captured, but a capsule built from it has
    // no script to run.
    //
    // Note WHY this is the empty-blob form rather than a deleted row:
    // `provenance_run_repro.code_sha256` is `REFERENCES provenance_code_blobs(sha256)`
    // with no ON DELETE clause, so the schema itself makes a truly dangling hash
    // unreachable for a live run — asserted below rather than claimed. The
    // absent-blob ghost is reachable at EXPORT time (the staging fetch fails), and
    // is covered there by `provenance::export_test`'s ghost-run bundle assertions.
    let empty_sha = store_code(&pool, "", "python").await;
    let run_ghost = Uuid::new_v4();
    let mut r = run_template(run_ghost, Some(project), None);
    r.code_sha256 = Some(empty_sha.clone());
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;

    // The FK really does prevent the deleted-row form (this is the premise above).
    let deleted = sqlx::query("DELETE FROM provenance_code_blobs WHERE sha256 = $1")
        .bind(&empty_sha)
        .execute(&pool)
        .await;
    assert!(
        deleted.is_err(),
        "the FK must block deleting a blob a live run references — otherwise this \
         leg is testing the wrong shape of ghost"
    );

    let g = get_graph(&server, &admin, project, Some(run_ghost)).await;
    let rd = &g["readiness"];
    assert_eq!(
        rd["code_captured"],
        json!(false),
        "a RECORDED code hash whose blob has no bytes is NOT captured code: {rd}"
    );
    assert_eq!(
        rd["ready"],
        json!(false),
        "…so the chain is NOT reproducible: {rd}"
    );

    // (d) The by-design arm, which keeps this fix from falsely reddening every
    // in-app interaction run (DEC-9 §5). A NON-compute run captures no code by
    // design and stays green on that flag.
    let run_selection = Uuid::new_v4();
    let mut r = run_template(run_selection, Some(project), None);
    r.kind = "selection".into();
    r.generator_id = "cell.select".into();
    r.code_sha256 = None;
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;

    let g = get_graph(&server, &admin, project, Some(run_selection)).await;
    let rd = &g["readiness"];
    assert_eq!(
        rd["code_captured"],
        json!(true),
        "a selection run captured no code BY DESIGN — no false reddening: {rd}"
    );
}
