//! Provenance HTTP routes (ITEM-30), aide-documented so they appear in OpenAPI +
//! drive the `Permissions`/`ApiClient` codegen (`.id("Provenance.*")`). The
//! download route is a plain `Response` route (mirrors the workstore byte-serving
//! path) — the perm is enforced by its inline extractor.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::routing::get;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::handlers::*;
use super::models::*;
use super::permissions::{
    ProvenanceExport, ProvenanceRead, ProvenanceSettingsManage, ProvenanceSettingsRead,
};
use super::settings::ProvenanceSettings;

pub fn provenance_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/provenance/graph", get_with(get_graph, get_graph_docs))
        .api_route("/provenance/forward", get_with(get_forward, get_forward_docs))
        .api_route("/provenance/runs", get_with(list_runs, list_runs_docs))
        .api_route("/provenance/runs/{id}", get_with(get_run, get_run_docs))
        .api_route(
            "/provenance/selections",
            post_with(record_selection, record_selection_docs),
        )
        .api_route(
            "/provenance/actions",
            post_with(record_action, record_action_docs),
        )
        .api_route("/provenance/verify", post_with(verify, verify_docs))
        .api_route(
            "/provenance/verifications",
            get_with(list_verifications, list_verifications_docs),
        )
        .api_route("/provenance/export", post_with(export, export_docs))
        // Byte-serving download: a plain Response route (not aide) — perm enforced
        // by the handler's inline `RequirePermissions<(ProvenanceExport,)>`.
        .route("/provenance/export/{id}", get(download_export))
        .api_route(
            "/provenance/settings",
            get_with(get_settings, get_settings_docs)
                .put_with(update_settings, update_settings_docs),
        )
}

fn get_graph_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.graph")
        .tag("provenance")
        .summary("Provenance graph + readiness for a project (or a target's closure)")
        .response::<200, Json<GraphDto>>()
}

fn get_forward_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.forward")
        .tag("provenance")
        .summary("Forward lineage from a dataset (everything derived from it)")
        .response::<200, Json<ForwardGraphDto>>()
}

fn list_runs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.runs")
        .tag("provenance")
        .summary("Paginated provenance runs (trust view)")
        .response::<200, Json<RunsPageDto>>()
}

fn get_run_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.run")
        .tag("provenance")
        .response::<200, Json<RunNodeDto>>()
}

fn record_selection_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.recordSelection")
        .tag("provenance")
        .summary("Record a selection as a reproducible recipe")
        .response::<201, Json<RunNodeDto>>()
}

fn record_action_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.recordAction")
        .tag("provenance")
        .summary("Record a dispatchable interaction (selection.* only this round)")
        .response::<201, Json<RunNodeDto>>()
}

fn verify_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceExport,)>(op)
        .id("Provenance.verify")
        .tag("provenance")
        .summary("Re-run a recorded compute run + verify its outputs reproduce")
        .description(
            "Spawns a sandboxed re-run of the recorded spec and compares the \
             regenerated output signature to the recorded one. The re-run is an \
             ordinary job: it appears in GET /jobs, can be stopped through \
             POST /jobs/{id}/stop by its requester or the project owner, and is \
             admitted under the SAME `max_concurrent_jobs` cap as every other run. \
             Returns the pending verification row (202); the client refetches on \
             `sync:provenance_verification`.",
        )
        .response::<202, Json<VerificationDto>>()
        .response_with::<403, (), _>(|r| r.description("Read-only access to the project"))
        .response_with::<404, (), _>(|r| {
            r.description("No such project, or the run is not in it")
        })
        .response_with::<429, (), _>(|r| {
            r.description("The compute pool is full (max_concurrent_jobs); retry shortly")
        })
}

fn list_verifications_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceRead,)>(op)
        .id("Provenance.verifications")
        .tag("provenance")
        .summary("List re-run verifications for a project (optionally one run)")
        .response::<200, Json<VerificationsResponse>>()
}

fn export_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceExport,)>(op)
        .id("Provenance.export")
        .tag("provenance")
        .summary("Build a reproducibility export bundle")
        .response::<200, Json<ExportResponse>>()
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceSettingsRead,)>(op)
        .id("Provenance.getSettings")
        .tag("provenance")
        .response::<200, Json<ProvenanceSettings>>()
}

fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProvenanceSettingsManage,)>(op)
        .id("Provenance.updateSettings")
        .tag("provenance")
        .response::<200, Json<ProvenanceSettings>>()
}
