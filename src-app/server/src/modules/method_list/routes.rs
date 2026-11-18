//! The method list's two endpoints, under `/api/methods/updates` (the reused
//! `projects::use` permission, like the method catalogue's; no new permission):
//!
//! - `GET /api/methods/updates`: the list in use (sequence, origin, when it was assembled,
//!   who signed it) and the last check (when, what it found, its problem in a plain
//!   sentence). A read: it never asks the registry.
//! - `POST /api/methods/updates/check`: check the registry now (the Settings button and its
//!   AI action), within the background budget (two presses at once share one check). It
//!   answers the same status. A newer list is taken for the NEXT run; a run
//!   already going keeps its own list.
//!
//! Both answer even when updates are off (demo mode): the status says so.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::http::StatusCode;
use axum::Json;

use txresbench_core::ApiResult;

use crate::modules::permissions::{with_permission, ProjectsUse, RequirePermissions};

use super::runtime::{self, MethodListStatus};

/// The module's routes (mounted by `register_routes`).
pub fn method_list_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route("/methods/updates", get_with(get_updates, get_updates_docs))
        .api_route(
            "/methods/updates/check",
            post_with(post_check, post_check_docs),
        )
}

async fn get_updates(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<MethodListStatus>> {
    Ok((StatusCode::OK, Json(runtime::status())))
}

fn get_updates_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("The method list in use (sequence, origin builtin | disk | live, when it was assembled, its signer) and the last check for a newer list (when, what it found, its problem in a plain sentence). Never asks the registry.")
        .id("MethodList.updates")
        .tag("method-list")
        .response::<200, Json<MethodListStatus>>()
}

async fn post_check(
    _auth: RequirePermissions<(ProjectsUse,)>,
) -> ApiResult<Json<MethodListStatus>> {
    let status = match runtime::runtime() {
        Some(rt) => rt.check_now().await,
        None => runtime::status(),
    };
    Ok((StatusCode::OK, Json(status)))
}

fn post_check_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Check the registry for a newer method list now. A verified newer list is used from the next run on (a run already going keeps its own list); a problem never fails the call, it is the status. Two checks at once share one. In demo mode updates are off and the status says so.")
        .id("MethodList.checkUpdates")
        .tag("method-list")
        .response::<200, Json<MethodListStatus>>()
}
