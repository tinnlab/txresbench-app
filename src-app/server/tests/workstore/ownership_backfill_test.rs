//! **ITEM-45 / ITEM-50 — the backfill, its dry-run, and the count that can say "I can't".**
//!
//! Every fixture here seeds **all three outcome buckets**. A fixture with only assignable rows
//! cannot catch a no-op backfill: the assigned count would be whatever the code produced and
//! there would be nothing it disagreed with. The plan names that shape explicitly, and it is
//! the same vacuity that made the GC tests prove nothing two rounds ago.

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::NewArtifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::ownership_backfill::{
    dependent_analysis_count, run_backfill, Decision,
};
use txresbench::modules::provenance::repository::{NewRun, ProvenanceRepository};

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

/// A recorded run whose inputs name `datasets`, scoped to `project`.
async fn run_with_dataset_inputs(
    pool: &sqlx::SqlitePool,
    project: Uuid,
    datasets: &[Uuid],
) -> Uuid {
    let run_id = Uuid::new_v4();
    let inputs: Vec<serde_json::Value> = datasets
        .iter()
        .enumerate()
        .map(|(i, d)| {
            json!({ "slot": format!("in{i}"), "kind": "dataset", "ref_id": d,
                    "content_hash": format!("sha256:{}", "a".repeat(64)) })
        })
        .collect();
    ProvenanceRepository::new(pool.clone())
        .insert_run(&NewRun {
            run_id,
            project_id: Some(project),
            dataset_id: None,
            kind: "compute".into(),
            status: "completed".into(),
            generator_id: "test.analysis".into(),
            generator_version: "0".into(),
            code_sha256: None,
            env_rootfs_sha256: None,
            lockfile_json: None,
            seed: None,
            params: json!({}),
            inputs_json: json!(inputs),
            acting_user: None,
            rerun_spec_json: None,
        })
        .await
        .expect("insert run");
    run_id
}

/// A PROJECT-scoped artifact with no `dataset_id` — the shape the backfill exists for.
async fn floating_artifact(
    repo: &CatalogRepository,
    project: Uuid,
    run_id: Option<Uuid>,
    output_id: &str,
    datatype: &str,
) -> Uuid {
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id,
        output_id: output_id.to_string(),
        datatype: datatype.to_string(),
        object_key: Some(format!("sha256:{}", "b".repeat(64))),
        is_multifile: false,
        content_hash: format!("sha256:{}", "b".repeat(64)),
        structure: json!({ "encoding": "opaque" }),
        meta: json!({}),
        role: "artifact".into(),
        stored_bytes: 1,
        logical_bytes: Some(1),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert floating artifact")
    .id
}

async fn dataset_id_of(pool: &sqlx::SqlitePool, artifact: Uuid) -> Option<Uuid> {
    sqlx::query_scalar::<_, Option<Uuid>>("SELECT dataset_id FROM artifacts WHERE id = $1")
        .bind(artifact)
        .fetch_one(pool)
        .await
        .expect("read dataset_id")
}

/// The scene: one assignable row, one with no dataset input, one ambiguous.
async fn three_buckets(
    server: &TestServer,
    token: &str,
    pool: &sqlx::SqlitePool,
    tag: &str,
) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    let project = create_project(server, token, &format!("backfill {tag}")).await;
    let repo = CatalogRepository::new(pool.clone());
    let ds_a: Uuid = create_dataset(server, token, &format!("{tag}-a")).await.parse().unwrap();
    let ds_b: Uuid = create_dataset(server, token, &format!("{tag}-b")).await.parse().unwrap();

    let one = run_with_dataset_inputs(pool, project, &[ds_a]).await;
    let none = run_with_dataset_inputs(pool, project, &[]).await;
    let two = run_with_dataset_inputs(pool, project, &[ds_a, ds_b]).await;

    let assignable = floating_artifact(&repo, project, Some(one), "labels", "metadata-column").await;
    let no_input = floating_artifact(&repo, project, Some(none), "qc", "report/qc").await;
    let ambiguous = floating_artifact(&repo, project, Some(two), "joint", "metadata-column").await;
    (project, ds_a, assignable, no_input, ambiguous)
}

/// **The dry run reports every bucket and writes NOTHING.**
#[tokio::test]
async fn the_dry_run_classifies_all_three_buckets_and_writes_nothing() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (_p, ds_a, assignable, no_input, ambiguous) =
        three_buckets(&server, &token, &pool, "dry").await;

    let report = run_backfill(&pool, false).await.expect("dry run");

    // NON-VACUITY: all three buckets are populated, or this fixture cannot catch a backfill
    // that quietly assigns nothing (or everything).
    assert!(report.assigned >= 1, "no assignable row: {}", report.render());
    assert!(report.unassigned_no_input >= 1, "{}", report.render());
    assert!(report.unassigned_ambiguous >= 1, "{}", report.render());

    let of = |id: Uuid| {
        report
            .rows
            .iter()
            .find(|r| r.artifact_id == id)
            .unwrap_or_else(|| panic!("row {id} absent from the report:\n{}", report.render()))
            .decision
            .clone()
    };
    assert_eq!(of(assignable), Decision::Assign(ds_a));
    assert_eq!(of(no_input), Decision::UnassignedNoInput);
    match of(ambiguous) {
        Decision::UnassignedAmbiguous(ds) => assert_eq!(ds.len(), 2),
        other => panic!("a two-dataset run must stay ambiguous, got {other:?}"),
    }

    // …and NOTHING moved.
    assert_eq!(report.written, 0, "a dry run must not write");
    for id in [assignable, no_input, ambiguous] {
        assert_eq!(dataset_id_of(&pool, id).await, None, "row {id} was modified by a DRY RUN");
    }
}

/// **The write assigns exactly the assignable row, and is idempotent.**
#[tokio::test]
async fn the_write_assigns_only_the_unambiguous_row_and_re_runs_clean() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (_p, ds_a, assignable, no_input, ambiguous) =
        three_buckets(&server, &token, &pool, "write").await;

    let dry = run_backfill(&pool, false).await.expect("dry");
    let wrote = run_backfill(&pool, true).await.expect("write");

    // THE DRY RUN'S PER-ROW OUTCOME EQUALS WHAT THE WRITE DID. This is the property that
    // makes the report the owner approves an account of what will actually happen.
    for d in &dry.rows {
        let w = wrote
            .rows
            .iter()
            .find(|r| r.artifact_id == d.artifact_id)
            .expect("same rows");
        assert_eq!(d.decision, w.decision, "row {} decided differently", d.artifact_id);
    }
    assert_eq!(wrote.written, wrote.assigned);
    assert!(wrote.written >= 1);

    assert_eq!(dataset_id_of(&pool, assignable).await, Some(ds_a));
    assert_eq!(
        dataset_id_of(&pool, ambiguous).await,
        None,
        "INV-14 — a two-dataset run must NOT be force-assigned; an invented association is \
         worse than a visible gap, and dataset_id is ON DELETE CASCADE so it also decides \
         what a dataset delete destroys"
    );
    assert_eq!(dataset_id_of(&pool, no_input).await, None);

    // IDEMPOTENT: a second pass decides the same and writes nothing new.
    let again = run_backfill(&pool, true).await.expect("re-run");
    assert_eq!(again.written, 0, "a re-run must be a no-op:\n{}", again.render());
    assert_eq!(dataset_id_of(&pool, assignable).await, Some(ds_a));
}

/// **The report names the datatypes**, so it can be checked against a measured expectation
/// rather than against a total that could be right for the wrong reasons.
#[tokio::test]
async fn the_report_breaks_down_by_datatype() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    three_buckets(&server, &token, &pool, "bydt").await;

    let report = run_backfill(&pool, false).await.expect("dry");
    assert!(report.by_datatype.get("metadata-column").copied().unwrap_or(0) >= 2);
    assert!(report.by_datatype.get("report/qc").copied().unwrap_or(0) >= 1);
    let rendered = report.render();
    assert!(rendered.contains("DRY RUN — no rows will be modified"));
    assert!(rendered.contains("metadata-column"));
}

/// **ITEM-50 — the dependent count, including its ability to refuse.**
#[tokio::test]
async fn the_dependent_count_is_real_and_can_say_it_cannot_answer() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (project, ds_a, _, _, _) = three_buckets(&server, &token, &pool, "count").await;

    // Two of the three seeded runs name ds_a (the single-input one and the ambiguous one).
    let n = dependent_analysis_count(&pool, project, ds_a)
        .await
        .expect("count")
        .expect("a project with recorded runs can answer");
    assert_eq!(
        n, 2,
        "the count is the runs that USED the dataset — a hardcoded 0 or a count of all runs \
         would both be wrong, and a warning showing either is worse than no warning"
    );

    // A dataset nothing used, in the same project: a real zero, not a refusal.
    let unused: Uuid = create_dataset(&server, &token, "count-unused")
        .await
        .parse()
        .unwrap();
    assert_eq!(
        dependent_analysis_count(&pool, project, unused).await.unwrap(),
        Some(0),
        "a project WITH recorded runs and no user of this dataset answers 0, not 'unknown'"
    );

    // A project with NO recorded runs cannot answer: every count would be 0, and 0 there
    // means "nothing is recorded", not "nothing uses it". Stage 3 must render that.
    let empty = create_project(&server, &token, "backfill count empty").await;
    assert_eq!(
        dependent_analysis_count(&pool, empty, ds_a).await.unwrap(),
        None,
        "cannot-compute must be expressible — a fabricated or always-zero count is worse \
         than none, because a user acts on it"
    );
}

/// **The two unassigned reasons are DIFFERENT facts, and the report must not conflate them.**
///
/// A run that recorded no inputs at all is a provenance gap. A run whose inputs are artifacts
/// that have since been deleted has intact provenance pointing at rows that are gone. They
/// recommend opposite investigations, and the live dry-run is what surfaced the distinction:
/// 12 rows were being reported as "no dataset input" when in fact every one of them had input
/// edges whose artifacts no longer exist.
#[tokio::test]
async fn an_input_that_no_longer_exists_is_reported_as_such_not_as_a_missing_input() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let project = create_project(&server, &token, "backfill deleted input").await;
    let repo = CatalogRepository::new(pool.clone());

    // A run whose single input names an artifact id that is not in the catalog.
    let ghost = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    ProvenanceRepository::new(pool.clone())
        .insert_run(&NewRun {
            run_id,
            project_id: Some(project),
            dataset_id: None,
            kind: "compute".into(),
            status: "completed".into(),
            generator_id: "test.analysis".into(),
            generator_version: "0".into(),
            code_sha256: None,
            env_rootfs_sha256: None,
            lockfile_json: None,
            seed: None,
            params: json!({}),
            inputs_json: json!([{ "slot": "in", "kind": "artifact", "ref_id": ghost,
                                  "content_hash": format!("sha256:{}", "c".repeat(64)) }]),
            acting_user: None,
            rerun_spec_json: None,
        })
        .await
        .expect("insert run");
    let orphaned =
        floating_artifact(&repo, project, Some(run_id), "orphaned", "metadata-column").await;

    // POSITIVE CONTROL in the same fixture: a run with genuinely NO inputs must still be
    // reported as that, or this test would pass for an implementation that collapsed both
    // reasons into the new bucket instead of the old one.
    let empty_run = run_with_dataset_inputs(&pool, project, &[]).await;
    let no_inputs =
        floating_artifact(&repo, project, Some(empty_run), "no-inputs", "report/qc").await;

    let report = run_backfill(&pool, false).await.expect("dry run");
    let of = |id: Uuid| {
        report
            .rows
            .iter()
            .find(|r| r.artifact_id == id)
            .unwrap_or_else(|| panic!("row {id} absent:\n{}", report.render()))
            .decision
            .clone()
    };

    match of(orphaned) {
        Decision::UnassignedInputsUnresolvable { edges, missing_artifacts } => {
            assert_eq!(edges, 1);
            assert_eq!(
                missing_artifacts, 1,
                "the report must say the input artifact is GONE — 'the run named no dataset \
                 input' sends the reader looking for a provenance gap that is not there"
            );
        }
        other => panic!("expected an unresolvable-inputs verdict, got {other:?}"),
    }
    assert_eq!(of(no_inputs), Decision::UnassignedNoInput);
    assert!(report.render().contains("no longer in the catalog"));
}

/// **ITEM-44(a) — a natural-key collision is REFUSED and reported, never discovered mid-write.**
///
/// `artifacts_natural_key` is `(COALESCE(project_id,0), COALESCE(dataset_id,0),
/// COALESCE(run_id,0), output_id)`, so filling `dataset_id` MOVES a row to a different slot.
/// If that slot is taken, the UPDATE fails — and a backfill that discovers this halfway
/// through has already written some rows and not others, on live data.
///
/// The plan called this the failure to account for rather than to discover. This is the
/// accounting: the same code path that would write checks first, so the DRY RUN reports the
/// refusal too — an assignment the dry-run promises and the write cannot make would be the
/// dry-run lying, which is the one thing it exists not to do.
#[tokio::test]
async fn an_assignment_that_would_collide_on_the_natural_key_is_refused_not_attempted() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let project = create_project(&server, &token, "backfill collision").await;
    let repo = CatalogRepository::new(pool.clone());
    let ds: Uuid = create_dataset(&server, &token, "collide-ds").await.parse().unwrap();
    let run = run_with_dataset_inputs(&pool, project, &[ds]).await;

    // The row the backfill would move…
    let floating = floating_artifact(&repo, project, Some(run), "same-output", "metadata-column").await;
    // …and a row already occupying the slot it would move INTO: same project, same run, same
    // output_id, and the dataset already set.
    let occupant = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: Some(ds),
            run_id: Some(run),
            output_id: "same-output".into(),
            datatype: "metadata-column".into(),
            object_key: Some(format!("sha256:{}", "d".repeat(64))),
            is_multifile: false,
            content_hash: format!("sha256:{}", "d".repeat(64)),
            structure: json!({ "encoding": "opaque" }),
            meta: json!({}),
            role: "artifact".into(),
            stored_bytes: 1,
            logical_bytes: Some(1),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert occupant")
        .id;

    let dry = run_backfill(&pool, false).await.expect("dry");
    let decision = dry
        .rows
        .iter()
        .find(|r| r.artifact_id == floating)
        .unwrap_or_else(|| panic!("row absent:\n{}", dry.render()))
        .decision
        .clone();
    match decision {
        Decision::CollisionRefused { would_assign, occupied_by } => {
            assert_eq!(would_assign, ds);
            assert_eq!(occupied_by, occupant, "the report names the row holding the slot");
        }
        other => panic!(
            "a derivable assignment into an OCCUPIED natural-key slot must be refused and \
             named, got {other:?}\n{}",
            dry.render()
        ),
    }
    assert_eq!(dry.collision_refused, 1);

    // And the WRITE agrees with the dry run: it does not attempt the update, so it neither
    // fails nor half-writes.
    let wrote = run_backfill(&pool, true).await.expect("write");
    assert_eq!(wrote.written, 0, "nothing was assignable without colliding");
    assert_eq!(dataset_id_of(&pool, floating).await, None);
}

/// **ITEM-44(b) — the report states the CASCADE widening in numbers, not in a comment.**
///
/// `artifacts.dataset_id` is `ON DELETE CASCADE` (verified against the live schema), so every
/// row this backfill assigns becomes destroyable by a dataset delete that previously could
/// not touch it. That is a consequence the owner should read in the report they approve, not
/// find in a migration comment afterwards.
#[tokio::test]
async fn the_report_states_how_many_rows_the_cascade_newly_covers() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (_p, _ds, _a, _n, _amb) = three_buckets(&server, &token, &pool, "cascade").await;

    let report = run_backfill(&pool, false).await.expect("dry");
    assert!(report.assigned >= 1, "the fixture must have something to widen");
    let rendered = report.render();
    assert!(
        rendered.contains("CASCADE WIDENING"),
        "the widening must be stated where the decision is read: {rendered}"
    );
    assert!(
        rendered.contains(&format!("{} row(s) become subject", report.assigned)),
        "…and with the count, not as a general warning: {rendered}"
    );
}

/// **ITEM-50's `GET` preserves the `Option` end to end.**
///
/// The route exists so stage 3's detach warning can render a real count — and the null is the
/// half that matters. Its consumer is a DESTRUCTIVE-ACTION confirmation, where "0 dependent
/// analyses" reads as a safety clearance; a route that coerced cannot-compute to 0 would put
/// that sentence in front of a user about to detach a dataset three analyses depend on.
#[tokio::test]
async fn the_dependent_analyses_route_returns_a_nullable_count() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (project, ds_a, _, _, _) = three_buckets(&server, &token, &pool, "route").await;

    async fn count_of(server: &TestServer, token: &str, p: Uuid, d: Uuid) -> Value {
        server
            .client
            .get(server.api_url(&format!("/projects/{p}/datasets/{d}/dependent-analyses")))
            .bearer_auth(token)
            .send()
            .await
            .expect("request")
            .json::<Value>()
            .await
            .expect("json")
    }

    let real = count_of(&server, &token, project, ds_a).await;
    assert_eq!(real["dependents"]["kind"], json!("counted"), "{real}");
    assert_eq!(real["dependents"]["count"], json!(2), "a real count arrives: {real}");

    // The refusal, on the wire, as null — not 0, not absent.
    let empty = create_project(&server, &token, "route empty").await;
    let unknown = count_of(&server, &token, empty, ds_a).await;
    assert_eq!(
        unknown["dependents"]["kind"],
        json!("cannot_compute"),
        "cannot-compute must arrive as its OWN VARIANT. As a nullable number it generates an \
         optional TS field and `count ?? 0` compiles — telling a user nothing depends on the \
         dataset they are about to remove: {unknown}"
    );
    assert!(
        unknown["dependents"]["count"].is_null(),
        "…and it carries NO number for a client to reach for: {unknown}"
    );
    assert!(
        unknown["dependents"]["reason"].as_str().is_some_and(|r| !r.is_empty()),
        "…and says why, so the surface can render a sentence rather than a blank: {unknown}"
    );
}
