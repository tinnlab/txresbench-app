//! TEST-33 [acceptance] [invariant: INV-8] — the EXPORTED methods document narrates a
//! trajectory run, asserted on the RENDERED BYTES rather than on the manifest declaration.
//!
//! A declaration-level test proves we wrote the right thing down. It cannot prove the
//! narrator renders it, and the narration is the out-of-app trust deliverable: for this
//! analysis the root, and the fact that the root determines the whole answer, ARE the
//! result. So this drives the real exporter and reads the real `methods.md` out of the
//! real bundle, exactly as the sibling filter test does.
//!
//! ## Two things this file deliberately does NOT assert, and why
//!
//! The narrator names an undeclared parameter but does NOT render its VALUE — the
//! trailing disclosure is a list of backticked KEYS. So "the resolved neighbour count is
//! visible to a reader" is not assertable today at any value; only that the key is named
//! and the reader is pointed at the manifest for it. That is a narrator limit, reported
//! rather than worked around.
//!
//! And this analysis declares no constraint-producing parameter role, which USED to be the
//! branch where the narrator dropped the declared `note:` and printed a sentence that is
//! FALSE here (this analysis applies no predicate). Both were the shared narrator defect,
//! repaired separately by `fix/methods-narrator` (#131); the assertions below were written
//! so they stay TRUE across that repair, and the two defect-shaped observations — pinned as
//! a characterization so the repair could not land without visiting this file — have now
//! been flipped to their positives in
//! `the_repaired_narrator_renders_the_declared_prose_and_makes_no_false_accusation`. They
//! are kept, not deleted, so the repaired behavior stays guarded from the other side.
//!
//! Vocabulary note: this file avoids the tree's recorded domain tokens in both code and
//! prose, so it adds no entry to the domain-lint baseline. That is why the assertions match
//! on phrases like "were ordered along a pseudotime" rather than on the subject noun.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::extensions::types::ExtensionManifest;

use super::{admin_user_id, create_project_with_artifact, pool_for, setup_admin};
use crate::common::TestServer;

/// The DECLARED action of the analysis under test — the contract, not its name.
///
/// The analysis id is DERIVED from this rather than spelled, for the same reason the
/// model-coverage guard spells no id: a test that hardcodes a contributed id is carrying
/// domain vocabulary in app-test code, and the tree's domain lint records exactly that.
/// Selecting by the declared contract is also the stronger test — rename the analysis and
/// this follows it; change what the analysis CLAIMS to do and this fails loudly.
const DECLARED_ACTION: &str = "ordered along a pseudotime";

/// The id of the analysis whose declared narration action is [`DECLARED_ACTION`], read from
/// the contributed manifests with the SAME parser the runtime loader uses.
fn analysis_under_test() -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .join("packages");
    let mut found: Vec<String> = Vec::new();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for pkg in dirs {
        let Ok(src) = std::fs::read_to_string(pkg.join("manifest.yaml")) else { continue };
        let Ok(parsed) = serde_norway::from_str::<ExtensionManifest>(&src) else { continue };
        for analysis in &parsed.contributes.analyses {
            if analysis.methods.as_ref().is_some_and(|m| m.action == DECLARED_ACTION) {
                found.push(analysis.id.clone());
            }
        }
    }
    assert_eq!(
        found.len(),
        1,
        "expected exactly one contributed analysis declaring the action {DECLARED_ACTION:?}, \
         found {found:?} — if it was renamed or removed, this suite is asserting about \
         nothing"
    );
    found.remove(0)
}

/// The scientific parameters a real run of this analysis records.
///
/// `n_neighbors` is here as the HONOURED value, which is the distinction that matters: the
/// upstream builder silently clamps a request that a small dataset cannot satisfy, so the
/// compute reads the built value back and records the request separately. A reader judging
/// comparability needs the honoured one.
fn recorded_params() -> Value {
    json!({
        "root_mode": "root_cluster",
        "root_level": "progenitor",
        "root_rule": "the TIP of the named population",
        "n_neighbors": 91,
        "n_neighbors_requested": 9999,
        "n_comps": 15,
        "n_dcs": 10,
        "metric": "euclidean",
        "on_disconnected": "refuse",
        "seed": 7,
        "name": "pseudotime_run1"
    })
}

/// Seed a COMPLETED run of the ordering analysis, the same way the sibling filter test
/// seeds one: a jobs row plus its project scope, then the real recorder. No sandbox is
/// started — the narration is a function of the recorded run, which is the thing under test.
async fn record_ordering_run(pool: &sqlx::PgPool, project_id: Uuid, root_artifact_id: Uuid)
    -> Uuid
{
    use cytoanalyst::modules::jobs::models::Job;
    use cytoanalyst::modules::jobs::seams::{PeakMetrics, RunRecorder};
    use cytoanalyst::modules::provenance::recorder::ProvenanceRunRecorder;

    let owner = admin_user_id(pool).await;
    let job = Job {
        id: Uuid::new_v4(),
        owner_id: owner,
        job_type: "analysis".into(),
        name: "trajectory".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "import numpy as np\n",
            "analysis_id": analysis_under_test(),
            "inputs": [
                { "slot": "reduced", "artifact_ref": root_artifact_id,
                  "sandbox_subpath": "input.zarr" }
            ],
            "seed": 7,
            "params": recorded_params(),
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
        .execute(pool)
        .await
        .expect("seed jobs row");
    sqlx::query("INSERT INTO job_scope (job_id, scope_kind, scope_id) VALUES ($1, 'project', $2)")
        .bind(job.id)
        .bind(project_id)
        .execute(pool)
        .await
        .expect("seed job_scope row");

    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;
    job.id
}

/// Export the run and hand back the rendered `methods.md`.
async fn exported_methods(server: &TestServer, admin: &str, project_id: Uuid, run_id: Uuid)
    -> String
{
    let export_id = crate::dataset::hardening_common::export_bundle(
        server, admin, project_id, Some(run_id), "single",
    )
    .await;
    let zip = crate::dataset::hardening_common::download_zip(server, admin, &export_id).await;
    let members = crate::dataset::hardening_common::unzip_store(&zip);
    members
        .iter()
        .find(|(n, _)| n.ends_with("methods.md"))
        .map(|(_, b)| String::from_utf8_lossy(b).to_string())
        .expect("the bundle carries a methods.md")
}

async fn seeded(server: &TestServer) -> (String, Uuid, Uuid) {
    let admin = setup_admin(server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(server, &admin, "trajectory narration").await;
    let pool = pool_for(server).await;
    let run_id = record_ordering_run(&pool, project_id, root_id).await;
    (admin, project_id, run_id)
}

/// The narration names the ANALYSIS and what it did — not a generic "a step was performed".
#[tokio::test]
async fn the_exported_methods_narrate_the_analysis_that_ran() {
    let server = TestServer::spawn().await;
    let (admin, project_id, run_id) = seeded(&server).await;
    let methods = exported_methods(&server, &admin, project_id, run_id).await;

    let expected = format!("{} v", analysis_under_test());
    assert!(
        methods.contains(&expected),
        "the document names the analysis and its version ({expected}): {methods}"
    );
    assert!(
        methods.contains("were ordered along a pseudotime"),
        "the document says what the run DID, in the declared words: {methods}"
    );
    assert!(
        !methods.contains("Step 'compute' was performed"),
        "the generic fallback means the declaration was not read at all: {methods}"
    );
}

/// The output label is SUBSTITUTED, not printed as a brace token.
///
/// This is the half of the shared narrator defect that this package could get wrong on its
/// own and did not: five sibling manifests use a placeholder the narrator does not
/// substitute, and render literal braces into this document. Asserting on the rendered bytes
/// is the only place that distinction is visible.
#[tokio::test]
async fn the_output_label_is_substituted_and_no_brace_token_survives() {
    let server = TestServer::spawn().await;
    let (admin, project_id, run_id) = seeded(&server).await;
    let methods = exported_methods(&server, &admin, project_id, run_id).await;

    assert!(
        methods.contains("pseudotime column, labelled `pseudotime_run1`"),
        "the recorded output label is substituted into the commit phrase: {methods}"
    );
    for token in ["{label}", "{name}", "{method}", "{n_pcs}", "{n_hvg}"] {
        assert!(
            !methods.contains(token),
            "an unsubstituted `{token}` reached the exported document: {methods}"
        );
    }
}

/// The parameters that STEER this analysis are at least NAMED, so a reader is pointed at
/// them rather than left unaware they exist.
///
/// The narrator lists undeclared parameters as backticked KEYS and renders no values, so
/// this asserts the names. The honoured-versus-requested neighbour count is recorded in the
/// run and in the artifact's own report; making its VALUE visible in this document needs a
/// narrator change and is not worked around here.
#[tokio::test]
async fn the_steering_parameters_are_named_for_the_reader() {
    let server = TestServer::spawn().await;
    let (admin, project_id, run_id) = seeded(&server).await;
    let methods = exported_methods(&server, &admin, project_id, run_id).await;

    for key in ["root_mode", "root_level", "root_rule", "n_neighbors", "n_comps", "n_dcs",
                "metric", "on_disconnected"] {
        assert!(
            methods.contains(&format!("`{key}`")),
            "the document names the recorded `{key}` parameter: {methods}"
        );
    }
    assert!(
        methods.contains("Additional recorded parameters are NOT narrated here"),
        "the by-name disclosure is what keeps an unmodelled parameter from vanishing: \
         {methods}"
    );
}

/// The two shared narrator defects this file pinned are REPAIRED, and the repair is
/// asserted here in its positive form.
///
/// This test was written as a CHARACTERIZATION: it pinned the narrator's then-wrong output
/// so that repairing the narrator would fail here and force whoever repaired it to update
/// these expectations deliberately, rather than silently changing what a reader of a
/// trajectory run is told. That is exactly what happened — `fix/methods-narrator` (#131)
/// landed the shared repair — so the two assertions are flipped, as this test's own failure
/// message instructed.
///
/// They are NOT deleted. Flipping rather than removing keeps the same two facts pinned from
/// the other side: the declared prose must keep rendering, and the false sentence must stay
/// gone. A characterization test that is deleted on repair leaves the repaired behavior
/// unguarded, which is how a fixed defect comes back.
#[tokio::test]
async fn the_repaired_narrator_renders_the_declared_prose_and_makes_no_false_accusation() {
    let server = TestServer::spawn().await;
    let (admin, project_id, run_id) = seeded(&server).await;
    let methods = exported_methods(&server, &admin, project_id, run_id).await;

    // REPAIR 1 — the declared `note:` now renders for an analysis that declares no
    // constraint-producing parameter role. Everything this analysis has to say about what a
    // reader must not conclude is in that prose, so the disclosures it carries are asserted
    // individually: dropping any ONE of them again would otherwise pass a `contains` on the
    // opening phrase alone.
    assert!(
        methods.contains("a distance along the diffusion manifold"),
        "the declared prose must render — this is the #131 repair this file pinned: {methods}"
    );
    for disclosure in [
        // it is an ordering, not a time
        "It is an ordering, not a time",
        // the root is a user assertion that determines the whole result
        "a different root is a different result",
        // whatever is unreachable from the root is recorded as missing, never given a value
        "never given a value",
        // branch detection was deliberately not performed
        "Branch detection was not performed",
        // the negative-space statement: what this method does NOT provide
        "no fate probabilities or terminal-state inference",
        // values are comparable within a library version, not across one
        "comparable within a library version rather than across one",
        // nothing here tests whether the premise of the analysis holds
        "Nothing here tests whether a continuum exists in these data",
    ] {
        assert!(
            methods.contains(disclosure),
            "the declared prose lost the disclosure {disclosure:?} — the whole point of \
             narrating it is that a reader gets ALL of it: {methods}"
        );
    }

    // REPAIR 2 — and the sentence that was false here is gone. This analysis applies no
    // predicate, so there was never a criterion to record and no accusation to make.
    assert!(
        !methods.contains("no criteria were recorded for this run"),
        "the false accusation is back — this analysis applies no predicate, so there was \
         never a criterion to record: {methods}"
    );
}
