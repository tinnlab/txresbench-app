//! TEST-27 — the runs endpoint paginates (`page`/`per_page`, default 10, clamp
//! 500) and each REST route returns its documented 2xx for the happy path.

use super::*;

#[tokio::test]
async fn runs_endpoint_paginates_and_clamps() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "pagination project").await;

    // Record 3 runs (distinct predicates so each is its own row).
    for v in ["1", "2", "3"] {
        record_selection(&server, &admin, project_id, root_id, column_recipe(v)).await;
    }

    // Default per_page is 10; total is 3.
    let def: Value = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs default")
        .json()
        .await
        .expect("runs json");
    assert_eq!(def["per_page"], json!(10), "default per_page is 10");
    assert_eq!(def["total"], json!(3), "total counts all runs");
    assert_eq!(def["runs"].as_array().unwrap().len(), 3);

    // page/per_page honored.
    let p1: Value = server
        .client
        .get(server.api_url(&format!(
            "/provenance/runs?project_id={project_id}&page=1&per_page=2"
        )))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs page1")
        .json()
        .await
        .expect("runs json");
    assert_eq!(p1["runs"].as_array().unwrap().len(), 2, "per_page=2 returns 2");
    assert_eq!(p1["total"], json!(3));

    // per_page over the cap is clamped to 500.
    let clamped: Value = server
        .client
        .get(server.api_url(&format!(
            "/provenance/runs?project_id={project_id}&per_page=1000"
        )))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs clamp")
        .json()
        .await
        .expect("runs json");
    assert_eq!(clamped["per_page"], json!(500), "per_page clamps to 500");
}

#[tokio::test]
async fn each_route_returns_its_documented_2xx() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "rest happy project").await;

    // POST /provenance/selections → 201 (+ gives us a run id).
    let run = record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let run_id = run["run_id"].as_str().expect("run_id").to_string();

    // POST /provenance/actions (selection.* only) → 201.
    let action = server
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
        .expect("record action");
    assert_eq!(action.status().as_u16(), 201, "POST actions is 201");

    // GET /provenance/graph → 200.
    let graph = server
        .client
        .get(server.api_url(&format!("/provenance/graph?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("graph");
    assert_eq!(graph.status().as_u16(), 200, "GET graph is 200");

    // GET /provenance/runs → 200.
    let runs = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs");
    assert_eq!(runs.status().as_u16(), 200, "GET runs is 200");

    // GET /provenance/runs/{id} → 200.
    let one = server
        .client
        .get(server.api_url(&format!("/provenance/runs/{run_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("run by id");
    assert_eq!(one.status().as_u16(), 200, "GET runs/{{id}} is 200");
    let one_body: Value = one.json().await.expect("run json");
    assert_eq!(one_body["run_id"], json!(run_id));

    // POST /provenance/export → 200, then GET /provenance/export/{id} → 200.
    let build: Value = server
        .client
        .post(server.api_url("/provenance/export"))
        .bearer_auth(&admin)
        .json(&json!({ "project_id": project_id, "target": run_id, "scope": "single" }))
        .send()
        .await
        .expect("export build")
        .json()
        .await
        .expect("export json");
    let export_id = build["export_id"].as_str().expect("export_id");
    let dl = server
        .client
        .get(server.api_url(&format!("/provenance/export/{export_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("export download");
    assert_eq!(dl.status().as_u16(), 200, "GET export/{{id}} is 200");

    // GET /provenance/settings → 200.
    let settings = server
        .client
        .get(server.api_url("/provenance/settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("settings");
    assert_eq!(settings.status().as_u16(), 200, "GET settings is 200");
}

// TEST-8 [ITEM-5, ITEM-6] — the predicate is visible on the two RUN endpoints:
// `GET /provenance/runs` (the paginated trust view) and `GET /provenance/runs/{id}`
// both return the run's SCIENTIFIC params (the filtered column + threshold) AND the
// `rerun_spec` envelope, and `params` no longer carries `language`/`arch`.
#[tokio::test]
async fn run_endpoints_carry_the_predicate_and_the_rerun_envelope() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "predicate rest project").await;
    let pool = pool_for(&server).await;
    let run_id = record_filter_run(&pool, project_id, root_id).await;

    // GET /provenance/runs — the paginated list.
    let page: Value = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs list")
        .json()
        .await
        .expect("runs json");
    let listed = page["runs"]
        .as_array()
        .expect("runs array")
        .iter()
        .find(|r| r["run_id"] == json!(run_id.to_string()))
        .expect("the filter run is listed");
    assert_eq!(listed["generator_id"], json!("cell.filter"));
    assert_predicate_visible(listed, "GET /provenance/runs");

    // GET /provenance/runs/{id} — the single-run read.
    let one = get_run_node(&server, &admin, run_id).await;
    assert_predicate_visible(&one, "GET /provenance/runs/{id}");
    // The envelope really is the full re-run spec, not a copy of `params`.
    assert_eq!(one["rerun_spec"]["script"], json!("import scanpy as sc\n"));
    assert_eq!(one["rerun_spec"]["inputs"][0]["slot"], json!("expression"));
}

// TEST-14 [acceptance, INV-2] [ITEM-5..ITEM-9] — the reviewer question "what was
// filtered on?" is answerable from EVERY surface for ONE seeded filter run: the two
// run endpoints, the graph, and the exported crate's `manifest.json` (whose
// descriptor is `ro-crate-metadata.json`) + `methods.md`.
#[tokio::test]
async fn every_trust_surface_answers_what_was_filtered_on() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "inv2 project").await;
    let pool = pool_for(&server).await;
    let run_id = record_filter_run(&pool, project_id, root_id).await;

    // 1 + 2. The run endpoints.
    let page: Value = server
        .client
        .get(server.api_url(&format!("/provenance/runs?project_id={project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("runs list")
        .json()
        .await
        .expect("runs json");
    let listed = page["runs"].as_array().expect("runs").iter()
        .find(|r| r["run_id"] == json!(run_id.to_string()))
        .expect("run listed");
    assert_predicate_visible(listed, "/provenance/runs");
    assert_predicate_visible(&get_run_node(&server, &admin, run_id).await, "/provenance/runs/{id}");

    // 3. The graph.
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
    assert_predicate_visible(node, "/provenance/graph");

    // 4 + 5. The exported crate — asserted on BUNDLE BYTES, not in-process structs.
    let export_id = crate::dataset::hardening_common::export_bundle(
        &server, &admin, project_id, Some(run_id), "single",
    )
    .await;
    let zip = crate::dataset::hardening_common::download_zip(&server, &admin, &export_id).await;
    let members = crate::dataset::hardening_common::unzip_store(&zip);
    let member = |name: &str| -> String {
        members
            .iter()
            .find(|(n, _)| n.ends_with(name))
            .map(|(_, b)| String::from_utf8_lossy(b).to_string())
            .unwrap_or_else(|| panic!("bundle member {name} (members: {:?})",
                members.iter().map(|(n, _)| n).collect::<Vec<_>>()))
    };

    let manifest = member("manifest.json");
    assert!(
        manifest.contains("ro-crate-metadata.json"),
        "the manifest is the RO-Crate metadata descriptor"
    );
    assert!(manifest.contains("FormalParameter"), "params are documented as FormalParameters");
    assert!(manifest.contains("pct_counts_mito"), "the filtered column is in the crate: {manifest}");
    assert!(!manifest.contains("\"name\": \"language\""), "no runtime metadata as a FormalParameter");

    let methods = member("methods.md");
    assert!(methods.contains("Cells were filtered on 2 criteria"), "prose narrates the filter: {methods}");
    assert!(methods.contains("pct_counts_mito ≤ 10"), "prose names the predicate: {methods}");
    // The committed column IS the run's label, verbatim (filter package 0.9.0, a62c3d80) —
    // so the prose names the LABEL, and naming a `keep_`-prefixed column would state a
    // column that no run commits. The negative control is the load-bearing half: it is
    // what the pre-0.9.0 expectation asserted, and it is now false of the data.
    assert!(
        methods.contains("labelled `lowqc`"),
        "prose names the committed mask column by its label, verbatim: {methods}"
    );
    assert!(
        !methods.contains("keep_lowqc"),
        "prose never names a `keep_`-prefixed column — no run commits one: {methods}"
    );
}
