//! **TEST-53 (direct leg) [covers: ITEM-40] — a dataset an INTEGRATED dataset is built from
//! cannot be detached.**
//!
//! Detaching is a list operation and for an ordinary dataset that is all it is. For a dataset an
//! alignment names as a SOURCE it is not: a gathered artifact has no blob of its own, so removing
//! a source makes every artifact derived from it unreadable. Visibility versus correctness —
//! which is why this refuses instead of warning.
//!
//! ── WHAT THIS DELIBERATELY DOES NOT COVER (DEC-24) ───────────────────────────────────────────
//!
//! TEST-53 as enumerated asserts the TRANSITIVE case — `D → V1 → V2` refused NAMING BOTH. That
//! leg is **absent, not skipped**, and the reason is measured rather than scheduling: nothing
//! mints a `datasets` row for a gathered artifact, so there is no `V1` for a second alignment to
//! name (DRIFT-stage3-1.45). A fixture for it could only be faked, and a walk pinned by a fixture
//! constructing a state the system cannot produce is the "looks correct and produces nothing"
//! class. When a gathered artifact mints a dataset row, the walk and this leg arrive together.
//!
//! ── THE POSITIVE CONTROL IS THE POINT ───────────────────────────────────────────────────────
//!
//! *A refusal that refuses everything passes the first assertion and breaks the behaviour it guards.* So the
//! unrelated dataset detaching CLEANLY is asserted in the same scene, against the same alignment,
//! not in a separate fixture where a blanket refusal would still look correct.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::detach_guard::{detach_verdict, DetachVerdict, Reason};

/// The datatype the fixture's manifest declares. Named HERE, in a test, rather than in the
/// guard: the guard selects on the artifact's STRUCTURAL signature precisely so that app code
/// carries no domain datatype id, and a test seeding a realistic row legitimately does.
const FIXTURE_DATATYPE: &str = "dataset-alignment";

use super::{create_project, pool_for, setup_admin};
use crate::common::TestServer;
use crate::dataset::create_dataset;

/// `create_dataset` answers a String id; the guard resolves Uuids. Parsed HERE, once, so a
/// malformed id fails in the fixture rather than surfacing as a spurious `Unresolvable` verdict
/// — which would make these tests pass for the wrong reason.
async fn dataset_uuid(server: &TestServer, token: &str, name: &str) -> Uuid {
    Uuid::parse_str(&create_dataset(server, token, name).await).expect("dataset id is a uuid")
}

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// The `dataset-alignment` entry of a producer-emitted manifest — a REAL one, byte-for-byte as
/// stage 1's emitter wrote it. Built by hand it would be this test asserting my reading of their
/// format, which is the seam failure this branch has already paid for twice.
fn alignment_entry(dir: &Path) -> Value {
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("manifest.json")).expect("fixture manifest.json"),
    )
    .expect("manifest parses");
    manifest["outputs"]
        .as_array()
        .expect("manifest declares outputs")
        .iter()
        .find(|o| o["datatype"] == Value::from(FIXTURE_DATATYPE))
        .cloned()
        .expect("the producer emits exactly one dataset-alignment output")
}

/// Seed the fixture's alignment into `project`, with its `meta.sources[].dataset_id` values
/// REPLACED by `real_ids` positionally.
///
/// Only the ids are rewritten. Every other byte — the structure, the roles, the extents, the
/// segment geometry — is the producer's, so `AlignmentPlan::parse` is exercised against real
/// output and this test cannot pass against a shape the producer does not emit.
///
/// Rewriting the ids is not a dialect invention: it is exactly what a real run produces once the
/// relay carries real dataset ids. The committed fixture stages SYNTHETIC datasets, so its
/// `params.dataset_ids` are `ds-a`/`ds-b` — see `an_unresolvable_source_refuses` for the arm that
/// uses them verbatim.
async fn seed_alignment(
    repo: &CatalogRepository,
    project: Uuid,
    fixture: &str,
    real_ids: &[Option<Uuid>],
) -> Uuid {
    let entry = alignment_entry(&fixture_dir(fixture));
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
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: None,
        output_id: "integrated_result".to_string(),
        datatype: FIXTURE_DATATYPE.to_string(),
        object_key: Some(format!("sha256:{}", "c".repeat(64))),
        is_multifile: false,
        content_hash: format!("sha256:{}", "c".repeat(64)),
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

#[tokio::test]
async fn a_source_of_an_integrated_dataset_is_refused_and_an_unrelated_one_is_not() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "detach refusal").await;

    // TWO datasets in ONE scene: the alignment is built from `source`, and `bystander` is an
    // ordinary dataset in the same project. Both verdicts are read against the SAME alignment,
    // so a guard that refused unconditionally cannot satisfy both.
    let source = dataset_uuid(&server, &token, "source dataset").await;
    let bystander = dataset_uuid(&server, &token, "unrelated dataset").await;

    seed_alignment(&repo, project, "stage1_alignment", &[Some(source), None]).await;

    // THE REFUSAL — a real source, reachable only through the alignment.
    let refused = detach_verdict(&pool, project, source)
        .await
        .expect("verdict");
    match &refused {
        DetachVerdict::Refused(blockers) => {
            assert_eq!(
                blockers.len(),
                1,
                "exactly the one alignment blocks: {blockers:?}"
            );
            assert_eq!(blockers[0].reason, Reason::DependsOn);
            assert_eq!(blockers[0].output_id, "integrated_result");
        }
        other => panic!("a source of an integrated dataset must be refused, got {other:?}"),
    }
    let message = refused.message().expect("a refusal carries its sentence");
    assert!(
        message.contains("integrated_result"),
        "the refusal must NAME what depends on it so the user knows what to remove first: {message}"
    );
    assert!(
        !message.to_lowercase().contains("virtual"),
        "\"virtual\" is internal vocabulary and must not reach a user-visible string: {message}"
    );

    // THE POSITIVE CONTROL — without it, a guard that refuses everything passes above.
    let allowed = detach_verdict(&pool, project, bystander)
        .await
        .expect("verdict");
    assert_eq!(
        allowed,
        DetachVerdict::Allowed,
        "an unrelated dataset must still detach cleanly, or the item is broken rather than safe"
    );
    assert_eq!(
        allowed.message(),
        None,
        "an allowed verdict carries no sentence"
    );
}

#[tokio::test]
async fn a_source_recorded_under_a_LEGACY_SPELLING_still_blocks() {
    // The committed fixture records its sources as `ds-a`/`ds-b` — synthetic names, not uuids,
    // which is what a producer that relayed a mount name or a legacy id would leave behind. A
    // gate that compared only uuids would call that "not a dependency" and allow a destructive
    // detach. So the dataset's NAME is compared too, and a dataset actually called `ds-b` is
    // blocked by the very fixture that would otherwise slip past.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "legacy spelling").await;

    let named_like_the_fixture = dataset_uuid(&server, &token, "ds-b").await;
    let bystander = dataset_uuid(&server, &token, "unrelated dataset").await;

    // Sources left VERBATIM — no id rewriting at all.
    seed_alignment(&repo, project, "stage1_alignment", &[]).await;

    match detach_verdict(&pool, project, named_like_the_fixture)
        .await
        .expect("verdict")
    {
        DetachVerdict::Refused(blockers) => {
            assert_eq!(blockers.len(), 1);
            assert_eq!(blockers[0].reason, Reason::DependsOn);
        }
        other => panic!("a source recorded under the dataset's NAME must block: {other:?}"),
    }

    // THE SAME CONTROL AGAIN, and it is what forced the guard's shape: an unreadable source must
    // not freeze every other detach in the project. Before the correction this was `Refused`.
    assert_eq!(
        detach_verdict(&pool, project, bystander)
            .await
            .expect("verdict"),
        DetachVerdict::Allowed,
        "an unreadable source must not block datasets it plainly does not name"
    );
}

#[tokio::test]
async fn an_alignment_whose_declaration_cannot_be_READ_refuses() {
    // The narrow genuinely-undeterminable case, and the only one that still refuses broadly: a
    // declaration this build cannot parse has sources that cannot be ENUMERATED, so the dataset
    // being detached cannot be ruled out. Skipping it instead would mean a corrupt alignment
    // silently permits the destructive action — the failure mode the whole item exists to stop.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let project = create_project(&server, &token, "undeclared alignment").await;
    let dataset = dataset_uuid(&server, &token, "some dataset").await;

    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: None,
        output_id: "corrupt_alignment".to_string(),
        datatype: FIXTURE_DATATYPE.to_string(),
        object_key: Some(format!("sha256:{}", "d".repeat(64))),
        is_multifile: false,
        content_hash: format!("sha256:{}", "d".repeat(64)),
        // CARRIES the alignment signature — a `sources[]` array and a `segments` extent — so
        // the guard selects it, and is then unreadable as an alignment in fact (no roles, no
        // members). That is the reachable shape of "cannot enumerate its sources": an artifact
        // that looks like an alignment and will not parse as one. An artifact of a wholly
        // different shape is simply not selected, which is correct — a corrupt CSV must not
        // freeze a project's detaches.
        structure: json!({
            "encoding": "zarr_v3",
            "kind": "table",
            "extents": { "segments": 2 },
        }),
        meta: json!({ "sources": [{ "dataset_id": "ds-a" }, { "dataset_id": "ds-b" }] }),
        role: "artifact".into(),
        stored_bytes: 1,
        logical_bytes: Some(1),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert corrupt alignment");

    match detach_verdict(&pool, project, dataset)
        .await
        .expect("verdict")
    {
        DetachVerdict::Refused(blockers) => {
            assert_eq!(blockers.len(), 1);
            assert_eq!(blockers[0].reason, Reason::Undeclared);
            assert_eq!(blockers[0].output_id, "corrupt_alignment");
        }
        other => panic!("an unreadable alignment must refuse, never allow: {other:?}"),
    }
}

#[tokio::test]
async fn a_project_with_no_alignment_allows_every_detach() {
    // The floor. Without it the two tests above are satisfied by a guard that refuses whenever an
    // alignment EXISTS, regardless of what it names — and every ordinary project would be frozen.
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let project = create_project(&server, &token, "no alignment").await;
    let dataset = dataset_uuid(&server, &token, "ordinary dataset").await;

    assert_eq!(
        detach_verdict(&pool, project, dataset)
            .await
            .expect("verdict"),
        DetachVerdict::Allowed,
    );
}
