//! Provenance wire DTOs (ITEM-1/12/16/21/30). Serialize/Deserialize/JsonSchema so
//! they enter the generated `types.ts`. The graph facade + interaction capture +
//! export layer all project their DB rows onto these.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One authoritative USED edge (run → an input), stored in the sidecar
/// `inputs_json` and surfaced on a run node.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsedEdgeDto {
    /// The logical input slot name (`input`, `reference`, …).
    pub slot: String,
    /// `upload` | `artifact` | `reference`.
    pub kind: String,
    /// The referenced artifact / reference-resource id (null for a bare hash).
    pub ref_id: Option<Uuid>,
    /// The pinned content identity of the input.
    pub content_hash: String,
    /// **ITEM-18 / INV-3** — how this input was BOUND: `user` (a person picked it) or
    /// `auto` (the system bound it and nobody reviewed the choice), carried verbatim
    /// from the run's `InputDecl.bound_by`.
    ///
    /// **Absence means UNSTATED — it does NOT mean `user`.** Every run recorded before
    /// this field carries no origin, and there is deliberately no backfill (DEC-7):
    /// writing `user` over those rows would fabricate a review that never happened,
    /// and writing `auto` would fabricate an accusation. A reader (the run table, the
    /// exported `inputs.json`, `methods.md`) must therefore say NOTHING about how an
    /// origin-less input was chosen, rather than describing it as reviewed.
    ///
    /// Stored as a plain `String` rather than the `sandbox::spec::BindingOrigin` enum
    /// on purpose: this DTO is deserialized out of a `jsonb` column written by past and
    /// future servers, and a closed enum there would turn an unrecognised origin into a
    /// whole-row parse failure — which `parse_inputs_checked` treats as a CORRUPT record
    /// (it reddens readiness). The strictness belongs at the INGRESS boundary, where
    /// `AnalysisSpec::parse` already refuses an unknown value (TEST-22).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_by: Option<String>,
}

/// A run node (from the `provenance_run_repro` sidecar) — the trust view row.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunNodeDto {
    pub run_id: Uuid,
    pub project_id: Uuid,
    pub kind: String,
    pub status: String,
    pub generator_id: String,
    pub generator_version: String,
    pub code_sha256: Option<String>,
    pub env_rootfs_sha256: Option<String>,
    pub seed: Option<i64>,
    /// **ITEM-5** (DEC-1 = BOTH) — the run's SCIENTIFIC parameters: what was
    /// actually filtered / thresholded on, exactly as the run executed them. The
    /// non-scientific runtime metadata (`language`, `arch`) is deliberately NOT
    /// here — it is not a scientific parameter, and each has its own carrier (the
    /// re-run spec's declared language; the pinned rootfs digest).
    ///
    /// A run recorded BEFORE the promotion carries the legacy
    /// `{seed, language, arch}` object; its real science is then read from
    /// [`Self::rerun_spec`] (DEC-9 — there is deliberately no backfill).
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    /// **ITEM-5** (DEC-1 = BOTH) — the re-run envelope (`rerun_spec_json`): the
    /// original `AnalysisSpec` the verify path replays from. Surfaced as its OWN
    /// field so a reviewer can inspect the full replay spec without overloading
    /// `params` with two meanings. `None` for an in-app interaction / promote run
    /// (not re-runnable via the compute path).
    #[serde(default)]
    pub rerun_spec: Option<serde_json::Value>,
    pub inputs: Vec<UsedEdgeDto>,
    pub acting_user: Option<Uuid>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub captured_at: DateTime<Utc>,
}

/// An artifact node (from P1's `artifacts` catalog) — a graph vertex.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactNodeDto {
    pub id: Uuid,
    pub content_hash: String,
    pub datatype: String,
    /// The producing run; null for source/upload/reference roots.
    pub run_id: Option<Uuid>,
    pub output_id: String,
    /// True when this artifact may be promoted to a standalone dataset — i.e. its
    /// datatype is a dataset INPUT the upload pipeline can expand into a full
    /// linked-object dataset (`extensions::is_dataset_input`). The UI gates the
    /// Promote affordance on this; a component-object artifact is `false`.
    pub promotable: bool,
}

/// The reproducibility readiness checklist (ITEM-21). Each flag is independent.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReadinessDto {
    pub seeds_set: bool,
    pub env_pinned: bool,
    pub inputs_checksummed: bool,
    pub code_captured: bool,
    /// **ITEM-4** — every compute run carries the SCIENTIFIC params a reproduce
    /// capsule needs to regenerate the `/inputs/params.json` the run consumed.
    /// False means at least one compute run would replay on processor DEFAULTS
    /// (silently a different answer), so the closure is NOT reproducible-ready.
    /// See `export::readiness::params_captured_flag`.
    pub params_captured: bool,
    pub roots_have_provenance: bool,
    /// True only when all six flags pass.
    pub ready: bool,
}

/// The provenance graph for a project (or a target's backward closure).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphDto {
    pub runs: Vec<RunNodeDto>,
    pub roots: Vec<ArtifactNodeDto>,
    pub readiness: ReadinessDto,
}

/// Forward lineage from a dataset (ITEM-21 / DEC-20): every run + output derived
/// from THIS dataset until the end (across promote boundaries + fan-out branches).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ForwardGraphDto {
    /// The dataset the forward walk started from.
    pub dataset_id: Uuid,
    /// The dataset's merkle content hash (the link key); empty if untyped/unhashed.
    pub content_hash: String,
    /// The runs derived from the dataset (topology-agnostic set).
    pub runs: Vec<RunNodeDto>,
    /// The artifacts/intermediates produced by those runs.
    pub outputs: Vec<ArtifactNodeDto>,
}

/// A page of run nodes (the paginated trust view, ITEM-30 / DEC-11).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RunsPageDto {
    pub runs: Vec<RunNodeDto>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// A reference-resource root (ITEM-4).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ReferenceResourceDto {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub accession: Option<String>,
    pub doi: Option<String>,
    pub content_hash: String,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------- requests ----------------------------------

/// `POST /provenance/selections` — record a selection as a reproducible recipe.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RecordSelectionRequest {
    pub project_id: Uuid,
    pub input_artifact_id: Uuid,
    /// The opaque, FLAT selection recipe — a `kind` plus that kind's own fields
    /// (DEC-7: a recipe, never a materialized mask). The versioned predicate-DSL
    /// envelope this once also accepted was scrapped (processor-ui-language
    /// ITEM-4) and is now refused with a 400.
    pub recipe: serde_json::Value,
    pub label: Option<String>,
}

/// `POST /provenance/actions` — the generic interaction chokepoint, and the
/// route a caller uses when the action type is not `selection.*`. Dispatchable
/// types are whatever `action_registry::catalog()` marks so: the `selection.*`
/// family plus `subset.filter` (the committed keep-mask the declarative filter
/// UI records). `annotate.*`/`group.*` are reserved, not dispatchable.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RecordActionRequest {
    pub project_id: Uuid,
    pub action_type: String,
    pub input_artifact_id: Uuid,
    pub recipe: serde_json::Value,
    pub label: Option<String>,
}

/// `POST /provenance/export` — build a reproducibility bundle.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ExportRequest {
    pub project_id: Uuid,
    /// The target run/artifact to walk back from (null = whole project).
    pub target: Option<Uuid>,
    /// `single` | `set` | `project` (ITEM-16).
    pub scope: String,
}

/// `POST /provenance/export` response — the built bundle handle.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExportResponse {
    pub export_id: Uuid,
}

// -------------------------------- verification -------------------------------

/// `POST /provenance/verify` — re-run a recorded compute run + compare outputs.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct VerifyRequest {
    pub project_id: Uuid,
    /// The recorded compute run to re-execute + verify.
    pub target_run_id: Uuid,
    /// `exact` (bit-identical) | `tolerant` (structural; byte-diffs →
    /// `inconclusive`, never `reproduced`). Defaults to `tolerant`.
    #[serde(default)]
    pub tolerance_mode: Option<String>,
}

/// A verification record (the re-run trust view). `status` ∈
/// `pending | reproduced | inconclusive | diverged | error`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerificationDto {
    pub id: Uuid,
    pub target_run_id: Uuid,
    pub project_id: Uuid,
    pub status: String,
    pub tolerance_mode: String,
    /// Itemized per-output comparison + summary.
    pub diff_report: serde_json::Value,
    /// The full rootfs digest the re-run executed against (null until run).
    pub rootfs_digest: Option<String>,
    /// The rendered codecheck-style certificate (null until terminal).
    pub cert_json: Option<serde_json::Value>,
    pub verified_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// `GET /provenance/verifications` response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VerificationsResponse {
    pub verifications: Vec<VerificationDto>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-7 [ITEM-5]: BOTH DEC-1 fields on `RunNodeDto` are `Option<T>` +
    // `#[serde(default)]`, so a LEGACY payload that omits them still deserializes
    // (to `None`) instead of erroring. That is the FE-safety condition for the five
    // existing TS consumers of this type — a required field breaks both sides.
    #[test]
    fn legacy_run_node_payload_deserializes_without_the_new_fields() {
        let legacy = serde_json::json!({
            "run_id": Uuid::nil(),
            "project_id": Uuid::nil(),
            "kind": "compute",
            "status": "completed",
            "generator_id": "cell.filter",
            "generator_version": "0.0.0",
            "code_sha256": null,
            "env_rootfs_sha256": null,
            "seed": 7,
            // NOTE: neither `params` nor `rerun_spec` is present.
            "inputs": [],
            "acting_user": null,
            "started_at": null,
            "finished_at": null,
            "captured_at": "2026-07-18T00:00:00Z",
        });
        let dto: RunNodeDto =
            serde_json::from_value(legacy).expect("a payload without the new fields deserializes");
        assert!(dto.params.is_none(), "absent `params` reads as None, not an error");
        assert!(dto.rerun_spec.is_none(), "absent `rerun_spec` reads as None, not an error");

        // …and a payload that DOES carry them round-trips both.
        let full = serde_json::json!({
            "run_id": Uuid::nil(), "project_id": Uuid::nil(), "kind": "compute",
            "status": "completed", "generator_id": "cell.filter", "generator_version": "0.0.0",
            "code_sha256": null, "env_rootfs_sha256": null, "seed": 7,
            "params": { "criteria": [{ "column": "pct_counts_mito", "max": 10 }], "seed": 7 },
            "rerun_spec": { "params": { "criteria": [] }, "language": "python" },
            "inputs": [], "acting_user": null, "started_at": null, "finished_at": null,
            "captured_at": "2026-07-18T00:00:00Z",
        });
        let dto: RunNodeDto = serde_json::from_value(full).expect("full payload deserializes");
        assert_eq!(
            dto.params.as_ref().and_then(|p| p["criteria"][0]["column"].as_str()),
            Some("pct_counts_mito"),
            "the promoted scientific params survive the round trip"
        );
        assert!(dto.rerun_spec.is_some(), "the re-run envelope survives the round trip");
    }

    // TEST-8: the verification DTOs round-trip through serde with the status +
    // tolerance vocabularies + the nullable fields.
    #[test]
    fn verification_dtos_roundtrip() {
        let req: VerifyRequest = serde_json::from_value(serde_json::json!({
            "project_id": Uuid::nil(),
            "target_run_id": Uuid::nil(),
            "tolerance_mode": "exact",
        }))
        .expect("VerifyRequest deserializes");
        assert_eq!(req.tolerance_mode.as_deref(), Some("exact"));
        // tolerance_mode is optional (absent → None → the handler defaults tolerant).
        let req2: VerifyRequest = serde_json::from_value(serde_json::json!({
            "project_id": Uuid::nil(), "target_run_id": Uuid::nil(),
        }))
        .expect("VerifyRequest without tolerance_mode");
        assert_eq!(req2.tolerance_mode, None);

        let dto = VerificationDto {
            id: Uuid::nil(),
            target_run_id: Uuid::nil(),
            project_id: Uuid::nil(),
            status: "inconclusive".into(),
            tolerance_mode: "tolerant".into(),
            diff_report: serde_json::json!({ "outputs_total": 2 }),
            rootfs_digest: None,
            cert_json: None,
            verified_at: None,
            created_at: Utc::now(),
        };
        let back: VerificationDto = serde_json::from_value(serde_json::to_value(&dto).unwrap()).unwrap();
        assert_eq!(back.status, "inconclusive");
        assert_eq!(back.tolerance_mode, "tolerant");
        assert!(back.rootfs_digest.is_none() && back.cert_json.is_none() && back.verified_at.is_none());
        assert_eq!(back.diff_report["outputs_total"], 2);
    }
}
