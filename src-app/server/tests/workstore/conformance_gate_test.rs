//! artifact-model **ITEM-18 / DEC-12** — the conformance gate, on the REAL path.
//!
//! Up to now `_lib/conformance.py` was built, unit-tested, and invoked by NOTHING. This
//! suite is the proof that it is invoked, and that its verdict has a CONSEQUENCE. Every
//! link runs for real, inside the spawned server:
//!
//!   `POST /jobs` (analysis) → the scheduler → a real bwrap run whose script writes three
//!   artifacts + `/outputs/manifest.json`
//!     → `finalize_analysis` → `WorkstoreIngestSink` → real blobs + real catalog rows
//!     → the post-ingest dispatch the sink fires → a SECOND sandbox job, the verification
//!       processor, with the artifacts hardlinked back out of the object store
//!     → the real `conformance.py` reading the real stored bytes
//!     → `artifacts.status = 'failed'` on the artifacts that do not conform.
//!
//! Nothing is stubbed and nothing is driven in-process (the object store, the sandbox
//! workspace root and the ingest sink are all process-global state owned by the SERVER,
//! so a test that called the sink itself would be testing a different program). The only
//! thing this test authors is the CONTENT: two declarations the gate must reject and one
//! it must accept.
//!
//! ## The negative control is the point
//!
//! All three artifacts come out of the same run, are ingested by the same call, and are
//! gated by the same verification job. `failed` on two and `ready` on the third therefore
//! cannot come from a gate that fails everything, and cannot come from a gate that never
//! ran. The three differ ONLY in what the producer declared:
//!
//! | output | bytes | `structure` | expected |
//! |---|---|---|---|
//! | `conforming` | a blob | `opaque` + `media_type` | `ready` |
//! | `nonconforming` | the same blob | `opaque`, no `media_type` | `failed` (INV-2: absence is an error) |
//! | `relabelled` | a real Zarr store | `opaque` + `media_type` | `failed` (the declaration is FALSE) |
//!
//! `relabelled` is the one that matters most. `encoding: "opaque"` routes to the branch
//! that checks no member structure, and nothing used to cross-check the claim — so a
//! producer switched the gate off for its own output by writing five words into its own
//! manifest, which is precisely the opt-out DEC-8 says cannot exist. It is exercised HERE,
//! on the production path, and not only in the Python unit suite, because a check that
//! lives in the library and is not reached by the job the server dispatches protects
//! nothing.
//!
//! ## Environment, and the skip that used to hide all of this
//!
//! The gate runs IN the sandbox by design (DEC-12), so the end-to-end test needs an
//! executable analysis sandbox and self-skips without one — through
//! [`hardening_common::record_skip`], NEVER a bare `eprintln!`. libtest CAPTURES stdout
//! for a passing test, so an `eprintln!` skip is byte-for-byte indistinguishable from a
//! real pass in a default run, AND it ignores `TXR_TEST_NO_SKIP=1`. That was not a
//! cosmetic gap: this is the ONLY test exercising `dispatch_after_ingest` → the
//! verification job → `conformance.py` → `apply_verdict`, and the gate itself fails OPEN
//! when the sandbox is missing — so one absent rootfs silenced the enforcement AND every
//! trace of its absence, at the same time.
//!
//! [`the_gate_records_an_unverified_outcome_when_it_cannot_reach_a_verdict`] is the other
//! half of that fix and needs NO sandbox: it drives the real indeterminate path on any
//! host and asserts both halves of the honest distinction — statuses untouched, and the
//! run carrying an operator-visible `NOT VERIFIED` record.
//!
//! ## The seam the hand-written verdicts left open
//!
//! Every other test below AUTHORS its `verdict.json`, so what the gate's receipt MEANS and
//! what this server DOES with it could each match their own docstring while disagreeing
//! with each other — and they did, for two rounds.
//! [`the_real_gates_own_verdict_drives_the_real_outcome`] closes it: it runs the real
//! `verify_conformance.main()` over stores the real writer wrote, and feeds the verdict
//! that comes out into the real `conclude`. It needs no sandbox either (the gate is plain
//! Python; only the mount points are redirected).

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::jobs::conformance::{
    apply_verdict, conclude, gate_now, verdict_from_run, GateOutcome, GateTarget, GateVerdict,
    GATE_LOG_PREFIX, GATE_LOG_UNVERIFIED,
};
use txresbench::modules::workstore::catalog::repository::CatalogRepository;

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::hardening_common::{
    admin_user_id, insert_running_job, record_skip, run_real_analysis, seed_artifact,
};

/// The producing run. Three outputs whose only differences are declared, not written.
///
/// `relabelled/` is a genuine Zarr v3 group node written by hand rather than through
/// `txr_zarr`: an inline-`script` analysis gets no staged helper modules
/// (`AnalysisSpec::resolve_entry` returns `helpers: []` for a script), and a hand-written
/// group node is what the gate's store-detection actually keys on anyway.
const EMIT_SCRIPT: &str = "import os, json\n\
os.makedirs('/outputs/relabelled', exist_ok=True)\n\
open('/outputs/good.bin','wb').write(b'declared bytes')\n\
open('/outputs/bad.bin','wb').write(b'declared bytes')\n\
json.dump({'zarr_format':3,'node_type':'group','attributes':{}},\n\
          open('/outputs/relabelled/zarr.json','w'))\n\
json.dump({'outputs':[\n\
 {'id':'conforming','datatype':'file/upload','path':'good.bin','layout':'opaque','role':'artifact',\n\
  'structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{}},\n\
 {'id':'nonconforming','datatype':'file/upload','path':'bad.bin','layout':'opaque','role':'artifact',\n\
  'structure':{'encoding':'opaque'},'meta':{}},\n\
 {'id':'relabelled','datatype':'file/upload','path':'relabelled','layout':'opaque','role':'artifact',\n\
  'structure':{'encoding':'opaque','media_type':'application/octet-stream'},'meta':{}}\n\
]}, open('/outputs/manifest.json','w'))\n";

/// Can this host EXECUTE an analysis sandbox? That, and only that, is what this suite
/// needs: the gate runs inside one (DEC-12).
///
/// Deliberately NOT `dataset::hardening_common::rootfs_gate`, which additionally demands
/// a pinned env-image DIGEST because it gates *reproducible capsule* tests. A host with a
/// bare pre-mounted rootfs (`TXR_ENV_ROOTFS_DIR`) executes perfectly but pins no digest,
/// so that gate self-skips — and a suite that silently skips where it could have run is a
/// suite that proves nothing while looking green. This drives the real
/// `POST /sandbox/execute` (the same probe, minus the digest clause), so the answer is
/// "did a sandboxed process actually run", verified rather than assumed.
async fn sandbox_executable(server: &TestServer, token: &str) -> bool {
    let Ok(resp) = server
        .client
        .post(server.api_url("/sandbox/execute"))
        .bearer_auth(token)
        .json(&json!({ "command": "echo probe" }))
        .send()
        .await
    else {
        return false;
    };
    match resp.json::<Value>().await {
        Ok(probe) => probe["exit_code"] == json!(0),
        Err(_) => false,
    }
}

async fn artifact_id(pool: &SqlitePool, run_id: Uuid, output_id: &str) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM artifacts WHERE run_id = $1 AND output_id = $2")
        .bind(run_id)
        .bind(output_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("artifact {output_id} was cataloged by the run: {e}"))
}

async fn status_of(pool: &SqlitePool, id: Uuid) -> String {
    sqlx::query_scalar::<_, String>("SELECT status FROM artifacts WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read artifact status")
}

/// Every `job_logs` line a job carries, in order — the operator-visible record surface
/// (`GET /jobs/{id}` returns exactly these).
async fn job_log_lines(pool: &SqlitePool, job_id: Uuid) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT content FROM job_logs WHERE job_id = $1 ORDER BY seq ASC",
    )
    .bind(job_id)
    .fetch_all(pool)
    .await
    .expect("read job logs")
}

/// Poll until `id` reaches `want` or the budget expires, returning the last status seen.
/// The dispatch is detached by design (DEC-12's accepted brief-liveness window), so
/// waiting is the honest shape — and exhausting the budget is a real failure, never a skip.
async fn await_status(pool: &SqlitePool, id: Uuid, want: &str, budget: Duration) -> String {
    let deadline = Instant::now() + budget;
    let mut last = String::new();
    while Instant::now() < deadline {
        last = status_of(pool, id).await;
        if last == want {
            return last;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    last
}

#[tokio::test]
async fn a_non_conforming_artifact_is_marked_failed_and_a_conforming_one_is_not() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    if !sandbox_executable(&server, &token).await {
        // A SKIP, recorded in the machine-readable skip ledger and a HARD FAILURE under
        // `TXR_TEST_NO_SKIP=1`. The bare `eprintln!` this replaces did neither, so the
        // one test covering the whole gate chain reported `1 passed` having run nothing.
        record_skip(
            "a_non_conforming_artifact_is_marked_failed_and_a_conforming_one_is_not",
            "the analysis sandbox is not executable on this host (the conformance gate \
             runs IN the sandbox by design — DEC-12). Point TXR_ENV_ROOTFS_SQUASHFS at a \
             rootfs.squashfs (or TXR_ENV_ROOTFS_DIR at a pre-mounted rootfs), or make the \
             live OCI env-image path reachable (`oras` + registry)",
        );
        return;
    }
    let project = create_project(&server, &token, "conformance gate").await;
    let pool = pool_for(&server).await;

    // A REAL analysis run, through `POST /jobs` → scheduler → bwrap → finalize → ingest.
    // The run itself SUCCEEDS: it is the data that is wrong, and the gate is what says so
    // afterwards — DEC-12's "a non-conforming artifact is briefly live" made concrete.
    let (run_id, signature) = run_real_analysis(
        &server,
        &token,
        &pool,
        Some(project),
        None,
        "conformance-gate",
        json!({
            "language": "python",
            "script": EMIT_SCRIPT,
            "inputs": [],
            "produces": [
                { "id": "conforming", "datatype": "file/upload", "path": "good.bin", "layout": "opaque", "role": "artifact" },
                { "id": "nonconforming", "datatype": "file/upload", "path": "bad.bin", "layout": "opaque", "role": "artifact" },
                { "id": "relabelled", "datatype": "file/upload", "path": "relabelled", "layout": "opaque", "role": "artifact" }
            ],
            "seed": 0
        }),
    )
    .await;
    assert_eq!(
        signature.len(),
        3,
        "the run cataloged all three outputs (the gate has something to gate): {signature:?}"
    );

    let good_id = artifact_id(&pool, run_id, "conforming").await;
    let bad_id = artifact_id(&pool, run_id, "nonconforming").await;
    let relabelled_id = artifact_id(&pool, run_id, "relabelled").await;

    // (1) The gate condemns the artifact whose declaration is incomplete.
    let bad_status = await_status(&pool, bad_id, "failed", Duration::from_secs(300)).await;
    assert_eq!(
        bad_status, "failed",
        "the artifact whose `structure` declares no media_type must be marked failed by \
         the post-ingest conformance job (ITEM-18 / DEC-12) — a gate that only logs is \
         not a gate. Last observed status: {bad_status}"
    );

    // (2) THE OPT-OUT, on the production path: a real Zarr store declared `opaque`. If
    // this stays `ready`, a processor author disables the gate for its own output with a
    // five-word manifest edit — which falsifies DEC-8's central claim that the author can
    // neither write nor weaken it.
    let relabelled_status =
        await_status(&pool, relabelled_id, "failed", Duration::from_secs(120)).await;
    assert_eq!(
        relabelled_status, "failed",
        "a Zarr store declared `encoding: opaque` must be condemned — otherwise `opaque` \
         is a producer-authored opt-out from every byte-level check (DEC-8). Last \
         observed status: {relabelled_status}"
    );

    // (3) NEGATIVE CONTROL, read AFTER the verdicts landed (so it is not a race that
    // passes because the gate had not run yet): the conforming artifact is untouched.
    assert_eq!(
        status_of(&pool, good_id).await,
        "ready",
        "the conforming artifact must NOT be failed — otherwise `failed` above proves \
         only that the gate fails everything it is handed"
    );

    // (4) The outcome is RECORDED on the run, where an operator meets it. All three
    // outcomes write one line; that is what lets "no line at all" be a detectable state
    // rather than looking identical to a clean pass.
    let lines = job_log_lines(&pool, run_id).await;
    let gate_lines: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains(GATE_LOG_PREFIX))
        .collect();
    assert_eq!(
        gate_lines.len(),
        1,
        "the run must carry exactly one conformance record: {lines:?}"
    );
    assert!(
        gate_lines[0].contains("FAILED") && gate_lines[0].contains(&bad_id.to_string()),
        "the record must name the artifacts that were marked failed: {}",
        gate_lines[0]
    );
    assert!(
        gate_lines[0].contains(&relabelled_id.to_string()),
        "…including the relabelled store: {}",
        gate_lines[0]
    );

    // (5) **THE CONSEQUENCE — end to end.** Everything above proves the gate's WRITE.
    // This closes the loop: an artifact this real run produced, that this real gate
    // condemned, is no longer served. Without it the whole chain still ends at a column
    // nothing reads, which is exactly the state ITEM-18 shipped in — DEC-12's "briefly
    // live before the job flags it" describing a window that never closed.
    //
    // The `ready` output is read on the same route as the control, so the refusals are
    // attributable to the gate's verdict and not to the byte plane being down.
    // (`conformance_read_half_test` covers every other surface of the read half without
    // needing a sandbox; this leg is the one that runs the ACTUAL gate first.)
    let serve = |id: uuid::Uuid| {
        server
            .client
            .get(server.api_url(&format!("/artifacts/{id}/data")))
            .bearer_auth(&token)
            .send()
    };
    for (label, id) in [("nonconforming", bad_id), ("relabelled", relabelled_id)] {
        let r = serve(id).await.expect("GET /artifacts/{id}/data");
        assert_eq!(
            r.status().as_u16(),
            409,
            "{label}: the gate condemned this artifact, so its bytes must stop being \
             served (409 ARTIFACT_NOT_CONFORMING — the row stays listed and readable, so \
             not 404)"
        );
        let v: serde_json::Value = r.json().await.expect("error body");
        assert_eq!(
            v["error_code"],
            txresbench::modules::workstore::consume::ERR_NOT_CONFORMING,
            "{label}: refused by the conformance read half, not by some other gate"
        );
    }
    let r = serve(good_id).await.expect("GET good /data");
    assert_eq!(
        r.status().as_u16(),
        200,
        "POSITIVE CONTROL: the conforming output of the SAME run still serves — the \
         refusals above are about the verdict, not about the route"
    );
}

/// **FINDING 3 — the gate fails open, and used to do it silently.**
///
/// The distinction being defended is real and is kept: a gate that RAN and found
/// violations marks the artifact `failed`; a gate that COULD NOT RUN must not claim the
/// bytes disagree with their declaration, because that is a false statement about data
/// that may be perfectly fine. What was indefensible is the *silence* that accompanied
/// it — an `error!` line, which `tracing` swallows in a test process and which is not
/// attached to the run whose data is unverified. Combined with the self-skip above, one
/// absent rootfs removed both the enforcement and the evidence.
///
/// This test drives the REAL indeterminate path — `gate_now` → `run_gate` → a spawn that
/// cannot stage its inputs — and asserts BOTH halves:
///
///  * the honest half: the artifacts are NOT marked failed, and NOT moved at all;
///  * the missing half: the producing run carries an operator-visible `NOT VERIFIED`
///    record naming every unverified artifact.
///
/// It needs no sandbox and therefore no skip: the catalog rows it submits have no blobs,
/// so input materialization fails on every host — including one where the sandbox works.
#[tokio::test]
async fn the_gate_records_an_unverified_outcome_when_it_cannot_reach_a_verdict() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gate indeterminate").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // A real `jobs` row to hang the record on (the FK target), plus two real catalog
    // rows whose blobs do not exist — so `materialize_inputs` fails and the gate reaches
    // no verdict, deterministically, sandbox or no sandbox.
    let job_id = insert_running_job(&pool, owner, "analysis", None).await;
    let mut targets = Vec::new();
    for (i, output) in ["alpha", "beta"].iter().enumerate() {
        let id = seed_artifact(
            &pool,
            Some(project),
            None,
            Some(job_id),
            output,
            &format!("sha256:{:064x}", 0xA1 + i),
            "file/upload",
            false,
        )
        .await;
        targets.push(GateTarget {
            artifact_id: id,
            project_id: Some(project),
            dataset_id: None,
            structure: json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
            meta: json!({}),
        });
    }
    let before: Vec<String> = {
        let mut v = Vec::new();
        for t in &targets {
            v.push(status_of(&pool, t.artifact_id).await);
        }
        v
    };
    assert!(
        before.iter().all(|s| s == "ready"),
        "the fixture rows start `ready`: {before:?}"
    );

    // The run already wrote its own output. The gate records AFTER the run finished and
    // owns no streaming counter, so it must append past what is there rather than
    // colliding with (or sorting before) the run's own lines.
    for (seq, line) in [(1, "the run's first line"), (2, "the run's second line")] {
        sqlx::query(
            "INSERT INTO job_logs (id, job_id, seq, stream, content)
             VALUES (randomblob(16), $1, $2, 'stdout', $3)",
        )
        .bind(job_id)
        .bind(seq as i32)
        .bind(line)
        .execute(&pool)
        .await
        .expect("seed the run's own log");
    }

    let outcome = gate_now(&pool, owner, job_id, job_id, &targets).await;

    // (1) It really was indeterminate — not a pass, and not a verdict. Asserted on the
    // RETURNED outcome, which is why `gate_now` returns one: the previous shape reported
    // this only through `tracing`, so no test could tell it from a clean run.
    let reason = match &outcome {
        GateOutcome::Indeterminate { reason } => reason.clone(),
        other => panic!(
            "expected an indeterminate outcome from a gate whose inputs cannot be \
             staged, got {other:?}"
        ),
    };
    assert!(!outcome.is_verdict());
    assert!(!reason.is_empty(), "an indeterminate outcome must say why");

    // (2) THE HONEST HALF — nothing was condemned. Marking data `failed` because the
    // checker could not run would be the same dishonesty as a gate that only logs,
    // pointed the other way.
    let repo = CatalogRepository::new(pool.clone());
    for t in &targets {
        assert_eq!(
            status_of(&pool, t.artifact_id).await,
            "ready",
            "an artifact the gate never examined must not be marked failed"
        );
        assert!(
            repo.get_any_status(t.artifact_id)
                .await
                .expect("row")
                .is_some(),
            "…and must still exist"
        );
    }

    // (3) THE HALF THAT WAS MISSING — the run says so, durably, where an operator looks.
    let lines = job_log_lines(&pool, job_id).await;
    assert_eq!(
        &lines[..2],
        &["the run's first line", "the run's second line"],
        "the gate's record must append AFTER the run's own output, not collide with it: \
         {lines:?}"
    );
    let record = lines
        .iter()
        .find(|l| l.contains(GATE_LOG_UNVERIFIED))
        .unwrap_or_else(|| {
            panic!(
                "the run carries no `{GATE_LOG_UNVERIFIED}` record — the gate failed open \
                 SILENTLY, which is the state this test exists to forbid. Lines: {lines:?}"
            )
        });
    for t in &targets {
        assert!(
            record.contains(&t.artifact_id.to_string()),
            "the record must name every unverified artifact ({}): {record}",
            t.artifact_id
        );
    }
    assert!(
        record.contains("UNCHECKED") && record.contains(&reason),
        "the record must say the bytes are unchecked and why: {record}"
    );
    assert!(
        !record.contains("FAILED"),
        "an indeterminate outcome must not read as a condemnation: {record}"
    );
}

// The three outcomes render three UNCONFUSABLE records — pinned in-source (pure
// function, no DB) by `jobs::conformance::tests::the_three_outcomes_render_records_nobody_can_confuse`.
// That is the control which stops "the run carries a NOT VERIFIED line" from being
// satisfiable by a recorder that writes that line unconditionally.

/// **The `{}` contradiction, resolved and pinned across the seam.**
///
/// Two layers disagreed about the same document and nothing noticed, because nothing
/// ingested a `{}` artifact and then ran the gate over it:
///
///  * INV-2's acceptance test showed an explicitly-empty declaration is a legal value for
///    the `structure` COLUMN (the refusal is about ABSENCE, not emptiness), and the
///    manifest accepted `{}` too;
///  * `conformance.py` condemned it — `{}` names no encoding — so the artifact ingested
///    clean and was marked `failed` moments later by a job the producer never sees.
///
/// Resolved in ONE direction: **`{}` is not a declaration.** The alternative — teaching
/// the gate that `{}` means "nothing to declare" — hands every producer a way to make the
/// gate check nothing, i.e. the opt-out DEC-8 forbids, and the twin of the
/// `encoding: "opaque"` hole this suite's `relabelled` case covers.
///
/// This test is the seam: the shapes refused at ingest here are the SAME shapes the gate
/// condemns in `test_conformance.py::test_a_structure_that_names_no_encoding_is_not_a_declaration`
/// and `test_verify_conformance.py::test_an_encodingless_structure_is_condemned_by_the_production_entry`.
/// The two halves are in different languages, so the agreement is asserted on both sides
/// and cross-referenced by name rather than left to inspection.
#[tokio::test]
async fn an_encodingless_structure_is_refused_at_ingest_the_way_the_gate_condemns_it() {
    use txresbench::modules::workstore::ingest::ingest_run_outputs;

    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "encodingless structure").await;
    let pool = pool_for(&server).await;
    let ingest = |structure: Value| {
        let store = super::server_store(&server);
        let pool = pool.clone();
        let server = &server;
        async move {
            let ws = server
                .data_dir()
                .join(format!("staging-{}", Uuid::new_v4()));
            super::write_manifest(
                &ws,
                &json!({ "outputs": [{
                    "id": "declared", "datatype": "file/upload", "path": "payload.bin",
                    "layout": "opaque", "role": "artifact",
                    "structure": structure, "meta": {}
                }]}),
                &[("payload.bin", b"declared bytes")],
            )
            .await;
            let run_id = Uuid::new_v4();
            (
                run_id,
                ingest_run_outputs(&pool, &store, Some(project), None, run_id, None, &ws).await,
            )
        }
    };

    // POSITIVE CONTROL — the byte-identical manifest WITH an encoding ingests, so every
    // refusal below is about the one field that changed and not about the fixture.
    let (_run, res) = ingest(json!({ "encoding": "opaque", "media_type": "text/plain" })).await;
    assert_eq!(res.expect("a declared encoding ingests").len(), 1);

    for empty in [
        json!({}),
        json!({ "media_type": "application/octet-stream" }),
        json!({ "encoding": "" }),
        json!({ "encoding": null }),
    ] {
        let (run, res) = ingest(empty.clone()).await;
        let err = match res {
            Err(e) => e,
            Ok(rows) => panic!(
                "a `structure` of {empty} was accepted at ingest while the conformance \
                 gate condemns it — the two layers must give the same answer, or an \
                 artifact ingests clean and is failed by a job its producer never sees. \
                 Landed: {rows:?}"
            ),
        };
        assert_eq!(err.error_code(), "BAD_MANIFEST", "for {empty}");
        let message = serde_json::to_value(&err).expect("AppError serializes")["message"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        assert!(
            message.contains("encoding"),
            "the refusal must name what is missing (`encoding`) — BAD_MANIFEST alone is \
             the code EVERY manifest defect answers with, so it discriminates nothing. \
             Got: {message}"
        );
        let listed = txresbench::modules::workstore::catalog::repository::CatalogRepository::new(
            pool.clone(),
        )
        .list_by_run(project, run)
        .await
        .expect("list");
        assert!(
            listed.is_empty(),
            "a refused ingest left a catalog row behind"
        );
    }
}

// ─────────── an INFRASTRUCTURE FAULT must not condemn the data it broke ───────────

/// Stage a gate run's TWO dirs the way `materialize_inputs` + the verification job
/// leave them (ITEM-17), then hand both to the real classifier. Returns
/// `(workspace, staging)`: the staged `/inputs` the classifier checks for an
/// infrastructure fault live in the WORKSPACE, while the verdict the gate wrote to
/// `/outputs` lands in a SEPARATE staging tree — which is what `run_gate` passes.
///
/// `dirs` names the targets staged as a multi-file directory rather than a single blob.
async fn stage_gate_run_dirs(
    root: &std::path::Path,
    targets: &[GateTarget],
    verdict: &Value,
    dirs: &[Uuid],
) -> (std::path::PathBuf, std::path::PathBuf) {
    let run = Uuid::new_v4();
    let ws = root.join("sandboxes").join(format!("gate-ws-{run}"));
    let staging = root.join("run-staging").join(format!("gate-ws-{run}"));
    assert!(
        !staging.starts_with(&ws),
        "the run's output staging is a separate tree, not a subdir of its workspace"
    );
    let inputs = ws.join("inputs");
    let outputs = txresbench::modules::sandbox::outputs::outputs_dir(&staging);
    tokio::fs::create_dir_all(&inputs).await.expect("inputs");
    tokio::fs::create_dir_all(&outputs).await.expect("outputs");
    tokio::fs::write(inputs.join("params.json"), b"{}")
        .await
        .expect("params.json");
    for t in targets {
        if dirs.contains(&t.artifact_id) {
            let d = inputs.join(t.artifact_id.to_string());
            tokio::fs::create_dir_all(&d).await.expect("staged dir");
            tokio::fs::write(d.join("zarr.json"), b"{}")
                .await
                .expect("member");
        } else {
            tokio::fs::write(inputs.join(t.artifact_id.to_string()), b"declared bytes")
                .await
                .expect("staged blob");
        }
    }
    tokio::fs::write(
        outputs.join("verdict.json"),
        serde_json::to_vec(verdict).unwrap(),
    )
    .await
    .expect("verdict.json");
    (ws, staging)
}

/// **An infrastructure fault CONDEMNED good data, and the trigger was real.**
///
/// `conformance.py` reports a staged input whose bytes are not there as an ordinary
/// per-artifact violation (`declared bytes are missing at …`, `error: None`, exit 1). At the
/// wire that is indistinguishable from "these bytes disagree with their declaration", so
/// [`apply_verdict`] flipped those rows to `failed` — the exact false statement this
/// module's own doc forbids, about data that may be perfectly fine.
///
/// The trigger is not hypothetical. `run_gate` spawns a synthetic job with no `jobs` row,
/// `is_stale_workspace` therefore calls its workspace stale, and `JobsModule::init` runs
/// `reconcile_orphaned_running` (finalize → ingest → `dispatch_after_ingest`) and then
/// `sweep_stale_workspaces` in the SAME task. A boot sweep could delete the `/inputs` of a
/// verification the same boot had just started. `scheduler::hold_live_workspace` closes
/// that window; this test covers the classification, which has to hold for every other way
/// staging can be lost (an operator `rm`, a filesystem fault, a future second sweeper).
///
/// Both halves are asserted, on the real DB, through the real `conclude`:
///  * the artifacts are NOT marked failed, and
///  * the run carries the operator-visible `NOT VERIFIED` record.
///
/// **The positive control is what makes it a test rather than a tautology**: the SAME
/// verdict over INTACT staging still condemns and still marks `failed`. A change that
/// merely stopped the gate condemning anything would fail that leg.
#[tokio::test]
async fn missing_input_bytes_do_not_condemn_the_artifacts_they_belong_to() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gate staging fault").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // Two runs so the two legs cannot contaminate each other's rows or log.
    let leg = |name: &'static str| {
        let pool = pool.clone();
        async move {
            let job_id = insert_running_job(&pool, owner, "analysis", None).await;
            let mut targets = Vec::new();
            for output in ["alpha", "beta"] {
                let id = seed_artifact(
                    &pool,
                    Some(project),
                    None,
                    Some(job_id),
                    &format!("{name}-{output}"),
                    &format!("sha256:{:064x}", Uuid::new_v4().as_u128()),
                    "file/upload",
                    false,
                )
                .await;
                targets.push(GateTarget {
                    artifact_id: id,
                    project_id: Some(project),
                    dataset_id: None,
                    structure: json!({
                        "encoding": "opaque", "media_type": "application/octet-stream"
                    }),
                    meta: json!({}),
                });
            }
            (job_id, targets)
        }
    };

    // The verdict `verify_conformance.py` writes when a staged input is not there: a
    // per-artifact violation, `error` unset, exit 1. Verbatim, because the whole defect is
    // that this shape is not distinguishable from a real condemnation.
    // `evidence` rides along because the entry emits it for every artifact it examined and
    // the server's positive control now requires a non-zero tally, not just a `checked`
    // listing (which the gate used to copy straight out of the manifest the server sent).
    let condemning = |targets: &[GateTarget]| {
        json!({
            "schema": 1,
            "checked": targets.iter().map(|t| t.artifact_id.to_string()).collect::<Vec<_>>(),
            "evidence": targets
                .iter()
                .map(|t| (t.artifact_id.to_string(), json!({ "checks": 1, "read_bytes": 14 })))
                .collect::<serde_json::Map<_, _>>(),
            "violations": {
                targets[0].artifact_id.to_string(): [format!(
                    "{}: declared bytes are missing at /inputs/{}",
                    targets[0].artifact_id, targets[0].artifact_id
                )],
            },
            "run_violations": [],
        })
    };

    // ── POSITIVE CONTROL: intact staging ⇒ the verdict is believed, and it condemns.
    let (ctrl_job, ctrl_targets) = leg("intact").await;
    let (ctrl_ws, ctrl_stg) = stage_gate_run_dirs(
        &server.data_dir(),
        &ctrl_targets,
        &condemning(&ctrl_targets),
        &[],
    )
    .await;
    let ctrl_result = verdict_from_run(&ctrl_ws, &ctrl_stg, &ctrl_targets).await;
    assert!(
        ctrl_result.is_ok(),
        "intact staging must still yield a verdict: {ctrl_result:?}"
    );
    let ctrl_outcome = conclude(&pool, ctrl_job, ctrl_job, &ctrl_targets, ctrl_result).await;
    match &ctrl_outcome {
        GateOutcome::Violations { failed, .. } => {
            assert_eq!(failed, &vec![ctrl_targets[0].artifact_id])
        }
        other => panic!("a reached verdict naming a violation must condemn, got {other:?}"),
    }
    assert_eq!(
        status_of(&pool, ctrl_targets[0].artifact_id).await,
        "failed",
        "the gate must still mark a genuinely condemned artifact failed"
    );
    assert_eq!(
        status_of(&pool, ctrl_targets[1].artifact_id).await,
        "ready",
        "…and only the one it named"
    );

    // ── THE FIX: the same verdict, with the staged bytes made unreachable.
    let (job_id, targets) = leg("swept").await;
    let (ws, stg) =
        stage_gate_run_dirs(&server.data_dir(), &targets, &condemning(&targets), &[]).await;
    // The sweep takes the WORKSPACE — `/inputs` is workspace scratch, so ITEM-17 does
    // not move it out of harm's way. The verdict in the staging tree survives intact,
    // which is precisely the situation the classifier has to see through: a complete,
    // condemning verdict sitting next to staging that is gone.
    tokio::fs::remove_file(ws.join("inputs").join(targets[0].artifact_id.to_string()))
        .await
        .expect("make the staged input bytes unreachable");
    assert!(
        stg.join("outputs").join("verdict.json").exists(),
        "the verdict is untouched by the loss of the inputs it was written from"
    );

    let result = verdict_from_run(&ws, &stg, &targets).await;
    let outcome = conclude(&pool, job_id, job_id, &targets, result).await;

    // (1) It is classified as a NON-verdict, not as a condemnation.
    let reason = match &outcome {
        GateOutcome::Indeterminate { reason } => reason.clone(),
        other => panic!(
            "bytes the SERVER staged going missing is an infrastructure fault, not a \
             statement about the artifacts — got {other:?}"
        ),
    };
    assert!(!outcome.is_verdict());
    assert!(
        reason.contains(&targets[0].artifact_id.to_string()),
        "the reason must name the artifact whose staging was lost: {reason}"
    );

    // (2) NOTHING is condemned. This is the half that was broken: a boot sweep deleting a
    // live verification's workspace flipped perfectly good artifacts to `failed`.
    let repo = CatalogRepository::new(pool.clone());
    for t in &targets {
        assert_eq!(
            status_of(&pool, t.artifact_id).await,
            "ready",
            "an artifact whose staged bytes vanished under the gate must NOT be marked \
             failed — the gate did not judge those bytes, it never read them"
        );
        assert!(repo
            .get_any_status(t.artifact_id)
            .await
            .expect("row")
            .is_some());
    }

    // (3) …and the run says so, where an operator meets it.
    let lines = job_log_lines(&pool, job_id).await;
    let record = lines
        .iter()
        .find(|l| l.contains(GATE_LOG_UNVERIFIED))
        .unwrap_or_else(|| {
            panic!("no `{GATE_LOG_UNVERIFIED}` record for a staging fault: {lines:?}")
        });
    assert!(
        !record.contains("FAILED"),
        "a staging fault must not read as a condemnation: {record}"
    );
    for t in &targets {
        assert!(record.contains(&t.artifact_id.to_string()), "{record}");
    }
    for dir in [&ws, &stg, &ctrl_ws, &ctrl_stg] {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

// ─────────── the outcome is what the gate CONCLUDED, not what PERSISTED ───────────

/// **A failed status write used to invert the operator's only signal.**
///
/// The `Conformed` / `Violations` branch was chosen from the list of rows that were
/// successfully flipped, so a `set_status` error dropped the row and a batch whose every
/// condemnation failed to write recorded `conformance: OK — N artifact(s) verified`. The
/// gate had condemned the data; the log said it was verified.
///
/// Two deterministic legs, one per way a write can fail to apply:
///  * the row is GONE — `UPDATE … WHERE id = $1` matches nothing. `set_status` reported
///    that as success, so the record claimed an artifact had been marked failed when
///    nothing had been written at all.
///  * the write ERRORS — driven with a closed pool, which is the case that produced the
///    `OK`-over-condemned-data inversion.
#[tokio::test]
async fn a_condemnation_the_server_could_not_write_is_never_reported_as_ok() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gate unpersisted").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let job_id = insert_running_job(&pool, owner, "analysis", None).await;

    let mut targets = Vec::new();
    for output in ["gone", "kept"] {
        let id = seed_artifact(
            &pool,
            Some(project),
            None,
            Some(job_id),
            output,
            &format!("sha256:{:064x}", Uuid::new_v4().as_u128()),
            "file/upload",
            false,
        )
        .await;
        targets.push(GateTarget {
            artifact_id: id,
            project_id: Some(project),
            dataset_id: None,
            structure: json!({ "encoding": "opaque", "media_type": "text/plain" }),
            meta: json!({}),
        });
    }
    let condemned_id = targets[0].artifact_id;
    let verdict: GateVerdict = serde_json::from_value(json!({
        "schema": 1,
        "checked": targets.iter().map(|t| t.artifact_id.to_string()).collect::<Vec<_>>(),
        "violations": { condemned_id.to_string(): ["value: does not decode"] },
        "run_violations": [],
    }))
    .expect("verdict");

    // ── LEG 1: the condemned row no longer exists.
    assert!(
        CatalogRepository::new(pool.clone())
            .delete(condemned_id)
            .await
            .expect("delete"),
        "the fixture row existed before it was deleted"
    );
    let applied = apply_verdict(&pool, &targets, &verdict)
        .await
        .expect("every violation label is an artifact id");
    assert_eq!(
        applied.condemned,
        vec![condemned_id],
        "the CONCLUSION is unaffected by whether the write landed"
    );
    assert!(
        applied.flipped.is_empty(),
        "an UPDATE that matched no row did not mark anything failed: {applied:?}"
    );
    assert_eq!(applied.unpersisted, vec![condemned_id]);

    let outcome = conclude(&pool, job_id, job_id, &targets, Ok(verdict.clone())).await;
    assert_eq!(
        outcome,
        GateOutcome::Violations {
            failed: vec![],
            unpersisted: vec![condemned_id],
            run_violations: 0,
        },
        "a condemnation the server could not write is still a condemnation"
    );
    let record = job_log_lines(&pool, job_id)
        .await
        .into_iter()
        .find(|l| l.contains(GATE_LOG_PREFIX))
        .expect("the gate recorded an outcome on the run");
    assert!(
        !record.contains(&format!("were marked failed [{condemned_id}]")),
        "the record must not claim a row was marked failed when the write applied to \
         nothing: {record}"
    );
    assert!(
        record.contains("CONDEMNED but the status write did NOT persist")
            && record.contains(&condemned_id.to_string()),
        "the record must name the rows that are still serving as `ready`: {record}"
    );

    // ── LEG 2: the write ERRORS. A closed pool fails every query, which is exactly the
    // shape that used to be reported as `conformance: OK`.
    let dead = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(server.database_url())
        .await
        .expect("connect a second pool");
    dead.close().await;
    let applied = apply_verdict(&dead, &targets, &verdict)
        .await
        .expect("every violation label is an artifact id");
    assert_eq!(applied.condemned, vec![condemned_id]);
    assert!(
        applied.flipped.is_empty() && applied.unpersisted == vec![condemned_id],
        "a DB error must land in `unpersisted`, never be dropped: {applied:?}"
    );
    let outcome = conclude(&dead, job_id, job_id, &targets, Ok(verdict)).await;
    match &outcome {
        GateOutcome::Violations {
            failed,
            unpersisted,
            ..
        } => {
            assert!(failed.is_empty() && unpersisted == &vec![condemned_id]);
        }
        other => panic!(
            "a condemning verdict whose every write failed must NOT be reported as \
             conformant — that is a write error silently inverting the meaning of the one \
             line an operator reads. Got {other:?}"
        ),
    }
    assert!(outcome.is_verdict());

    // NEGATIVE CONTROL: the artifact the verdict did not name is untouched throughout, so
    // none of the above is satisfiable by a path that condemns everything.
    assert_eq!(status_of(&pool, targets[1].artifact_id).await, "ready");
}

/// **A violation nobody can attribute used to be forgotten, and the batch reported OK.**
///
/// `GateVerdict::condemned` parsed its keys with `filter_map(… .ok())`, so a `violations`
/// key that is not an artifact id was discarded — no log, no run-level violation, no error.
/// Nothing downstream could report it either: `apply_verdict` walks the already-parsed ids,
/// and `violations` is only ever logged from the `Violations` arm, which is not taken when
/// the parsed list is empty. So a verdict whose only violations sat under such keys passed
/// the evidence control (that reads `checked`/`evidence`, never `violations`) and came out
/// as `Conformed` — "every ingested artifact conforms" recorded over condemned data.
///
/// Driven through `conclude`, which is where the outcome is chosen, so this pins the NET
/// RESULT rather than the parse in isolation. Both rows must keep the status ingest gave
/// them: the verdict is refused whole, not enforced in part.
#[tokio::test]
async fn a_violation_under_a_label_that_is_not_an_artifact_id_is_never_reported_as_ok() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gate unattributable").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let job_id = insert_running_job(&pool, owner, "analysis", None).await;

    let artifact = seed_artifact(
        &pool,
        Some(project),
        None,
        Some(job_id),
        "kept",
        &format!("sha256:{:064x}", Uuid::new_v4().as_u128()),
        "file/upload",
        false,
    )
    .await;
    let targets = vec![GateTarget {
        artifact_id: artifact,
        project_id: Some(project),
        dataset_id: None,
        structure: json!({ "encoding": "opaque", "media_type": "text/plain" }),
        meta: json!({}),
    }];

    // The submitted artifact is fully accounted for — read, no violation. The ONLY
    // violation rides under a key this server cannot attribute to any row.
    let verdict: GateVerdict = serde_json::from_value(json!({
        "schema": 1,
        "checked": [artifact.to_string()],
        "evidence": { artifact.to_string(): {
            "checks": 4, "shards": 1, "chunks": 3, "decoded_bytes": 4096, "read_bytes": 1210
        } },
        "violations": { "outputs[0]": ["value: does not decode"] },
        "run_violations": [],
    }))
    .expect("verdict");

    let outcome = conclude(&pool, job_id, job_id, &targets, Ok(verdict)).await;
    match &outcome {
        GateOutcome::Indeterminate { reason } => {
            assert!(
                reason.contains("outputs[0]"),
                "the label that could not be attributed must be NAMED, or it is dropped by \
                 a second route: {reason}"
            );
        }
        other => panic!(
            "a verdict carrying a condemnation this server cannot attribute must not be \
             reported as conformant — that is the same silent inversion the unpersisted-write \
             case closed, one layer up. Got {other:?}"
        ),
    }
    assert!(
        !outcome.is_verdict(),
        "…and it is NOT a verdict about the bytes"
    );
    assert_eq!(
        status_of(&pool, artifact).await,
        "ready",
        "nothing is enforced from a verdict that could not be attributed whole"
    );

    let record = job_log_lines(&pool, job_id)
        .await
        .into_iter()
        .find(|l| l.contains(GATE_LOG_PREFIX))
        .expect("the gate recorded an outcome on the run");
    assert!(
        record.contains("NOT VERIFIED"),
        "the operator-visible record must say the batch was not verified: {record}"
    );
}

// ─────────── the REAL gate's own output, driven into the REAL `conclude` ───────────

/// The processors' shared library directory, where `verify_conformance.py` lives.
fn gate_lib_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../packages/_lib")
}

/// Build the fixture stores with the REAL writer, then run the REAL entry over them.
///
/// The only thing redirected is where `/inputs` and `/outputs` are mounted — the same and
/// only deviation the Python suite makes — so `main()` is production's `main()`, reading
/// bytes `txr_zarr` actually wrote and writing the `verdict.json` this server then reads.
/// `spec` is `[{id, path, n, delete_shard?}]`; the DECLARATION each artifact is checked
/// against is whatever the writer stamped, never anything this test composes.
///
/// **`path` is supplied by the caller, from `GateTarget::subpath()`** — the SERVER's own
/// derivation of where it stages an artifact for the gate (ITEM-23: a sanitized slot plus
/// a suffix read off `structure.encoding`, so a `zarr_v3` artifact lands at `<id>.zarr`).
/// This fixture stands in for the runner's staging step, so it must stage where the
/// runner would; hardcoding `<id>` on this side made the fixture and `staging_fault`
/// disagree, and the disagreement (not the gate) is what failed the batch.
const FIXTURE_AND_GATE: &str = r#"
import json, os, sys
sys.path.insert(0, sys.argv[1])
import numpy as np
import txr_zarr as cz
import verify_conformance as v
inputs, outputs, spec = sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
entries = []
for item in spec:
    root = os.path.join(inputs, item['path'])
    n = int(item['n'])
    with cz.Table(root, axis='rows', n=n) as t:
        t.numeric('value', np.arange(n, dtype=np.float32), dtype='float32')
        structure = t.close()
    if item.get('delete_shard'):
        os.unlink(os.path.join(root, 'value', 'c', '0'))
    entries.append({'id': item['id'], 'path': item['path'], 'structure': structure})
with open(os.path.join(inputs, 'params.json'), 'w') as fh:
    json.dump({'outputs': entries}, fh)
v.INPUTS, v.OUTPUTS = inputs, outputs
v.VERDICT = os.path.join(outputs, 'verdict.json')
raise SystemExit(v.main())
"#;

/// Can this host run the fixture writer + the gate? Both are plain Python; the writer
/// needs `numpy`, which is the whole dependency.
fn gate_runnable() -> bool {
    gate_lib_dir().join("verify_conformance.py").is_file()
        && std::process::Command::new("python3")
            .args(["-c", "import numpy"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
}

/// Run one batch through the real gate and return `(exit code, stderr, workspace,
/// staging)` — the dirs laid out exactly as `run_gate` hands them to `verdict_from_run`
/// (ITEM-17: the staged `/inputs` are workspace scratch, the verdict is in a SEPARATE
/// staging tree).
fn run_real_gate(
    root: &std::path::Path,
    spec: &Value,
) -> (i32, String, std::path::PathBuf, std::path::PathBuf) {
    let run = Uuid::new_v4();
    let ws = root.join("sandboxes").join(format!("real-gate-{run}"));
    let staging = root.join("run-staging").join(format!("real-gate-{run}"));
    let inputs = ws.join("inputs");
    let outputs = txresbench::modules::sandbox::outputs::outputs_dir(&staging);
    std::fs::create_dir_all(&inputs).expect("inputs");
    std::fs::create_dir_all(&outputs).expect("outputs");
    let out = std::process::Command::new("python3")
        .arg("-c")
        .arg(FIXTURE_AND_GATE)
        .arg(gate_lib_dir())
        .arg(&inputs)
        .arg(&outputs)
        .arg(spec.to_string())
        .output()
        .expect("spawn the real gate");
    let code = out.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    assert!(
        (0..=2).contains(&code),
        "the entry exits 0/1/2 only; got {code} — stderr: {stderr}"
    );
    (code, stderr, ws, staging)
}

/// **The seam nothing crossed: what `checks` MEANS on the gate's side vs what this server
/// DOES with it.**
///
/// Every other test in this file hand-writes its `verdict.json`, so both halves could
/// agree with their own docstrings while disagreeing with each other — and they did. The
/// gate's container reader recorded its receipt from `len(shards)`, a count derived from
/// the DECLARED grid, ABOVE the loop that opens anything. An `n=0` member (a legal shape
/// the real writer emits, with a real but EMPTY chunk plane) therefore came back
/// `checks: 1, chunks: 0, decoded_bytes: 0`, `checked: [the artifact]`, `violations: {}`,
/// exit 0 — which is `examined()` true, `accounts_for()` true, nothing condemned, i.e.
/// `GateOutcome::Conformed` over an artifact whose bytes were never opened. No hand-written
/// fixture would ever have been written that way, which is exactly why it survived.
///
/// Three batches, three arms, all from the real entry's real output:
///
/// | fixture | the gate | this server |
/// |---|---|---|
/// | an intact table | exit 0, a receipt with decoded bytes | `Conformed`, row stays `ready` |
/// | a table with its only shard file DELETED | exit 1, a violation, NO receipt | `Violations`, row `failed` |
/// | an `n=0` table (legal, nothing to read) | exit 1, no violation, NO receipt | `Indeterminate`, row stays `ready` |
///
/// The third row is the one under repair, and it is asserted on BOTH sides at once: the
/// gate must not call it clean, and this server must not call it either conforming or bad.
#[tokio::test]
async fn the_real_gates_own_verdict_drives_the_real_outcome() {
    if !gate_runnable() {
        record_skip(
            "the_real_gates_own_verdict_drives_the_real_outcome",
            "python3 with numpy is required to write the fixture stores the real gate reads",
        );
        return;
    }
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "gate real verdict").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let data_dir = server.data_dir();

    // One batch per arm: a verdict is refused or acted on WHOLE, so mixing them into one
    // batch would let the strongest arm mask the others.
    for (label, rows, want_exit, expect) in [
        ("intact", json!([{ "n": 64 }]), 0, "conformed"),
        (
            "deleted-shard",
            json!([{ "n": 64, "delete_shard": true }]),
            1,
            "violations",
        ),
        ("nothing-to-read", json!([{ "n": 0 }]), 1, "indeterminate"),
    ] {
        let job_id = insert_running_job(&pool, owner, "analysis", None).await;
        let id = seed_artifact(
            &pool,
            Some(project),
            None,
            Some(job_id),
            label,
            &format!("sha256:{:064x}", Uuid::new_v4().as_u128()),
            "file/upload",
            true,
        )
        .await;
        // The declaration the GATE checks against is the one the writer stamped into
        // `params.json`, which is the point of running it for real. The `structure` here
        // is read for exactly ONE thing: `GateTarget::subpath()` — the server's derivation
        // (ITEM-23) of where this artifact is staged — which `verdict_from_run`'s
        // staging-fault check then looks under.
        let targets = vec![GateTarget {
            artifact_id: id,
            project_id: Some(project),
            dataset_id: None,
            structure: json!({ "encoding": "zarr_v3", "kind": "table" }),
            meta: json!({}),
        }];
        let mut spec = rows.as_array().expect("spec rows").clone();
        spec[0]["id"] = json!(id.to_string());
        // The fixture stages where the SERVER says it staged — one source for both sides,
        // so the two can no longer be hardcoded into disagreement.
        spec[0]["path"] = json!(targets[0].subpath());
        let (code, stderr, ws, staging) = run_real_gate(&data_dir, &Value::Array(spec));
        assert_eq!(
            code, want_exit,
            "[{label}] the real entry's exit code is half its contract — stderr: {stderr}"
        );

        let verdict_doc: Value = serde_json::from_slice(
            &std::fs::read(
                txresbench::modules::sandbox::outputs::outputs_dir(&staging).join("verdict.json"),
            )
            .expect("the gate wrote a verdict"),
        )
        .expect("…and it parses");
        let result = verdict_from_run(&ws, &staging, &targets).await;
        let outcome = conclude(&pool, job_id, job_id, &targets, result).await;

        match expect {
            "conformed" => {
                assert_eq!(
                    outcome,
                    GateOutcome::Conformed { checked: 1 },
                    "[{label}] a table the gate read every byte of conforms: {verdict_doc}"
                );
                assert!(
                    verdict_doc["evidence"][id.to_string()]["decoded_bytes"]
                        .as_u64()
                        .unwrap_or(0)
                        > 0,
                    "[{label}] …and the receipt behind it records the bytes: {verdict_doc}"
                );
                assert_eq!(status_of(&pool, id).await, "ready");
            }
            "violations" => {
                match &outcome {
                    GateOutcome::Violations { failed, .. } => assert_eq!(failed, &vec![id]),
                    other => panic!("[{label}] bytes that do not decode condemn: {other:?}"),
                }
                assert!(
                    verdict_doc["evidence"].get(id.to_string()).is_none(),
                    "[{label}] a file that does not exist earns no receipt for having been \
                     read — this used to report `shards: 1`: {verdict_doc}"
                );
                assert_eq!(status_of(&pool, id).await, "failed");
            }
            _ => {
                match &outcome {
                    GateOutcome::Indeterminate { reason } => assert!(
                        reason.contains(&id.to_string()),
                        "[{label}] the unread artifact must be named: {reason}"
                    ),
                    other => panic!(
                        "[{label}] an artifact with NOTHING to read is neither conforming nor \
                         condemned — got {other:?} from {verdict_doc}"
                    ),
                }
                assert_eq!(
                    verdict_doc["violations"],
                    json!({}),
                    "[{label}] legitimate empty data must not be condemned: {verdict_doc}"
                );
                assert_eq!(
                    status_of(&pool, id).await,
                    "ready",
                    "[{label}] …so the row keeps the status ingest gave it"
                );
                let record = job_log_lines(&pool, job_id)
                    .await
                    .into_iter()
                    .find(|l| l.contains(GATE_LOG_PREFIX))
                    .expect("the gate recorded an outcome on the run");
                assert!(
                    record.contains(GATE_LOG_UNVERIFIED),
                    "[{label}] and an operator is told it was not verified: {record}"
                );
            }
        }
    }
}
