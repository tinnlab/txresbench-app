//! **TEST-53 (TRANSITIVE leg) [covers: ITEM-40 / INV-13] — `D → V1 → V2` refuses NAMING BOTH.**
//!
//! `detach_refusal_test` covers the direct leg. This file covers the one that was deferred, and
//! the reason it could be deferred stopped being true without anything failing:
//!
//! > *nothing mints a `datasets` row for a gathered artifact … so there is no `V1` that a second
//! > alignment could name as a source.*
//!
//! `virtual_dataset.rs::create_for_run` became a fourth `INSERT INTO datasets` site ~45 minutes
//! after that was written. From then on the chain was constructible at the data layer and nothing
//! refused it — the serve path resolves chains (`gather_exec::plan_chain`), so a user could detach
//! `D`, be told it was safe, and lose `V2`.
//!
//! ── WHY THE FIXTURE BUILDS `V1` WITH RAW SQL, AND WHY THAT IS NOT FAKING IT ──────────────────
//!
//! The deferral's own objection — *"a walk pinned by a fixture constructing a state the system
//! cannot produce is the 'looks correct and produces nothing' class"* — is right, and it is why
//! `V1` here is not an invented shape. It is exactly the row `create_for_run` inserts: the same
//! three columns that matter (`source = 'integrate'`, `metadata.alignment_run_id`,
//! `metadata.alignment.artifact_id`), and it is now also the ONLY shape the database will accept
//! for an `integrate` row (`datasets_integrate_declares_alignment`, migration `202608040008`).
//! A drift in what the creator writes therefore breaks this fixture's INSERT rather than letting
//! it quietly assert a dead shape — which is the property the deferral was asking for.
//!
//! Running the real creator instead would need a real integration job, a real workspace and a
//! real producer manifest; `creator_real_run_test` owns that, and pinning a refusal to it would
//! make this gate's coverage hostage to a compute fixture.
//!
//! ── WHAT EACH TEST UNIQUELY KILLS ────────────────────────────────────────────────────────────
//!
//! * [`detaching_the_root_of_a_chain_refuses_and_names_every_dependent_in_it`] — kills a guard
//!   that stops after ONE level. Its assertion is `blockers.len() == 2` AND both names present;
//!   the pre-walk code answers `Refused([A1])`, which is a refusal, so a test asserting only
//!   "refused" would pass under BOTH behaviours. It also kills a walk that finds the second level
//!   but drops the first from the message.
//! * [`the_bystander_still_detaches_with_a_whole_chain_standing`] — kills a walk that grows the
//!   frontier by anything other than a real edge (e.g. adding every `integrate` dataset in the
//!   project, or every alignment's product regardless of whether it blocked). Under that
//!   mutation `A2` blocks the bystander too and this fails.
//! * [`the_database_refuses_an_integrate_dataset_with_no_alignment_edge`] — kills removing the
//!   CHECK. This is the guard on the PREMISE rather than on the behaviour: the walk finds `V1`
//!   through `metadata.alignment.artifact_id` and through nothing else, so a fifth minting site
//!   that omits that key would be invisible to it in precisely the way the fourth one was.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::NewArtifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::detach_guard::{detach_verdict, DetachVerdict, Reason};

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

async fn dataset_uuid(server: &TestServer, token: &str, name: &str) -> Uuid {
    Uuid::parse_str(&create_dataset(server, token, name).await).expect("dataset id is a uuid")
}

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// The producer's own alignment manifest entry, read byte-for-byte. Same reason
/// `detach_refusal_test` does it: hand-building the shape would make this test assert my reading
/// of the producer's format rather than the format.
///
/// **Selected STRUCTURALLY, not by datatype id.** `detach_refusal_test` names the id in a
/// const; this file cannot, because the TEST-tier domain-literal scan is shrink-only and a new
/// literal widens it. That constraint improves the fixture rather than bending it: the entry is
/// found by the same signature `detach_guard::ALIGNMENT_SIGNATURE` selects on — a `meta.sources[]`
/// array plus a `segments` extent — so if the producer ever renamed its datatype this helper
/// would keep working, while a spelled id would silently find nothing. The id itself is then
/// CARRIED from the entry onto the seeded row, so the row is typed exactly as the producer types
/// it without this file ever writing the string.
fn alignment_entry(dir: &Path) -> Value {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("manifest.json")).expect("fixture manifest.json"),
    )
    .expect("manifest parses");
    manifest["outputs"]
        .as_array()
        .expect("manifest declares outputs")
        .iter()
        .find(|o| {
            o["meta"]["sources"].is_array() && o["structure"]["extents"].get("segments").is_some()
        })
        .cloned()
        .expect("the producer emits exactly one alignment output (sources[] + a segments extent)")
}

/// Seed one alignment into `project` under `output_id`, with `meta.sources[].dataset_id`
/// replaced positionally by `real_ids`.
///
/// `output_id` is a parameter — unlike the direct-leg helper — because a chain needs TWO
/// alignments in ONE project and `insert_artifact`'s idempotency key is
/// (project, dataset, run, output). Seeding both under one name would silently return the first
/// row twice and the "chain" would be one alignment wearing two hats.
async fn seed_alignment(
    repo: &CatalogRepository,
    project: Uuid,
    output_id: &str,
    real_ids: &[Option<Uuid>],
) -> Uuid {
    let entry = alignment_entry(&fixture_dir("stage1_alignment"));
    let mut meta = entry["meta"].clone();
    let sources = meta["sources"].as_array_mut().expect("meta.sources[]");
    assert!(
        sources.len() >= 2,
        "an alignment over fewer than two sources is not an alignment; fixture drifted"
    );
    for (i, src) in sources.iter_mut().enumerate() {
        if let Some(Some(real)) = real_ids.get(i) {
            src["dataset_id"] = json!(real.to_string());
        }
    }
    // The blob hash is derived from `output_id` so the two alignments are distinct rows in every
    // column the catalog dedupes on, not just in their id.
    let hash = format!(
        "sha256:{:0>64}",
        output_id.replace(|c: char| !c.is_ascii_alphanumeric(), "")
    );
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: None,
        output_id: output_id.to_string(),
        // The producer's own id, carried rather than spelled — see `alignment_entry`.
        datatype: entry["datatype"]
            .as_str()
            .expect("the manifest entry declares a datatype")
            .to_string(),
        object_key: Some(hash.clone()),
        is_multifile: false,
        content_hash: hash,
        structure: entry["structure"].clone(),
        meta,
        role: "artifact".into(),
        stored_bytes: 1,
        logical_bytes: Some(1),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert alignment artifact")
    .id
}

/// The VIRTUAL DATASET row an integration run produces — the same shape
/// `virtual_dataset::create_for_run` inserts, `metadata.alignment.artifact_id` and all.
async fn seed_virtual_dataset(
    pool: &sqlx::SqlitePool,
    owner_of: Uuid,
    name: &str,
    alignment: Uuid,
) -> Uuid {
    // The owner is taken from a real dataset rather than invented: `datasets.owner_id` is a FK.
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM datasets WHERE id = $1")
        .bind(owner_of)
        .fetch_one(pool)
        .await
        .expect("owner of the seed dataset");
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source) \
         VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), NULL, $4, 'integrate')",
    )
    .bind(id)
    .bind(name)
    .bind(owner)
    .bind(json!({
        "alignment_run_id": Uuid::new_v4().to_string(),
        "alignment": { "artifact_id": alignment.to_string() },
    }))
    .execute(pool)
    .await
    .expect("insert virtual dataset");
    id
}

#[tokio::test]
async fn detaching_the_root_of_a_chain_refuses_and_names_every_dependent_in_it() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "detach chain").await;

    // D → A1 → V1 → A2 → (V2, which need not exist for the refusal to be owed: what breaks is
    // A2's readability, and A2 is already unreadable the moment D leaves).
    let root = dataset_uuid(&server, &token, "root dataset").await;
    let a1 = seed_alignment(&repo, project, "first_integration", &[Some(root), None]).await;
    let v1 = seed_virtual_dataset(&pool, root, "Integrated: root + other", a1).await;
    seed_alignment(&repo, project, "second_integration", &[Some(v1), None]).await;

    let verdict = detach_verdict(&pool, project, root).await.expect("verdict");
    let blockers = match &verdict {
        DetachVerdict::Refused(b) => b,
        other => panic!("the root of a chain must be refused, got {other:?}"),
    };

    // THE ASSERTION THAT KILLS THE ONE-LEVEL GUARD. The pre-walk code returns exactly one
    // blocker here and that is still a `Refused`, so asserting the variant alone would pass
    // under both behaviours — the failure this file exists to make impossible.
    let named: Vec<&str> = blockers.iter().map(|b| b.output_id.as_str()).collect();
    assert_eq!(
        blockers.len(),
        2,
        "INV-13: BOTH levels of the chain must block. Only the direct one did: {named:?}"
    );
    assert!(
        named.contains(&"first_integration"),
        "the direct dependent is missing: {named:?}"
    );
    assert!(
        named.contains(&"second_integration"),
        "the TRANSITIVE dependent is missing — the walk stopped at one level: {named:?}"
    );
    assert!(
        blockers.iter().all(|b| b.reason == Reason::DependsOn),
        "both are real dependencies, not cannot-determine: {blockers:?}"
    );

    // …and the sentence names both, because "what do I remove first" is the question it answers
    // and an unnamed second level makes the answer wrong rather than incomplete.
    let message = verdict.message().expect("a refusal carries its sentence");
    assert!(
        message.contains("first_integration") && message.contains("second_integration"),
        "the refusal must name every dependent in the chain: {message}"
    );
}

#[tokio::test]
async fn the_bystander_still_detaches_with_a_whole_chain_standing() {
    // THE POSITIVE CONTROL FOR THE WALK, and it is a different control from the direct leg's: a
    // walk can be too eager as easily as too shallow. If the frontier grew by anything other
    // than "the product of an alignment that actually blocked" — every `integrate` dataset in
    // the project, say — `second_integration` would block this too and a chain would freeze the
    // whole project. The scene is the SAME one as above, so a blanket refusal cannot satisfy both.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "chain bystander").await;

    let root = dataset_uuid(&server, &token, "root dataset").await;
    let bystander = dataset_uuid(&server, &token, "unrelated dataset").await;
    let a1 = seed_alignment(&repo, project, "first_integration", &[Some(root), None]).await;
    let v1 = seed_virtual_dataset(&pool, root, "Integrated: root + other", a1).await;
    seed_alignment(&repo, project, "second_integration", &[Some(v1), None]).await;

    assert_eq!(
        detach_verdict(&pool, project, bystander)
            .await
            .expect("verdict"),
        DetachVerdict::Allowed,
        "a dataset no level of the chain names must still detach cleanly"
    );

    // And the MIDDLE of the chain is refused on its own account — V1 is named by A2, which is
    // the direct rule applied to a virtual dataset. Asserting it here proves the chain's second
    // edge is real rather than a fixture artifact of the first test's frontier.
    match detach_verdict(&pool, project, v1).await.expect("verdict") {
        DetachVerdict::Refused(b) => {
            let named: Vec<&str> = b.iter().map(|x| x.output_id.as_str()).collect();
            assert_eq!(named, vec!["second_integration"], "{named:?}");
        }
        other => panic!("the middle of a chain is itself a source and must be refused: {other:?}"),
    }
}

#[tokio::test]
async fn the_database_refuses_an_integrate_dataset_with_no_alignment_edge() {
    // **The guard on the PREMISE, not on the behaviour.** The walk discovers `V1` through
    // `metadata.alignment.artifact_id` and through nothing else. A future site that mints an
    // `integrate` row without it would reintroduce exactly the gap this branch closes — a chain
    // the data layer can build and the refusal cannot see — and no comment can notice that
    // happening. So the edge is a CHECK, and this asserts the CHECK, not the creator.
    //
    // Deliberately NOT a source scan for `INSERT INTO datasets`: a text guard fires on harmless
    // additions and misses a helper, a different spelling, or a `COPY`. The invariant is a
    // property of the row, so it is asserted on the row.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let seed = dataset_uuid(&server, &token, "seed for owner").await;
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM datasets WHERE id = $1")
        .bind(seed)
        .fetch_one(&pool)
        .await
        .expect("owner");

    for (case, metadata) in [
        (
            "no alignment key at all",
            json!({ "alignment_run_id": "r1" }),
        ),
        (
            "an alignment object with no artifact_id",
            json!({ "alignment_run_id": "r2", "alignment": { "key_column": "k" } }),
        ),
        (
            "an EMPTY artifact_id — present but naming nothing",
            json!({ "alignment_run_id": "r3", "alignment": { "artifact_id": "" } }),
        ),
    ] {
        let err = sqlx::query(
            "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
             VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), $4, 'integrate')",
        )
        .bind(Uuid::new_v4())
        .bind(format!("bad integrate: {case}"))
        .bind(owner)
        .bind(&metadata)
        .execute(&pool)
        .await
        .expect_err(&format!(
            "an integrate dataset with {case} must be refused by the database — the walk cannot \
             see it, so nothing else would catch it"
        ));
        assert!(
            err.to_string()
                .contains("datasets_integrate_declares_alignment"),
            "refused by the WRONG constraint for {case:?}: {err}"
        );
    }

    // THE CONTROL — the constraint must not refuse the shapes that are fine, or it is a
    // constraint that blocks everything and proves nothing.
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), $4, 'integrate')",
    )
    .bind(Uuid::new_v4())
    .bind("a well-formed integrate dataset")
    .bind(owner)
    .bind(json!({
        "alignment_run_id": Uuid::new_v4().to_string(),
        "alignment": { "artifact_id": Uuid::new_v4().to_string() },
    }))
    .execute(&pool)
    .await
    .expect("a creator-shaped integrate row must still insert");

    // …and an `upload` row is untouched by it, whatever its metadata says. The constraint is
    // partial on purpose; a version that fired on every row would be caught here.
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, metadata, source) \
         VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), '{}', 'upload')",
    )
    .bind(Uuid::new_v4())
    .bind("an ordinary upload")
    .bind(owner)
    .execute(&pool)
    .await
    .expect("an upload dataset carries no alignment and must be unaffected");
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  #163 — the FILTER edge: a source under a `source='filter'` VD is protected too
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// The detach guard was alignment-shaped: it walked `meta.sources[]` on `integrate` rows. A filter
// VD has NO alignment — its source lives in the VD-owned MASK's `meta.sources[]` (`mask::mask_meta`,
// the channel that doc designates for this guard) — so the walk never saw it and a source was
// detachable out from under a filter VD, leaving its mask + gathered columns reading through a gone
// source (the #151 class, new topology). The fix traverses the filter edge in the same fixpoint.

/// Seed a `source='filter'` VD in `project`: a stored mask bound to it (recording `source` in its
/// `meta.sources[]`, exactly as `create_filter_vd_for_run` does), attached via `project_datasets`.
async fn seed_filter_vd(
    pool: &sqlx::SqlitePool,
    repo: &CatalogRepository,
    project: Uuid,
    name: &str,
    source: Uuid,
) -> Uuid {
    let owner: Uuid = sqlx::query_scalar("SELECT owner_id FROM datasets WHERE id = $1")
        .bind(source)
        .fetch_one(pool)
        .await
        .expect("owner of the source dataset");

    // A stored mask artifact (bind_mask_to_dataset requires `object_key IS NOT NULL`).
    let key = format!(
        "sha256:{:0>64}",
        name.replace(|c: char| !c.is_ascii_alphanumeric(), "")
    );
    let mask = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: format!("mask-{name}"),
            datatype: "data/opaque".into(),
            object_key: Some(key.clone()),
            is_multifile: true,
            content_hash: key,
            structure: json!({ "kind": "table", "axis": "rows", "n": 3,
                "columns": [{ "name": "values", "path": "values" }] }),
            meta: json!({ "filter_mask": { "label": name } }),
            role: "artifact".into(),
            stored_bytes: 3,
            logical_bytes: Some(3),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert mask")
        .id;

    let vd = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source) \
         VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), NULL, $4, 'filter')",
    )
    .bind(vd)
    .bind(name)
    .bind(owner)
    .bind(json!({
        "filter_run_id": Uuid::new_v4().to_string(),
        "filter": { "source_dataset_id": source.to_string(), "mask_artifact_id": mask.to_string() }
    }))
    .execute(pool)
    .await
    .expect("insert filter vd");

    // Bind the mask to the VD — records `source` in `meta.sources[]` (the edge the guard walks).
    assert!(
        repo.bind_mask_to_dataset(mask, vd, &source.to_string())
            .await
            .expect("bind mask"),
        "the mask must bind (it owns bytes)"
    );

    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project)
        .bind(vd)
        .execute(pool)
        .await
        .expect("attach filter vd to project");
    vd
}

/// **A source under a FILTER VD cannot be detached; an unrelated dataset can (#163).**
///
/// nc: revert the filter-edge query + fixpoint leg in `detach_guard` and the source detaches
/// (`Allowed`) with a live filter VD reading through it — the exact gap #163 named.
#[tokio::test]
async fn a_source_under_a_filter_vd_cannot_be_detached() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "detach under filter").await;

    let source = dataset_uuid(&server, &token, "filtered source").await;
    let other = dataset_uuid(&server, &token, "unrelated dataset").await;
    seed_filter_vd(&pool, &repo, project, "Kept high-quality", source).await;

    // Detaching the SOURCE is refused, naming the filter VD.
    let verdict = detach_verdict(&pool, project, source).await.expect("verdict");
    let blockers = match &verdict {
        DetachVerdict::Refused(b) => b,
        other => panic!("a source under a filter VD must be refused, got {other:?}"),
    };
    assert!(
        blockers
            .iter()
            .any(|b| b.output_id == "Kept high-quality" && b.reason == Reason::DependsOn),
        "the refusal must NAME the filter VD as a real dependent: {blockers:?}"
    );

    // POSITIVE CONTROL: a dataset that no filter VD reads detaches. Without it, a guard that
    // refused everything would satisfy the assertion above and break the behaviour it protects.
    assert_eq!(
        detach_verdict(&pool, project, other)
            .await
            .expect("verdict"),
        DetachVerdict::Allowed,
        "an unrelated dataset is under no filter VD and must still detach"
    );
}
