//! Serve-by-digest endpoint (ITEM-22 / DEC-32): `GET /api/sandbox/rootfs/{digest}`.
//!
//! Streams the content-digest-keyed rootfs squashfs from the LOCAL cache so a
//! reproducer can obtain the EXACT historical rootfs a run pinned
//! (`env_rootfs_sha256`) from a RUNNING CytoAnalyst — v1's deployment-assisted
//! delivery (no public GitHub-Release/OCI/CI publish; that's a fast-follow). A
//! reproduce capsule's `environments.json` records, per distinct digest,
//! `obtain = "GET /api/sandbox/rootfs/<digest>"` + `placement =
//! env/<digest>/rootfs.squashfs`; this endpoint is the `obtain` target.
//!
//! Registered as a PLAIN (non-aide) route so a multi-GB octet-stream body adds
//! no OpenAPI schema churn; it is still permission-gated in the handler via the
//! `RequirePermissions` extractor (§1 of the coding guidelines). The gate reuses
//! the sandbox READ permission (`sandbox::settings::read`) — the same perm that
//! reads rootfs status; an authenticated principal holding it may fetch a
//! present digest.

use axum::body::{Body, Bytes};
use axum::extract::Path;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use aide::axum::ApiRouter;
use tokio::io::AsyncReadExt;

use ziee_core::AppError;

use super::cache;
use crate::modules::permissions::RequirePermissions;
use crate::modules::sandbox::permissions::SandboxSettingsRead;

/// Mount the serve-by-digest route onto the module router. Plain `.route` (not
/// `.api_route`) — see the module docs.
pub fn register(router: ApiRouter) -> ApiRouter {
    router.route("/sandbox/rootfs/{digest}", get(serve_rootfs))
}

/// Stream a cached rootfs squashfs by its content digest. 400 for a malformed
/// digest, 404 when the digest is absent from the local cache, else a streamed
/// `application/octet-stream`.
async fn serve_rootfs(
    _auth: RequirePermissions<(SandboxSettingsRead,)>,
    Path(digest): Path<String>,
) -> Result<Response, AppError> {
    // Path-traversal guard: a `{digest}` is model-/reproducer-supplied.
    if !cache::is_valid_digest(&digest) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "ROOTFS_BAD_DIGEST",
            "a rootfs digest must be a 64-char lowercase hex sha256",
        ));
    }
    if !cache::has_digest(&digest) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "ROOTFS_DIGEST_ABSENT",
            format!("rootfs digest {digest} is not present in this deployment's cache"),
        ));
    }

    let path = cache::squashfs_path_for(&digest);
    let file = tokio::fs::File::open(&path).await.map_err(|e| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "ROOTFS_OPEN_FAILED",
            format!("open cached rootfs: {e}"),
        )
    })?;
    let len = file
        .metadata()
        .await
        .map(|m| m.len())
        .map_err(|e| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ROOTFS_STAT_FAILED",
                format!("stat cached rootfs: {e}"),
            )
        })?;

    // Stream in 64 KiB chunks (the squashfs is multi-GB — never buffer it). The
    // Item type is pinned to `Result<Bytes, io::Error>` explicitly (io::Error
    // satisfies `Body::from_stream`'s `Into<BoxError>` bound).
    let stream = async_stream::stream! {
        let mut file = file;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => yield Ok::<Bytes, std::io::Error>(Bytes::copy_from_slice(&buf[..n])),
                Err(e) => {
                    yield Err(e);
                    break;
                }
            }
        }
    };
    let body = Body::from_stream(stream);

    let headers = [
        (header::CONTENT_TYPE, "application/octet-stream".to_string()),
        (header::CONTENT_LENGTH, len.to_string()),
        (
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"ziee-rootfs-{digest}.squashfs\""),
        ),
        // Content-addressed bytes never change for a digest → safe to cache hard.
        (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
    ];

    Ok((StatusCode::OK, headers, body).into_response())
}
