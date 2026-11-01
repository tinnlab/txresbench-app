//! Dataset HTTP routes (aide-documented → OpenAPI). The owner-corrected entity:
//! owner-scoped + shareable datasets (visibility = owner ∪ sharees), M:N to
//! projects (attach lives in the project module), streaming upload → dataset(s)
//! grouped by the datatype's `FileLayout`, and an owner-scoped folder layer.
//!
//! Capability gate: `projects::use` (every real CytoAnalyst user holds it — no new
//! global permission, DEC-23); the AUTHZ boundary is dataset ownership + shares.

use aide::axum::routing::{delete_with, get_with, post_with, put_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};
// `ingest_bytes` is still the right call for the PROMOTE path (`promote_artifact`),
// which re-ingests bytes it already holds from the workstore — a different path from
// the three multipart UPLOAD routes, which stream (#182). Its own whole-file buffer
// is out of scope here and recorded as still-buffering in the branch's report.
use ziee_file::ingest::ingest_bytes;
use ziee_file::FileRepository;

use crate::modules::file::stream::{
    ingest_staged, multipart_error, read_text_capped, stage_multipart_field, StagedPart,
};
use crate::modules::file::upload_guard::{guard_upload_body, UploadLimits, MAX_PART_HEADER_BYTES};
use crate::modules::file::{NoopFileEvents, NoopFileProcessor};
use crate::modules::jobs::models::CreateJobRequest;
use crate::modules::jobs::repository::JobRepository;
use crate::modules::jobs::seams;
use crate::modules::permissions::{active_group_ids, with_permission, RequirePermissions};
use crate::modules::sandbox::backend::PriorityClass;
// DEC-8's promotable tier — the SAME constant the manifest contract + `role_or_default`
// use, so the promote gate and the value ingest wrote can never drift into two spellings.
use crate::modules::project::ProjectsUse;
use crate::modules::provenance::models::UsedEdgeDto;
use crate::modules::provenance::recorder::{dataset_edge, edge_from_artifact};
use crate::modules::provenance::repository::{NewReference, NewRun, ProvenanceRepository};
use crate::modules::sandbox::outputs::ROLE_ARTIFACT;
use crate::modules::sandbox::spec::{resolve_resource_class, AnalysisSpec};
use crate::modules::sync::{
    fan_out_owner_scoped, publish, Actor, Audience, SyncAction, SyncEntity, SyncOrigin,
};
use crate::modules::workstore::authz::require_artifact_read;
use crate::modules::workstore::catalog::repository::CatalogRepository;
use crate::modules::workstore::object_store::ContentKey;
use crate::modules::workstore::settings::WorkstoreSettings;

use super::models::*;
use super::repository::{
    enforce_cardinality, plan_upload_groups_by_name_preferring, DatasetAccess, DatasetRepository,
    DEFAULT_PER_PAGE, MAX_PER_PAGE,
};

/// Resolve the ceiling on an upload request body for THIS deployment mode.
///
/// `None` means **no size ceiling at all**. That is the desktop/self-hosted answer,
/// and it is the owner's ruling verbatim: *"we should not limit file size, that
/// depends on user computer to process"* (`docs/design/upload-limits-policy.md`,
/// ruling 1 / INV-1). The user's own disk is the limit, so the upload routes carry
/// `DefaultBodyLimit::disable()` and the guard counts nothing.
///
/// This is the ONLY saas/desktop distinction in this file, deliberately: the ruling
/// asked for a mode-dependent LIMIT POLICY, not for a mode-dependent upload path,
/// and everything downstream of here — staging, group planning, ingest, the typed
/// refusals — is byte-identical in both builds.
pub fn upload_body_ceiling(_settings: &WorkstoreSettings) -> Option<u64> {
    None
}

/// The per-request upload limits, read AT USE from the settings cache.
///
/// Called once per upload request by the guard layer. The part-header bound is
/// mode-independent (it is not a file-size limit — see
/// `modules::file::upload_guard`); only the body ceiling varies by mode.
async fn upload_limits(pool: &sqlx::SqlitePool) -> UploadLimits {
    let settings = crate::modules::workstore::settings_cache::get(pool).await;
    UploadLimits {
        max_body_bytes: upload_body_ceiling(&settings),
        max_part_header_bytes: MAX_PART_HEADER_BYTES,
    }
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Fan a `Dataset`/`DatasetFolder` change to the owner AND every sharee, so a
/// shared dataset's edits reach the collaborators' devices too.
///
/// ## `owner_id` is WHOSE data changed; `actor` is WHO changed it
///
/// They are the same user only when the owner acts. Every mutation reachable
/// through `require_can_edit` is ALSO reachable by an `edit`-role sharee, and for
/// those `auth.user.id` is not the owner. Passing the actor where the owner
/// belongs is not a cosmetic slip: `sharee_user_ids` does NOT include the owner,
/// so the owner is not in `sharees` either — the frame is addressed to the actor,
/// the loop's dedup compares against the actor, and **the owner of the dataset is
/// never told at all**. That shipped twice (`upload_dataset`, `add_supporting_file`)
/// against a helper that took only `owner_id`, because at a call site the two are
/// indistinguishable by type and the wrong one still compiles. Naming both in the
/// signature is what makes the confusion visible at every call site.
///
/// The `origin`-follows-the-actor rule lives in [`fan_out_owner_scoped`]; this is a
/// naming wrapper over it, kept so the dataset call sites read in dataset terms.
fn publish_to_all(
    entity: SyncEntity,
    action: SyncAction,
    id: Uuid,
    owner_id: Uuid,
    sharees: &[Uuid],
    actor: Actor,
) {
    fan_out_owner_scoped(entity, action, id, owner_id, sharees, actor);
}

/// Resolve a dataset's audience through [`dataset_audience`] and fan one `Dataset`
/// change to it — the form every mutation whose actor may NOT be the dataset's owner
/// uses (#168).
///
/// The `owner_id` parameter of [`publish_to_all`] above solved the actor-vs-owner
/// confusion; it did not solve the second one, which is that `datasets.owner_id` is
/// the CREATING MEMBER and an account removal changes neither it nor `account_id`. So
/// `rename_dataset`, `upload_dataset` and `add_supporting_file` each inlined
/// `(ds.owner_id, sharee_user_ids(id))` and kept addressing a member removed from the
/// organization — able to see, live, that the dataset they created there had changed,
/// while every fetch of it correctly 404'd. Resolving through the one helper fixes all
/// three at once and deletes the hand-copy that let them drift from it.
///
/// EVERY `Dataset` fan-out in this file now resolves through `dataset_audience` — this
/// helper where the audience can be resolved at the emit, and the raw [`publish_to_all`]
/// at the three sites that must capture it BEFORE the mutation cascades it away
/// (`delete_dataset` and `split_dataset`, where the shares go with the row;
/// `unshare_dataset`, where the ex-sharee must still be told to refetch). `share_dataset`
/// resolves AFTER its write, deliberately: the newly-added principal's users are only in
/// the audience once the `dataset_shares` row exists.
///
/// Those four were owner-gated, so their old `auth.user.id` anchor leaked nothing — but
/// leaving them would have left this branch with an asymmetry of its own making: an
/// account co-member told when a dataset is RENAMED and not when it is DELETED, i.e. a
/// phantom row in their list until the 60s re-check.
///
/// A resolution failure or an empty audience skips the emit (the client's 60s sync
/// re-check is the backstop) — never falls back to an owner-addressed frame, which is
/// the shape that was the leak.
/// [`dataset_audience`] for the three sites that must hold the audience ACROSS their
/// mutation, so they cannot use [`publish_dataset_audience`]. Same failure posture as
/// that helper — an unresolvable or empty audience skips the emit — but it says so in
/// the log instead of vanishing: a `.ok().flatten()` here drops an entire fan-out on a
/// transient DB error with no trace, and this is the only shape in the family that
/// would have been silent about it.
async fn resolve_dataset_audience_or_warn(
    pool: &SqlitePool,
    id: Uuid,
) -> Option<(Uuid, Vec<Uuid>)> {
    match crate::modules::dataset::sync::dataset_audience(pool, id).await {
        Ok(Some(pair)) => Some(pair),
        Ok(None) => {
            tracing::debug!(dataset_id = %id, "dataset sync: nobody may see this dataset; no frame emitted");
            None
        }
        Err(err) => {
            tracing::warn!(dataset_id = %id, error = ?err, "dataset sync: audience unresolved; connected devices will not live-refresh this dataset until their next refetch");
            None
        }
    }
}

async fn publish_dataset_audience(pool: &SqlitePool, action: SyncAction, id: Uuid, actor: Actor) {
    match crate::modules::dataset::sync::dataset_audience(pool, id).await {
        Ok(Some((owner_id, sharees))) => {
            publish_to_all(SyncEntity::Dataset, action, id, owner_id, &sharees, actor);
        }
        Ok(None) => {
            tracing::debug!(dataset_id = %id, "dataset sync: nobody may see this dataset; no frame emitted");
        }
        Err(err) => {
            tracing::warn!(dataset_id = %id, error = ?err, "dataset sync: audience unresolved; connected devices will not live-refresh this dataset until their next refetch");
        }
    }
}

/// Pagination + filtering for the dataset list endpoints
/// (`?page=&per_page=&search=&folder_id=`). Bounds every user-facing list to one
/// windowed page (CODING_GUIDELINES §4) — default 50, cap 500. `search` is an
/// optional case-insensitive substring on the dataset name (trimmed; blank → no
/// filter); `folder_id` (list_mine only) restricts to a folder's members.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct DatasetListQuery {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub per_page: Option<i64>,
    /// Optional case-insensitive substring filter on the dataset name.
    #[serde(default)]
    pub search: Option<String>,
    /// Optional folder filter (list_mine only): restrict to datasets in this folder.
    #[serde(default)]
    pub folder_id: Option<Uuid>,
}

impl DatasetListQuery {
    /// Clamp to sane bounds (page ≥ 1, per_page 1..=`MAX_PER_PAGE`, default
    /// `DEFAULT_PER_PAGE`). Mirrors the jobs list's `clamped()`.
    fn clamped(&self) -> (i64, i64) {
        let page = self.page.unwrap_or(1).max(1);
        let per_page = self
            .per_page
            .unwrap_or(DEFAULT_PER_PAGE)
            .clamp(1, MAX_PER_PAGE);
        (page, per_page)
    }

    /// The trimmed search term, or `None` when absent/blank — so an empty or
    /// whitespace-only `?search=` applies no filter.
    fn search_term(&self) -> Option<String> {
        self.search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
}

/// A windowed page of datasets plus the total row count matching the SAME filters
/// (owner/shared scope + search + folder), WITHOUT limit/offset — so the frontend
/// can compute the page count for server-side pagination.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetPage {
    /// Each row is a `Dataset` plus its DERIVED primary-processing status (so the
    /// library can badge a running / failed convert per row).
    pub items: Vec<DatasetListItem>,
    pub total: i64,
}

/// Enrich a page of bare `Dataset` rows with their DERIVED primary-processing
/// status (one batched `processing_status_map` query, no N+1) → list items. The raw
/// convert-`error` text (may reference internal sandbox workspace paths) is REDACTED
/// for any row `acting_user` may not EDIT — a `view`-role sharee sees the "Failed"
/// status but not the engine's raw failure string.
///
/// The boundary used to be OWNERSHIP, and it protected the wrong direction. An
/// `edit`-role sharee may run the processing job themselves (`799d0cf3`), which makes
/// them the job's owner and hands them that identical string at `GET /jobs/{id}` — so
/// the list withheld from exactly the people who could already read it, while the
/// SAME dataset's error was visible or not depending on who happened to press "run".
/// EDIT is the boundary that holds: it is the set that may see the job the text comes
/// from, so list and detail now agree for every principal. A `view` sharee is still
/// redacted — that arm is unchanged, and is what keeps readers off the raw engine
/// output.
async fn enrich_items(
    repo: &DatasetRepository,
    items: Vec<Dataset>,
    acting_user: Uuid,
    group_ids: &[Uuid],
) -> Result<Vec<DatasetListItem>, (StatusCode, AppError)> {
    let ids: Vec<Uuid> = items.iter().map(|d| d.id).collect();
    let map = repo.processing_status_map(&ids).await.map_err(e)?;
    // One batched membership query, not one `access()` per row (this is the list path).
    let editable = repo
        .editable_subset(&ids, acting_user, group_ids)
        .await
        .map_err(e)?;
    Ok(items
        .into_iter()
        .map(|dataset| {
            let (js, je) = map.get(&dataset.id).cloned().unwrap_or((None, None));
            let (processing_status, mut processing_error) = map_processing_status(js, je);
            if !editable.contains(&dataset.id) {
                processing_error = None; // redact raw error text for non-editors
            }
            DatasetListItem {
                dataset,
                processing_status,
                processing_error,
            }
        })
        .collect())
}

/// One entry of the combined-upload `supporting` mapping (ITEM-11): tags a `file`
/// part (by its 0-based upload-order `index`) as a SUPPORTING annotation aligned to
/// a named `axis` of the primary dataset, with an optional supporting `kind`
/// (defaults `annotation_table`) + optional explicit `datatype` (else derived from the
/// `kind` via [`supporting_datatype_for_kind`]). Mirrors the type-first wizard's
/// per-slot payload.
#[derive(Debug, Clone, Deserialize)]
struct SupportingPartSpec {
    /// The 0-based index of the tagged `file` part in upload order.
    index: usize,
    /// The primary datatype axis this annotation aligns to (an `AxisSpec.name`).
    axis: String,
    /// The supporting kind (open string); defaults `annotation_table`.
    #[serde(default)]
    kind: Option<String>,
    /// The supporting file's datatype; derived from `kind` (never sniffed) when absent.
    #[serde(default)]
    datatype: Option<String>,
}

/// Build the dataset routes.
///
/// ## What bounds an upload, after the uncapping ruling (#185 §1)
///
/// The upload routes get their own layer stack so the limit policy does NOT leak
/// onto the JSON CRUD endpoints (which keep axum's 2 MB default, correctly). All
/// three upload routes — the combined files→dataset(s) upload, the
/// single-file-into-an-existing-dataset upload, and the supporting-file upload —
/// share it.
///
/// `DefaultBodyLimit::disable()` is applied in BOTH modes. It is not itself the
/// policy: it removes axum's 2 MB default so the policy can be decided per request
/// by [`upload_limits`] instead of being frozen into the layer stack at build time.
/// Forgetting it would silently cap every upload at 2 MB.
///
/// What binds now, precisely:
///
/// * a **`file`** part is streamed to disk and never materialized
///   (`modules::file::stream::stage_multipart_field`), so it costs disk, not RAM —
///   which is what makes "no size ceiling" a safe thing to say on desktop at all;
/// * the **whole body** is bounded only under SaaS, at the configured
///   `workstore_settings.max_upload_body_bytes`. On desktop nothing bounds it but
///   free disk, which is the ruling: *"we should not limit file size, that depends
///   on user computer to process"*;
/// * a **non-file** part (`groups`/`datatype`/`supporting`/`axis`/`kind`) is text and
///   is therefore held whole by definition — so it is capped at
///   `stream::TEXT_FIELD_MAX_BYTES` and refused past it, in both modes. With no body
///   ceiling above it on desktop, that cap is now the ONLY thing bounding it;
/// * a part's **multipart header block** is capped at
///   `upload_guard::MAX_PART_HEADER_BYTES`, in both modes. This is new, and it is
///   load-bearing: `multer` accumulates those bytes inside axum's extractor before
///   `next_field()` returns, so the body limit used to be the only thing bounding
///   them — see the `upload_guard` module doc;
/// * on `POST /datasets/upload` the NUMBER of `file` parts is capped at the
///   configured `workstore_settings.max_upload_parts` (default 1024), because
///   per-part state is held for the whole request and small-times-unbounded is
///   unbounded. The other two routes need no such cap: they read a SINGLE `file`
///   field, and a repeated one replaces the previous part (whose guard unlinks it).
///   Their peak is TWO parts, not one — Rust evaluates the replacement fully before
///   dropping the value it replaces, so the old part's temp file outlives the staging
///   of the new one — but two is a constant, which is what the invariant needs;
/// * a capped field's PARSED form can still be a constant multiple of the cap — a
///   1 MiB `groups` body of `[[0],[0],…]` deserializes to ~10-15 MiB of `Vec`
///   headers before `plan_upload_groups` rejects it. Bounded by a constant, which is
///   the property that matters here, but not bounded BY the cap.
///
/// Each of those is answered with a typed refusal rather than an OOM:
/// `413 UPLOAD_TOO_LARGE` over the SaaS body ceiling, `413 UPLOAD_FIELD_TOO_LARGE`
/// over a text-field cap or a part-header cap, `413 UPLOAD_TOO_MANY_PARTS` over the
/// part cap, and `507 UPLOAD_STORAGE_UNAVAILABLE` when the staging write fails. Note
/// the refusal is written while the rest of the body is still in flight, so hyper
/// closes the connection afterwards — a client sending gigabytes past the ceiling may
/// observe the reset before it reads the response. The server survives either way,
/// which is the property that matters; a client that wants to SEE the code should not
/// stream past a refusal.
pub fn dataset_routes() -> ApiRouter {
    let upload = ApiRouter::new()
        .api_route(
            "/datasets/upload",
            post_with(upload_datasets, upload_datasets_docs),
        )
        .api_route(
            "/datasets/{id}/upload",
            post_with(upload_dataset, upload_dataset_docs),
        )
        // Add a SUPPORTING (axis-aligned annotation) file to an existing dataset
        // (ITEM-14) — fires the integrate converter. Shares the raised body limit.
        .api_route(
            "/datasets/{id}/supporting-files",
            post_with(add_supporting_file, add_supporting_file_docs),
        )
        // Read the per-request limits from the settings cache, then bound the body
        // with them. `from_fn` sees the app-root `Extension(SqlitePool)` because
        // that layer is applied OUTSIDE this sub-router.
        .layer(axum::middleware::from_fn(
            |req: axum::extract::Request, next: axum::middleware::Next| async move {
                let limits = match req.extensions().get::<sqlx::SqlitePool>() {
                    Some(pool) => upload_limits(pool).await,
                    // No pool in extensions is a boot-wiring bug, not a request the
                    // guard should let through unbounded: fall back to the compiled
                    // defaults, which carry the SaaS ceiling under saas and `None`
                    // (the ruling) on desktop — never "unlimited on saas" (INV-3).
                    None => UploadLimits {
                        max_body_bytes: upload_body_ceiling(&WorkstoreSettings::defaults()),
                        max_part_header_bytes: MAX_PART_HEADER_BYTES,
                    },
                };
                guard_upload_body(limits, req, next).await
            },
        ))
        // Removes axum's 2 MB DEFAULT so the guard above owns the policy. Applied in
        // both modes: on desktop there is no ceiling (INV-1), and under SaaS the
        // ceiling is the settings row, read per request rather than baked in here.
        .layer(DefaultBodyLimit::disable());

    ApiRouter::new()
        .api_route(
            "/datasets",
            get_with(list_mine, list_mine_docs).post_with(create_dataset, create_dataset_docs),
        )
        .api_route("/datasets/shared", get_with(list_shared, list_shared_docs))
        .api_route(
            "/datasets/artifact-summaries",
            get_with(artifact_summaries, artifact_summaries_docs),
        )
        .api_route(
            "/datasets/promote",
            post_with(promote_artifact, promote_artifact_docs),
        )
        .api_route(
            "/datasets/{id}",
            get_with(get_dataset, get_dataset_docs)
                .put_with(rename_dataset, rename_dataset_docs)
                .delete_with(delete_dataset, delete_dataset_docs),
        )
        .api_route(
            "/datasets/{id}/shares",
            get_with(list_shares, list_shares_docs).post_with(share_dataset, share_dataset_docs),
        )
        .api_route(
            "/datasets/{id}/shares/{share_id}",
            delete_with(unshare_dataset, unshare_dataset_docs),
        )
        .api_route(
            "/datasets/{id}/split",
            post_with(split_dataset, split_dataset_docs),
        )
        // Run a processor on a dataset (owner/dataset-scoped, no project) — resolves
        // the dataset's file(s) as sandbox inputs + enqueues a dataset-scoped
        // analysis job through the jobs launch path. Handler lives in `process.rs`.
        .api_route(
            "/datasets/{id}/process",
            post_with(
                super::process::process_dataset,
                super::process::process_dataset_docs,
            ),
        )
        // ---- folders (ITEM-24) ----
        .api_route(
            "/dataset-folders",
            get_with(list_folders, list_folders_docs).post_with(create_folder, create_folder_docs),
        )
        .api_route(
            "/dataset-folders/{id}",
            put_with(rename_folder, rename_folder_docs)
                .delete_with(delete_folder, delete_folder_docs),
        )
        .api_route(
            "/dataset-folders/{id}/datasets",
            get_with(list_folder_datasets, list_folder_datasets_docs),
        )
        .api_route(
            "/dataset-folders/{id}/datasets/{dataset_id}",
            post_with(add_to_folder, add_to_folder_docs)
                .delete_with(remove_from_folder, remove_from_folder_docs),
        )
        .merge(upload)
}

// ============================== CRUD (ITEM-1) ==============================

async fn list_mine(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<DatasetListQuery>,
) -> ApiResult<Json<DatasetPage>> {
    let (page, per_page) = q.clamped();
    let repo = DatasetRepository::new(pool);
    let (items, total) = repo
        .list_mine(
            auth.user.id,
            q.search_term().as_deref(),
            q.folder_id,
            page,
            per_page,
        )
        .await
        .map_err(e)?;
    let items = enrich_items(&repo, items, auth.user.id, &active_group_ids(&auth.groups)).await?;
    Ok((StatusCode::OK, Json(DatasetPage { items, total })))
}

fn list_mine_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "List datasets you own (paginated: ?page=&per_page=, default 50, cap 500; \
             optional ?search= case-insensitive name substring, ?folder_id= folder filter). \
             Returns { items, total } where total is the count matching the same filters.",
        )
        .id("Dataset.listMine")
        .tag("dataset")
        .response::<200, Json<DatasetPage>>()
}

async fn list_shared(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<DatasetListQuery>,
) -> ApiResult<Json<DatasetPage>> {
    let (page, per_page) = q.clamped();
    let repo = DatasetRepository::new(pool);
    let (items, total) = repo
        .list_shared(
            auth.user.id,
            &active_group_ids(&auth.groups),
            q.search_term().as_deref(),
            page,
            per_page,
        )
        .await
        .map_err(e)?;
    let items = enrich_items(&repo, items, auth.user.id, &active_group_ids(&auth.groups)).await?;
    Ok((StatusCode::OK, Json(DatasetPage { items, total })))
}

fn list_shared_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "List datasets shared with you (paginated: ?page=&per_page=, default 50, cap 500; \
             optional ?search= case-insensitive name substring). \
             Returns { items, total } where total is the count matching the same filters.",
        )
        .id("Dataset.listShared")
        .tag("dataset")
        .response::<200, Json<DatasetPage>>()
}

/// `GET /datasets/artifact-summaries` — "how many artifacts, and what is in there"
/// for every dataset the caller can SEE, in ONE batched read.
///
/// Takes no ids (DEC-2): the caller's visible set IS the scope, so an id list would
/// restate the ACL and force a POST for URL length. Every dataset the read COVERED is
/// present — one holding nothing arrives with a zero count and no groups — so absence
/// means "past the cap, not looked at" and nothing else (DEC-3). Both caps are
/// constants, not client input.
async fn artifact_summaries(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<DatasetArtifactSummaryList>> {
    let repo = DatasetRepository::new(pool);
    let rows = repo
        .artifact_summary_rows(
            auth.user.id,
            &active_group_ids(&auth.groups),
            SUMMARY_DATASET_CAP,
            GROUP_CAP,
        )
        .await
        .map_err(e)?;

    // The rows arrive ordered by dataset, so one pass folds them without a map. A
    // dataset holding nothing arrives as a single row with no group — it still gets a
    // summary, with an empty `groups`.
    let mut summaries: Vec<DatasetArtifactSummary> = Vec::new();
    for (dataset_id, artifact_count, total_logical_bytes, group) in rows {
        let entry = match summaries.last_mut() {
            Some(last) if last.dataset_id == dataset_id => last,
            _ => {
                summaries.push(DatasetArtifactSummary {
                    dataset_id,
                    artifact_count,
                    total_logical_bytes,
                    groups: Vec::new(),
                });
                summaries.last_mut().expect("just pushed")
            }
        };
        if let Some(group) = group {
            entry.groups.push(group);
        }
    }
    Ok((
        StatusCode::OK,
        Json(DatasetArtifactSummaryList { summaries }),
    ))
}

fn artifact_summaries_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "Artifact summaries for every dataset you can see (owned or shared with you): \
             the artifact count, the total stored size, and the per-datatype groups — each \
             carrying one representative member's manifest slot name and BOTH of its \
             producer declarations (`meta`, what the bytes mean; `structure`, how to decode \
             them), size-bounded and otherwise unread. Takes no parameters; a dataset the \
             read covered but which holds no ready, promotable, non-hidden artifact is \
             present with a zero count, so absence means only 'past the cap'.",
        )
        .id("Dataset.artifactSummaries")
        .tag("dataset")
        .response::<200, Json<DatasetArtifactSummaryList>>()
}

async fn create_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    active: crate::modules::account::ActiveAccount,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<CreateDatasetRequest>,
) -> ApiResult<Json<Dataset>> {
    if req.name.trim().is_empty() {
        return Err(e(AppError::bad_request(
            "INVALID_NAME",
            "Dataset name is required",
        )));
    }
    let repo = DatasetRepository::new(pool);
    let metadata = req.metadata.unwrap_or_else(|| serde_json::json!({}));
    // A4 ITEM-7: stamp the ACTIVE account (PROV-A4-1) — the extractor 404'd a
    // non-member header before this body ran, so the write is authorized.
    let ds = repo
        .create_in_account(
            auth.user.id,
            active.account_id,
            req.name.trim(),
            req.datatype.as_deref(),
            &metadata,
        )
        .await
        .map_err(e)?;
    publish(
        SyncEntity::Dataset,
        SyncAction::Create,
        ds.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::CREATED, Json(ds)))
}

fn create_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Create a dataset (metadata only; files land via upload or promote)")
        .id("Dataset.create")
        .tag("dataset")
        .response::<201, Json<Dataset>>()
}

async fn get_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<DatasetWithFiles>> {
    let repo = DatasetRepository::new(pool);
    // Visibility = owner ∪ sharee; a foreign dataset reads as 404. Resolved through
    // `access` rather than `is_visible_to` because the redaction below needs the
    // EDIT/VIEW distinction too, and one call answering both cannot disagree with
    // itself the way two calls can.
    let access = repo
        .access(id, auth.user.id, &active_group_ids(&auth.groups))
        .await
        .map_err(e)?;
    if access == DatasetAccess::NotVisible {
        return Err(e(AppError::not_found("Dataset")));
    }
    let dataset = repo
        .get(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;
    let files = repo.list_files(id, 1, MAX_PER_PAGE).await.map_err(e)?;
    // DERIVE the primary-processing status from the dataset's processing job so the
    // detail page shows a running / done / FAILED convert (with the reason).
    let (js, je) = repo
        .processing_status_map(&[id])
        .await
        .map_err(e)?
        .remove(&id)
        .unwrap_or((None, None));
    let (processing_status, mut processing_error) = map_processing_status(js, je);
    // Redact for anyone who may not EDIT — not merely for anyone who does not OWN.
    // See `enrich_items`: an `edit` sharee can read this exact string off the job they
    // are allowed to run, so an ownership boundary here withheld it only from people
    // who already had it, while a `view` sharee (the party it is actually for) stays
    // redacted on both this route and the list.
    if access != DatasetAccess::CanEdit {
        processing_error = None;
    }
    Ok((
        StatusCode::OK,
        Json(DatasetWithFiles {
            dataset,
            files,
            processing_status,
            processing_error,
        }),
    ))
}

fn get_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Get a dataset (owner or sharee) with its linked files")
        .id("Dataset.get")
        .tag("dataset")
        .response::<200, Json<DatasetWithFiles>>()
        .response_with::<404, (), _>(|r| r.description("Not found or not visible"))
}

async fn rename_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<RenameDatasetRequest>,
) -> ApiResult<Json<Dataset>> {
    if req.name.trim().is_empty() {
        return Err(e(AppError::bad_request(
            "INVALID_NAME",
            "Dataset name is required",
        )));
    }
    let repo = DatasetRepository::new(pool.clone());
    // MUTATION → owner ∪ `edit`-sharee (ITEM-2 role enforcement): a `view`-only
    // sharee 403s, a foreign/absent dataset 404s.
    repo.require_can_edit(id, auth.user.id, &active_group_ids(&auth.groups))
        .await
        .map_err(e)?;
    let ds = repo
        .set_name(id, req.name.trim())
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;
    // #168: membership-derived audience via `dataset_audience`, never
    // `ds.owner_id + sharee_user_ids` — that inlined pair is what kept addressing a
    // removed ex-creator. See `publish_dataset_audience`.
    publish_dataset_audience(
        &pool,
        SyncAction::Update,
        id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::OK, Json(ds)))
}

fn rename_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Rename a dataset (owner or edit-role sharee)")
        .id("Dataset.rename")
        .tag("dataset")
        .response::<200, Json<Dataset>>()
        .response_with::<403, (), _>(|r| r.description("A view-only sharee cannot edit"))
        .response_with::<404, (), _>(|r| r.description("Not found or not visible"))
}

async fn delete_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = DatasetRepository::new(pool.clone());
    // Resolve the sync audience BEFORE the delete cascades the shares away. #168: it is
    // the SAME audience the rename/upload paths now use — an account member who is told
    // when this dataset is RENAMED must be told when it is DELETED, or their list keeps
    // a phantom row until the 60s re-check. (The `auth.user.id` anchor this replaced
    // leaked nothing — `delete` is owner-gated — but it under-delivered.)
    let audience = resolve_dataset_audience_or_warn(&pool, id).await;
    // Delete is owner-only (lifecycle authority — an edit-sharee must not destroy
    // the owner's dataset); a foreign/absent id → 404 (no oracle).
    if !repo.delete(id, auth.user.id).await.map_err(e)? {
        return Err(e(AppError::not_found("Dataset")));
    }
    if let Some((anchor, sharees)) = audience {
        publish_to_all(
            SyncEntity::Dataset,
            SyncAction::Delete,
            id,
            anchor,
            &sharees,
            Actor::user(auth.user.id, origin.0),
        );
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn delete_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Delete a dataset (owner only)")
        .id("Dataset.delete")
        .tag("dataset")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Not found or not owned"))
}

// ============================== sharing (ITEM-2) ==============================

async fn list_shares(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Query(q): Query<DatasetListQuery>,
) -> ApiResult<Json<Vec<DatasetShare>>> {
    let (page, per_page) = q.clamped();
    let repo = DatasetRepository::new(pool);
    // Only the owner manages/sees the share list.
    // H-1 (#147): "owner only" means the creator who is STILL a member of the
    // dataset's account. The bare `owner_of` check this replaces was reachable by a
    // REMOVED member — and on the share route it was a complete bypass of the whole
    // fix, since every hardened predicate preserves the `dataset_shares` disjunct:
    // a removed member could self-grant an `edit` share and regain permanent access
    // to the account's dataset with no membership at all.
    if !repo.is_current_owner(id, auth.user.id).await.map_err(e)? {
        return Err(e(AppError::not_found("Dataset")));
    }
    let shares = repo.list_shares(id, page, per_page).await.map_err(e)?;
    Ok((StatusCode::OK, Json(shares)))
}

fn list_shares_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("List a dataset's shares (owner only; paginated ?page=&per_page=)")
        .id("Dataset.listShares")
        .tag("dataset")
        .response::<200, Json<Vec<DatasetShare>>>()
}

async fn share_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<ShareDatasetRequest>,
) -> ApiResult<Json<DatasetShare>> {
    if !matches!(req.principal_type.as_str(), "user" | "group") {
        return Err(e(AppError::bad_request(
            "INVALID_PRINCIPAL",
            "principal_type must be user|group",
        )));
    }
    if !matches!(req.role.as_str(), "view" | "edit") {
        return Err(e(AppError::bad_request(
            "INVALID_ROLE",
            "role must be view|edit",
        )));
    }
    let repo = DatasetRepository::new(pool.clone());
    // H-1 (#147): "owner only" means the creator who is STILL a member of the
    // dataset's account. The bare `owner_of` check this replaces was reachable by a
    // REMOVED member — and on the share route it was a complete bypass of the whole
    // fix, since every hardened predicate preserves the `dataset_shares` disjunct:
    // a removed member could self-grant an `edit` share and regain permanent access
    // to the account's dataset with no membership at all.
    if !repo.is_current_owner(id, auth.user.id).await.map_err(e)? {
        return Err(e(AppError::not_found("Dataset")));
    }
    // H-1 (#147): refuse a SELF-share. This is not tidiness — it closes the
    // USER-PRINCIPAL route into the pre-removal half of the hole the rest of this
    // branch closes post-removal. It does NOT close that half: see the NOTE below.
    //
    // Every hardened predicate deliberately preserves its `dataset_shares` disjunct
    // (the share union is orthogonal to membership by design), and `is_current_owner`
    // above only stops a REMOVED member from granting a share. But a member could
    // grant themselves an `edit` share one second BEFORE being removed and reach the
    // identical end state: permanent read+edit on the account's dataset with no
    // membership at all. The post-removal gate alone is therefore trivially
    // side-stepped by anyone who sees it coming.
    //
    // A self-share is meaningless for a legitimate user — the owner already has
    // strictly more authority than any share confers — so refusing it removes no
    // capability. The project side has always refused it (`SELF_SHARE`,
    // `project/handlers.rs`); the dataset side simply never did. Mirrors that code
    // and its status — including the ORDERING: authorization first, so a stranger
    // or a removed member gets the uniform 404 rather than a 400 that would answer a
    // different question than the one they asked.
    //
    // NOTE the residue, stated rather than glossed, because it is larger than it
    // looks: both `access` arms admit `principal_type = 'group'` with NO membership
    // conjunct, so a member can reach the IDENTICAL end state with the same single
    // request by naming a group they belong to instead of themselves. An attacker
    // "who sees the removal coming" would do exactly that. A share granted to them by
    // someone else survives too. Those are legitimate grants under the current model
    // — narrowing the share union is a change to the sharing model, not a bugfix —
    // and whether a share should outlive the recipient's membership is filed as a
    // product decision (#172). What this check buys is that the SELF-SERVE, no-second-
    // principal, no-group-needed route is closed and the rest is visible and filed,
    // rather than a hole nobody wrote down.
    //
    // Also not retroactive: `add_share` upserts, and no backfill removes self-share
    // rows written before this change. Recorded in #172.
    if req.principal_type == "user" && req.principal_id == auth.user.id {
        return Err(e(AppError::bad_request(
            "SELF_SHARE",
            "You cannot share a dataset with yourself",
        )));
    }
    let share = repo
        .add_share(id, &req.principal_type, req.principal_id, &req.role)
        .await
        .map_err(e)?;
    // Notify everyone who may now SEE it — the account's members AND every sharee,
    // including the newly-added principal's users (#168: the same audience the other
    // dataset mutations use, so the sets cannot disagree by route).
    publish_dataset_audience(
        &pool,
        SyncAction::Update,
        id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::CREATED, Json(share)))
}

fn share_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Share a dataset with a user or group (owner only)")
        .id("Dataset.share")
        .tag("dataset")
        .response::<201, Json<DatasetShare>>()
}

async fn unshare_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((id, share_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let repo = DatasetRepository::new(pool.clone());
    // H-1 (#147): "owner only" means the creator who is STILL a member of the
    // dataset's account. The bare `owner_of` check this replaces was reachable by a
    // REMOVED member — and on the share route it was a complete bypass of the whole
    // fix, since every hardened predicate preserves the `dataset_shares` disjunct:
    // a removed member could self-grant an `edit` share and regain permanent access
    // to the account's dataset with no membership at all.
    if !repo.is_current_owner(id, auth.user.id).await.map_err(e)? {
        return Err(e(AppError::not_found("Dataset")));
    }
    // Resolve the audience BEFORE removing the share (so the ex-sharee refetches).
    // #168: membership ∪ sharees, the same set every other dataset mutation fans to.
    let audience = resolve_dataset_audience_or_warn(&pool, id).await;
    if !repo.remove_share(id, share_id).await.map_err(e)? {
        return Err(e(AppError::not_found("Share")));
    }
    if let Some((anchor, sharees)) = audience {
        publish_to_all(
            SyncEntity::Dataset,
            SyncAction::Update,
            id,
            anchor,
            &sharees,
            Actor::user(auth.user.id, origin.0),
        );
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn unshare_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Remove a dataset share (owner only)")
        .id("Dataset.unshare")
        .tag("dataset")
        .response::<204, ()>()
}

// ============================== upload + split (ITEM-4) ==============================

/// The archive extensions a declared `allow_archive` manifest type accepts as a whole
/// bundle. Generic transport conventions, not domain knowledge.
///
/// It is DELIBERATELY broader than the wizard's `accept` glob, and the two are not the
/// same list. The wizard's glob is a file-picker HINT for a human choosing one file; this
/// is the server deciding whether an upload is "a set of members" or "bundles handed over
/// whole", and it must answer for every client, not only the wizard. Being broader is the
/// safe direction: an extension listed here and not there is merely one the picker does
/// not suggest, while the reverse would refuse an upload the picker had just offered.
fn is_archive_name(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    [
        ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".tar.zst",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext))
}

/// Stream a multipart upload of one-or-many `file` fields into dataset(s),
/// grouped by an optional `groups` field (a JSON array-of-arrays of file
/// indices). Default = one dataset per file (the "don't guess" behaviour — two
/// independent `.h5ad` → two datasets); an explicit group (an mtx trio → one
/// 10x matrix) is honoured + cardinality-checked against the datatype's
/// `FileLayout`.
async fn upload_datasets(
    auth: RequirePermissions<(ProjectsUse,)>,
    active: crate::modules::account::ActiveAccount,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    mut multipart: Multipart,
) -> ApiResult<Json<UploadResponse>> {
    // Collect every `file` part + an optional `groups` JSON spec + an optional
    // DECLARED `datatype` (the type-first wizard, DEC-9). A declared type lets the
    // uploader assert what the file IS instead of relying on sniff/auto-group — the
    // path that types a single bundled archive (a `.tar.gz`/`.zip` wrapping a 10x
    // trio) as `single-cell/matrix-mtx` so the converter expands it (a raw archive
    // sniffs to nothing). PLUS the `supporting` mapping (ITEM-11: tags some `file`
    // parts as axis-aligned annotations folded onto the primary dataset).
    //
    // #182: each `file` part is STREAMED to a temp file on the data volume, never
    // collected into a `Vec<u8>`. Every part is still held for the whole request
    // (group planning needs all filenames before it can decide, `repository.rs:269`),
    // but a held part is now a path + a length + a digest instead of the file
    // itself — so peak RSS is O(number of parts), not O(bytes uploaded).
    //
    // #185 §1: the part-count ceiling is read AT USE from the admin settings row
    // (`workstore_settings.max_upload_parts`, default 1024 — the value the retired
    // `MAX_UPLOAD_PARTS` const carried), so an operator can move it without a
    // rebuild. Read ONCE per request rather than per part: a limit that changed
    // mid-request would make the refusal depend on where in the body the PUT landed,
    // and the cache read is cheap but not free.
    let max_parts = crate::modules::workstore::settings_cache::get(&pool)
        .await
        .max_upload_parts_usize();
    let mut files: Vec<(String, StagedPart)> = Vec::new();
    let mut explicit_groups: Option<Vec<Vec<usize>>> = None;
    let mut declared_datatype: Option<String> = None;
    let mut supporting_specs: Option<Vec<SupportingPartSpec>> = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| e(multipart_error("INVALID_MULTIPART", "Malformed multipart body", &err)))?
    {
        // The field name is copied out BEFORE the match: reading a part now takes
        // `&mut field` (`chunk()`), which cannot coexist with a borrow held by the
        // match scrutinee.
        let field_name = field.name().map(|n| n.to_string());
        match field_name.as_deref() {
            Some("supporting") => {
                // #182: capped + streamed, not `field.text()`. A non-file field is
                // held whole by definition, so without a ceiling it is the SAME
                // unbounded-RAM defect the `file` parts had, on the same route.
                let raw = read_text_capped(
                    &mut field,
                    "supporting",
                    "INVALID_SUPPORTING",
                    "Failed to read supporting",
                )
                .await
                .map_err(e)?;
                let parsed: Vec<SupportingPartSpec> = serde_json::from_str(&raw).map_err(|err| {
                    e(AppError::bad_request(
                        "INVALID_SUPPORTING",
                        format!("supporting must be a JSON array of {{index, axis, kind?, datatype?}}: {err}"),
                    ))
                })?;
                supporting_specs = Some(parsed);
            }
            Some("file") => {
                let filename = field
                    .file_name()
                    .filter(|f| !f.trim().is_empty())
                    .map(|f| f.to_string())
                    .unwrap_or_else(|| format!("upload-{}.bin", files.len()));
                // #182: `field.bytes()` materialized the whole part, and `.to_vec()`
                // copied it a second time. Stream it to disk instead.
                //
                // The COUNT is capped before the part is read, not after. Each part's
                // retained state is tiny, but every part is held until the last group
                // is ingested (group planning needs all the filenames), and small
                // times unbounded is unbounded — a request could otherwise carry
                // ~10^8 minimal parts under the old 64 GiB body ceiling, and with no
                // arithmetic bound at all now that a desktop build has no body
                // ceiling (#185 §1). Which is why this cap survived the uncapping
                // ruling: it bounds part STATE, not file size. Refused by name,
                // before a single byte of the offending part is written to disk.
                if files.len() >= max_parts {
                    return Err(e(AppError::new(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "UPLOAD_TOO_MANY_PARTS",
                        format!(
                            "An upload may contain at most {max_parts} files; \
                             this request has more and was refused."
                        ),
                    )));
                }
                let staged = stage_multipart_field(&mut field).await.map_err(e)?;
                files.push((filename, staged));
            }
            Some("groups") => {
                let raw =
                    read_text_capped(&mut field, "groups", "INVALID_GROUPS", "Failed to read groups")
                        .await
                        .map_err(e)?;
                let parsed: Vec<Vec<usize>> = serde_json::from_str(&raw).map_err(|err| {
                    e(AppError::bad_request(
                        "INVALID_GROUPS",
                        format!("groups must be a JSON array of index arrays: {err}"),
                    ))
                })?;
                explicit_groups = Some(parsed);
            }
            Some("datatype") => {
                let raw = read_text_capped(
                    &mut field,
                    "datatype",
                    "INVALID_DATATYPE",
                    "Failed to read datatype",
                )
                .await
                .map_err(e)?;
                let dt = raw.trim().to_string();
                if !dt.is_empty() {
                    declared_datatype = Some(dt);
                }
            }
            _ => {}
        }
    }

    // A declared datatype must be a real registry type (else the upload silently
    // mistypes). Reject an unknown id up front (400).
    if let Some(dt) = &declared_datatype {
        let known = crate::modules::datatype::try_registry()
            .map(|reg| reg.get(dt).is_some())
            .unwrap_or(true); // registry not built (unit context) → don't block
        if !known {
            return Err(e(AppError::bad_request(
                "UNKNOWN_DATATYPE",
                format!("Declared datatype '{dt}' is not a known datatype"),
            )));
        }
    }

    if files.is_empty() {
        return Err(e(AppError::bad_request(
            "MISSING_FILE",
            "Multipart body has no `file` field",
        )));
    }
    // #160 — a part filename is now expected to carry a relative PATH, so its length is no
    // longer bounded by "a basename someone typed". Two things break without a bound:
    //
    //  * `files.filename` is `varchar(255)` (ziee-file's `202607140125_file_schema.sql`),
    //    so a longer name is a Postgres 22001 → a 500, raised INSIDE the per-group ingest
    //    loop, i.e. after earlier groups are already committed as datasets with enqueued
    //    converters. A half-applied upload reported as a server error.
    //  * member matching splits the whole path, and a part header may carry ~64 KiB of it
    //    (the multipart header ceiling) across up to `max_upload_parts` parts. Splitting
    //    that per file, per member, per carrier is a synchronous stretch of this handler
    //    measured in tens of seconds — an authenticated request that pins a worker.
    //
    // Refused by name, up front, before anything is created. 255 is not a policy choice
    // here; it is what the column stores, and every legitimate vendor-relative path is far
    // under it (a Visium HD member is ~60 characters plus the folder the user picked).
    // CHARACTERS, not bytes: `varchar(255)` counts characters, so a byte count both
    // refuses a legitimate 90-character CJK path and quotes the user a number they cannot
    // reconcile with what they see.
    const MAX_FILENAME_CHARS: usize = 255;
    for (fname, _staged) in &files {
        let n = fname.chars().count();
        if n > MAX_FILENAME_CHARS {
            // NAME the file — "an uploaded file" is unactionable when the upload carried
            // hundreds. Elide it, since it is caller-supplied text going into a 400 body.
            let shown: String = fname.chars().take(80).collect();
            return Err(e(AppError::bad_request(
                "FILENAME_TOO_LONG",
                format!(
                    "'{shown}…' has a {n}-character name; the maximum is \
                     {MAX_FILENAME_CHARS}. Pick the bundle folder itself rather than a \
                     folder above it, or upload it as an archive."
                ),
            )));
        }
    }
    for (fname, staged) in &files {
        if staged.is_empty() {
            return Err(e(AppError::bad_request(
                "EMPTY_FILE",
                format!("Uploaded file '{fname}' is empty"),
            )));
        }
    }

    // ITEM-11 — partition `file` parts into PRIMARY (grouped into dataset(s)) vs
    // SUPPORTING (axis-aligned annotations folded onto the primary). Supporting
    // parts are tagged by their upload-order index; they never participate in group
    // planning nor the primary content_hash (DEC-10).
    let supporting_specs = supporting_specs.unwrap_or_default();
    let supporting_by_index: std::collections::HashMap<usize, SupportingPartSpec> = {
        let mut m = std::collections::HashMap::new();
        for s in supporting_specs {
            if s.index >= files.len() {
                return Err(e(AppError::bad_request(
                    "INVALID_SUPPORTING",
                    format!(
                        "supporting file index {} is out of range (0..{})",
                        s.index,
                        files.len()
                    ),
                )));
            }
            m.insert(s.index, s);
        }
        m
    };
    // Explicit `groups` index-space is the FULL upload; mixing it with a supporting
    // partition is ambiguous — reject rather than mis-map (the wizard sends one XOR
    // the other).
    if !supporting_by_index.is_empty() && explicit_groups.is_some() {
        return Err(e(AppError::bad_request(
            "INVALID_GROUPS",
            "explicit `groups` cannot be combined with `supporting` files in one upload",
        )));
    }

    let mut primary_files: Vec<(String, StagedPart)> = Vec::new();
    let mut supporting_parts: Vec<(SupportingPartSpec, String, StagedPart)> = Vec::new();
    for (i, (fname, staged)) in files.into_iter().enumerate() {
        match supporting_by_index.get(&i) {
            Some(spec) => supporting_parts.push((spec.clone(), fname, staged)),
            None => primary_files.push((fname, staged)),
        }
    }
    if primary_files.is_empty() {
        return Err(e(AppError::bad_request(
            "SUPPORTING_WITHOUT_PRIMARY",
            "an upload with supporting files must also include at least one primary file",
        )));
    }

    // Plan groups by FILENAME over the PRIMARY files (ITEM-4 + ITEM-28): an explicit
    // spec wins; else a declared multi-member group auto-groups into ONE fixed-type
    // Manifest dataset and everything else stays one-per-file (DEC-2 default).
    let filenames: Vec<String> = primary_files.iter().map(|(name, _)| name.clone()).collect();
    // Sniff/plan against the process registry (built at boot). BOTH each group's type
    // id AND its member filenames are DATA (every capability carrier's
    // `input_requirements`, DEC-13) — resolved here, never literals in the planner.
    // S11: ALL carriers are passed, so a deployment is no longer capped at one
    // auto-grouping datatype (the planner picks the carrier that actually matches).
    let registry = crate::modules::datatype::try_registry();
    let group_specs =
        crate::modules::dataset::repository::manifest_group_specs(registry.as_deref());
    // #160: a DECLARED type is consulted FIRST. Carriers are id-sorted and the planner
    // takes the first that matches; that is arbitrary between two carriers that both match
    // one upload, and the user's stated type is not arbitrary. Without this the OTHER
    // carrier's group was stamped with the declared id while the declared type's real
    // members were sniffed one at a time — the same silent mistyping this item closes.
    let groups = plan_upload_groups_by_name_preferring(
        &filenames,
        explicit_groups.as_deref(),
        &group_specs,
        declared_datatype.as_deref(),
    )
    .map_err(|msg| e(AppError::bad_request("INVALID_GROUPS", msg)))?;

    // #160 / DEC-3 — a DECLARED multi-member container must actually GROUP, or the
    // upload is refused BY NAME.
    //
    // Without this the failure is silent and produces WRONG DATA rather than nothing:
    // `enforce_cardinality` rejects only `Single`-with->1 (a `Manifest` with 1 file
    // passes), and the group typing below prefers `declared_datatype` for every group —
    // so a type-first upload whose members did not resolve used to land as N one-file
    // datasets EACH STAMPED WITH THE BUNDLE TYPE, HTTP 200, no error anywhere, each
    // enqueuing the bundle's on-ingest converter. The user asked for one bundle and got
    // four things that claim to be bundles.
    //
    // Two exclusions, each load-bearing and each covered by a test:
    //   * an UNTYPED upload keeps the DEC-2 one-dataset-per-file default verbatim —
    //     there is no stated intent to contradict, so there is nothing to refuse;
    //   * an EXPLICIT `groups` spec is the caller's own partition and stays authoritative.
    //
    // There is NO count exemption. A declared type receiving one non-archive file used to
    // be exempt, which left the original defect open on the shortest path to it (the
    // wizard's Archive arm takes a drop of anything). The archive contract is expressed by
    // `archives_only` below, which answers for one file and for N.
    //
    // And it refuses BOTH shapes: the declared container failing to group, AND grouping
    // while other files ride along. An earlier version allowed the second, citing
    // `repository.rs`'s "extras alongside a complete group are IGNORED, not fatal" — which
    // is a statement about `detect_manifest_group`'s RETURN VALUE, in a unit test, not
    // about what this handler creates. The planner emits one group per unmatched file, so
    // a whole vendor output tree declared as its container produced one correct bundle plus
    // up to `max_upload_parts` junk datasets, with no way to undo them in one action.
    //
    // The gap is computed from the DECLARED type's own members, not from whichever
    // carrier the planner happened to pick — the planner takes the first id-sorted carrier
    // that matches, so reading the answer off its choice reports "none of your files are
    // declared members" for an upload in which every declared member resolved.
    let mut declared_group_formed: Option<Vec<usize>> = None;
    if explicit_groups.is_none() {
        if let Some(declared) = declared_datatype.as_deref() {
            if let Some(spec) = group_specs.iter().find(|g| g.datatype == declared) {
                use crate::modules::dataset::repository::{
                    explain_manifest_group, ManifestGroupOutcome,
                };
                match explain_manifest_group(&filenames, &spec.members) {
                    ManifestGroupOutcome::Grouped(found) => {
                        // The members resolved. Every OTHER primary file is, by the
                        // declaration the caller just made, not part of what they declared —
                        // and the planner makes one dataset per unmatched file, so a whole
                        // vendor output tree declared as its container produced one correct
                        // bundle plus up to `max_upload_parts` junk datasets, HTTP 200, with
                        // no way to undo them in one action.
                        //
                        // This reverses an earlier narrowing of the rule, which cited
                        // `repository.rs`'s "extras alongside a complete group are IGNORED,
                        // not fatal" — a statement about `detect_manifest_group`'s RETURN
                        // VALUE, in a unit test, not about what this handler creates. The
                        // cost of refusing is one named message the user can act on; the
                        // cost of not refusing is a thousand rows they cannot.
                        let extra = primary_files.len() - found.len();
                        if extra > 0 {
                            tracing::info!(
                                datatype = %declared,
                                files = primary_files.len(),
                                members = spec.members.len(),
                                extra,
                                "upload refused: a declared multi-file type carried files \
                                 that are not its members"
                            );
                            return Err(e(AppError::bad_request(
                                "MANIFEST_GROUP_INCOMPLETE",
                                format!(
                                    "'{declared}' declares {} member file(s), and this \
                                     upload carries {extra} other file(s) as well. Upload \
                                     just the declared members — the upload wizard's folder \
                                     mode selects them for you — or send the whole bundle as \
                                     one archive. Nothing was created.",
                                    spec.members.len()
                                ),
                            )));
                        }
                        declared_group_formed = Some(found);
                    }
                    ManifestGroupOutcome::Undeclared => {}
                    ManifestGroupOutcome::Gap(gap) => {
                        // THE ARCHIVE ESCAPE. A declared manifest type also accepts a
                        // BUNDLED archive, and an archive satisfies no member by design —
                        // so "the members did not resolve" is not a defect when the upload
                        // contains no members at all, only archives. The shipped contract
                        // is stated for one archive (`enforce_cardinality` passes a
                        // `Manifest` holding 1 file); refusing N of them would narrow a
                        // route with no versioning over a shape the wizard never emits but
                        // an API caller legitimately can.
                        //
                        // The escape is about ARCHIVES, not about COUNT: a PARTIAL member
                        // set is still refused, because there the user was plainly
                        // assembling the bundle and stopped short.
                        let allows_archive = registry
                            .as_ref()
                            .and_then(|reg| reg.get(declared))
                            .and_then(|dt| dt.input_requirements.clone())
                            .map(|ir| {
                                matches!(
                                    ir,
                                    crate::modules::datatype::types::InputRequirements::Manifest {
                                        allow_archive: true,
                                        ..
                                    }
                                )
                            })
                            .unwrap_or(false);
                        let archives_only = allows_archive
                            && gap.missing.len() == spec.members.len()
                            && gap.ambiguous.is_empty()
                            && gap.multi_claim.is_empty()
                            && filenames.iter().all(|f| is_archive_name(f));

                        // NOT gated on a COUNT. Exempting a single file left the original
                        // defect wide open on the shortest path to it: pick a manifest type
                        // in the wizard's Archive arm, drop `notes.txt` (the `accept` glob
                        // is advisory and the drop path bypasses it), and the result was a
                        // 200, a dataset stamped with the bundle type, and the bundle's
                        // on-ingest converter enqueued to fail asynchronously. The archive
                        // contract is expressed by `archives_only`, which already answers
                        // for one file and for N.
                        if !archives_only {
                            // An operator has to be able to answer "is the new gate
                            // rejecting real bundles?" — a 4xx is not logged anywhere. COUNTS
                            // and the declared id only: the paths are the caller's and there
                            // may be a thousand of them.
                            tracing::info!(
                                datatype = %declared,
                                files = primary_files.len(),
                                missing = gap.missing.len(),
                                ambiguous = gap.ambiguous.len(),
                                multi_claim = gap.multi_claim.len(),
                                scattered = gap.scattered_roots.len(),
                                "upload refused: a declared multi-file type did not group"
                            );
                            return Err(e(AppError::bad_request(
                                "MANIFEST_GROUP_INCOMPLETE",
                                format!(
                                    "'{declared}' is a multi-file type whose {} declared \
                                     members must jointly form ONE dataset, and this upload \
                                     does not supply them: {}. Nothing was created.",
                                    spec.members.len(),
                                    gap.explain()
                                ),
                            )));
                        }
                    }
                }
            }
        }
    }

    // When the DECLARED type grouped, it grouped over EVERY primary file — the refusal
    // above is what guarantees that — so the plan is not something to infer. Taking it
    // rather than the planner's is what stops this handler depending on which carrier
    // sorted first: with two carriers whose members overlap, the planner could group by the
    // OTHER one and leave the declared type's remaining members as singletons, each stamped
    // with the declared id. `plan_upload_groups_by_name_preferring` makes that choice come
    // out right too, and is unit-tested; this makes the handler not need it to.
    let groups = match &declared_group_formed {
        Some(found) => vec![crate::modules::dataset::repository::UploadGroup {
            indices: found.clone(),
            datatype: declared_datatype.clone(),
        }],
        None => groups,
    };

    // Sniff each primary file's datatype (best-effort) up front. #182: the sniff
    // input is UNCHANGED (it only ever used the first `SNIFF_MAGIC_BYTES`); only its
    // source moves from an in-RAM slice to a bounded read of the staged part's head.
    let mut sniffed: Vec<Option<String>> = Vec::with_capacity(primary_files.len());
    for (fname, staged) in &primary_files {
        let detected = match registry.as_ref() {
            Some(reg) => {
                let head = staged.head(crate::modules::datatype::SNIFF_MAGIC_BYTES).await;
                crate::modules::datatype::sniff(reg, fname, &head)
            }
            None => None,
        };
        sniffed.push(detected);
    }

    let repo = DatasetRepository::new(pool.clone());
    let file_repo = FileRepository::new(pool.clone());
    let mut out: Vec<DatasetWithFiles> = Vec::with_capacity(groups.len());
    // The import job id per created dataset (parallel to `out`) — the DAG parent the
    // supporting integrate jobs depend on (ITEM-20). `None` = the datatype had no
    // on-ingest converter (so a supporting job, if any, runs without a dep).
    let mut import_jobs: Vec<Option<Uuid>> = Vec::with_capacity(groups.len());

    for group in &groups {
        // The group's datatype: a DECLARED type (the type-first wizard) wins — it is
        // how a single bundled archive is typed as its multi-file datatype; else a
        // FIXED type when the group was auto-detected by filename (an mtx trio,
        // ITEM-28); else its representative (first) file's sniff.
        let group_datatype = declared_datatype
            .clone()
            .or_else(|| group.datatype.clone())
            .or_else(|| group.indices.first().and_then(|&i| sniffed[i].clone()));
        let layout = match (&registry, &group_datatype) {
            (Some(reg), Some(dt)) => reg.file_layout_for(dt),
            _ => None,
        };
        enforce_cardinality(layout, group.indices.len()).map_err(e)?;

        // Name the dataset after its (first) file's basename — EXCEPT for a multi-file
        // group whose members arrived with a relative path, where the basename is a file
        // INSIDE the thing the user picked. #160: a user who picks a bundle folder gets a
        // dataset named after the folder, not after whichever member sorted first (twelve
        // members and the name `counts.h5` is both uninformative and indistinguishable
        // from the single-resolution container's).
        let first_name = &primary_files[group.indices[0]].0;
        let base_name = if group.indices.len() > 1 {
            first_name
                .split(['/', '\\'])
                // `.`/`..` are not a folder the user picked — a client is free to send them
                // as part of a relative path, and a dataset called `..` helps nobody.
                .find(|s| !s.is_empty() && *s != "." && *s != "..")
                .filter(|root| *root != first_name.as_str())
                // When EVERY segment was rejected, fall back to the last segment under the
                // same rules — falling back to `rsplit('/')` re-admitted the `..` the filter
                // had just excluded, and split on one separator only.
                .or_else(|| {
                    first_name
                        .split(['/', '\\'])
                        .filter(|s| !s.is_empty() && *s != "." && *s != "..")
                        .next_back()
                })
                .unwrap_or("upload")
                .to_string()
        } else {
            first_name
                .rsplit('/')
                .next()
                .unwrap_or(first_name.as_str())
                .to_string()
        };
        // A4 ITEM-7 (blind-audit fix): the upload wizard is the PRIMARY dataset-create
        // path — stamp the ACTIVE account (PROV-A4-1), not the actor's personal one, so
        // a member uploading under an org attributes the dataset to that org (INV-2).
        let ds = repo
            .create_in_account(
                auth.user.id,
                active.account_id,
                &base_name,
                group_datatype.as_deref(),
                &serde_json::json!({}),
            )
            .await
            .map_err(e)?;

        // Ingest each file in the group into ziee-file, then link it. #182: the
        // staged temp file is MOVED into the blob store — the bytes are never
        // materialized in this process.
        for (ordinal, &fi) in group.indices.iter().enumerate() {
            let (fname, staged) = &mut primary_files[fi];
            let fname = fname.clone();
            let file = ingest_staged(
                &file_repo,
                &NoopFileEvents,
                auth.user.id,
                staged,
                &fname,
                None,
                "user",
                None,
            )
            .await
            .map_err(e)?;
            repo.link_file(ds.id, file.id, ordinal as i32)
                .await
                .map_err(e)?;
        }
        repo.recompute_content_hash(ds.id).await.map_err(e)?;

        // Re-read the dataset (content_hash now set) + its files.
        let dataset = repo.get(ds.id).await.map_err(e)?.unwrap_or(ds);
        let linked = repo
            .list_files(dataset.id, 1, MAX_PER_PAGE)
            .await
            .map_err(e)?;
        // ITEM-6: auto-run an on-ingest converter for this dataset's datatype (a no-op
        // when the datatype has no matching converter — the no-converter path stays
        // job-free, so existing "creation spawns no job" behavior is preserved).
        // BEST-EFFORT: the dataset + files are already ingested, so a transient
        // enqueue failure must NOT fail the upload — log it (the converter can be
        // re-triggered) rather than surfacing a 500 for a successful upload. The
        // returned import job id is the DAG parent for this dataset's supporting jobs.
        let import_job = match maybe_autoconvert_on_ingest(&pool, auth.user.id, &dataset, &linked)
            .await
        {
            Ok(job_id) => job_id,
            Err((_, err)) => {
                tracing::warn!(dataset_id = %dataset.id, "on-ingest auto-convert enqueue failed (upload still succeeded): {err}");
                None
            }
        };
        // Link the dataset to its PRIMARY processing job so the processing status
        // (running / done / FAILED) DERIVES on any later list/detail read.
        // Best-effort — a link failure must NOT fail an otherwise-successful upload.
        if let Some(job_id) = import_job {
            if let Err(err) = repo.set_processing_job(dataset.id, job_id).await {
                tracing::warn!(dataset_id = %dataset.id, "linking processing job failed (upload still succeeded): {err}");
            }
        }
        import_jobs.push(import_job);
        publish(
            SyncEntity::Dataset,
            SyncAction::Create,
            dataset.id,
            Audience::owner(auth.user.id),
            origin.0,
        );
        out.push(DatasetWithFiles {
            dataset,
            files: linked,
            // Fresh upload: the badge appears on the next list render (sync-refetch
            // derives it from the import job linked above).
            processing_status: None,
            processing_error: None,
        });
    }

    // ITEM-11/20 — fold the supporting files onto the primary dataset + build the
    // conversion DAG: each supporting file becomes an integrate job that DEPENDS on
    // the primary import job (so it starts `blocked` and runs only after the import
    // completes; if the import fails, the child cascade-fails). Supporting files
    // attach to the FIRST created dataset (the type-first wizard uploads one primary
    // + its annotations). BEST-EFFORT per file: the file is already linked, so an
    // enqueue hiccup is logged, not surfaced as a 500.
    if !supporting_parts.is_empty() {
        // Safe: `primary_files` non-empty ⇒ `out` non-empty.
        let target = out[0].dataset.clone();
        let deps: Vec<Uuid> = import_jobs.first().copied().flatten().into_iter().collect();
        for (spec, fname, mut staged) in supporting_parts {
            // Resolve the supporting datatype + kind, then run the SAME four gates the
            // dedicated endpoint enforces (cap / carve-out / primary type / unknown
            // axis) — this path previously trusted the body unchecked. A gate failure
            // is a hard 422 (the primary dataset(s) are already created; the request
            // errors rather than silently accepting an invalid supporting file).
            let kind = match spec
                .kind
                .clone()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty())
            {
                Some(k) => k,
                None => default_supporting_kind()?,
            };
            // A carve-out kind is refused with its OWN code, before the datatype
            // resolution can report it as merely undeclared (DEC-17 ordering).
            reject_carved_out_kind(&kind)?;
            // Supporting datatype from its KIND, not a generic sniff (see the dedicated
            // endpoint); an explicit `datatype` still wins. An UNDECLARED kind is a
            // typed 422, never a silently mistyped (and therefore never-integrated)
            // file — S10.
            let datatype = match spec.datatype.clone().filter(|d| !d.trim().is_empty()) {
                Some(d) => d,
                None => supporting_datatype_for_kind(&kind)
                    .ok_or_else(|| unknown_supporting_kind(&kind))?,
            };
            validate_supporting_file(&repo, &target, &datatype, &kind, &spec.axis).await?;

            let file = ingest_staged(
                &file_repo,
                &NoopFileEvents,
                auth.user.id,
                &mut staged,
                &fname,
                None,
                "user",
                None,
            )
            .await
            .map_err(e)?;
            let ordinal = repo.file_count(target.id).await.map_err(e)? as i32;
            repo.link_file_with_role(target.id, file.id, ordinal, "supporting", Some(&kind))
                .await
                .map_err(e)?;
            let df = DatasetFile {
                file_id: file.id,
                filename: fname.clone(),
                file_size: staged.size() as i64,
                ordinal,
                role: "supporting".to_string(),
                kind: Some(kind),
                integration_status: None,
                integration_summary: None,
            };
            match super::process::maybe_integrate_on_add(
                &pool,
                auth.user.id,
                &target,
                &datatype,
                &df,
                &spec.axis,
                &deps,
            )
            .await
            {
                Ok(Some(job_id)) => {
                    // ITEM-17 parity — record the `kind='integrate'` provenance run in
                    // the combined-upload path too (previously only the add-later
                    // endpoint did).
                    record_integrate_run(
                        &pool,
                        &target,
                        file.id,
                        &staged.content_hash(),
                        &spec.axis,
                        job_id,
                        auth.user.id,
                    )
                    .await;
                }
                Ok(None) => {}
                Err((_, err)) => {
                    tracing::warn!(dataset_id = %target.id, file_id = %file.id, "supporting-file integrate enqueue failed (upload still succeeded): {err}");
                }
            }
        }
        // Refresh the target dataset's file list so the response includes the
        // just-linked supporting files.
        out[0].files = repo
            .list_files(target.id, 1, MAX_PER_PAGE)
            .await
            .map_err(e)?;
    }

    Ok((StatusCode::OK, Json(UploadResponse { datasets: out })))
}

/// ITEM-6 — on-ingest auto-trigger. If the freshly-created `dataset`'s `datatype`
/// declares an `on-ingest` converter in the extension registry, enqueue a
/// zero-param converter job scoped to this dataset. REUSES the `process_dataset`
/// enqueue path: build an [`AnalysisSpec`] with `code_ref = converter.run.entry`
/// (`params = {}`), append the dataset's file(s) as `dataset_file_ref` inputs via
/// the shared [`build_dataset_inputs`](super::process::build_dataset_inputs),
/// create the dataset-scoped job, and publish the owner-scoped sync signal (the
/// scheduler picks it up on its next tick). No matching converter → NO job (the
/// existing create/upload "no job" behavior is preserved).
async fn maybe_autoconvert_on_ingest(
    pool: &SqlitePool,
    owner_id: Uuid,
    dataset: &Dataset,
    files: &[DatasetFile],
) -> Result<Option<Uuid>, (StatusCode, AppError)> {
    // Only a typed dataset with at least one file can drive a converter.
    let Some(datatype) = dataset.datatype.as_deref() else {
        return Ok(None);
    };
    if files.is_empty() {
        return Ok(None);
    }
    // A recognized on-ingest converter for this datatype (else: nothing to do).
    let Some(converter) = crate::modules::extensions::find_on_ingest_converter(datatype) else {
        return Ok(None);
    };

    // Build the converter's zero-param spec (code_ref = run.entry, language =
    // run.runtime), then append the dataset's file(s) as sandbox inputs — the SAME
    // `build_dataset_inputs` the `/datasets/{id}/process` path uses.
    let mut spec: AnalysisSpec = serde_json::from_value(serde_json::json!({
        "language": converter.runtime,
        "code_ref": converter.entry,
        // M3: thread the owning package so `code_ref` resolves in the CORRECT package.
        "package": converter.extension_id,
        // #189: the converter's DECLARED env. Server-derived (this spec is built here,
        // not supplied by a caller), so it needs no `with_declared_env` overwrite.
        "env": converter.env,
        "params": {},
    }))
    .map_err(|err| {
        e(AppError::internal_error(format!(
            "build converter spec: {err}"
        )))
    })?;
    spec.inputs
        .extend(super::process::build_dataset_inputs(files, "dataset"));

    // Re-serialize + validate the COMPLETE spec through the SAME codec the runner
    // uses (script/code_ref presence + the path-injection guard) — a bad spec fails
    // here at create, not at dispatch.
    let params = serde_json::to_value(&spec).map_err(|err| {
        e(AppError::internal_error(format!(
            "serialize converter spec: {err}"
        )))
    })?;
    AnalysisSpec::parse(&params).map_err(e)?;

    // Enqueue through the SAME jobs launch path the `/process` flow uses — scoped to
    // this dataset (owner processing), a zero-param `analysis` job.
    let create = CreateJobRequest {
        job_type: "analysis".to_string(),
        name: Some(format!("Convert {}", dataset.name)),
        params: Some(params),
        priority_class: Some(PriorityClass::Normal.as_str().to_string()),
        resource_class: Some(resolve_resource_class(None).as_str().to_string()),
        project_id: None,
        dataset_id: Some(dataset.id),
    };
    let job = JobRepository::new(pool.clone())
        .create(owner_id, &create)
        .await
        .map_err(e)?;

    // Tell the owner's OTHER devices a job appeared (owner-scoped). The scheduler
    // picks it up on its next tick (no start action for the user).
    seams::sync_sink().publish_job_changed(owner_id, seams::JobChange::Created, job.id);
    tracing::info!(
        dataset_id = %dataset.id, %datatype, extension = %converter.extension_id,
        converter = %converter.converter_id, job_id = %job.id,
        "on-ingest converter auto-enqueued for uploaded dataset"
    );
    Ok(Some(job.id))
}

fn upload_datasets_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Upload one-or-many files → dataset(s), grouped by FileLayout (streaming)")
        .id("Dataset.upload")
        .tag("dataset")
        .response::<200, Json<UploadResponse>>()
        .response_with::<400, (), _>(|r| r.description("Missing/empty file or invalid grouping"))
        .response_with::<413, (), _>(|r| {
            r.description(
                "Too large. `UPLOAD_TOO_LARGE`: the body exceeds the configured upload ceiling (`workstore_settings.max_upload_body_bytes`) — SaaS deployments only; a desktop/self-hosted deployment imposes no upload size ceiling, so this code cannot arise there. `UPLOAD_FIELD_TOO_LARGE`: a non-file field, or one part's multipart header block, exceeds its cap — both modes. `UPLOAD_TOO_MANY_PARTS`: more file parts than `workstore_settings.max_upload_parts` — both modes.",
            )
        })
        .response_with::<507, (), _>(|r| {
            r.description(
                "The server could not write the upload to disk (`UPLOAD_STORAGE_UNAVAILABLE`)",
            )
        })
}

/// Upload ONE file INTO an existing dataset (ITEM-4): store the blob in ziee-file
/// (owner-scoped by the uploader), sniff its datatype (P2 sniff-on-upload), link
/// it onto the dataset + re-merkle the `content_hash`, and record a deployment
/// global `kind='upload'` provenance reference root so every backward walk
/// terminates at a checksummed upload root. Owner-only (a foreign / nonexistent
/// dataset reads as 404). `Multipart` is the request BODY → the last extractor.
async fn upload_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<Json<DatasetFileUploadResponse>> {
    let repo = DatasetRepository::new(pool.clone());

    // MUTATION → owner ∪ `edit`-sharee (ITEM-2 role enforcement): a `view`-only
    // sharee 403s; a foreign/absent id → 404 (no existence oracle).
    repo.require_can_edit(id, auth.user.id, &active_group_ids(&auth.groups))
        .await
        .map_err(e)?;
    let dataset = repo
        .get(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;

    // Pull the single `file` field out of the multipart body. #182: streamed to a
    // temp file, never held whole in this process.
    let mut filename = String::from("upload.bin");
    let mut file_part: Option<StagedPart> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|err| {
        e(multipart_error(
            "INVALID_MULTIPART",
            "Malformed multipart body",
            &err,
        ))
    })? {
        if field.name() == Some("file") {
            if let Some(fname) = field.file_name() {
                if !fname.trim().is_empty() {
                    filename = fname.to_string();
                }
            }
            file_part = Some(stage_multipart_field(&mut field).await.map_err(e)?);
        }
    }

    let mut staged = file_part.ok_or_else(|| {
        e(AppError::bad_request(
            "MISSING_FILE",
            "Multipart body has no `file` field",
        ))
    })?;
    if staged.is_empty() {
        return Err(e(AppError::bad_request(
            "EMPTY_FILE",
            "Uploaded file is empty",
        )));
    }

    // P2 sniff-on-upload: type the blob by extension + magic bytes (best-effort;
    // an unrecognized file yields `None` — the FE shows "unknown"). The sniff input
    // is unchanged: the same bounded head, read from the staged part.
    let detected_datatype = match crate::modules::datatype::try_registry() {
        Some(reg) => {
            let head = staged.head(crate::modules::datatype::SNIFF_MAGIC_BYTES).await;
            crate::modules::datatype::sniff(&reg, &filename, &head)
        }
        None => None,
    };

    // Persist to the blob store (owner-scoped by the uploader via `ingest_staged`).
    let file_repo = FileRepository::new(pool.clone());
    let file = ingest_staged(
        &file_repo,
        &NoopFileEvents,
        auth.user.id,
        &mut staged,
        &filename,
        None,
        "user",
        None,
    )
    .await
    .map_err(e)?;

    // Link the blob onto the dataset (append at the next ordinal) + re-merkle.
    let ordinal = repo.file_count(id).await.map_err(e)? as i32;
    repo.link_file(id, file.id, ordinal).await.map_err(e)?;
    repo.recompute_content_hash(id).await.map_err(e)?;
    let dataset = repo.get(id).await.map_err(e)?.unwrap_or(dataset);

    // Record a hashed root — a deployment-global (`project_id` NULL) provenance
    // reference of kind 'upload' — so every backward provenance walk terminates at
    // a checksummed upload root. Best-effort: NEVER fail the upload on a
    // provenance hiccup.
    // #182: the SAME sha256 over the SAME bytes, computed while streaming rather
    // than over an in-RAM slice — so the recorded upload root is unchanged.
    let content_hash = staged.content_hash();
    if let Err(err) = ProvenanceRepository::new(pool.clone())
        .insert_reference(&NewReference {
            project_id: None,
            kind: "upload".to_string(),
            name: filename.clone(),
            version: String::new(),
            accession: None,
            doi: None,
            content_hash,
        })
        .await
    {
        tracing::warn!(
            "dataset upload root-reference record failed (upload still succeeded): {err}"
        );
    }

    // Notify everyone who may currently SEE the dataset that it changed.
    //
    // AUDIENCE-addressed, not actor-addressed: this handler is gated by
    // `require_can_edit`, so an `edit`-role sharee reaches it and `auth.user.id` is who
    // changed it (and whose connection `origin` suppresses), not whose data changed.
    // #168: the audience is resolved from CURRENT account membership u shares rather
    // than from `dataset.owner_id + sharee_user_ids`, which addressed the creating
    // member forever.
    publish_dataset_audience(
        &pool,
        SyncAction::Update,
        id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;

    Ok((
        StatusCode::OK,
        Json(DatasetFileUploadResponse {
            file_id: file.id,
            detected_datatype,
            dataset,
        }),
    ))
}

fn upload_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description(
            "Upload a file into an existing dataset (multipart `file`; owner or edit-role sharee)",
        )
        .id("Dataset.uploadFile")
        .tag("dataset")
        .response::<200, Json<DatasetFileUploadResponse>>()
        .response_with::<400, (), _>(|r| r.description("Missing/empty file"))
        .response_with::<413, (), _>(|r| {
            r.description(
                "Too large. `UPLOAD_TOO_LARGE`: the body exceeds the configured upload ceiling (`workstore_settings.max_upload_body_bytes`) — SaaS deployments only; a desktop/self-hosted deployment imposes no upload size ceiling, so this code cannot arise there. `UPLOAD_FIELD_TOO_LARGE`: this route reads no non-file fields, but a part's multipart header block is still capped — both modes.",
            )
        })
        .response_with::<507, (), _>(|r| {
            r.description(
                "The server could not write the upload to disk (`UPLOAD_STORAGE_UNAVAILABLE`)",
            )
        })
        .response_with::<403, (), _>(|r| r.description("A view-only sharee cannot edit"))
        .response_with::<404, (), _>(|r| r.description("Dataset not found or not visible"))
}

/// A supporting file's datatype is derived from its KIND (a supporting upload arrives
/// in a KNOWN role), NOT from a generic content sniff. This is deliberate — a
/// supporting type is excluded from the PRIMARY sniff pool (see the manifests), so a
/// supporting `.csv` resolves here by its declared kind rather than by its extension.
/// An explicit `datatype` field still wins; carved-out kinds are rejected by the gate.
///
/// This paragraph used to continue "…so a generic `.csv` primary upload still sniffs
/// to `de`". That claim is RETIRED: the producer-less `de` type was pruned, it was the
/// only type declaring a `.csv` ingest hint, and `datatype::sniff` now answers `None`
/// for a plain `.csv` (the caller shows "unknown"). Which sharpens the contrast rather
/// than weakening it — a supporting `.csv` is typed by its declared role precisely
/// BECAUSE an extension alone cannot type a `.csv` at all. Enforced by
/// `server/tests/datatype/cross_side_test.rs`.
///
/// ## S10 — this used to ignore its argument
///
/// The body was `fn supporting_datatype_for_kind(_kind: &str) -> String {
/// "annotation-table".to_string() }`: EVERY kind resolved to one package's datatype.
/// On a deployment without that package the failure is SILENT — the four gates pass,
/// `find_on_integrate_converter` matches nothing, `maybe_integrate_on_add` answers
/// `Ok(None)`, and the file is linked with `integration_status = NULL` forever with
/// no job, no error and no log.
///
/// The pairing was already DATA (`accepts: {role: supporting, kind, type_id}`); the
/// resolver now reads it, and an undeclared kind is `None` so the caller can refuse
/// loudly ([`unknown_supporting_kind`]) instead of mistyping the file.
fn supporting_datatype_for_kind(kind: &str) -> Option<String> {
    crate::modules::extensions::supporting_datatype_for_kind(kind)
}

/// Reject a CARVE-OUT kind (DEC-17) before anything else looks at it.
///
/// A `reference` / `index_companion` is not a per-dataset supporting file at all, so
/// it has (and needs) no supporting DATATYPE — asking [`supporting_datatype_for_kind`]
/// about it would answer `UNKNOWN_SUPPORTING_KIND` ("no package declares this kind"),
/// which is true but misleading: the kind is understood, it is routed elsewhere.
/// Ordering this first keeps the dedicated `UNSUPPORTED_SUPPORTING_KIND` answer.
/// [`validate_supporting_file`] re-checks it (it is the shared gate both upload paths
/// run), so this is an ordering guard, not a replacement.
fn reject_carved_out_kind(kind: &str) -> Result<(), (StatusCode, AppError)> {
    use crate::modules::datatype::types::SupportingKind;
    let parsed: SupportingKind =
        serde_json::from_value(serde_json::Value::String(kind.to_string()))
            .unwrap_or_else(|_| SupportingKind::Other(kind.to_string()));
    if matches!(
        parsed,
        SupportingKind::Reference | SupportingKind::IndexCompanion
    ) {
        return Err(e(AppError::unprocessable_entity(
            "UNSUPPORTED_SUPPORTING_KIND",
            format!("Supporting kind '{kind}' is not stored per-dataset (references live in the shared library; index/companion route to the primary import)"),
        )));
    }
    Ok(())
}

/// The typed 422 for a `kind` no installed package declares (S10). Names what IS
/// declared, so the operator can see immediately that the package is missing rather
/// than watching an upload sit at "not integrated" forever.
fn unknown_supporting_kind(kind: &str) -> (StatusCode, AppError) {
    let declared: Vec<String> = crate::modules::extensions::declared_supporting_kinds()
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    e(AppError::unprocessable_entity(
        "UNKNOWN_SUPPORTING_KIND",
        format!(
            "No installed package declares the supporting kind '{kind}' (declared kinds: \
             {declared:?}), so this file has no datatype and could never be integrated. \
             Install the package that declares it, or send an explicit `datatype`."
        ),
    ))
}

/// The supporting `kind` for an upload that did not send one (S10). Resolved from the
/// registry: exactly one declared kind ⇒ that one (byte-identical to the
/// `"annotation_table"` literal this replaces on a stock deployment); zero or several
/// ⇒ a typed 422 asking the client to say which, rather than assuming a domain.
fn default_supporting_kind() -> Result<String, (StatusCode, AppError)> {
    crate::modules::extensions::sole_supporting_kind().ok_or_else(|| {
        let declared: Vec<String> = crate::modules::extensions::declared_supporting_kinds()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        e(AppError::unprocessable_entity(
            "MISSING_SUPPORTING_KIND",
            format!(
                "A `kind` field is required: this deployment declares {} supporting kinds \
                 ({declared:?}), so there is no unambiguous default",
                declared.len()
            ),
        ))
    })
}

/// The FOUR supporting-file validation gates, shared by the dedicated endpoint
/// (`add_supporting_file`) AND the combined-upload supporting loop
/// (`upload_datasets`) so both enforce IDENTICAL rules (a confirmed security gap:
/// the combined-upload path trusted `axis`/`kind`/`datatype` from the body with none
/// of these). Returns the typed 422 on the first failing gate; `Ok` when all pass.
/// Order mirrors the original endpoint: cap → carve-out kind → primary type → axis.
async fn validate_supporting_file(
    repo: &DatasetRepository,
    dataset: &Dataset,
    datatype: &str,
    kind: &str,
    axis: &str,
) -> Result<(), (StatusCode, AppError)> {
    // Per-dataset supporting cap (DEC-12).
    if repo.supporting_file_count(dataset.id).await.map_err(e)? as usize
        >= super::process::MAX_SUPPORTING_FILES_PER_DATASET
    {
        return Err(e(AppError::unprocessable_entity(
            "SUPPORTING_LIMIT",
            format!(
                "This dataset already has the maximum of {} supporting files",
                super::process::MAX_SUPPORTING_FILES_PER_DATASET
            ),
        )));
    }
    // Carve-out kinds (DEC-17): a reference / index_companion is NOT a per-dataset
    // supporting file. Parse the open `kind` string into the typed `SupportingKind`
    // (unknown → `Other`, never an error) and gate on the VARIANT, so the taxonomy is
    // the single source of truth rather than a parallel string list.
    use crate::modules::datatype::types::SupportingKind;
    let parsed_kind: SupportingKind =
        serde_json::from_value(serde_json::Value::String(kind.to_string()))
            .unwrap_or_else(|_| SupportingKind::Other(kind.to_string()));
    if matches!(
        parsed_kind,
        SupportingKind::Reference | SupportingKind::IndexCompanion
    ) {
        return Err(e(AppError::unprocessable_entity(
            "UNSUPPORTED_SUPPORTING_KIND",
            format!("Supporting kind '{kind}' is not stored per-dataset (references live in the shared library; index/companion route to the primary import)"),
        )));
    }
    // A dataset-INPUT (primary) datatype is not a supporting type — the dataset
    // already has its primary (`PRIMARY_ALREADY_SET`).
    if crate::modules::extensions::is_dataset_input(datatype) {
        return Err(e(AppError::unprocessable_entity(
            "PRIMARY_ALREADY_SET",
            format!("'{datatype}' is a primary dataset input; this dataset already has a primary. Only supporting types can be added"),
        )));
    }
    // The axis MUST be one the dataset DECLARES (DEC-6/DEC-15). Resolve the dataset's
    // datatype → its declared axes via the P2 registry; an unknown axis → 422.
    let declared_axes: Vec<String> = dataset
        .datatype
        .as_deref()
        .and_then(|dt| {
            crate::modules::datatype::try_registry().map(|reg| {
                reg.axes_for(dt)
                    .into_iter()
                    .map(|a| a.name)
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    if !declared_axes.iter().any(|a| a == axis) {
        return Err(e(AppError::unprocessable_entity(
            "UNKNOWN_AXIS",
            format!("Axis '{axis}' is not one of this dataset's declared axes {declared_axes:?}"),
        )));
    }
    Ok(())
}

/// Record a `kind='integrate'` provenance run node (ITEM-17) for a supporting-file
/// integration, shared by the dedicated endpoint AND the combined-upload path (which
/// previously recorded nothing). Best-effort: a provenance hiccup never fails the
/// already-linked supporting add. A dataset with no primary `content_hash` records
/// nothing (the forward walk's used-edge requires the hash). The annotation used-edge
/// carries the documented `upload` kind (a hashed user-uploaded file), and the dataset
/// edge uses [`recorder::dataset_edge`] — replacing the ad-hoc `kind="supporting"`.
async fn record_integrate_run(
    pool: &SqlitePool,
    dataset: &Dataset,
    file_id: Uuid,
    // #182: the annotation's `sha256:<hex>`, computed while the part was streamed to
    // disk — the SAME digest over the SAME bytes. Takes the HASH rather than the
    // bytes so this function can never be handed a whole file again.
    annotation_hash: &str,
    axis: &str,
    job_id: Uuid,
    acting_user: Uuid,
) {
    let Some(hash) = dataset.content_hash.clone() else {
        return;
    };
    // Both used-edges MUST carry a `content_hash` (the forward walk's `UsedEdgeDto`
    // requires it, all-or-nothing per run): the dataset's primary hash + the
    // annotation file's own content hash.
    let inputs = serde_json::to_value([
        dataset_edge("dataset", dataset.id, &hash),
        UsedEdgeDto {
            slot: "annotation".to_string(),
            kind: "upload".to_string(),
            ref_id: Some(file_id),
            content_hash: annotation_hash.to_string(),
            // A server-derived integrate input: nobody picked it from candidates, so
            // its origin is UNSTATED (never `user` — ITEM-18 / DEC-7).
            bound_by: None,
        },
    ])
    .unwrap_or_else(|_| serde_json::json!([]));
    let integrate_run = NewRun {
        run_id: Uuid::new_v4(),
        project_id: None,
        dataset_id: Some(dataset.id),
        kind: "integrate".to_string(),
        status: "completed".to_string(),
        generator_id: "dataset.integrate".to_string(),
        generator_version: env!("CARGO_PKG_VERSION").to_string(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        seed: Some(0),
        params: serde_json::json!({ "job_id": job_id, "axis": axis, "supporting_file_id": file_id }),
        inputs_json: inputs,
        acting_user: Some(acting_user),
        rerun_spec_json: None,
    };
    if let Err(err) = ProvenanceRepository::new(pool.clone())
        .insert_run(&integrate_run)
        .await
    {
        tracing::warn!(dataset_id = %dataset.id, "integrate provenance run record failed: {err}");
    }
}

/// Add ONE SUPPORTING (axis-aligned annotation) file to an existing dataset
/// (ITEM-14, `POST /datasets/{id}/supporting-files`). Owner ∪ edit-role sharee
/// (mirrors `{id}/upload`). Accepts multipart `file` + `axis` (required — one of the
/// dataset's DECLARED axes) + optional `kind` (default `annotation_table`) + optional
/// `datatype` (else sniffed, else `annotation-table`). REJECTS (422): a file whose
/// datatype is a dataset-INPUT/primary type (`PRIMARY_ALREADY_SET`), a carved-out
/// `reference`/`index_companion` kind (`UNSUPPORTED_SUPPORTING_KIND`, DEC-17), an
/// axis not declared by the dataset (`UNKNOWN_AXIS`), or the per-dataset cap
/// (`SUPPORTING_LIMIT`). On success the file is linked `role=supporting` and the
/// integrate converter is fired (the import is already complete, so the integrate
/// job has no unmet dep and runs). `Multipart` is the request BODY → the last extractor.
async fn add_supporting_file(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<Json<DatasetFileUploadResponse>> {
    let repo = DatasetRepository::new(pool.clone());

    // MUTATION → owner ∪ edit-sharee; a view-only sharee 403s, a foreign/absent id 404s.
    repo.require_can_edit(id, auth.user.id, &active_group_ids(&auth.groups))
        .await
        .map_err(e)?;
    let dataset = repo
        .get(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;

    // Pull the `file` bytes + the `axis`/`kind`/`datatype` text fields.
    let mut filename = String::from("supporting.bin");
    let mut file_part: Option<StagedPart> = None;
    let mut axis: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut datatype_field: Option<String> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|err| {
        e(multipart_error(
            "INVALID_MULTIPART",
            "Malformed multipart body",
            &err,
        ))
    })? {
        // Copied out before the match — reading a part takes `&mut field`.
        let field_name = field.name().map(|n| n.to_string());
        match field_name.as_deref() {
            Some("file") => {
                if let Some(fname) = field.file_name() {
                    if !fname.trim().is_empty() {
                        filename = fname.to_string();
                    }
                }
                file_part = Some(stage_multipart_field(&mut field).await.map_err(e)?);
            }
            // #182: every non-file field is capped + streamed here too — an
            // uncapped `axis`/`kind`/`datatype` is the same unbounded allocation
            // under the same 64 GiB body limit.
            Some("axis") => {
                axis = Some(
                    read_text_capped(&mut field, "axis", "INVALID_AXIS", "Failed to read axis")
                        .await
                        .map_err(e)?,
                );
            }
            Some("kind") => {
                kind = Some(
                    read_text_capped(&mut field, "kind", "INVALID_KIND", "Failed to read kind")
                        .await
                        .map_err(e)?,
                );
            }
            Some("datatype") => {
                datatype_field = Some(
                    read_text_capped(
                        &mut field,
                        "datatype",
                        "INVALID_DATATYPE",
                        "Failed to read datatype",
                    )
                    .await
                    .map_err(e)?,
                );
            }
            _ => {}
        }
    }

    let mut staged = file_part.ok_or_else(|| {
        e(AppError::bad_request(
            "MISSING_FILE",
            "Multipart body has no `file` field",
        ))
    })?;
    if staged.is_empty() {
        return Err(e(AppError::bad_request(
            "EMPTY_FILE",
            "Uploaded file is empty",
        )));
    }
    let axis = axis
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| {
            e(AppError::bad_request(
                "MISSING_AXIS",
                "An `axis` field is required",
            ))
        })?;
    let kind = match kind.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
        Some(k) => k,
        None => default_supporting_kind()?,
    };

    // A carve-out kind is refused with its OWN code, before the datatype resolution
    // can report it as merely undeclared (DEC-17 ordering).
    reject_carved_out_kind(&kind)?;

    // Resolve the supporting file's datatype: explicit field → DECLARED for its KIND
    // (NOT a generic sniff — a supporting type is intentionally not a primary sniff
    // candidate). An undeclared kind is a typed 422 (S10): mistyping the file makes
    // it match no `on-integrate` converter, and that outcome is silent.
    let datatype = match datatype_field
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
    {
        Some(d) => d,
        None => {
            supporting_datatype_for_kind(&kind).ok_or_else(|| unknown_supporting_kind(&kind))?
        }
    };

    // The four supporting-file gates (cap / carve-out kind / primary type / unknown
    // axis) — the SAME helper the combined-upload supporting loop calls, so both
    // paths enforce identical rules.
    validate_supporting_file(&repo, &dataset, &datatype, &kind, &axis).await?;

    // Persist the blob (owner-scoped) + link it `role=supporting` at the next ordinal.
    let file_repo = FileRepository::new(pool.clone());
    let file = ingest_staged(
        &file_repo,
        &NoopFileEvents,
        auth.user.id,
        &mut staged,
        &filename,
        None,
        "user",
        None,
    )
    .await
    .map_err(e)?;
    let ordinal = repo.file_count(id).await.map_err(e)? as i32;
    repo.link_file_with_role(id, file.id, ordinal, "supporting", Some(&kind))
        .await
        .map_err(e)?;

    // Fire the integrate converter (Phase B: the import is complete, so no dep → runs
    // now). Best-effort: the file is already linked; an enqueue hiccup is logged.
    let df = DatasetFile {
        file_id: file.id,
        filename: filename.clone(),
        file_size: staged.size() as i64,
        ordinal,
        role: "supporting".to_string(),
        kind: Some(kind),
        integration_status: None,
        integration_summary: None,
    };
    match super::process::maybe_integrate_on_add(
        &pool,
        auth.user.id,
        &dataset,
        &datatype,
        &df,
        &axis,
        &[],
    )
    .await
    {
        Ok(Some(job_id)) => {
            // ITEM-17 — record the `kind='integrate'` provenance run node
            // (dataset-scoped), the SAME helper the combined-upload path now calls so
            // the integration derivation shows in the forward provenance graph.
            record_integrate_run(
                &pool,
                &dataset,
                file.id,
                &staged.content_hash(),
                &axis,
                job_id,
                auth.user.id,
            )
            .await;
        }
        Ok(None) => {}
        Err((_, err)) => {
            tracing::warn!(dataset_id = %id, file_id = %file.id, "supporting-file integrate enqueue failed (link still succeeded): {err}");
        }
    }

    // Re-read the dataset (unchanged content_hash — supporting is additive, DEC-10)
    // and notify the owner + sharees.
    let dataset = repo.get(id).await.map_err(e)?.unwrap_or(dataset);
    // AUDIENCE-addressed (see `upload_dataset`): `require_can_edit` lets an `edit`-role
    // sharee add a supporting file, and everyone who may currently SEE the dataset must
    // be told — resolved from CURRENT membership u shares, not from `dataset.owner_id`
    // (#168).
    publish_dataset_audience(
        &pool,
        SyncAction::Update,
        id,
        Actor::user(auth.user.id, origin.0),
    )
    .await;

    Ok((
        StatusCode::OK,
        Json(DatasetFileUploadResponse {
            file_id: file.id,
            detected_datatype: Some(datatype),
            dataset,
        }),
    ))
}

fn add_supporting_file_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Add a supporting (axis-aligned annotation) file to a dataset (multipart `file` + `axis`; owner or edit-role sharee) — fires the integrate converter")
        .id("Dataset.addSupportingFile")
        .tag("dataset")
        .response::<200, Json<DatasetFileUploadResponse>>()
        .response_with::<400, (), _>(|r| r.description("Missing/empty file or missing axis"))
        .response_with::<413, (), _>(|r| {
            r.description(
                "Too large. `UPLOAD_TOO_LARGE`: the body exceeds the configured upload ceiling (`workstore_settings.max_upload_body_bytes`) — SaaS deployments only; a desktop/self-hosted deployment imposes no upload size ceiling, so this code cannot arise there. `UPLOAD_FIELD_TOO_LARGE`: a non-file field, or one part's multipart header block, exceeds its cap — both modes.",
            )
        })
        .response_with::<507, (), _>(|r| {
            r.description(
                "The server could not write the upload to disk (`UPLOAD_STORAGE_UNAVAILABLE`)",
            )
        })
        .response_with::<403, (), _>(|r| r.description("A view-only sharee cannot edit"))
        .response_with::<404, (), _>(|r| r.description("Dataset not found or not visible"))
        .response_with::<422, (), _>(|r| r.description("Primary type / carved-out kind / unknown axis / supporting cap"))
}

// ============================== promote (ITEM-7) ==============================

/// Promote a `role='artifact'` workstore output to a NEW owner-scoped Dataset
/// (DEC-7). **Byte-preserving:** the artifact's bytes are read from the workstore
/// object store and re-ingested into ziee-file, so the new dataset's merkle
/// `content_hash` equals the source artifact's `content_hash`. Records a
/// `kind='promote'` provenance run node (source artifact → promoted dataset,
/// dataset-scoped) so the derivation chain crosses the promote boundary.
///
/// Gated by artifact-read (the artifact's OWN scope — project role OR dataset
/// owner/sharee) + dataset-create (the promoter owns the new dataset). Only
/// `role='artifact'` outputs are promotable — a `role='intermediate'` output → 422.
async fn promote_artifact(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<PromoteRequest>,
) -> ApiResult<Json<DatasetWithFiles>> {
    // 1. Load the source artifact (foreign/nonexistent → 404, no oracle).
    let catalog = CatalogRepository::new(pool.clone());
    let artifact = catalog
        .get_any_status(req.artifact_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Artifact")))?;

    // 2. Artifact-read authz: dispatches on the artifact's own tenancy scope
    //    (project role, or dataset owner/sharee) — a foreign artifact reads as 404.
    require_artifact_read(&pool, &artifact, auth.user.id).await?;

    // 2b. ITEM-18 / DEC-12 — the READ half of the conformance gate, and the surface where
    //     forgetting it costs the most. Promote is BYTE-PRESERVING: it re-ingests the
    //     artifact's bytes into ziee-file as a new owner-scoped Dataset. A `datasets` row
    //     carries no conformance status, so a condemned artifact promoted once is laundered
    //     PERMANENTLY — the flag stays on the artifact and the copy that outlives it has
    //     nothing on it at all. Refused before any byte is read.
    //
    //     Placed after authz (the refusal names the artifact, so a foreign one must 404
    //     first) and before the role/multifile gates, because "these bytes are not what
    //     they claim" is prior to any question about which tier they belong to.
    let artifact = crate::modules::workstore::consume::ConsumableArtifact::try_new(artifact)
        .map_err(e)?
        .into_inner();

    // 3. The DEC-8 ROLE gate: `role='artifact'` is the promotable/export tier;
    //    `role='intermediate'` is viz-only → 422.
    //
    //    This gate briefly disappeared. It used to read `artifacts.params.role`, and
    //    artifact-model ITEM-7 dropped `params`, so it lost its input and was removed —
    //    along with its test, deleted rather than inverted. That was a real behaviour
    //    change nothing authorized: dropping `params` was about deleting a bag the
    //    SERVER synthesized by merging three manifest fields, not about retiring a rule.
    //
    //    The fix is NOT to re-derive the role from `meta`. `meta` is the producer's
    //    display declaration carried verbatim, and reading a server decision out of it
    //    would be `params` again wearing a different column name. `role` is instead a
    //    FIRST-CLASS column (migration `…0003_artifact_role.sql`), exactly like `hidden`
    //    — manifest-declared, written once at ingest, indexed, and read here.
    //
    //    It is not redundant with gate 4b below. 4b asks whether the DATATYPE is a
    //    dataset input; this asks whether the producer marked this particular output
    //    promotable at all. An `intermediate` output of a dataset-input datatype passes
    //    4b and must still be refused.
    if artifact.role != ROLE_ARTIFACT {
        return Err(e(AppError::unprocessable_entity(
            "NOT_PROMOTABLE",
            format!(
                "this output is declared role='{}' — only a role='{ROLE_ARTIFACT}' output \
                 is promotable (an intermediate is produced for visualization, not export)",
                artifact.role
            ),
        )));
    }

    // 4. Multi-file artifacts (Zarr chunk-dirs / BAM+bai) are not promotable in
    //    v1 — byte-preserving equality under ziee-file's per-file name handling is
    //    deferred (ITEM-7 promotes single-blob artifacts; the tested path).
    if artifact.is_multifile {
        return Err(e(AppError::unprocessable_entity(
            "MULTIFILE_PROMOTE_UNSUPPORTED",
            "Promoting a multi-file artifact to a dataset is not supported yet",
        )));
    }

    // 4b. Dataset-input gate: a dataset is a COLLECTION of linked objects; only an
    //     artifact whose datatype is a dataset INPUT (a type an on-ingest converter
    //     accepts, so the pipeline can expand it into that collection) is promotable.
    //     A component-object datatype (single-cell/expression, embedding,
    //     metadata-column, …) is a piece INSIDE a dataset, not a
    //     standalone dataset → 422.
    if !crate::modules::extensions::is_dataset_input(&artifact.datatype) {
        return Err(e(AppError::unprocessable_entity(
            "NOT_A_DATASET_INPUT",
            format!(
                "'{}' is a dataset component, not a dataset input — only an artifact whose \
                 datatype the upload pipeline can expand into a full dataset can be promoted",
                artifact.datatype
            ),
        )));
    }

    // 5. Read the artifact bytes from the workstore object store (byte-preserving).
    let store = crate::modules::workstore::try_get_object_store().ok_or_else(|| {
        e(AppError::internal_error(
            "workstore object store not initialized",
        ))
    })?;
    // ITEM-16: promoting a GATHERED artifact would need it materialised first, which is
    // ITEM-31's stage-time materialisation. Refuse by name rather than promote an empty
    // dataset.
    let key = ContentKey::parse(
        artifact
            .stored_key("ITEM-31 (stage-time materialisation of a gathered artifact)")
            .map_err(e)?,
    );
    let bytes = store.get(&key).await.map_err(e)?;

    // 6. Name + type-metadata carried from the source artifact.
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| artifact.output_id.clone());
    // The producer's DECLARED meaning (`meta`) is what travels onto the promoted
    // dataset. It used to be the ingest-INFERRED `shape`; ITEM-15 deleted that
    // inference and ITEM-7 the column, so this now carries a declaration rather than
    // the server's own reading of the bytes (INV-1).
    let metadata = if artifact.meta.is_object() {
        artifact.meta.clone()
    } else {
        serde_json::json!({})
    };
    // Name the re-ingested blob with the dataset-input's REAL extension (e.g. an
    // `single-cell/anndata` artifact → `.h5ad`), not an inert `.bin` — the ingest→
    // expand pipeline below (and the converter inside it) keys off the filename.
    let input_ext = crate::modules::datatype::try_registry()
        .and_then(|reg| {
            reg.get(&artifact.datatype)
                .and_then(|d| d.ingest.as_ref())
                .and_then(|i| i.extensions.first().cloned())
        })
        .unwrap_or_else(|| "bin".to_string());
    let filename = format!("{}.{}", artifact.output_id, input_ext);

    // 7. Create the promoted dataset (owner = promoter; source='promote').
    let repo = DatasetRepository::new(pool.clone());
    let created = repo
        .create_promoted(
            auth.user.id,
            &name,
            Some(artifact.datatype.as_str()),
            &metadata,
            artifact.id,
        )
        .await
        .map_err(e)?;

    // 8. Re-ingest the bytes into ziee-file + link (single file → content_hash ==
    //    source artifact hash, byte-preserving).
    let file_repo = FileRepository::new(pool.clone());
    let file = ingest_bytes(
        &file_repo,
        &NoopFileProcessor,
        &NoopFileEvents,
        auth.user.id,
        &bytes,
        &filename,
        None,
        "user",
        None,
    )
    .await
    .map_err(e)?;
    repo.link_file(created.id, file.id, 0).await.map_err(e)?;
    repo.recompute_content_hash(created.id).await.map_err(e)?;

    // 8b. Run the SAME ingest→expand pipeline an upload runs: enqueue the on-ingest
    //     converter so the promoted dataset-input expands into the full linked-object
    //     dataset (soma + expression + embeddings + metadata-columns, …). Non-fatal
    //     — a convert-enqueue failure must not fail the promote (mirrors upload).
    let promoted_files = repo
        .list_files(created.id, 1, MAX_PER_PAGE)
        .await
        .map_err(e)?;
    match maybe_autoconvert_on_ingest(&pool, auth.user.id, &created, &promoted_files).await {
        // Link the primary convert job so the promoted dataset's processing status
        // (running / done / FAILED) DERIVES on read — mirrors upload (a promote path
        // blind to convert failures was an audit finding). Best-effort.
        Ok(Some(job_id)) => {
            if let Err(err) = repo.set_processing_job(created.id, job_id).await {
                tracing::warn!(dataset_id = %created.id, "linking promote processing job failed (promote still succeeded): {err}");
            }
        }
        Ok(None) => {}
        Err((_, err)) => {
            tracing::warn!(dataset_id = %created.id, "promote on-ingest convert enqueue failed (promote still succeeded): {err}");
        }
    }

    // 9. Record a `kind='promote'` provenance run node: the source artifact is the
    //    used-edge; the run is dataset-scoped to the NEW promoted dataset (Task-B).
    //    Fire this AFTER the dataset exists (the run's dataset_id FK references it).
    let source_edge = edge_from_artifact("source", &artifact);
    let inputs_json = serde_json::to_value([source_edge]).unwrap_or_else(|_| serde_json::json!([]));
    let promote_run = NewRun {
        run_id: Uuid::new_v4(),
        project_id: None,
        dataset_id: Some(created.id),
        kind: "promote".to_string(),
        status: "completed".to_string(),
        generator_id: "dataset.promote".to_string(),
        generator_version: env!("CARGO_PKG_VERSION").to_string(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        // Promote is a deterministic byte-copy — no RNG.
        seed: Some(0),
        params: serde_json::json!({ "source_artifact_id": artifact.id, "name": name }),
        inputs_json,
        acting_user: Some(auth.user.id),
        rerun_spec_json: None,
    };
    ProvenanceRepository::new(pool.clone())
        .insert_run(&promote_run)
        .await
        .map_err(e)?;

    // 10. Re-read + emit.
    let dataset = repo.get(created.id).await.map_err(e)?.unwrap_or(created);
    let files = repo
        .list_files(dataset.id, 1, MAX_PER_PAGE)
        .await
        .map_err(e)?;
    publish(
        SyncEntity::Dataset,
        SyncAction::Create,
        dataset.id,
        Audience::owner(auth.user.id),
        origin.0,
    );

    Ok((
        StatusCode::CREATED,
        Json(DatasetWithFiles {
            dataset,
            files,
            processing_status: None,
            processing_error: None,
        }),
    ))
}

fn promote_artifact_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Promote a role='artifact' output to a new owner-scoped dataset (byte-preserving)")
        .id("Dataset.promote")
        .tag("dataset")
        .response::<201, Json<DatasetWithFiles>>()
        .response_with::<404, (), _>(|r| r.description("Artifact not found or not visible"))
        .response_with::<409, (), _>(|r| r.description("`ARTIFACT_NOT_CONFORMING` — the conformance gate condemned this artifact's bytes (ITEM-18 / DEC-12). Promotion is byte-preserving and a dataset row carries no conformance status, so promoting would launder the condemnation permanently"))
        .response_with::<422, (), _>(|r| r.description("Output is not promotable (intermediate / multi-file)"))
}

/// Split a multi-file dataset into one single-file dataset per file (the
/// mis-group escape hatch, ITEM-4). The original is deleted; the children are
/// re-hashed (single-file identity). Owner only.
async fn split_dataset(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<UploadResponse>> {
    let repo = DatasetRepository::new(pool.clone());
    let dataset = repo
        .get(id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Dataset")))?;
    // Split is owner-only (it DELETES the parent + re-owns the files into new
    // datasets — a lifecycle/ownership action, not a content edit).
    //
    // H-1 (#147): "owner" here means the creator who is STILL a member of the
    // dataset's account. The bare `dataset.owner_id != auth.user.id` this replaces
    // let a REMOVED member split — deleting the account's parent dataset and
    // re-owning its files. It also had to move with `DatasetRepository::delete`:
    // that now requires membership too, so a bare-creator gate here would have left
    // a removed member able to CREATE the children while the parent delete silently
    // no-oped, i.e. a half-executed split. `is_current_owner` and `delete`'s WHERE
    // clause are two hand-copied literals with the same meaning; they are held
    // together by `is_current_owner_matches_delete` in the integration suite, not by
    // this comment asserting it.
    if !repo
        .is_current_owner(id, auth.user.id)
        .await
        .map_err(e)?
    {
        return Err(e(AppError::not_found("Dataset")));
    }
    // Resolve the parent's sync audience BEFORE the delete cascades the shares
    // away — a shared parent's sharees must also drop it (finding: split emitted
    // Delete owner-only, leaving sharees a phantom entry until reconnect). #168: the
    // audience is now membership ∪ sharees, so an account co-member drops the phantom
    // parent too — the same set the rename/upload paths fan to.
    let audience = resolve_dataset_audience_or_warn(&pool, id).await;
    let files = repo.list_files(id, 1, MAX_PER_PAGE).await.map_err(e)?;
    if files.len() < 2 {
        return Err(e(AppError::unprocessable_entity(
            "NOT_SPLITTABLE",
            "A single-file dataset cannot be split",
        )));
    }

    let mut out: Vec<DatasetWithFiles> = Vec::with_capacity(files.len());
    for f in &files {
        let name = format!("{} — {}", dataset.name, f.filename);
        // Each split child is a standalone single file; its datatype is
        // re-determined on demand (the parent type may not apply per-file). A4
        // (blind-audit fix): a child INHERITS the PARENT dataset's account
        // (`dataset.account_id`), not the actor's personal account — so splitting an
        // org dataset keeps its children in that org. Behaviour-preserving for a solo
        // user (the parent's account IS their personal account).
        let child = repo
            .create_in_account(
                auth.user.id,
                dataset.account_id,
                &name,
                None,
                &serde_json::json!({}),
            )
            .await
            .map_err(e)?;
        repo.link_file(child.id, f.file_id, 0).await.map_err(e)?;
        repo.recompute_content_hash(child.id).await.map_err(e)?;
        let child = repo.get(child.id).await.map_err(e)?.unwrap_or(child);
        let linked = repo
            .list_files(child.id, 1, MAX_PER_PAGE)
            .await
            .map_err(e)?;
        // #168: the child's CREATE goes to the child's audience, not to the actor
        // alone. Widening the parent's DELETE (above) without this would leave an
        // account co-member watching the parent vanish and the children never appear
        // until their 60s re-check — an incoherence introduced BY the widening, so it
        // is corrected in the same motion rather than left as its consequence. The
        // child inherits the parent's `account_id`, so its audience is the same set
        // that just received the parent's Delete.
        publish_dataset_audience(
            &pool,
            SyncAction::Create,
            child.id,
            Actor::user(auth.user.id, origin.0),
        )
        .await;
        out.push(DatasetWithFiles {
            dataset: child,
            files: linked,
            processing_status: None,
            processing_error: None,
        });
    }
    // Drop the mis-grouped parent (its files were re-linked into the children;
    // deleting the parent only removes ITS dataset_files links, not the files).
    repo.delete(id, auth.user.id).await.map_err(e)?;
    // Fan the parent's Delete to everyone who could see it, captured above.
    if let Some((anchor, sharees)) = audience {
        publish_to_all(
            SyncEntity::Dataset,
            SyncAction::Delete,
            id,
            anchor,
            &sharees,
            Actor::user(auth.user.id, origin.0),
        );
    }

    Ok((StatusCode::OK, Json(UploadResponse { datasets: out })))
}

fn split_dataset_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Split a multi-file dataset into per-file datasets (owner only)")
        .id("Dataset.split")
        .tag("dataset")
        .response::<200, Json<UploadResponse>>()
        .response_with::<422, (), _>(|r| r.description("Dataset has fewer than two files"))
}

// ============================== folders (ITEM-24) ==============================

async fn list_folders(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<DatasetListQuery>,
) -> ApiResult<Json<Vec<DatasetFolder>>> {
    let (page, per_page) = q.clamped();
    let repo = DatasetRepository::new(pool);
    let folders = repo
        .list_folders(auth.user.id, page, per_page)
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(folders)))
}

fn list_folders_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("List your dataset folders (paginated ?page=&per_page=)")
        .id("Dataset.listFolders")
        .tag("dataset")
        .response::<200, Json<Vec<DatasetFolder>>>()
}

async fn create_folder(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(req): Json<FolderNameRequest>,
) -> ApiResult<Json<DatasetFolder>> {
    if req.name.trim().is_empty() {
        return Err(e(AppError::bad_request(
            "INVALID_NAME",
            "Folder name is required",
        )));
    }
    let repo = DatasetRepository::new(pool);
    let folder = repo
        .create_folder(auth.user.id, req.name.trim())
        .await
        .map_err(e)?;
    publish(
        SyncEntity::DatasetFolder,
        SyncAction::Create,
        folder.id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::CREATED, Json(folder)))
}

fn create_folder_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Create a dataset folder")
        .id("Dataset.createFolder")
        .tag("dataset")
        .response::<201, Json<DatasetFolder>>()
}

async fn rename_folder(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
    Json(req): Json<FolderNameRequest>,
) -> ApiResult<Json<DatasetFolder>> {
    if req.name.trim().is_empty() {
        return Err(e(AppError::bad_request(
            "INVALID_NAME",
            "Folder name is required",
        )));
    }
    let repo = DatasetRepository::new(pool);
    let folder = repo
        .rename_folder(id, auth.user.id, req.name.trim())
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Folder")))?;
    publish(
        SyncEntity::DatasetFolder,
        SyncAction::Update,
        id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::OK, Json(folder)))
}

fn rename_folder_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Rename a dataset folder (owner only)")
        .id("Dataset.renameFolder")
        .tag("dataset")
        .response::<200, Json<DatasetFolder>>()
        .response_with::<404, (), _>(|r| r.description("Not found or not owned"))
}

async fn delete_folder(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path(id): Path<Uuid>,
) -> ApiResult<()> {
    let repo = DatasetRepository::new(pool);
    if !repo.delete_folder(id, auth.user.id).await.map_err(e)? {
        return Err(e(AppError::not_found("Folder")));
    }
    publish(
        SyncEntity::DatasetFolder,
        SyncAction::Delete,
        id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::NO_CONTENT, ()))
}

fn delete_folder_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Delete a dataset folder (owner only)")
        .id("Dataset.deleteFolder")
        .tag("dataset")
        .response::<204, ()>()
        .response_with::<404, (), _>(|r| r.description("Not found or not owned"))
}

async fn list_folder_datasets(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Query(q): Query<DatasetListQuery>,
) -> ApiResult<Json<Vec<Dataset>>> {
    let (page, per_page) = q.clamped();
    let repo = DatasetRepository::new(pool);
    // Owner-scoped folder: a foreign folder reads as 404.
    if repo.get_folder(id).await.map_err(e)?.map(|f| f.owner_id) != Some(auth.user.id) {
        return Err(e(AppError::not_found("Folder")));
    }
    let items = repo
        .list_datasets_in_folder(id, auth.user.id, page, per_page)
        .await
        .map_err(e)?;
    Ok((StatusCode::OK, Json(items)))
}

fn list_folder_datasets_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("List datasets in a folder (owner only; paginated ?page=&per_page=)")
        .id("Dataset.listFolderDatasets")
        .tag("dataset")
        .response::<200, Json<Vec<Dataset>>>()
}

async fn add_to_folder(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((id, dataset_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<serde_json::Value>> {
    let repo = DatasetRepository::new(pool);
    if !repo
        .add_to_folder(id, dataset_id, auth.user.id)
        .await
        .map_err(e)?
    {
        return Err(e(AppError::not_found("Folder or dataset")));
    }
    publish(
        SyncEntity::DatasetFolder,
        SyncAction::Update,
        id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::OK, Json(serde_json::json!({ "added": true }))))
}

fn add_to_folder_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Add a dataset to a folder (owner of both)")
        .id("Dataset.addToFolder")
        .tag("dataset")
        .response::<200, Json<serde_json::Value>>()
        .response_with::<404, (), _>(|r| r.description("Folder/dataset not found or not owned"))
}

async fn remove_from_folder(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((id, dataset_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let repo = DatasetRepository::new(pool);
    if !repo
        .remove_from_folder(id, dataset_id, auth.user.id)
        .await
        .map_err(e)?
    {
        return Err(e(AppError::not_found("Folder membership")));
    }
    publish(
        SyncEntity::DatasetFolder,
        SyncAction::Update,
        id,
        Audience::owner(auth.user.id),
        origin.0,
    );
    Ok((StatusCode::NO_CONTENT, ()))
}

fn remove_from_folder_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(ProjectsUse,)>(op)
        .description("Remove a dataset from a folder (owner)")
        .id("Dataset.removeFromFolder")
        .tag("dataset")
        .response::<204, ()>()
}

#[cfg(test)]
mod tests {
    // #185 §1 — the uncapped-uploads resolver tests at the end of this module.
    use super::{upload_body_ceiling, WorkstoreSettings};

    // S10: a supporting file's datatype must be a FUNCTION OF ITS KIND, resolved
    // from the manifest DATA that already declares the pairing (an `accepts` entry
    // with `role: supporting` carries BOTH `kind` and `type_id`).
    //
    // `supporting_datatype_for_kind(_kind)` ignored its argument and answered
    // `annotation-table` for EVERY kind. The failure that produces is SILENT: the
    // four gates pass, `find_on_integrate_converter` matches nothing, and the file is
    // linked with `integration_status = NULL` forever — no job, no error, no log.
    //
    // RED ON REVERT: restore the argument-ignoring body and the first assertion
    // fails (two different kinds resolve to the same datatype).
    /// The SHIPPED declarations, read from a real extracted seed folder (the same
    /// layout production scans) — never the process-wide registry, so this is
    /// parallel-safe and cannot be made vacuous by test ordering.
    fn shipped_declarations() -> Vec<(String, String)> {
        use crate::modules::extensions::{embedded, ExtensionRegistry};
        let dir = std::env::temp_dir().join(format!("cyto-supkind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp seed dir");
        embedded::reconcile(&dir, &embedded::embedded_seed()).expect("extract the seed");
        let reg = ExtensionRegistry::build_from_dir(&dir).expect("build the shipped registry");
        let out = crate::modules::extensions::declared_supporting_kinds_from(&reg);
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn a_supporting_kind_resolves_its_own_declared_datatype() {
        use crate::modules::extensions::supporting_datatype_from_declared;
        let declared = shipped_declarations();
        assert!(
            !declared.is_empty(),
            "no shipped package declares ANY `role: supporting` accepts `kind` — the \
             resolver would then refuse every supporting upload"
        );
        assert_ne!(
            supporting_datatype_from_declared("annotation_table", &declared),
            supporting_datatype_from_declared("no_package_declares_this_kind", &declared),
            "the resolver must be a function OF its `kind` argument — answering one \
             fixed datatype for every kind mistypes the file, and the resulting \
             no-converter-matched outcome is silent"
        );
        // The SHIPPED pairing is the one the manifests declare (unchanged behaviour).
        assert_eq!(
            supporting_datatype_from_declared("annotation_table", &declared).as_deref(),
            Some("annotation-table"),
            "declared by `packages/anndata-import/manifest.yaml`"
        );
        // …and an UNDECLARED kind is `None`, so the caller refuses loudly rather than
        // attaching a file that can never be integrated.
        assert_eq!(
            supporting_datatype_from_declared("no_package_declares_this_kind", &declared),
            None
        );
    }

    // S10 (the pure core): the `(kind → datatype)` pairing comes from the manifest
    // `accepts: {role: supporting, kind, type_id}` declarations, first-declaration
    // wins (registry order is id-sorted ⇒ deterministic), undeclared ⇒ None.
    #[test]
    fn the_kind_to_datatype_pairing_is_read_from_the_declarations() {
        use crate::modules::extensions::supporting_datatype_from_declared;
        let declared = vec![
            (
                "annotation_table".to_string(),
                "annotation-table".to_string(),
            ),
            ("image_mask".to_string(), "imaging/mask".to_string()),
            // A second declaration of an already-declared kind loses to the first.
            (
                "annotation_table".to_string(),
                "some-other-table".to_string(),
            ),
        ];
        assert_eq!(
            supporting_datatype_from_declared("annotation_table", &declared).as_deref(),
            Some("annotation-table")
        );
        assert_eq!(
            supporting_datatype_from_declared("image_mask", &declared).as_deref(),
            Some("imaging/mask"),
            "a SECOND supporting kind resolves to ITS OWN datatype — the whole point"
        );
        // Padding is normalized (the wire value is user-supplied).
        assert_eq!(
            supporting_datatype_from_declared("  image_mask ", &declared).as_deref(),
            Some("imaging/mask")
        );
        assert_eq!(
            supporting_datatype_from_declared("unknown", &declared),
            None
        );
        // A deployment with NO integrating package declares nothing ⇒ nothing resolves.
        assert_eq!(
            supporting_datatype_from_declared("annotation_table", &[]),
            None
        );
    }

    // ── uncapped-uploads (#185 §1) ──────────────────────────────────────────────
    // NOTE on ids: TEST-N is a PER-FEATURE namespace; the tests below belong to the
    // `uncapped-uploads` feature and are prefixed so a grep for an id cannot bind
    // one feature's claim to another feature's assertion (lifecycle A11).

    // uncapped-uploads TEST-3 [acceptance INV-3]: "Do not let 'unlimited' become the
    // accidental behaviour of a misconfigured SaaS deployment."
    //
    // The SaaS resolver is TOTAL — there is no input for which it yields `None`. The
    // case that matters is the one an operator cannot see coming: the settings row is
    // absent or the DB read failed, so `settings_cache` hands back
    // `WorkstoreSettings::defaults()`. That must resolve to the compiled 64 GiB
    // ceiling (exactly what the deployment had before this change), never to
    // "no ceiling".
    //
    // This asserts the DESIGN's promise rather than the code's behaviour: flipping
    // the resolver to fail open would turn it red at the first assertion, which is
    // the property an implementation-shaped test would not have.
    // uncapped-uploads: the desktop arm of the same resolver — no input yields a
    // ceiling. Paired with TEST-3 so both arms of the cfg are asserted somewhere that
    // compiles in the build that has them.
    #[test]
    fn uncapped_uploads_desktop_ceiling_is_none_for_every_row() {
        let base = WorkstoreSettings::defaults();
        for stored in [1024 * 1024, 68_719_476_736, 256i64 * 1024 * 1024 * 1024, 0] {
            let row = WorkstoreSettings { max_upload_body_bytes: stored, ..base.clone() };
            assert_eq!(
                upload_body_ceiling(&row),
                None,
                "desktop imposes no size ceiling whatever the row says (stored={stored})"
            );
        }
    }
}
