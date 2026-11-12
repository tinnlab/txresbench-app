//! TEST-20 — the interaction chokepoint: `POST /provenance/selections` on a known
//! input writes a `selection.*` run node + an emitted code blob + a `used` edge
//! (by content-hash) + a generated recipe artifact in P1's catalog; a selection
//! on an UNKNOWN input is rejected by the closure guard (400).

use super::*;

#[tokio::test]
async fn selection_records_run_code_edge_and_artifact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "interaction project").await;

    let run = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run_id = Uuid::parse_str(run["run_id"].as_str().expect("run_id")).unwrap();

    // A `selection.*` run node.
    assert!(
        run["kind"].as_str().unwrap().starts_with("selection."),
        "kind is a selection.* action ({})",
        run["kind"]
    );
    assert_eq!(run["project_id"], json!(project_id.to_string()));
    // An emitted code blob is referenced.
    let code_sha = run["code_sha256"].as_str().expect("a code blob was captured");
    // A `used` edge by pinned content-hash.
    let inputs = run["inputs"].as_array().expect("inputs");
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["content_hash"], json!(root_hash));

    let pool = pool_for(&server).await;

    // The code blob physically exists.
    let blobs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_code_blobs WHERE sha256 = $1",
    )
    .bind(code_sha)
    .fetch_one(&pool)
    .await
    .expect("count code blobs");
    assert_eq!(blobs, 1, "the emitted code blob is persisted");

    // A GENERATED recipe artifact landed in P1's catalog, produced by this run.
    let gen: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artifacts WHERE project_id = $1 AND run_id = $2",
    )
    .bind(project_id)
    .bind(run_id)
    .fetch_one(&pool)
    .await
    .expect("count generated artifacts");
    assert_eq!(gen, 1, "one generated recipe artifact for the run");
}

#[tokio::test]
async fn selection_on_unknown_input_is_rejected() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "closure guard project").await;

    // No artifact seeded → an input id that resolves to nothing.
    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": Uuid::new_v4(),
            "recipe": column_recipe("3"),
            "label": null,
        }))
        .send()
        .await
        .expect("record selection on unknown input");
    assert_eq!(resp.status().as_u16(), 400, "the closure guard rejects a from-nowhere input");
}

// ── TEST-25 — the server-side capture chokepoint is UNIQUE (a PARTIAL INV-8 proof) ──

/// **Scope correction (FINDING 5).** This test was labelled INV-8's `[acceptance]`
/// proof under a comment claiming it made "the exact call the declarative save step
/// makes". It does not, and cannot: the SAVE path is a FRONTEND sequence
/// (`cell-filter.yaml` `cf.run` → `run_processor` → `wait_for` → `call_action
/// provenance.record-selection` → `Stores.Provenance.recordSelection` → this POST).
/// Everything above the POST is unexercised here, so a save path that never fires —
/// or fires with the wrong `input_artifact_id` — would leave this test green.
/// `DESIGN_FIDELITY.md` additionally forbids discharging INV-8 on the filesystem
/// grep below.
///
/// What this test DOES prove, honestly:
///  * the chokepoint accepts the save path's wire shape and mints its own run node
///    (`generator_id`, the `used` edge, the generated cell-set artifact);
///  * STRUCTURALLY, `capture_selection`/`capture_action` remain the ONLY server-side
///    selection-capture entry point — nobody added a second bespoke path that would
///    bypass the closure guard, the code emitter, or the `used` edge.
///
/// **INV-8's acceptance proof is TEST-26** (`ui/tests/e2e/provenance/
/// filter-save-records-recipe.spec.ts`), which drives the real app end to end.
/// INV-8 stays AT-RISK until TEST-26 passes; this test must not be read as its
/// discharge.
#[tokio::test]
async fn the_server_side_capture_chokepoint_is_unique() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "chokepoint project").await;
    let pool = pool_for(&server).await;

    // The wire shape `Stores.Provenance.recordSelection` posts. NOTE this is the
    // POST only — see the scope correction above: it does NOT drive the FE save
    // sequence that is supposed to produce it.
    let run = record_selection(
        &server,
        &admin,
        project_id,
        root_id,
        json!({ "kind": "setop", "op": "union", "refs": ["sel-a", "sel-b"] }),
    )
    .await;
    let run_id = Uuid::parse_str(run["run_id"].as_str().expect("run_id")).unwrap();

    // It produced a run created BY `capture_selection`: its generator + the `used` edge +
    // the generated cell-set artifact are the chokepoint's own signature.
    assert_eq!(
        run["generator_id"],
        json!("provenance.selection"),
        "the run was minted by the interaction chokepoint"
    );
    assert_eq!(run["inputs"][0]["content_hash"], json!(root_hash), "the `used` edge is present");
    // S5 end-to-end: the artifact's datatype is now RESOLVED from the declared
    // `selection-set-target` capability carrier (`packages/single-cell-types`),
    // not from a `"cell-set"` literal in the server. `cell-set` is the id that
    // package DECLARES, so a stock deployment is unchanged — and this asserts the
    // declaration→resolution path actually runs, rather than that the server assumed it.
    let generated: Vec<String> =
        sqlx::query_scalar("SELECT datatype FROM artifacts WHERE run_id = $1")
            .bind(run_id)
            .fetch_all(&pool)
            .await
            .expect("the generated selection artifact(s)");
    assert_eq!(
        generated,
        vec!["cell-set".to_string()],
        "the chokepoint wrote ONE generated selection artifact, typed by the declared \
         `selection-set-target` carrier"
    );

    // STRUCTURAL (a UNIQUENESS assertion over the source tree — NOT, on its own, a
    // discharge of INV-8; see the scope correction above). `capture_selection`/
    // `capture_action` remain the ONLY server-side selection-capture entry point:
    // nobody added a second bespoke path that would bypass the closure guard, the
    // code emitter, or the `used` edge. Two independent signatures of the
    // chokepoint, each of which a second path would have to duplicate: it MINTS the
    // `provenance.selection` generator, and it is the sole caller of the code
    // emitter whose sha256 becomes the run's reproducibility claim.
    fn files_containing(needle: &str) -> Vec<String> {
        fn walk(dir: &std::path::Path, needle: &str, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).expect("read src dir") {
                let p = entry.expect("dir entry").path();
                if p.is_dir() {
                    walk(&p, needle, hits);
                } else if p.extension().is_some_and(|e| e == "rs")
                    && std::fs::read_to_string(&p).unwrap_or_default().contains(needle)
                {
                    hits.push(p.display().to_string());
                }
            }
        }
        let mut hits = Vec::new();
        walk(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), needle, &mut hits);
        hits.sort();
        hits
    }
    for needle in [
        // the minting literal (the `#[cfg(test)]` export fixtures use `.into()`)
        "generator_id: \"provenance.selection\".to_string()",
        // the emitter call whose output's sha256 IS the run's reproducibility claim
        "action_registry::emit_code(",
    ] {
        let hits = files_containing(needle);
        assert_eq!(
            hits.len(),
            1,
            "INV-8: exactly ONE server-side selection-capture site may exist \
             (signature {needle:?}); found: {hits:?}"
        );
        assert!(
            hits[0].ends_with("provenance/interaction.rs"),
            "the sole capture site is the existing chokepoint, got {}",
            hits[0]
        );
    }
}

// ── ROUND-2 FIXES (F2-11 / F2-13 / F2-14) — the capture chokepoint's failure modes ──

/// Every `provenance_run_repro` / `artifacts` / `provenance_code_blobs` count, as a
/// triple, so a test can assert "this request persisted NOTHING".
async fn persisted_counts(pool: &SqlitePool) -> (i64, i64, i64) {
    let one = |sql: &'static str| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&pool).await.expect("count") }
    };
    (
        one("SELECT count(*) FROM provenance_run_repro").await,
        one("SELECT count(*) FROM artifacts").await,
        one("SELECT count(*) FROM provenance_code_blobs").await,
    )
}

/// `POST /provenance/selections` without the 201 assertion — for the refusal paths.
async fn post_selection(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
    input_artifact_id: Uuid,
    recipe: Value,
    label: Value,
) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(token)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": input_artifact_id,
            "recipe": recipe,
            "label": label,
        }))
        .send()
        .await
        .expect("post selection");
    let status = resp.status().as_u16();
    (status, resp.json().await.expect("json body"))
}

/// **ERROR-HANDLING-2 / F2-11** — a fault in the object-store step must not leave a
/// COMMITTED `recorded` run behind.
///
/// The capture spans three stores and no transaction can span the object store, so
/// the fix is ORDERING: recipe bytes → generated artifact → run node LAST, with a
/// compensating artifact delete if the run insert fails. Before it, `insert_run` ran
/// FIRST: making the object store unwritable returned HTTP 500 to the client while
/// COMMITTING the run row + its code blob with no recipe artifact, and every retry
/// minted another — four retries produced four phantom `recorded` runs, indis-
/// tinguishable in `GET /provenance/graph` from a real capture.
///
/// RED ON REVERT: move the `insert_run` call back above the `store.put` +
/// `write_generated_artifact` block and the run-count assertions fail (1 phantom run
/// per attempt).
#[tokio::test]
async fn an_object_store_fault_records_no_phantom_run() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "atomic capture project").await;
    let pool = pool_for(&server).await;

    // A control capture first: proves the path works and warms the store dirs.
    let ok = record_selection(&server, &admin, project_id, root_id, column_recipe("1")).await;
    assert!(ok["run_id"].is_string(), "the control capture recorded");
    let (runs_before, arts_before, _blobs_before) = persisted_counts(&pool).await;

    // Make the object store unwritable (the auditor's exact repro: `chmod 555` on
    // the workstore blob + staging dirs → `workstore: mkdir failed: Permission denied`).
    let workstore = server.data_dir().join("workstore");
    let dirs = [workstore.join("blobs"), workstore.join("staging")];
    let mut restore: Vec<(std::path::PathBuf, u32)> = Vec::new();
    for d in &dirs {
        std::fs::create_dir_all(d).expect("ensure store dir");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(d).expect("stat store dir").permissions().mode();
        restore.push((d.clone(), mode));
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o555))
            .expect("make the store read-only");
    }

    // Four retries, exactly as the auditor drove it.
    let mut statuses = Vec::new();
    for i in 0..4 {
        let (status, body) = post_selection(
            &server,
            &admin,
            project_id,
            root_id,
            column_recipe(&format!("store-fails-{i}")),
            json!("store-fails"),
        )
        .await;
        statuses.push((status, body));
    }

    // Restore BEFORE asserting so a failure still leaves a droppable server.
    for (d, mode) in restore {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(mode));
    }

    for (status, body) in &statuses {
        assert!(
            !(200..300).contains(status),
            "an unwritable object store must fail the capture, got {status}: {body}"
        );
    }

    let (runs_after, arts_after, _blobs_after) = persisted_counts(&pool).await;
    assert_eq!(
        runs_after, runs_before,
        "a failed capture must record NO run — the graph may never show a capture that \
         did not happen (4 failed attempts left {} phantom run(s))",
        runs_after - runs_before
    );
    assert_eq!(
        arts_after, arts_before,
        "…and no generated cell-set artifact either"
    );
    let phantoms: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_run_repro WHERE params->>'label' = 'store-fails'",
    )
    .fetch_one(&pool)
    .await
    .expect("count phantom runs");
    assert_eq!(phantoms, 0, "no `recorded` run carries the failed capture's label");

    // The store is writable again → capture works, so the guard is a failure path,
    // not a latch.
    let again = record_selection(&server, &admin, project_id, root_id, column_recipe("2")).await;
    assert!(again["run_id"].is_string(), "capture recovers once the store is writable");
}

/// **SECURITY-2 / ERROR-HANDLING-4 (F2-14)** — the bounded-growth guard measured only
/// the EMITTED CODE, so two unbounded quantities rode straight past it:
///
///  * a 1.5 MB `label`, stored TWICE per capture (`provenance_run_repro.params` + the
///    generated artifact's `params`), neither deduped, once per authenticated request;
///  * for the LEGACY dialect the emitted code is INDEPENDENT of recipe size — a
///    1,900,063-byte recipe emits a 119-byte script — while the recipe itself is
///    persisted three times, uncapped.
///
/// RED ON REVERT: delete the label check (case A returns 201) or the serialized-recipe
/// check (case B returns 201), and the "persisted nothing" assertions fail with them.
#[tokio::test]
async fn an_over_cap_label_or_legacy_recipe_is_refused_and_persists_nothing() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "capture growth project").await;
    let pool = pool_for(&server).await;
    let before = persisted_counts(&pool).await;

    // (A) a 1.5 MB label on an otherwise tiny recipe (well under the 2 MB body limit).
    let (status, body) = post_selection(
        &server,
        &admin,
        project_id,
        root_id,
        column_recipe("3"),
        json!("L".repeat(1_500_000)),
    )
    .await;
    assert_eq!(status, 422, "an unbounded label is refused: {}", body["error_code"]);
    assert_eq!(body["error_code"], json!("PROVENANCE_LABEL_TOO_LONG"), "{body}");

    // (B) a ~1.9 MB LEGACY recipe whose emitted script is a few hundred bytes: only a
    //     cap on the SERIALIZED RECIPE can catch it.
    let mut legacy = column_recipe("3");
    legacy["_junk"] = json!("J".repeat(1_900_000));
    let recipe_bytes = serde_json::to_vec(&legacy).expect("serialize").len();
    assert!(recipe_bytes > 1_800_000, "the payload really is ~1.9 MB ({recipe_bytes} B)");
    let (status, body) =
        post_selection(&server, &admin, project_id, root_id, legacy, json!("huge legacy")).await;
    assert_eq!(status, 422, "an over-cap legacy recipe is refused: {}", body["error_code"]);
    assert_eq!(body["error_code"], json!("PROVENANCE_RECIPE_TOO_LARGE"), "{body}");
    assert!(
        body["error"].as_str().unwrap_or_default().contains("capture_code_max_bytes"),
        "the error names the admin knob so an operator can act on it: {body}"
    );

    // Neither refusal persisted anything at all.
    assert_eq!(
        persisted_counts(&pool).await,
        before,
        "a refused capture persists no run, no artifact and no code blob"
    );

    // …and a label/recipe inside the caps still records (bounds, not a ban).
    let ok = record_selection(&server, &admin, project_id, root_id, column_recipe("4")).await;
    assert!(ok["code_sha256"].is_string(), "a normal capture still records: {ok}");
}

/// **ERROR-HANDLING-3 / F2-12** — a run whose declared input could not be resolved
/// must not report itself as fully checksummed, and the loss must be VISIBLE.
///
/// The dropped edge used to be invisible downstream: `graph.rs`'s readiness was
/// `inputs.iter().all(…)`, vacuously TRUE over the empty vec the drop produced, so a
/// run with no lineage at all affirmatively answered `"inputs_checksummed": true`.
/// Now an unresolvable input is RECORDED as a hash-less `unresolved` used-edge and an
/// empty conjunction is not satisfied.
///
/// RED ON REVERT: restore the `Ok(None) => tracing::warn!(…)` drop in
/// `recorder::resolve_used_edges` (the run records with `inputs: []`) or the bare
/// `.all()` in `graph::inputs_checksummed_flag` — either way readiness comes back true.
#[tokio::test]
async fn a_run_with_an_unresolvable_input_is_not_reported_as_checksummed() {
    use txresbench::modules::jobs::models::Job;
    use txresbench::modules::jobs::seams::{PeakMetrics, RunRecorder};
    use txresbench::modules::provenance::recorder::ProvenanceRunRecorder;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "unresolved input project").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // A compute run declaring an input artifact that is NOT in the catalog — the
    // genuinely-unresolvable case (as opposed to a DB fault, which now aborts the record).
    let job_id = Uuid::new_v4();
    let job = Job {
        id: job_id,
        owner_id: owner,
        job_type: "analysis".into(),
        name: "ghost-input".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "import scanpy as sc\n",
            "analysis_id": "cell.filter",
            "inputs": [
                { "slot": "expression", "artifact_ref": Uuid::new_v4(), "sandbox_subpath": "expression.h5ad" }
            ],
            "produces": [],
            "seed": 7,
            "params": filter_run_params(),
        }),
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        exit_code: Some(0),
        error: None,
        pid: None,
        priority_class: "normal".into(),
        resource_class: "cpu-sandbox".into(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    };
    sqlx::query("INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1,$2,$3,$4,$5)")
        .bind(job.id)
        .bind(job.owner_id)
        .bind(&job.job_type)
        .bind(&job.name)
        .bind(&job.status)
        .execute(&pool)
        .await
        .expect("seed jobs row");
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job.id)
        .bind(project_id)
        .execute(&pool)
        .await
        .expect("seed job_scope row");

    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;

    // The run node SURFACES the unresolved input rather than hiding it.
    let node = get_run_node(&server, &admin, job_id).await;
    let inputs = node["inputs"].as_array().expect("inputs array");
    assert_eq!(inputs.len(), 1, "the declared input is still represented: {node}");
    assert_eq!(inputs[0]["kind"], json!("unresolved"), "…as an UNRESOLVED edge: {node}");
    assert_eq!(inputs[0]["content_hash"], json!(""), "…pinning nothing: {node}");
    assert_eq!(inputs[0]["slot"], json!("expression"));

    // …and the readiness projection refuses to call it checksummed.
    let resp = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get graph");
    assert_eq!(resp.status().as_u16(), 200, "graph read is 200");
    let graph: Value = resp.json().await.expect("graph json");
    assert_eq!(
        graph["readiness"]["inputs_checksummed"],
        json!(false),
        "a run whose lineage could not be resolved must NOT report checksummed inputs: {}",
        graph["readiness"]
    );
    assert_eq!(graph["readiness"]["ready"], json!(false), "{}", graph["readiness"]);
}

/// ROUND-4 / R3-01 — the capture's two DB writes must be ONE transaction.
///
/// `capture_action` writes the recipe bytes to the object store, INSERTs the
/// generated cell-set artifact into P1's catalog, and only then INSERTs the run
/// node. Both DB writes went through the POOL, so they committed independently.
/// The `insert_run` error arm compensates by deleting the artifact — but a DROPPED
/// FUTURE (the client disconnects, axum drops the handler future, a `select!` arm
/// loses) never reaches that arm: the artifact stays COMMITTED in the catalog with
/// `run_id` naming a run that was never inserted and never will be. `artifacts
/// .run_id` has no FK, so nothing else removes it; the graph walk then sees a
/// cell-set produced by a nonexistent run.
///
/// The proof drives the REAL production function against the REAL per-test DB and
/// cancels it by dropping the future mid-flight, then asks a SEPARATE connection —
/// which can only see COMMITTED rows — what survived.
///
/// RED BEFORE THE FIX: the probe sees the committed `selection` artifact while the
/// capture future is still pending, and it is still there after the drop.
#[tokio::test]
async fn a_dropped_capture_commits_no_orphan_artifact() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    use txresbench::modules::provenance::interaction;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "atomic capture").await;
    // Two independent pools: one drives the capture, one observes ONLY what is
    // committed (an uncommitted row inside a transaction is invisible to it).
    let pool = pool_for(&server).await;
    let probe = pool_for(&server).await;
    let user_id = admin_user_id(&probe).await;

    // The capture puts recipe bytes through the PROCESS-WIDE object store, and this
    // test process is not the server process, so the test binary needs one installed.
    // It is the HARNESS's single root, not a private one: `OBJECT_STORE`/`STORE_CLAIM`
    // are `OnceCell`s, so a private root here would silently lose the race to whichever
    // test ran first — and, when torn down at the end of this test, would leave the
    // global naming a deleted directory for every later test that sweeps.
    crate::common::object_store::shared_object_store_root();

    async fn counts(p: &SqlitePool, project_id: Uuid) -> (i64, i64) {
        let arts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM artifacts WHERE project_id = $1 AND output_id = 'selection'",
        )
        .bind(project_id)
        .fetch_one(p)
        .await
        .expect("count selection artifacts");
        let runs: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM provenance_run_repro WHERE project_id = $1",
        )
        .bind(project_id)
        .fetch_one(p)
        .await
        .expect("count runs");
        (arts, runs)
    }

    let mut fut = Box::pin(interaction::capture_action(
        &pool,
        project_id,
        user_id,
        "selection.column",
        root_id,
        column_recipe("3"),
        Some("dropped mid-flight".to_string()),
    ));

    // Poll the REAL capture future by hand, checking after each pending poll
    // whether the artifact has already been COMMITTED on its own.
    let waker = Waker::noop();
    let mut cx = Context::from_waker(waker);
    let mut completed = false;
    let mut cancelled_at_first_visible_artifact = false;
    for _ in 0..600 {
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(_) => {
                completed = true;
                break;
            }
            Poll::Pending => {}
        }
        // The instant the generated artifact becomes visible to an INDEPENDENT
        // connection, it is committed. Cancel the capture exactly there — that is
        // the window a client disconnect lands in.
        if counts(&probe, project_id).await.0 > 0 {
            cancelled_at_first_visible_artifact = true;
            break;
        }
        // Yield so the tokio reactor can advance the sqlx socket I/O.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    drop(fut);

    assert!(
        cancelled_at_first_visible_artifact || completed,
        "the capture neither completed nor committed an artifact within the poll budget — \
         the probe never observed the write, so this test proved nothing"
    );

    // THE INVARIANT: a committed cell-set artifact and its producing run node stand
    // or fall together. Before the fix the artifact committed on its own, so a
    // capture cancelled here left (1 artifact, 0 runs) — a catalog row whose
    // `run_id` names a run that never existed and that no FK reclaims.
    let (arts, runs) = counts(&probe, project_id).await;
    assert_eq!(
        arts, runs,
        "a cancelled capture left {arts} generated artifact(s) and {runs} run(s): the two \
         writes are one transaction or they are not atomic"
    );
    assert!(arts <= 1, "at most one capture was attempted, got {arts}");
}

// ───── TEST-44: the input's TENANCY rule, over the real REST surface (INV-8) ─────
//
// (Rehomed from the deleted `save_recipe_test.rs` when ITEM-4 scrapped the predicate
// DSL. These two cases are about `inputs::resolve_input`'s authorization, not about
// any recipe dialect — the recipe is incidental and is now a FLAT one.)
//
// The unit test in `provenance/inputs.rs` pins the pure predicate; this pins the
// HTTP behaviour it decides, because the rule is authorization-shaped and the bug it
// fixes was only ever visible end to end: a workbench run's input is normally an
// artifact of an ATTACHED DATASET (`project_id = NULL`), and requiring
// `project_id == Some(project)` made `POST /provenance/selections` 400 for the
// commonest real save. Three cases:
//   (a) an attached dataset's artifact  → 201 (the fix),
//   (b) an UNattached dataset's artifact → 400 PROVENANCE_UNKNOWN_INPUT (not widened),
//   (c) a project READER               → 403 (the edit gate still precedes all of it).
#[tokio::test]
async fn an_attached_datasets_artifact_is_a_valid_selection_input() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "Attached dataset tenancy").await;
    let pool = pool_for(&server).await;

    // A DATASET-scoped artifact (project_id NULL) — what an upload produces.
    let dataset_id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, kind, name, personal_user_id) VALUES ($1, 'personal', 'seed', (SELECT id FROM users LIMIT 1)) ON CONFLICT (personal_user_id) WHERE kind='personal' DO UPDATE SET name = accounts.name")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("seed personal account");
    sqlx::query("INSERT INTO datasets (id, name, owner_id, account_id) VALUES ($1, $2, (SELECT id FROM users LIMIT 1), (SELECT id FROM accounts WHERE kind='personal' LIMIT 1))")
        .bind(dataset_id)
        .bind("tenancy-fixture")
        .execute(&pool)
        .await
        .expect("seed dataset");
    let art_id = seed_dataset_scoped_artifact(&pool, dataset_id, &format!("sha256:{}", "b".repeat(64))).await;

    // (b) NOT attached yet → the input is out of the project's tenancy.
    let (status, body) = post_selection(
        &server,
        &admin,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert_eq!(status, 400, "an unattached dataset's artifact is NOT in scope: {body}");
    assert_eq!(body["error_code"], "PROVENANCE_UNKNOWN_INPUT", "{body}");

    // (a) attach it → the SAME input is now a valid, pinnable closure terminus.
    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project_id)
        .bind(dataset_id)
        .execute(&pool)
        .await
        .expect("attach dataset");
    let (status, body) = post_selection(
        &server,
        &admin,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert_eq!(status, 201, "an ATTACHED dataset's artifact is a valid input: {body}");

    // …and the recorded run pins THAT artifact as its used-edge (the closure terminus
    // the whole invariant is about), not nothing.
    let used: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_run_repro WHERE project_id = $1 AND inputs_json LIKE $2",
    )
    .bind(project_id)
    .bind(format!("%{art_id}%"))
    .fetch_one(&pool)
    .await
    .expect("count runs pinning the input");
    assert_eq!(used, 1, "the recorded run pins the attached dataset's artifact");

    // (c) a NON-MEMBER is still refused — the edit gate precedes the scope rule.
    create_user(&server, &admin, "tenancy_reader", "tenancy_reader@txresbench.test").await;
    let reader = login(&server, "tenancy_reader").await;
    let (status, _) = post_selection(
        &server,
        &reader,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert!(
        status == 403 || status == 404,
        "a non-editor cannot record provenance regardless of input scope; got {status}"
    );
}

/// ROUND-4 / R3-14 — the tenancy rule above admits an attached dataset's artifact
/// on the ATTACHMENT alone. It never asks whether the ACTING USER may read that
/// dataset.
///
/// A dataset is a separately-permissioned resource: `graph::load_project_walk_context`
/// and `read_forward_graph` both re-check `is_visible_to` per dataset precisely so a
/// project collaborator cannot learn a private dataset's lineage. The CAPTURE
/// chokepoint did not. So a project Editor — who never had, and cannot get, read
/// access to the owner's dataset — could pin one of its artifacts and read the id +
/// pinned `content_hash` straight back out of his own run node. That is
/// `CODING_GUIDELINES` §1's critical class: a path-ID handler acting on a resource
/// whose ownership it never verified.
///
/// The refusal is `400 PROVENANCE_UNKNOWN_INPUT` — the endpoint's existing
/// unresolvable-input answer, which is also the non-oracle one (it does not confirm
/// that the artifact exists).
///
/// RED BEFORE THE FIX: the editor's POST returns 201 and his run node carries the
/// private dataset artifact's content hash.
#[tokio::test]
async fn an_editor_cannot_pin_an_artifact_from_a_dataset_he_cannot_read() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "cross-dataset tenancy").await;
    let pool = pool_for(&server).await;

    // The ADMIN's private dataset + one of its artifacts, attached to the project.
    let dataset_id = Uuid::new_v4();
    let secret_hash = format!("sha256:{}", "c".repeat(64));
    sqlx::query("INSERT INTO accounts (id, kind, name, personal_user_id) VALUES ($1, 'personal', 'seed', (SELECT id FROM users WHERE username = 'admin')) ON CONFLICT (personal_user_id) WHERE kind='personal' DO UPDATE SET name = accounts.name")
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .expect("seed personal account");
    sqlx::query("INSERT INTO datasets (id, name, owner_id, account_id) VALUES ($1, $2, (SELECT id FROM users WHERE username = 'admin'), (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = (SELECT id FROM users WHERE username = 'admin')))")
        .bind(dataset_id)
        .bind("private-owner-dataset")
        .execute(&pool)
        .await
        .expect("seed dataset");
    let art_id = seed_dataset_scoped_artifact(&pool, dataset_id, &secret_hash).await;
    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project_id)
        .bind(dataset_id)
        .execute(&pool)
        .await
        .expect("attach dataset");

    // An EDITOR on the project — with no share on the dataset at all.
    let editor = shared_collaborator(&server, &admin, project_id, "ds_editor", "editor").await;

    let (status, body) = post_selection(
        &server,
        &editor,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert_eq!(
        status, 400,
        "an editor who cannot READ the dataset must not be able to pin its artifact: {body}"
    );
    assert_eq!(body["error_code"], "PROVENANCE_UNKNOWN_INPUT", "{body}");

    // Nothing about the private artifact leaked into anything he can read.
    let leaked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_run_repro WHERE project_id = $1 AND inputs_json LIKE $2",
    )
    .bind(project_id)
    .bind(format!("%{art_id}%"))
    .fetch_one(&pool)
    .await
    .expect("count runs pinning the private artifact");
    assert_eq!(leaked, 0, "no run pins the private dataset's artifact");

    let graph = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&editor)
        .send()
        .await
        .expect("graph");
    let graph: Value = graph.json().await.expect("graph json");
    assert!(
        !graph.to_string().contains(&secret_hash),
        "the private dataset artifact's content hash must not reach the editor: {graph}"
    );

    // CONTROL: the dataset's OWNER is unaffected — the rule is a visibility check,
    // not a blanket ban on dataset-scoped inputs.
    let (status, body) = post_selection(
        &server,
        &admin,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert_eq!(status, 201, "the dataset owner can still pin his own artifact: {body}");

    // CONTROL: once the dataset is SHARED with him, the editor can too.
    sqlx::query(
        "INSERT INTO dataset_shares (id, dataset_id, principal_type, principal_id, role) \
         VALUES (randomblob(16), $1, 'user', \
                 (SELECT id FROM users WHERE username = 'ds_editor'), 'view')",
    )
    .bind(dataset_id)
    .execute(&pool)
    .await
    .expect("share dataset with the editor");
    let (status, body) = post_selection(
        &server,
        &editor,
        project_id,
        art_id,
        json!({ "kind": "freehand", "ids": ["cell_1"] }),
        json!(null),
    )
    .await;
    assert_eq!(status, 201, "a dataset SHAREE may pin its artifact: {body}");
}
