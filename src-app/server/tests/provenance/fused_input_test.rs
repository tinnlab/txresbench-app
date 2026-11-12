//! TEST-43 [ITEM-35] — a run whose input was a FUSED pick records EVERY artifact the
//! pick spanned as its own `used` edge.
//!
//! ── WHY THIS TEST EXISTS, AND WHY NO EXISTING ONE COVERS IT ──────────────────────────
//!
//! A fused offer is ONE row in the picker standing for SEVERAL artifacts (ITEM-32): two
//! datasets carrying a same-named column whose vocabularies reconcile are shown once, and
//! the offer carries all of its members with a deterministic PRIMARY at the head. The
//! stored pick is that primary's plain id — INV-4 forbids inventing a delimited composed
//! one — so the full set has to travel to the run as several bindings on ONE slot.
//!
//! The failure this guards is silent by construction. Recording ONLY the primary passes
//! every existing provenance test: that id resolves fine, no error is raised, the run node
//! is written, `readiness.inputs_checksummed` stays true — and the recorded lineage claims
//! a colouring drawn from two artifacts was drawn from one. Nothing downstream can tell.
//! So the assertion here is over the FULL SET and its ORDER, never over a count alone or
//! over "the run recorded something".
//!
//! ── THE SHAPE IS A CROSS-DATASET ONE, BECAUSE FUSION'S PRECONDITION IS ───────────────
//!
//! `fuseSameName` fires only when a group spans MORE THAN ONE dataset, so a fused pair is
//! never two artifacts of one dataset. That makes this the run whose inputs straddle two
//! separately-permissioned datasets attached to one project — the recorder's WIDENED
//! tenancy arm (`inputs::artifact_in_project_scope` + the per-user `require_dataset_read`
//! gate), taken twice in one spec. A single-dataset run never reaches that arm twice, so
//! this is a genuinely new path rather than a second spelling of `recorder_test`'s.
//!
//! ── CONTROLS (run, RED observed, tree restored — see DRIFT-1) ────────────────────────
//!
//!  · NC — the spec declares ONLY the primary (the enumerated control: "recording only the
//!    primary"). The full-set assertion goes red naming the missing member.
//!  · NC — `resolve_used_edges` deduplicated by `slot` (keep-first). Same red, from the
//!    other side: the producer declared both and the consumer collapsed them.

use super::*;

use txresbench::modules::jobs::models::Job;
use txresbench::modules::jobs::seams::PeakMetrics;
use txresbench::modules::jobs::seams::RunRecorder;
use txresbench::modules::provenance::recorder::ProvenanceRunRecorder;
use txresbench::modules::provenance::repository::ProvenanceRepository;

/// The slot a fused pick binds. ONE slot, several bindings — the shape
/// `hostCtx::resolveInputs` produces from an array-valued declared input and
/// `jobsCapability` maps to one `{slot, artifact_ref}` entry per member.
const FUSED_SLOT: &str = "colour_source";

/// An analysis `Job` binding `members` to {@link FUSED_SLOT}, IN THE GIVEN ORDER — one
/// `artifact_ref` input each. Order is part of the fixture, not an accident of it: the
/// fused offer's primary is deterministic (lowest artifact id) and leads the set, so a
/// recorder that reordered or collapsed the bindings is a real defect and the assertions
/// below must be able to see it.
fn fused_job(owner: Uuid, members: &[Uuid]) -> Job {
    let inputs: Vec<serde_json::Value> = members
        .iter()
        .map(|id| json!({ "slot": FUSED_SLOT, "artifact_ref": id }))
        .collect();
    Job {
        id: Uuid::new_v4(),
        owner_id: owner,
        job_type: "analysis".into(),
        name: "fused-input-test".into(),
        status: "completed".into(),
        params: json!({
            "language": "python",
            "script": "print('ok')\n",
            "inputs": inputs,
            "seed": 3
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
    }
}

/// Seed the synthetic job's `jobs` row + its project `job_scope` row, so the recorder
/// resolves the run's scope from the table (ITEM-68).
async fn seed_job_scope(pool: &SqlitePool, job: &Job, project: Uuid) {
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status) VALUES ($1, $2, $3, $4, $5)",
    )
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
        .bind(project)
        .execute(pool)
        .await
        .expect("seed job_scope row");
}

/// One dataset owned by the first-run admin, ATTACHED to `project`, carrying one
/// dataset-scoped artifact at `content_hash`. Returns the artifact id.
///
/// Dataset-scoped (`project_id` NULL) on purpose: that is what an uploaded dataset's
/// artifacts are, and it is the arm the widened tenancy check exists for. A
/// project-scoped pair would resolve through the direct match and never exercise it.
async fn attached_dataset_artifact(
    pool: &SqlitePool,
    project: Uuid,
    name: &str,
    content_hash: &str,
) -> Uuid {
    let dataset_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id) \
         VALUES ($1, $2, (SELECT id FROM users WHERE username = 'admin'), \
                 (SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = \
                  (SELECT id FROM users WHERE username = 'admin')))",
    )
    .bind(dataset_id)
    .bind(name)
    .execute(pool)
    .await
    .expect("seed dataset");
    let artifact_id = seed_dataset_scoped_artifact(pool, dataset_id, content_hash).await;
    sqlx::query("INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)")
        .bind(project)
        .bind(dataset_id)
        .execute(pool)
        .await
        .expect("attach dataset to project");
    artifact_id
}

/// The `(ref_id, content_hash)` pairs of the edges recorded for {@link FUSED_SLOT}, in the
/// order the recorder wrote them.
///
/// Reads by NAME out of the recorded JSON rather than by position in the edge array, and
/// narrows to the slot under test, so an unrelated future edge cannot shift what this
/// reads and a renamed field fails loudly instead of comparing `Null` to `Null`.
fn fused_edges(inputs_json: &Value) -> Vec<(String, String)> {
    inputs_json
        .as_array()
        .expect("inputs_json is an array")
        .iter()
        .filter(|e| e["slot"] == json!(FUSED_SLOT))
        .map(|e| {
            (
                e["ref_id"].as_str().unwrap_or_default().to_string(),
                e["content_hash"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect()
}

/// TEST-43 — BOTH members of a fused pick are recorded, each pinned by its own content
/// hash, in the order the pick declared them.
#[tokio::test]
async fn a_fused_pick_records_every_member_as_its_own_used_edge() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "fused input project").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    // TWO datasets, because fusion's own precondition is that the group spans more than
    // one. Distinct content hashes, so an edge that pinned the WRONG member is visible —
    // two members sharing a hash would let a duplicated primary read as a correct pair.
    let primary_hash = format!("sha256:{}", "1".repeat(64));
    let secondary_hash = format!("sha256:{}", "2".repeat(64));
    let primary = attached_dataset_artifact(&pool, project_id, "fused-ds-a", &primary_hash).await;
    let secondary =
        attached_dataset_artifact(&pool, project_id, "fused-ds-b", &secondary_hash).await;

    // VACUITY FLOOR. Every assertion below is over a derived set; a fixture that collapsed
    // to one artifact would let a primary-only recorder read green.
    assert_ne!(
        primary, secondary,
        "the fused pair must be two distinct artifacts"
    );
    assert_ne!(
        primary_hash, secondary_hash,
        "…pinned by two distinct hashes"
    );

    let job = fused_job(owner, &[primary, secondary]);
    let job_id = job.id;
    seed_job_scope(&pool, &job, project_id).await;
    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;

    let row = ProvenanceRepository::new(pool.clone())
        .get_run(job_id)
        .await
        .expect("query sidecar")
        .expect("the fused run was recorded");

    // MEMBERSHIP **and** SEQUENCE, never a count. A recorder that dropped the second
    // member, that recorded the primary twice, or that reordered the pair all keep the
    // count a naive assertion would check.
    assert_eq!(
        fused_edges(&row.inputs_json),
        vec![
            (primary.to_string(), primary_hash.clone()),
            (secondary.to_string(), secondary_hash.clone()),
        ],
        "every member of the fused pick is recorded, pinned by its own content hash, in \
         the order the pick declared them: {}",
        row.inputs_json
    );

    // …and each one RESOLVED. An unresolved edge carries `ref_id: null` + an empty hash
    // and would already have failed the comparison above — this states the property the
    // comparison implies, so a future relaxation of it cannot pass silently.
    for edge in row.inputs_json.as_array().expect("inputs_json array") {
        assert_eq!(
            edge["kind"],
            json!("upload"),
            "a fused member resolves to a known root artifact rather than a from-nowhere \
             hole: {edge}"
        );
    }
}

/// The other half of the same rule, from the CONSUMER's side: two bindings on one slot are
/// two edges, and the SECOND member is not the one that survives either.
///
/// This is the enumerated control turned into a live assertion. A recorder that collapsed
/// a repeated slot — by key, by de-duplication, by last-write-wins — would record exactly
/// one edge and every existing provenance test would still pass, because the one edge it
/// kept resolves. Asserting the pair from the primary-only direction AND from the
/// secondary-only direction is what makes "both" mean both.
#[tokio::test]
async fn a_repeated_slot_is_not_collapsed_to_either_end_of_the_pair() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "fused input collapse").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;

    let first_hash = format!("sha256:{}", "3".repeat(64));
    let second_hash = format!("sha256:{}", "4".repeat(64));
    let first = attached_dataset_artifact(&pool, project_id, "collapse-ds-a", &first_hash).await;
    let second = attached_dataset_artifact(&pool, project_id, "collapse-ds-b", &second_hash).await;

    let job = fused_job(owner, &[first, second]);
    let job_id = job.id;
    seed_job_scope(&pool, &job, project_id).await;
    ProvenanceRunRecorder::new(pool.clone())
        .record_run(&job, &[], 0, PeakMetrics::default(), &std::env::temp_dir())
        .await;

    let repo = ProvenanceRepository::new(pool.clone());
    let row = repo
        .get_run(job_id)
        .await
        .expect("query")
        .expect("run recorded");
    let edges = fused_edges(&row.inputs_json);

    assert!(
        edges.iter().any(|(id, _)| id == &first.to_string()),
        "the FIRST binding survives a repeated slot: {}",
        row.inputs_json
    );
    assert!(
        edges.iter().any(|(id, _)| id == &second.to_string()),
        "…and so does the SECOND — a keep-first collapse loses exactly this one: {}",
        row.inputs_json
    );
    assert_eq!(
        edges.len(),
        2,
        "…and neither is duplicated: {}",
        row.inputs_json
    );

    // The stashed re-run spec carries both too. A run whose RECORD names two inputs but
    // whose replay names one is a lineage that cannot be reproduced from its own node,
    // which is the same hole one layer further out.
    let spec = repo
        .get_rerun_spec(job_id)
        .await
        .expect("rerun spec")
        .expect("a rerun spec was stashed");
    let replayed: Vec<String> = spec["inputs"]
        .as_array()
        .expect("rerun spec inputs array")
        .iter()
        .filter(|i| i["slot"] == json!(FUSED_SLOT))
        .map(|i| i["artifact_ref"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        replayed,
        vec![first.to_string(), second.to_string()],
        "the re-run spec replays every member of the fused pick, in order: {spec}"
    );
}
