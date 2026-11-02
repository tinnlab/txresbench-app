//! TEST-16 — after recording a run node over real catalog rows, the graph facade
//! returns the backward walk from that run to a hashed root (run_id NULL).

use super::*;

#[tokio::test]
async fn graph_walk_terminates_at_hashed_root() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, root_hash) =
        create_project_with_artifact(&server, &admin, "graph project").await;

    // Record a run (a selection over the seeded root artifact).
    let run = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run_id = run["run_id"].as_str().expect("run_id").to_string();

    // The run's authoritative USED edge pins the root's content hash.
    let inputs = run["inputs"].as_array().expect("inputs array");
    assert_eq!(inputs.len(), 1, "one used edge");
    assert_eq!(inputs[0]["content_hash"], json!(root_hash), "input pins the root hash");

    // GET /provenance/graph?project_id=..&target=<run> → the closure walk.
    let resp = server
        .client
        .get(server.api_url(&format!(
            "/provenance/graph?project_id={project_id}&target={run_id}"
        )))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get graph");
    assert_eq!(resp.status().as_u16(), 200, "graph read is 200");
    let graph: Value = resp.json().await.expect("graph json");

    // The walk includes the target run.
    let runs = graph["runs"].as_array().expect("runs array");
    assert!(
        runs.iter().any(|r| r["run_id"] == json!(run_id)),
        "the target run is in the walk"
    );

    // …and terminates at the run-less hashed root.
    let roots = graph["roots"].as_array().expect("roots array");
    assert!(!roots.is_empty(), "the walk terminates at ≥1 root");
    let terminal = roots
        .iter()
        .find(|a| a["content_hash"] == json!(root_hash))
        .expect("the hashed root is a terminus");
    assert!(terminal["run_id"].is_null(), "the root has no producing run");
}

// TEST-9 [ITEM-6] — the SAME two fields appear on run nodes from EVERY endpoint
// that projects through the single `run_to_dto` constructor: `GET /provenance/graph`,
// `GET /provenance/forward`, `POST /provenance/selections`, `POST /provenance/actions`
// (the two run endpoints are TEST-8's half). Six endpoints, one projection.
#[tokio::test]
async fn every_run_to_dto_endpoint_carries_the_params_and_rerun_spec_fields() {
    use crate::dataset::hardening_common::{
        get_forward_resp, insert_run, run_template, upload_dataset, used_edge,
    };

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "run_to_dto coverage project").await;
    let pool = pool_for(&server).await;

    // A real `cell.filter` compute run → GET /provenance/graph.
    let run_id = record_filter_run(&pool, project_id, root_id).await;
    let graph: Value = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("graph")
        .json()
        .await
        .expect("graph json");
    let node = graph["runs"].as_array().expect("graph runs").iter()
        .find(|r| r["run_id"] == json!(run_id.to_string()))
        .expect("the filter run is a graph node");
    assert_predicate_visible(node, "GET /provenance/graph");

    // POST /provenance/selections → the created node (an INTERACTION run: it records
    // no re-run spec by design, so `rerun_spec` is null while `params` is present —
    // the field must still exist on the wire, and must not be an error).
    let sel = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    assert!(sel["params"].is_object(), "POST /selections: the node carries its params");
    assert!(sel["rerun_spec"].is_null(), "an interaction run records no re-run envelope");

    // POST /provenance/actions → the same projection.
    let action: Value = server
        .client
        .post(server.api_url("/provenance/actions"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "action_type": "selection.column",
            "input_artifact_id": root_id,
            "recipe": column_recipe("4"),
            "label": null,
        }))
        .send()
        .await
        .expect("record action")
        .json()
        .await
        .expect("action json");
    assert!(action["params"].is_object(), "POST /actions: the node carries its params");
    assert!(action.get("rerun_spec").is_some(), "POST /actions: the envelope field is on the wire");

    // GET /provenance/forward — a DATASET-scoped run (the forward walk's node kind).
    let (dataset, _file, h_d) =
        upload_dataset(&server, &admin, "forward predicate ds", "matrix.csv", b"cell,gene\nc1,3\n").await;
    let fwd_run = Uuid::new_v4();
    let mut r = run_template(fwd_run, None, Some(dataset));
    r.generator_id = "cell.filter".into();
    r.params = json!({ "criteria": [{ "column": "pct_counts_mito", "control": "range", "max": 10 }], "label": "lowqc", "seed": 0 });
    r.rerun_spec_json = Some(json!({ "language": "python", "params": filter_run_params() }));
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset), &h_d)]);
    insert_run(&pool, &r).await;

    let fwd: Value = get_forward_resp(&server, &admin, dataset)
        .await
        .json()
        .await
        .expect("forward json");
    let fwd_node = fwd["runs"].as_array().expect("forward runs").iter()
        .find(|n| n["run_id"] == json!(fwd_run.to_string()))
        .expect("the dataset-scoped run is forward-reachable");
    assert_predicate_visible(fwd_node, "GET /provenance/forward");
}

// ── FINDING 3 — `rerun_spec` must not leak host paths to a project VIEWER ───────

/// `RunNodeDto.rerun_spec` (DEC-1 = BOTH) surfaces the run's re-run envelope so a
/// reviewer can inspect the replay spec. It shipped the FULL `AnalysisSpec`,
/// including `InputDecl.host_path` + `extra_mounts[].host_path` — server
/// filesystem layout — and every trust surface that carries it
/// (`GET /provenance/runs/{id}`, `/runs`, `/graph`) is gated only by
/// `require_project_read`, i.e. **Viewer+**.
///
/// The DTO is now redacted at the projection (`graph::redact_rerun_spec`), so
/// nobody receives host paths over any wire; the re-run path reads
/// `rerun_spec_json` from the repository IN-PROCESS and is unaffected (proved by
/// the verify tests, which still reproduce).
///
/// RED ON REVERT: restore `rerun_spec: row.rerun_spec_json.clone()` in
/// `graph::run_to_dto` and the host-path assertions fail on BOTH callers.
#[tokio::test]
async fn rerun_spec_never_ships_host_paths_to_a_project_viewer() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "rerun spec redaction project").await;
    let pool = pool_for(&server).await;

    // A run whose spec carries BOTH host-path carriers, written straight into the
    // sidecar so the test pins the DTO projection (not the recorder's input shape).
    let run_id = record_filter_run(&pool, project_id, root_id).await;
    let host_input = "/var/lib/cytoanalyst/workspaces/deadbeef/inputs/expression.h5ad";
    let host_mount = "/srv/refs/GRCh38";
    sqlx::query(
        "UPDATE provenance_run_repro SET rerun_spec_json = json_set(
             json_set(rerun_spec_json, '$.inputs[0].host_path', json_quote($2)),
             '$.extra_mounts',
             json_array(json_object('host_path', $3, 'sandbox_path', '/refs'))
         ) WHERE run_id = $1",
    )
    .bind(run_id)
    .bind(host_input)
    .bind(host_mount)
    .execute(&pool)
    .await
    .expect("stamp host paths onto the stored spec");

    // Sanity: the STORED row really does carry them (so a green test cannot be a
    // false negative from an empty fixture).
    let stored: Value =
        sqlx::query_scalar("SELECT rerun_spec_json FROM provenance_run_repro WHERE run_id = $1")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .expect("stored spec");
    assert!(stored.to_string().contains(host_input), "fixture precondition: {stored}");
    assert!(stored.to_string().contains(host_mount), "fixture precondition: {stored}");

    let viewer = shared_collaborator(&server, &admin, project_id, "prov-rerun-viewer", "viewer").await;
    for (who, token) in [("viewer", &viewer), ("owner", &admin)] {
        let node = get_run_node(&server, token, run_id).await;
        let spec = node["rerun_spec"].to_string();
        assert!(!spec.contains(host_input), "{who}: input host path leaked: {spec}");
        assert!(!spec.contains(host_mount), "{who}: mount host path leaked: {spec}");
        assert!(!spec.contains("host_path"), "{who}: the carrier key leaked: {spec}");
        assert!(
            node["rerun_spec"]["extra_mounts"].is_null(),
            "{who}: extra_mounts is dropped wholesale: {spec}"
        );
        // …and the SCIENCE the field exists for still arrives (the FE reads
        // `rerun_spec.params`), so this is a redaction, not a removal.
        assert_eq!(
            node["rerun_spec"]["params"]["criteria"][0]["column"],
            json!("pct_counts_mito"),
            "{who}: the re-run envelope still carries the scientific params: {spec}"
        );
        assert_eq!(node["rerun_spec"]["language"], json!("python"), "{who}: {spec}");
    }

    // The paginated + graph surfaces project through the SAME `run_to_dto`, so a
    // second carrier cannot regress independently — assert them too.
    let listed: Value = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}&per_page=50")))
        .bearer_auth(&viewer)
        .send()
        .await
        .expect("list runs")
        .json()
        .await
        .expect("runs json");
    assert!(
        !listed.to_string().contains("/var/lib/cytoanalyst"),
        "the paginated trust view leaks a host path: {listed}"
    );
}

/// ROUND-4 / R3F-03, at the surface the BADGE actually reads.
///
/// A project with a root artifact and ZERO recorded runs used to answer
/// `readiness.ready = true` with all six flags true, because every flag is an
/// `.all()` over an empty run set. `LineagePane`'s badge renders that as
/// "✓ Reproducible" for a project in which nothing has been captured at all.
///
/// RED BEFORE THE FIX: `ready` is `true` and every flag is `true`.
#[tokio::test]
async fn a_project_with_roots_but_no_runs_is_not_reported_reproducible() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // A root artifact, no runs.
    let (project_id, _root_id, _hash) =
        create_project_with_artifact(&server, &admin, "roots but no runs").await;

    let resp = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get graph");
    assert_eq!(resp.status().as_u16(), 200);
    let graph: Value = resp.json().await.expect("graph json");
    assert!(graph["runs"].as_array().expect("runs").is_empty(), "no runs: {graph}");
    assert!(!graph["roots"].as_array().expect("roots").is_empty(), "one root: {graph}");

    let r = &graph["readiness"];
    assert_eq!(r["ready"], json!(false), "nothing is captured, so nothing is reproducible: {r}");
    // The badge counts FALSE flags — leaving the five run-derived ones vacuously
    // true is what renders the literal nonsense "⚠ 0 issues".
    for flag in ["seeds_set", "env_pinned", "inputs_checksummed", "code_captured", "params_captured"]
    {
        assert_eq!(r[flag], json!(false), "{flag} has no evidence in an empty closure: {r}");
    }
    // …while the roots fact, which is NOT run-derived, stays honest.
    assert_eq!(r["roots_have_provenance"], json!(true), "the hashed root is real: {r}");
}
