//! Closure resolver (ITEM-9). An input must resolve to a known
//! `{upload/source artifact · prior-analysis-output artifact · pinned reference
//! resource}`, or the capture is rejected — guaranteeing every backward walk
//! terminates at roots (no "from-nowhere" hole).

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::repository::ProvenanceRepository;

/// A resolved input — a known artifact or a pinned reference resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedInput {
    Artifact { id: Uuid, content_hash: String },
    Reference { id: Uuid, content_hash: String },
}

impl ResolvedInput {
    pub fn content_hash(&self) -> &str {
        match self {
            ResolvedInput::Artifact { content_hash, .. } => content_hash,
            ResolvedInput::Reference { content_hash, .. } => content_hash,
        }
    }

    /// The used-edge `kind` label for this input.
    pub fn kind(&self) -> &'static str {
        match self {
            ResolvedInput::Artifact { .. } => "artifact",
            ResolvedInput::Reference { .. } => "reference",
        }
    }

    pub fn id(&self) -> Uuid {
        match self {
            ResolvedInput::Artifact { id, .. } => *id,
            ResolvedInput::Reference { id, .. } => *id,
        }
    }
}

/// Pure classifier: an artifact lookup wins, else a reference lookup, else the
/// input is unknown (the rejected "from-nowhere" case).
pub fn classify(
    artifact: Option<(Uuid, String)>,
    reference: Option<(Uuid, String)>,
) -> Option<ResolvedInput> {
    if let Some((id, content_hash)) = artifact {
        return Some(ResolvedInput::Artifact { id, content_hash });
    }
    if let Some((id, content_hash)) = reference {
        return Some(ResolvedInput::Reference { id, content_hash });
    }
    None
}

/// True when an artifact is IN the project's tenancy: either scoped to the project
/// itself, or scoped to a DATASET that is attached to the project (`project_datasets`).
///
/// The dataset arm is not a widening of trust — it is the ordinary flow. A user
/// uploads a dataset (its artifacts carry `dataset_id`, `project_id = NULL`), attaches
/// it to a project, and the workbench runs analyses over it. Requiring
/// `project_id == Some(project)` therefore rejected the input of EVERY run over an
/// attached dataset, which is the commonest save: the selection capture 400'd
/// (`PROVENANCE_UNKNOWN_INPUT`) and the compute run's `used` edge was dropped, so a
/// committed filter recorded no replayable recipe at all. Callers have already passed
/// the project-edit gate, and the workbench is already allowed to READ that dataset's
/// data — an attached dataset's artifact is exactly as in-scope as a project one.
pub fn artifact_in_project_scope(
    artifact_project_id: Option<Uuid>,
    artifact_dataset_id: Option<Uuid>,
    project_id: Uuid,
    project_dataset_ids: &[Uuid],
) -> bool {
    // PROJECT COLUMN WINS, exactly as `workstore::authz::artifact_scope` decides it
    // ("if both were somehow set, project wins — never a dataset leak for a
    // project-scoped row"). A dual-scoped artifact stamped with ANOTHER project's id
    // is that project's row; the dataset attachment must not re-home it here, or two
    // modules would hold contradictory definitions of "in tenancy scope" for the same
    // row and the looser one would be the provenance chokepoint.
    if let Some(owner) = artifact_project_id {
        return owner == project_id;
    }
    match artifact_dataset_id {
        Some(ds) => project_dataset_ids.contains(&ds),
        None => false,
    }
}

/// Resolve `input_id` against the project's catalog + reference resources. Rejects
/// an unknown/ambient input with 400 `PROVENANCE_UNKNOWN_INPUT`.
///
/// **ROUND-4 (R3-14) — `caller_id` is an AUTHORIZATION input, not telemetry.**
/// The dataset arm below admits an artifact on the project ATTACHMENT alone. A
/// dataset is a separately-permissioned resource, so the attachment says the
/// PROJECT may use it — not that every project collaborator may. `graph::
/// load_project_walk_context` and `read_forward_graph` both re-check
/// `is_visible_to` per dataset for exactly this reason ("do NOT authorize once");
/// this chokepoint did not, so a project Editor could pin an artifact of an
/// owner's private dataset and read its id + pinned `content_hash` straight back
/// out of his own run node (CODING_GUIDELINES §1). The visibility check is now
/// part of resolution, and a caller who cannot read the dataset gets the same
/// `PROVENANCE_UNKNOWN_INPUT` an unknown id gets — no existence oracle.
pub async fn resolve_input(
    pool: &PgPool,
    project_id: Uuid,
    caller_id: Uuid,
    input_id: Uuid,
) -> Result<ResolvedInput, AppError> {
    let catalog = CatalogRepository::new(pool.clone());
    let repo = ProvenanceRepository::new(pool.clone());
    let candidate = catalog.get_any_status(input_id).await?;
    // Only pay for the attachment lookup when the cheap project-scope check misses.
    // A DB error propagates (`?`) rather than degrading to "not in scope": rejecting a
    // legitimate input because a query blipped would look exactly like a tenancy
    // violation to the caller.
    let in_scope_artifact = match candidate {
        Some(a) if a.project_id == Some(project_id) => Some(a),
        Some(a) if a.project_id.is_none() && a.dataset_id.is_some() => {
            let attached = repo.dataset_ids_for_project(project_id).await?;
            let in_scope =
                artifact_in_project_scope(a.project_id, a.dataset_id, project_id, &attached);
            // The ACTING USER must be able to read that dataset too (R3-14). The
            // check is the workstore's own dataset gate, which resolves the caller's
            // group memberships inline — so no group ids need threading through the
            // handler, and the two modules cannot drift apart on what "may read this
            // dataset" means. A DB error propagates; only a definite "not visible"
            // drops the candidate.
            let visible = match (in_scope, a.dataset_id) {
                (true, Some(ds)) => {
                    match crate::modules::workstore::authz::require_dataset_read(
                        pool, ds, caller_id,
                    )
                    .await
                    {
                        Ok(()) => true,
                        // `require_dataset_read` answers a not-visible dataset with
                        // 404 (its own no-oracle contract); anything else is a real
                        // fault and must propagate, never degrade to "not in scope".
                        Err((_, err)) if err.status_code() == 404 => {
                            tracing::warn!(
                                %project_id, %caller_id, dataset_id = %ds, artifact_id = %a.id,
                                "provenance: refused a selection input from a dataset the acting \
                                 user cannot read (the project attachment is not a per-user grant)"
                            );
                            false
                        }
                        Err((_, err)) => return Err(err),
                    }
                }
                _ => false,
            };
            visible.then_some(a)
        }
        _ => None,
    };

    // ITEM-18 / DEC-12 — the READ half of the conformance gate. This is the PRE-FLIGHT
    // input resolver: what it returns is pinned into the run's `used` edge as
    // `(ref_id, content_hash)`, i.e. the provenance claim that this run consumed these
    // bytes legitimately. An artifact the gate condemned must not become that claim, and
    // it must not become it QUIETLY — so the refusal is the explicit 409, not a fall-through
    // to `PROVENANCE_UNKNOWN_INPUT`, which would tell the user their input does not exist
    // when it does and is merely broken.
    //
    // Applied AFTER the scope/visibility resolution above: the refusal names the artifact,
    // so an out-of-scope one must resolve to "unknown" first (no existence oracle).
    let artifact = match in_scope_artifact {
        Some(a) => {
            let a = crate::modules::workstore::consume::ConsumableArtifact::try_new(a)?;
            Some((a.id, a.content_hash.clone()))
        }
        None => None,
    };

    let reference = if artifact.is_none() {
        repo.find_reference_by_id(project_id, input_id)
            .await?
            .map(|r| (r.id, r.content_hash))
    } else {
        None
    };

    classify(artifact, reference).ok_or_else(|| {
        AppError::bad_request(
            "PROVENANCE_UNKNOWN_INPUT",
            "the selection input does not resolve to a known artifact or reference resource",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5: ACCEPT a known upload/analysis artifact or a pinned reference;
    // REJECT an unknown/ambient input.
    #[test]
    fn accepts_artifact_or_reference_rejects_unknown() {
        let id = Uuid::new_v4();
        let art = classify(Some((id, "sha256:a".into())), None).expect("artifact accepted");
        assert!(matches!(art, ResolvedInput::Artifact { .. }));
        assert_eq!(art.kind(), "artifact");

        let rid = Uuid::new_v4();
        let refr = classify(None, Some((rid, "sha256:ref".into()))).expect("reference accepted");
        assert!(matches!(refr, ResolvedInput::Reference { .. }));
        assert_eq!(refr.content_hash(), "sha256:ref");

        assert!(classify(None, None).is_none(), "unknown input rejected");

        // Precedence: when BOTH an artifact and a reference resolve, the artifact
        // wins (the closer, project-owned identity).
        let art_id = Uuid::new_v4();
        let ref_id = Uuid::new_v4();
        let both = classify(
            Some((art_id, "sha256:art".into())),
            Some((ref_id, "sha256:ref".into())),
        )
        .expect("resolved when both present");
        assert!(matches!(both, ResolvedInput::Artifact { .. }), "artifact wins over reference");
        assert_eq!(both.id(), art_id);
        assert_eq!(both.content_hash(), "sha256:art");
    }

    // TEST-43 (INV-8 root cause): a project-scoped run's input is very often an
    // artifact scoped to an ATTACHED DATASET (`project_id = NULL`) — the ordinary
    // upload→attach→analyze flow. Requiring `project_id == Some(project)` rejected
    // exactly that, which 400'd every real filter's selection capture.
    #[test]
    fn attached_dataset_artifact_is_in_project_scope() {
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let attached_ds = Uuid::new_v4();
        let foreign_ds = Uuid::new_v4();
        let attached = [attached_ds];

        // 1. the project's OWN artifact (the pre-existing accepted case).
        assert!(artifact_in_project_scope(Some(project), None, project, &attached));
        // 2. an artifact of a dataset ATTACHED to the project (the fixed case).
        assert!(artifact_in_project_scope(None, Some(attached_ds), project, &attached));
        // …but the PROJECT COLUMN WINS when both are set: a row stamped with another
        // project's id is that project's row, and the attachment must not re-home it
        // (this matches `workstore::authz::artifact_scope`, which gates such a row on
        // `require_project_read(other_project)`).
        assert!(!artifact_in_project_scope(
            Some(other_project),
            Some(attached_ds),
            project,
            &attached
        ));
        // The project's OWN dual-scoped row is of course still in scope.
        assert!(artifact_in_project_scope(Some(project), Some(attached_ds), project, &attached));

        // 3. NOT widened: another project's artifact stays out.
        assert!(!artifact_in_project_scope(Some(other_project), None, project, &attached));
        // 4. NOT widened: a dataset that is NOT attached stays out.
        assert!(!artifact_in_project_scope(None, Some(foreign_ds), project, &attached));
        // 5. NOT widened: a scope-less ambient artifact stays out.
        assert!(!artifact_in_project_scope(None, None, project, &attached));
        // 6. NOT widened: with no attachments at all, only the project's own passes.
        assert!(!artifact_in_project_scope(None, Some(attached_ds), project, &[]));
        assert!(artifact_in_project_scope(Some(project), None, project, &[]));
    }
}
