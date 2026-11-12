//! Workstore REST wiring — **TWO routes** (artifact-model §0.3 "API — two routes").
//!
//! | | cacheable |
//! |---|---|
//! | `GET /artifacts?<filter>` (the JSON control plane) | **never** — rows are mutable |
//! | `GET /artifacts/{id}/data[/{*member}]` | **forever** — `immutable` |
//!
//! BOTH planes are aide-documented and flow into the OpenAPI spec + `types.ts`.
//!
//! The byte plane used to be registered with plain `.route()` on the theory that
//! an opaque body has no JSON schema to publish. The consequence was worse than
//! the problem: aide never saw the routes, so the generated `ApiClient` carried no
//! method for them and the frontend reader had to hand-roll `getBaseUrl()` +
//! `getAuthToken()` + a raw `fetch` — a direct violation of the "call the
//! generated method, never raw fetch" rule, and one the generator could not have
//! flagged because the endpoints did not exist as far as it knew. Declaring them
//! as `application/octet-stream` (artifact-model ITEM-30) costs one `_docs` fn per
//! route and gives the client a real method to call. Mounted under `/api` by the
//! framework.

use aide::axum::routing::{delete_with, get_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Extension, Json};
use sqlx::SqlitePool;

use txresbench_core::ApiResult;

use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::project::ProjectsUse;

use super::permissions::{WorkstoreSettingsManage, WorkstoreSettingsRead};
use super::settings::{UpdateWorkstoreSettings, WorkstoreSettings, WorkstoreSettingsRepository};
use super::settings_cache;

use super::catalog::models::Artifact;
use super::data_api::{
    delete_artifact, get_artifact, get_artifact_bytes_presence, get_catalog,
    get_dependent_analyses, list_artifacts, serve_artifact_data, serve_artifact_member,
    DependentAnalyses, ListedArtifact, ProjectCatalog,
};
use super::presence::BytesPresenceReport;

pub fn workstore_routes() -> ApiRouter {
    #[allow(unused_mut)]
    let mut router = ApiRouter::new()
        // --- control plane (JSON, documented) ---
        .api_route(
            "/projects/{project_id}/artifacts",
            get_with(list_artifacts, list_artifacts_docs),
        )
        .api_route(
            "/projects/{project_id}/catalog",
            get_with(get_catalog, get_catalog_docs),
        )
        .api_route("/artifacts/{id}", get_with(get_artifact, get_artifact_docs))
        .api_route(
            "/projects/{project_id}/datasets/{dataset_id}/dependent-analyses",
            get_with(get_dependent_analyses, get_dependent_analyses_docs),
        )
        // The READ-ONLY storage-health report. A STATIC segment under `/artifacts/`, which
        // the router prefers over the `{id}` sibling below — and that sibling is
        // DELETE-only, so there is no GET for it to shadow either way.
        .api_route(
            "/projects/{project_id}/artifacts/bytes-presence",
            get_with(
                get_artifact_bytes_presence,
                get_artifact_bytes_presence_docs,
            ),
        )
        .api_route(
            "/projects/{project_id}/artifacts/{id}",
            delete_with(delete_artifact, delete_artifact_docs),
        )
        // --- data plane (raw bytes, aide-declared) — THE ONLY READ SURFACE (ITEM-12) ---
        // `/data[/{*member}]` IS a Zarr store: codec-free byte-Range serving of the
        // whole artifact or of any member path resolved through the merkle manifest
        // (INV-4), cached `private, max-age=31536000, immutable` (ITEM-9). The client
        // range-reads chunks and decodes them itself.
        //
        // artifact-model ITEM-12 DELETED the second read surface — `GET
        // /artifacts/{id}/read`, `serve_core.rs`, the Selection grammar and its tier
        // routing — under INV-1: the server stores and serves, it never opens a byte
        // for meaning. A Selection→Arrow endpoint is by construction a server that
        // parses the payload, so the two positions were not reconcilable (DEC-3);
        // `/read` now 404s and the browser decodes with zero dependencies.
        .api_route(
            "/artifacts/{id}/data",
            get_with(serve_artifact_data, serve_artifact_data_docs),
        )
        .api_route(
            "/artifacts/{id}/data/{*member}",
            get_with(serve_artifact_member, serve_artifact_member_docs),
        )
        // --- admin settings (issue #54): GC policy + ingest size caps ---
        .api_route(
            "/workstore/settings",
            get_with(get_settings, get_settings_docs).put_with(update_settings, update_settings_docs),
        );

    // --- debug-only e2e seed route (compiled OUT of release; NOT aide/OpenAPI) ---
    // ONE generic, subject-matter-free engine: the caller POSTs a multipart `plan` (+ optional
    // raw `input` bytes) describing exactly which artifacts to insert, so every type id,
    // output id and payload value lives in the e2e DATA that drives it rather than in this
    // crate. It replaced six hand-written, subject-specific seed routes.
    #[cfg(debug_assertions)]
    {
        router = router.route(
            "/projects/{project_id}/_debug/seed",
            // A real binary fixture posted as the `input` part (multi-MB) exceeds axum's 2 MB
            // default body cap; raise it for THIS debug route only (compiled out of release
            // anyway).
            post(super::data_api::seed_debug)
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024)),
        );
    }

    router
}

// ───────────────────────── admin settings (issue #54) ─────────────────────────
// Gated routes call `with_permission::<(..)>` in their `*_docs` so the 403 example
// carries `required_permissions` — what the framework scrapes to emit the FE
// `Permissions.<Name>` constants. Mirrors `modules/sandbox/routes.rs`.

async fn get_settings(
    _auth: RequirePermissions<(WorkstoreSettingsRead,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<WorkstoreSettings>> {
    let row = WorkstoreSettingsRepository::new(pool)
        .get()
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(row)))
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(WorkstoreSettingsRead,)>(op)
        .id("Workstore.getSettings")
        .tag("workstore")
        .summary("Read the workstore GC policy + ingest size caps")
        .response::<200, Json<WorkstoreSettings>>()
}

async fn update_settings(
    auth: RequirePermissions<(WorkstoreSettingsManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<UpdateWorkstoreSettings>,
) -> ApiResult<Json<WorkstoreSettings>> {
    let repo = WorkstoreSettingsRepository::new(pool);
    // Merge the partial onto the current row, validate the RESULT (422 on
    // out-of-range — the safety bounds, DEC-3), then persist + refresh the
    // read-at-use cache so the next sweep / ingest sees the new values (INV-4).
    let current = repo.get().await.map_err(|e| e.to_api_error())?;
    let merged = WorkstoreSettingsRepository::merge(&current, &body);
    merged.validate().map_err(|e| e.to_api_error())?;
    let row = repo.update(&body, auth.user.id).await.map_err(|e| e.to_api_error())?;
    settings_cache::invalidate(row.clone());
    super::emit_settings_changed();
    Ok((StatusCode::OK, Json(row)))
}

fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(WorkstoreSettingsManage,)>(op)
        .id("Workstore.updateSettings")
        .tag("workstore")
        .summary("Update the workstore GC policy + ingest size caps")
        .response::<200, Json<WorkstoreSettings>>()
}

fn list_artifacts_docs(op: TransformOperation) -> TransformOperation {
    op.description("List a project's cataloged artifacts (filterable by datatype/run_id/output_id); each row carries its DERIVED source dataset (ITEM-22)")
        .id("Workstore.listArtifacts")
        .tag("workstore")
        .response::<200, Json<Vec<ListedArtifact>>>()
}

fn get_dependent_analyses_docs(op: TransformOperation) -> TransformOperation {
    op.description(
        "How many analyses in this project used this dataset. `dependents` is a DISCRIMINATED \
         UNION, not a nullable number: `{kind:'counted',count}` or `{kind:'cannot_compute', \
         reason}`. A nullable number generates an optional field, and `count ?? 0` then \
         compiles — which would put '0 dependent analyses' in front of a user about to \
         detach a dataset three analyses depend on.",
    )
    .id("Workstore.getDependentAnalyses")
    .tag("workstore")
    .response::<200, Json<DependentAnalyses>>()
}

fn get_catalog_docs(op: TransformOperation) -> TransformOperation {
    op.description("A project's catalog overview: per-axis entry counts + artifact briefs")
        .id("Workstore.getCatalog")
        .tag("workstore")
        .response::<200, Json<ProjectCatalog>>()
}

fn get_artifact_docs(op: TransformOperation) -> TransformOperation {
    op.description("One artifact's typed metadata")
        .id("Workstore.getArtifact")
        .tag("workstore")
        .response::<200, Json<Artifact>>()
        .response_with::<404, (), _>(|r| r.description("Artifact not found / not visible"))
}

fn get_artifact_bytes_presence_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "READ-ONLY storage health: which of a project's cataloged artifacts do NOT have \
             their bytes in the object store. `status: \"ready\"` records that INGEST \
             succeeded, not that the blobs are still on disk, so a project can list 89 \
             healthy-looking artifacts whose every read answers 404. This is how a client \
             (or an operator) finds out which ones, and it writes NOTHING — no status is \
             changed and no blob is removed. Bytes can be absent for legitimate reasons (a \
             pruned cache, a partial restore, a store mounted at the wrong root), so the \
             report says the bytes are not in this store and never asserts that anything \
             removed them. A row the store could not answer for is reported \
             `indeterminate`, never `absent`.",
        )
        .id("Workstore.getArtifactBytesPresence")
        .tag("workstore")
        .response::<200, Json<BytesPresenceReport>>()
        .response_with::<404, (), _>(|r| {
            r.description("Project not found / not visible to the caller")
        })
}

/// The shared response contract of both byte routes (artifact-model ITEM-30/36).
/// `Vec<u8>` is aide's octet-stream carrier — it publishes
/// `content: application/octet-stream` with no schema, which is the honest
/// declaration for a body the server never opens for meaning (INV-1).
fn byte_responses(op: TransformOperation) -> TransformOperation {
    op.response_with::<200, Vec<u8>, _>(|r| {
        r.description(
            "The requested bytes, streamed. 200 even for a `?range=` read: the URL names the \
             exact resource, so the response is COMPLETE for that URL — which is what makes it \
             cacheable (`private, max-age=31536000, immutable`). A `Range:` header instead \
             answers 206.",
        )
    })
    .response_with::<400, (), _>(|r| {
        r.description(
            "Malformed `range` (`INVALID_RANGE`), a `range` param AND a `Range:` header on one \
             request (`AMBIGUOUS_RANGE`), or a member/whole-object mismatch \
             (`NOT_MULTIFILE` / `MEMBER_REQUIRED`)",
        )
    })
    .response_with::<404, (), _>(|r| {
        r.description("Artifact not found / not visible, or the member path is not in the manifest")
    })
    .response_with::<409, (), _>(|r| {
        r.description(
            "`ARTIFACT_NOT_CONFORMING` — the post-ingest conformance gate (ITEM-18 / DEC-12) \
             found this artifact's bytes to disagree with its declared `structure`, so they are \
             no longer served. Deliberately NOT a 404: the row stays in the catalog listing and \
             `GET /artifacts/{id}` still answers 200 with `status: \"failed\"`, which is where a \
             user meets the condemnation and can delete it.",
        )
    })
    .response_with::<416, (), _>(|r| {
        r.description("The `range` is well-formed but names bytes this object does not have")
    })
}

/// Both byte routes are permission-gated at runtime — `serve_artifact_data` and
/// `serve_artifact_member` each take `RequirePermissions<(ProjectsUse,)>` and route
/// through `load_readable_artifact` → `require_artifact_read`. `with_permission` is what
/// puts that in the CONTRACT: it emits the `bearerAuth` security requirement and the
/// documented 403, exactly as the sibling `datatype/routes.rs` does. Without it the
/// published spec described two gated byte endpoints as OPEN, and every client generated
/// from it inherited that (there was never a runtime hole — only a lying contract).
fn serve_artifact_data_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "Stream a single-file artifact's raw bytes. `?range=<a>-<b>` / `<a>-` / `-<n>` returns \
             exactly that span with a 200 (never a 206), so every chunk is an ordinary cacheable GET \
             (ITEM-36). Streamed from disk, so server memory is constant in blob size (ITEM-37).",
        )
        .id("Workstore.getArtifactData")
        .tag("workstore")
        .with(byte_responses)
}

fn serve_artifact_member_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "Stream one member of a multi-file artifact, addressed by its path through the merkle \
             manifest (INV-4) — `/data/zarr.json`, `/data/c/0`, `/data/logFC/c/3`. Same `?range=` and \
             cache contract as the whole-object route; this is what makes `/data/` a Zarr store the \
             client reads with its own ranges.",
        )
        .id("Workstore.getArtifactDataMember")
        .tag("workstore")
        .with(byte_responses)
}

fn delete_artifact_docs(op: TransformOperation) -> TransformOperation {
    op.description("Delete a project artifact; emits sync:artifact so a bound result pane self-closes (ITEM-19)")
        .id("Workstore.deleteArtifact")
        .tag("workstore")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Artifact not found / not in project / not visible"))
}
