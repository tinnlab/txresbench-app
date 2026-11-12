//! The freeze transition + auto-freeze-on-consume — DEC-2 **final**: async
//! job-dependency, NOT a synchronous producer-await.
//!
//! ## The mechanism (DEC-2 final)
//!
//! Freezing a draft runs the package's declared `draftable.freeze` PRODUCER through the
//! NORMAL run runtime (the producer reads `draft.data` from `/inputs/params.json`,
//! writes `/outputs` + `manifest.json`; the ingest sink mints an immutable
//! content-addressed `ready` artifact). That producer is a full run that can take up to
//! the sandbox timeout — so it is NEVER awaited synchronously while holding any scarce
//! resource (a scheduler slot / an HTTP request / a DB connection / a row lock). Both
//! round-1 designs (freeze inside the runner; freeze synchronously at job-create) only
//! RELOCATED that DoS. The final design uses the jobs system's own DEPENDENCY machinery:
//!
//! * **Explicit `POST /drafts/{id}/freeze`** enqueues a freeze producer job and returns
//!   202 immediately (the client polls the draft / freeze job for `frozen`).
//! * **`POST /jobs` referencing an `open` draft** ([`resolve_draft_inputs_for_create`]):
//!   in ONE short flow — validate EVERY input first (a partial failure enqueues
//!   NOTHING), then for each open draft find-or-reuse an in-flight freeze job (dedup
//!   under a per-draft write-lock (the `BEGIN IMMEDIATE` transaction, SQLite's
//!   substitution for `pg_advisory_xact_lock` — ITEM-23) and create the CONSUMER as `blocked` on those
//!   freeze jobs via `job_dependencies`. The consumer returns 202, pending. NO producer
//!   run is awaited; NO connection / row lock is held across a run.
//! * **Freeze-completion hook** ([`FreezeCompletion`]) — extends the jobs completion
//!   path (where `unblock_dependents` fires): when a freeze job reaches `completed`, it
//!   resolves the minted artifact, stamps the draft `frozen`, and substitutes
//!   `draft_ref`→`artifact_ref` into every dependent consumer's PERSISTED `params`
//!   BEFORE the `blocked`→`queued` flip. So the consumer dispatches pinned, and its
//!   provenance + re-run spec (both read `job.params`) see the frozen artifact, never
//!   the volatile `draft_ref` (INV-4 provenance holds). A freeze FAILURE cascade-fails
//!   the consumers (DEPENDENCY_FAILED) — the existing `cascade_fail_dependents` path.
//!
//! An `open` draft is therefore NEVER STAGED unpinned: the consumer stays `blocked`
//! until its freeze pins the artifact (INV-4). [`assert_no_unresolved_draft_refs`] is the
//! runner's defense-in-depth guard (a consumer must never reach staging with a live
//! `draft_ref`).
//!
//! Core interprets NOTHING about the producer's output shape (INV-1): the producer emits
//! the typed artifact for its `kind`; the freeze only reuses the generic
//! `ingest_run_outputs` path verbatim.

use std::collections::HashMap;

use async_trait::async_trait;
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;
use txresbench_core::AppError;

use crate::modules::jobs::models::CreateJobRequest;
use crate::modules::jobs::repository::JobRepository;
use crate::modules::jobs::seams::FreezeCompletionSink;
use crate::modules::sandbox::spec::{AnalysisSpec, InputDecl};
use crate::modules::sync::Actor;

use super::models::{Draft, DRAFT_STATUS_FROZEN};
use super::repository::DraftRepository;
use super::sync::publish_draft;

/// The plan a `POST /jobs` create resolves for its `draft_ref` inputs (DEC-2 final):
/// the (partially) substituted params + the freeze jobs the consumer must DEPEND on.
/// An already-frozen draft is pinned into `params` NOW (INV-5 idempotent, no freeze job);
/// an open draft's `draft_ref` is LEFT in `params` and a freeze job is added to
/// `freeze_job_ids` — the completion hook substitutes it before the consumer unblocks.
pub struct DraftResolution {
    pub params: serde_json::Value,
    pub freeze_job_ids: Vec<Uuid>,
}

/// Resolve a consuming analysis job's `draft_ref` inputs (ITEM-8 / INV-4 / DEC-2 final).
///
/// Validate-ALL-first, then enqueue: every referenced draft is checked (existence +
/// edit access + a declared freeze producer) BEFORE any freeze job is created, so a
/// partial failure enqueues nothing (no orphaned freeze jobs, no half-mutated create).
/// A foreign/nonexistent draft → 404 (no existence oracle, INV-3); a viewer → 403; an
/// open draft whose `kind` names no producer → 422 (`DRAFT_NOT_FREEZABLE`).
///
/// The fast path clones unchanged when no input references a draft.
pub async fn resolve_draft_inputs_for_create(
    pool: &SqlitePool,
    params: &serde_json::Value,
    owner_id: Uuid,
) -> Result<DraftResolution, AppError> {
    let spec = AnalysisSpec::parse(params)?;
    let draft_refs: Vec<Uuid> = spec.inputs.iter().filter_map(|i| i.draft_ref).collect();
    if draft_refs.is_empty() {
        return Ok(DraftResolution {
            params: params.clone(),
            freeze_job_ids: Vec::new(),
        });
    }

    // PHASE 1 — validate EVERY referenced draft (reads only; no writes, no enqueue).
    // Classify each: already-frozen (pin now, INV-5) vs open-needs-freeze (must declare
    // a producer). A failure here returns before anything is enqueued.
    enum Plan {
        AlreadyFrozen(Uuid),
        NeedsFreeze(Draft),
    }
    let mut plans: HashMap<Uuid, Plan> = HashMap::new();
    for draft_id in &draft_refs {
        if plans.contains_key(draft_id) {
            continue;
        }
        let draft = load_editable_draft(pool, *draft_id, owner_id).await?;
        match draft.frozen_artifact_id {
            Some(art) if draft.status == DRAFT_STATUS_FROZEN => {
                plans.insert(*draft_id, Plan::AlreadyFrozen(art));
            }
            _ => {
                // 422 BEFORE any enqueue — the load-bearing "unpinnable open draft is
                // refused at create, never staged" guard (INV-4).
                validate_freezable(&draft.kind)?;
                plans.insert(*draft_id, Plan::NeedsFreeze(draft));
            }
        }
    }

    // PHASE 2 — enqueue. For each open draft, find-or-reuse an in-flight freeze job
    // (dedup). Already-frozen drafts are pinned into `params` now.
    let mut freeze_job_ids: Vec<Uuid> = Vec::new();
    let mut pinned_now: HashMap<Uuid, Uuid> = HashMap::new();
    for (draft_id, plan) in &plans {
        match plan {
            Plan::AlreadyFrozen(art) => {
                pinned_now.insert(*draft_id, *art);
            }
            Plan::NeedsFreeze(draft) => {
                let job_id = find_or_create_freeze_job(pool, draft, owner_id).await?;
                if !freeze_job_ids.contains(&job_id) {
                    freeze_job_ids.push(job_id);
                }
                // The open draft's `draft_ref` STAYS in params — the freeze-completion
                // hook pins it (draft_ref→artifact_ref) before the consumer unblocks.
            }
        }
    }

    // Substitute the already-frozen drafts' `artifact_ref` NOW; leave open drafts'
    // `draft_ref` for the completion hook.
    let out = substitute_draft_refs(params, &pinned_now);
    Ok(DraftResolution {
        params: out,
        freeze_job_ids,
    })
}

/// Enqueue (or reuse) the freeze producer job for an already-authorized draft, returning
/// its job id — the explicit `POST /drafts/{id}/freeze` path. The handler has already
/// resolved edit access + handled the idempotent already-frozen case; this just
/// find-or-creates the producer job (422 when the draft's `kind` names no producer).
pub async fn enqueue_freeze_for_draft(
    pool: &SqlitePool,
    draft: &Draft,
    actor_id: Uuid,
) -> Result<Uuid, AppError> {
    find_or_create_freeze_job(pool, draft, actor_id).await
}

/// A defense-in-depth guard for the RUNNER (DEC-2): a spec that still carries a
/// `draft_ref` at staging was NOT pinned by the freeze-completion hook — an internal
/// invariant break. Refuse to stage it (an unpinned `open` draft must NEVER be consumed).
pub fn assert_no_unresolved_draft_refs(spec: &AnalysisSpec) -> Result<(), String> {
    if let Some(input) = spec
        .inputs
        .iter()
        .find(|i: &&InputDecl| i.draft_ref.is_some())
    {
        return Err(format!(
            "internal error: input slot {:?} still carries an unresolved draft_ref at staging — \
             draftable inputs must be frozen + pinned before the consumer is unblocked \
             (draftable-entity INV-4)",
            input.slot
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- internals

/// Load a draft the consuming/freezing actor may EDIT (freeze mutates its project). A
/// nonexistent/foreign draft → 404 (INV-3), a viewer → 403.
async fn load_editable_draft(
    pool: &SqlitePool,
    draft_id: Uuid,
    owner_id: Uuid,
) -> Result<Draft, AppError> {
    use crate::modules::project::scope::ProjectScope;
    use crate::modules::project::ProjectRepository;

    let draft = DraftRepository::new(pool.clone())
        .get(draft_id)
        .await?
        .ok_or_else(|| AppError::not_found("Draft"))?;
    let scope = ProjectScope::resolve(
        &ProjectRepository::new(pool.clone()),
        draft.project_id,
        owner_id,
    )
    .await?
    .ok_or_else(|| AppError::not_found("Draft"))?;
    scope.require_can_edit()?;
    Ok(draft)
}

/// 422 unless the opaque `kind` names a resolvable freeze producer (INV-1: we MATCH the
/// kind, never interpret it). Cheap registry lookups — the validate-all-first check.
fn validate_freezable(kind: &str) -> Result<(), AppError> {
    let (spec, _pkg) =
        crate::modules::extensions::find_draftable_by_kind(kind).ok_or_else(|| {
            AppError::unprocessable_entity(
                "DRAFT_NOT_FREEZABLE",
                format!("no package declares a draftable freeze producer for kind {kind:?}"),
            )
        })?;
    crate::modules::extensions::resolve_analysis_run(&spec.freeze).ok_or_else(|| {
        AppError::unprocessable_entity(
            "DRAFT_FREEZE_PRODUCER_MISSING",
            format!(
                "the freeze producer {:?} for kind {kind:?} is not a runnable analysis (no `run` block)",
                spec.freeze
            ),
        )
    })?;
    Ok(())
}

/// Build the freeze producer's analysis `params` for `draft` (its `params` bag IS the
/// opaque `draft.data`, which the producer reads from `/inputs/params.json`). 422 when
/// the draft's `kind` names no producer. Validated through the runner codec so a bad
/// spec fails HERE, at enqueue.
fn build_freeze_producer_params(draft: &Draft) -> Result<serde_json::Value, AppError> {
    let (spec, _pkg) =
        crate::modules::extensions::find_draftable_by_kind(&draft.kind).ok_or_else(|| {
            AppError::unprocessable_entity(
                "DRAFT_NOT_FREEZABLE",
                format!(
                    "no package declares a draftable freeze producer for kind {:?}",
                    draft.kind
                ),
            )
        })?;
    let entry = crate::modules::extensions::resolve_analysis_run(&spec.freeze).ok_or_else(|| {
        AppError::unprocessable_entity(
            "DRAFT_FREEZE_PRODUCER_MISSING",
            format!(
                "the freeze producer {:?} for kind {:?} is not a runnable analysis (no `run` block)",
                spec.freeze, draft.kind
            ),
        )
    })?;
    let params = serde_json::json!({
        "language": entry.runtime,
        "code_ref": entry.entry,
        "package": entry.package_id,
        "analysis_id": entry.analysis_id,
        // #189: the producer analysis' DECLARED env, read out of the registry entry we
        // just resolved — server-derived, never from the draft body.
        "env": entry.env,
        // The producer receives the whole opaque draft body as its params bag.
        "params": draft.data,
    });
    AnalysisSpec::parse(&params)?;
    Ok(params)
}

/// Find an in-flight freeze producer job for `draft`'s CURRENT content (content-aware
/// dedup) or create one, returning its id. Serialized per-draft by the transaction's
/// WRITE LOCK (`BEGIN IMMEDIATE` — the SQLite substitution for the dropped
/// `pg_advisory_xact_lock`, ITEM-19's doctrine: SQLite has no advisory locks, the
/// single-writer transaction IS the lock) held ONLY across the find-or-create decision
/// (never across the producer RUN — DEC-2), so two concurrent consumers of the same
/// open draft at the same content share ONE freeze job.
///
/// The job row AND its `draft_freeze_jobs` mapping are inserted in the SAME transaction
/// (`lock_tx`): a mapping-insert failure rolls the producer job back with it, so a freeze
/// producer can never run orphaned (unmapped → its completion hook would never resolve its
/// draft). This also removes the earlier nested second-pool-connection acquire.
async fn find_or_create_freeze_job(
    pool: &SqlitePool,
    draft: &Draft,
    actor_id: Uuid,
) -> Result<Uuid, AppError> {
    // Build the producer params BEFORE taking the lock — a missing producer 422s here
    // without ever holding the write lock.
    let params = build_freeze_producer_params(draft)?;
    // The content-aware dedup key: a stable hash of the draft's CURRENT `data`. Only an
    // in-flight freeze that captured THESE bytes may be reused.
    let content_hash = draft_content_hash(&draft.data);

    // `BEGIN IMMEDIATE` acquires the SQLite reserved lock at the transaction's open, so
    // exactly one find-or-create runs at a time: a concurrent consumer's transaction
    // waits at its open (pool `busy_timeout`) and then sees the committed mapping —
    // the ITEM-18/19 write-serialization substitution for the advisory lock.
    let mut lock_tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(AppError::database_error)?;
    if let Some(existing) =
        DraftRepository::find_inflight_freeze_job(&mut lock_tx, draft.id, &content_hash).await?
    {
        lock_tx.commit().await.map_err(AppError::database_error)?;
        return Ok(existing);
    }

    // None in-flight at this content → create the freeze producer job AND its mapping in
    // THIS one transaction (atomic), so the mapping is visible the instant the write
    // lock releases to a racing consumer and no orphan producer can exist.
    let create = CreateJobRequest {
        job_type: "analysis".to_string(),
        name: Some(format!("Freeze draft {}", draft.id)),
        params: Some(params),
        priority_class: Some("interactive".to_string()),
        resource_class: None,
        project_id: Some(draft.project_id),
        dataset_id: None,
    };
    // The freeze producer has NO dependencies (it is the producer), so it is born `queued`
    // and never triggers the completed-dep substitution seam — no re-entrancy.
    let (job, _born_error) = JobRepository::new(pool.clone())
        .create_with_deps_in_conn(&mut lock_tx, actor_id, &create, &[])
        .await?;
    DraftRepository::insert_freeze_mapping(&mut lock_tx, job.id, draft.id, &content_hash).await?;
    lock_tx.commit().await.map_err(AppError::database_error)?;

    // Let the owner's other devices see the freeze job (owner-scoped).
    crate::modules::jobs::seams::sync_sink().publish_job_changed(
        actor_id,
        crate::modules::jobs::seams::JobChange::Created,
        job.id,
    );
    Ok(job.id)
}

/// A stable content hash of a draft's opaque `data` — the CONTENT-AWARE freeze-dedup key
/// (DEC-2 round-3). Object key order is canonicalized first, so the hash is invariant to
/// jsonb round-trips + serialization order (robust even if `serde_json`'s `preserve_order`
/// is ever enabled by dependency unification), then sha256.
fn draft_content_hash(data: &serde_json::Value) -> String {
    let canon = canonicalize_json(data);
    // Serializing a `serde_json::Value` is infallible in practice; an empty buffer on the
    // impossible error only makes two distinct bodies collide, never a correctness break
    // (a collision would merely reuse a freeze — the same as today's coarser dedup).
    let bytes = serde_json::to_vec(&canon).unwrap_or_default();
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(&bytes);
    format!("sha256:{:x}", h.finalize())
}

/// Recursively rebuild a JSON value with object keys in sorted order (arrays keep their
/// order — it is significant). Building the canonical value with keys INSERTED sorted makes
/// the subsequent `to_vec` deterministic under both the default `BTreeMap`-backed map and a
/// `preserve_order` `IndexMap`.
fn canonicalize_json(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonicalize_json(&map[k]));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(canonicalize_json).collect())
        }
        other => other.clone(),
    }
}

/// Substitute `draft_ref`→`artifact_ref` for every input whose draft id is a key in
/// `subs`; leave every other input byte-identical (an open draft's `draft_ref` not yet
/// frozen, a non-draft input). Pure + unit-testable — the ONE transform both the
/// create-path (already-frozen drafts) and the completion hook (a just-frozen draft) use.
fn substitute_draft_refs(
    params: &serde_json::Value,
    subs: &HashMap<Uuid, Uuid>,
) -> serde_json::Value {
    let mut out = params.clone();
    let Some(inputs) = out.get_mut("inputs").and_then(|v| v.as_array_mut()) else {
        return out;
    };
    for input in inputs.iter_mut() {
        let Some(obj) = input.as_object_mut() else {
            continue;
        };
        let Some(v) = obj.get("draft_ref") else {
            continue;
        };
        if v.is_null() {
            continue;
        }
        let Ok(draft_id) = serde_json::from_value::<Uuid>(v.clone()) else {
            continue;
        };
        if let Some(artifact_id) = subs.get(&draft_id) {
            obj.remove("draft_ref");
            obj.insert("artifact_ref".to_string(), serde_json::json!(artifact_id));
        }
    }
    out
}

// ---------------------------------------------------- freeze-completion hook

/// The installed [`FreezeCompletionSink`] (pool baked in). Registered from
/// `DraftsModule::init`; read by the jobs completion path.
pub struct FreezeCompletion {
    pool: SqlitePool,
}

impl FreezeCompletion {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The in-transaction hook body: no-op unless `completed_job_id` is a freeze
    /// producer. Resolves the minted artifact, pins it into every dependent consumer's
    /// params, and stamps the draft `frozen` (unless edited since the freeze was
    /// requested). Returns the frozen draft id(s) for the post-commit emit.
    async fn run_hook(
        &self,
        conn: &mut SqliteConnection,
        completed_job_id: Uuid,
    ) -> Result<Vec<Uuid>, AppError> {
        // IDENTIFY with a PK-only lookup on `draft_freeze_jobs` — touching NO other table.
        // Every ordinary (non-freeze) job completion returns None here and does ZERO
        // fallible work against the `drafts`/`artifacts` tables, so a drafts-table problem
        // can never abort an UNRELATED job's completion transaction. Only a confirmed
        // freeze proceeds to read `drafts`/`artifacts` (below).
        let Some(draft_id) = DraftRepository::freeze_target_draft(conn, completed_job_id).await?
        else {
            return Ok(Vec::new()); // not a freeze job — the no-op fast path
        };

        // Confirmed freeze — resolve its minted artifact (reads drafts + jobs + artifacts,
        // all on the completion `conn`, never a second pool connection).
        let Some(artifact_id) =
            Self::resolve_freeze_artifact(conn, completed_job_id, draft_id).await?
        else {
            tracing::warn!(
                %completed_job_id, %draft_id,
                "a freeze producer completed but minted no artifact; the draft is left \
                 unfrozen and its consumers will fail cleanly at staging"
            );
            return Ok(Vec::new());
        };

        // Pin artifact_ref into every blocked dependent's PERSISTED params BEFORE the
        // unblock flips them queued (so no unresolved draft_ref reaches staging). The
        // dependents are LOCKED `FOR UPDATE` by `list_blocked_dependents_with_params`, so
        // a CONCURRENT freeze completion for another of the same consumer's open-draft
        // inputs serializes on the consumer row and substitutes on top of this pin —
        // both pins land (the multi-dependency lost-update fix).
        let subs = HashMap::from([(draft_id, artifact_id)]);
        let dependents =
            JobRepository::list_blocked_dependents_with_params(conn, completed_job_id).await?;
        for (job_id, params) in dependents {
            let pinned = substitute_draft_refs(&params, &subs);
            if pinned != params {
                JobRepository::update_job_params_in_conn(conn, job_id, &pinned).await?;
            }
        }

        // Read the draft's PRIOR frozen artifact BEFORE the stamp overwrites it — that is this
        // new version's `parent_artifact_id` in the lineage chain (INV-7 / DEC-11). `None` for a
        // first freeze (version 1).
        let parent_artifact_id =
            DraftRepository::draft_frozen_artifact_in_conn(conn, draft_id).await?;

        // Stamp the draft frozen unless it was edited since the freeze was requested
        // (DEC-3/INV-2 edit-race guard). The consumer already pinned the snapshot it
        // asked for above, regardless of this.
        let stamped = DraftRepository::set_frozen_if_unmodified_in_conn(
            conn,
            draft_id,
            completed_job_id,
            artifact_id,
        )
        .await?;

        // Record the fork-edge for the frozen version ONLY when the draft actually advanced to
        // this artifact (INV-7). A draft edited mid-freeze is NOT stamped and keeps its prior
        // frozen pointer, so this artifact is not a version in its chain — recording it would
        // mint a second child of the same parent and break the linear version count. On the
        // stamped path the lineage row commits atomically with the `frozen` stamp on this conn.
        if stamped {
            DraftRepository::record_lineage_in_conn(
                conn,
                artifact_id,
                draft_id,
                parent_artifact_id,
            )
            .await?;
        }
        Ok(if stamped { vec![draft_id] } else { Vec::new() })
    }

    /// Resolve the immutable artifact a completed freeze producer minted for `draft_id`.
    /// Called ONLY after [`DraftRepository::freeze_target_draft`] confirmed a freeze job,
    /// so the `drafts`/`artifacts` reads never run for an unrelated completion. `None`
    /// when the draft vanished, the run id is unresolvable, or the producer minted no
    /// artifact.
    async fn resolve_freeze_artifact(
        conn: &mut SqliteConnection,
        freeze_job_id: Uuid,
        draft_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        let Some(project_id) = DraftRepository::draft_project_in_conn(conn, draft_id).await? else {
            return Ok(None);
        };
        let Some(run_id) = JobRepository::effective_run_id_in_conn(conn, freeze_job_id).await?
        else {
            return Ok(None);
        };
        DraftRepository::pick_run_artifact_in_conn(conn, project_id, run_id).await
    }

    /// The create-after-complete race body (draftable-entity DEC-2 round-3): for each dep
    /// that was ALREADY `completed` when the consumer was born, resolve that freeze's
    /// minted artifact (skipping any dep that is not a freeze producer) and substitute
    /// `draft_ref`→`artifact_ref` into the consumer's `params`. Runs inside the create
    /// transaction, so the consumer is BORN pinned. Reuses the SAME PK-only identification
    /// as the completion hook, so a non-freeze dep touches only `draft_freeze_jobs`.
    async fn substitute_completed(
        &self,
        conn: &mut SqliteConnection,
        params: &serde_json::Value,
        completed_dep_ids: &[Uuid],
    ) -> Result<serde_json::Value, AppError> {
        let mut subs: HashMap<Uuid, Uuid> = HashMap::new();
        for &dep in completed_dep_ids {
            let Some(draft_id) = DraftRepository::freeze_target_draft(conn, dep).await? else {
                continue; // not a freeze dep — leave it alone
            };
            if let Some(artifact_id) = Self::resolve_freeze_artifact(conn, dep, draft_id).await? {
                subs.insert(draft_id, artifact_id);
            }
        }
        if subs.is_empty() {
            return Ok(params.clone());
        }
        Ok(substitute_draft_refs(params, &subs))
    }
}

#[async_trait]
impl FreezeCompletionSink for FreezeCompletion {
    async fn on_freeze_completed_in_tx(
        &self,
        conn: &mut SqliteConnection,
        completed_job_id: Uuid,
    ) -> Result<Vec<Uuid>, String> {
        self.run_hook(conn, completed_job_id)
            .await
            .map_err(|e| e.to_string())
    }

    async fn substitute_completed_freeze_deps_in_tx(
        &self,
        conn: &mut SqliteConnection,
        params: &serde_json::Value,
        completed_dep_ids: &[Uuid],
    ) -> Result<serde_json::Value, String> {
        self.substitute_completed(conn, params, completed_dep_ids)
            .await
            .map_err(|e| e.to_string())
    }

    async fn emit_frozen(&self, draft_ids: &[Uuid]) {
        for &draft_id in draft_ids {
            // Resolve the draft's project for the audience, then emit a DETACHED
            // `Draft/Update` (nobody clicked freeze on completion — INV-6, origin None).
            match DraftRepository::new(self.pool.clone()).get(draft_id).await {
                Ok(Some(draft)) => {
                    publish_draft(
                        &self.pool,
                        draft.project_id,
                        crate::modules::sync::SyncAction::Update,
                        draft_id,
                        Actor::detached(),
                    )
                    .await;
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(%draft_id, error = ?e, "freeze-completion sync: draft lookup failed")
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_with(inputs: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "language": "python",
            "script": "print('x')",
            "inputs": inputs,
        })
    }

    #[test]
    fn substitute_pins_only_mapped_drafts() {
        let d1 = Uuid::new_v4();
        let d2 = Uuid::new_v4();
        let art1 = Uuid::new_v4();
        let params = spec_with(serde_json::json!([
            { "slot": "a", "draft_ref": d1 },
            { "slot": "b", "draft_ref": d2 },
            { "slot": "c", "artifact_ref": Uuid::new_v4() },
        ]));
        let subs = HashMap::from([(d1, art1)]);
        let out = substitute_draft_refs(&params, &subs);
        let inputs = out["inputs"].as_array().unwrap();
        // d1 was pinned → draft_ref gone, artifact_ref set.
        assert!(inputs[0].get("draft_ref").is_none());
        assert_eq!(inputs[0]["artifact_ref"], serde_json::json!(art1));
        // d2 unmapped → its draft_ref is preserved (the completion hook pins it later).
        assert_eq!(inputs[1]["draft_ref"], serde_json::json!(d2));
        // a non-draft input is untouched.
        assert!(inputs[2].get("artifact_ref").is_some());
    }

    #[test]
    fn substitute_no_inputs_is_clone() {
        let params = serde_json::json!({ "language": "python", "script": "x" });
        let out = substitute_draft_refs(&params, &HashMap::new());
        assert_eq!(out, params);
    }

    #[test]
    fn content_hash_is_stable_order_invariant_and_content_sensitive() {
        let a = serde_json::json!({ "n": 1, "items": ["A", "B"], "meta": { "x": 1, "y": 2 } });
        // Same logical content, keys written in a DIFFERENT order (+ nested).
        let a_reordered =
            serde_json::json!({ "meta": { "y": 2, "x": 1 }, "items": ["A", "B"], "n": 1 });
        // A genuinely different body (the "edited mid-freeze S1→S2" case).
        let b = serde_json::json!({ "n": 2, "items": ["A", "B"], "meta": { "x": 1, "y": 2 } });

        assert_eq!(
            draft_content_hash(&a),
            draft_content_hash(&a_reordered),
            "key order must not change the hash (jsonb round-trip invariance)"
        );
        assert_ne!(
            draft_content_hash(&a),
            draft_content_hash(&b),
            "different content must hash differently (a stale freeze must not be reused)"
        );
        // Array element ORDER is significant (an ordered list) — it DOES change.
        let a_arr_swapped =
            serde_json::json!({ "n": 1, "items": ["B", "A"], "meta": { "x": 1, "y": 2 } });
        assert_ne!(
            draft_content_hash(&a),
            draft_content_hash(&a_arr_swapped),
            "array order is content — a reordered array is different content"
        );
        assert!(
            draft_content_hash(&a).starts_with("sha256:"),
            "the hash is the sha256:<hex> form"
        );
    }
}
