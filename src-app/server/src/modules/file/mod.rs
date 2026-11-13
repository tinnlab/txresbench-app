//! `file` module — adopts the SDK's `txresbench-file` blob STORE + its mountable
//! `file_routes` HTTP surface.
//!
//! TxResBench uses the store for INPUT uploads only (dataset matrix blobs — see
//! the storage design; result partial-reads / HDF5 do NOT flow
//! through it). Scientific blobs need no pdf/text/thumbnail derivatives, so the
//! injected [`txresbench_file::seams::FileProcessor`] is a no-op that stores the
//! original only, and the [`txresbench_file::seams::FileEvents`] seam is a no-op (no
//! cross-device File sync entity today — kept minimal).
//!
//! Wiring split (mirrors auth/notification):
//! - This self-registering `MODULE_ENTRIES` module merges
//!   `file_routes::<DefaultIdentityResolver>()` (list/get/download/delete/
//!   versions) under the `/api` prefix. Those routes are owner-scoped by
//!   `files.user_id` AND gated by the injected [`access::DatasetFileAccessPolicy`],
//!   which resolves real dataset/account standing — ownership alone is NOT
//!   authorization here, because `files.user_id` is the uploading actor and
//!   survives the uploader's removal from the account (see `access`).
//! - Boot wiring (`lib.rs::build_app`) calls `init_file_storage` + installs the
//!   `Extension(FileContext { .. })` the store-generic handlers pull from.
//! - The multipart upload POST is app-side (`dataset` module), as the SDK
//!   intends: `file_routes` deliberately ships no upload route. Its bytes reach
//!   the store through [`stream`], which streams AROUND the SDK's `&[u8]` write
//!   seam instead of buffering the whole file (#182) — see that module's doc for
//!   why an app-side transcription of `store_processed` is faithful here.

pub mod stream;

/// The upload request-body guard (#185 §1): the per-request SaaS body ceiling and
/// the multipart part-header bound that replaces what `DefaultBodyLimit` used to
/// supply. See the module doc for why removing the body limit required it.
pub mod upload_guard;

pub mod access;

use aide::axum::ApiRouter;
use async_trait::async_trait;
use linkme::distributed_slice;
use uuid::Uuid;

use txresbench_auth::auth::DefaultIdentityResolver;
use txresbench_core::AppError;
use txresbench_file::models::ProcessingResult;
use txresbench_file::seams::{FileEvents, FileProcessor};
use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

/// No-op processor: single-cell matrix blobs are opaque binary (no pdf/text/
/// thumbnail/preview derivatives), so we store the original bytes only.
/// Returning `ProcessingResult::default()` yields empty derivative sets.
pub struct NoopFileProcessor;

#[async_trait]
impl FileProcessor for NoopFileProcessor {
    async fn process(&self, _bytes: &[u8], _mime_type: &str) -> Result<ProcessingResult, AppError> {
        Ok(ProcessingResult::default())
    }
}

/// No-op events seam: TxResBench has no `SyncEntity::File` (files are surfaced
/// through their owning dataset), so post-persist change/delete/commit
/// notifications are dropped. Kept minimal; wire to `sync::publish` if a
/// device-level file stream is ever needed.
pub struct NoopFileEvents;

impl FileEvents for NoopFileEvents {
    fn on_file_changed(&self, _user_id: Uuid, _file_id: Uuid, _origin: Option<Uuid>) {}
    fn on_file_deleted(&self, _user_id: Uuid, _file_id: Uuid, _origin: Option<Uuid>) {}
}

pub struct FileModule;

impl AppModule for FileModule {
    fn name(&self) -> &'static str {
        "file"
    }

    fn description(&self) -> &'static str {
        "Generic blob store (txresbench-file) — dataset upload backing."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // Fix the store-generic handlers' resolver to TxResBench's
        // `DefaultIdentityResolver` (same resolver `modules::permissions`
        // fixes `RequirePermissions` to). Every file response is owner-scoped
        // by `user.id` AND authorized by the `FileAccessPolicy` carried on the
        // `Extension<FileContext>` these handlers read, which is installed
        // globally at boot (`lib.rs::build_app`). Owner scope alone was the whole
        // authorization until that seam existed, which let a removed member keep
        // listing, downloading and deleting the org's files — see `access`.
        router.merge(txresbench_file::http::file_routes::<DefaultIdentityResolver>())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static FILE: ModuleEntry = ModuleEntry {
    name: "file",
    order: 16,
    description: "Generic blob store (txresbench-file) — dataset upload backing.",
    constructor: || Box::new(FileModule),
};
