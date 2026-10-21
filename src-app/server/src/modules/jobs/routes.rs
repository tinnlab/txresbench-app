//! Jobs HTTP routes (aide-documented) — CRUD + stop + the per-job logs/metrics SSE
//! stream + the admin concurrency settings. Gating mirrors `modules/user/routes.rs`
//! (`with_permission` in the docs fn + a `RequirePermissions` extractor in the
//! handler).
//!
//! A job row is owned by whoever CREATED it, and that is not always the owner of the
//! thing it acts on: a project Editor or an `edit`-role dataset sharee may enqueue a
//! job scoped to someone else's project/dataset (see `create_job`). The caveat that
//! stood here — that `list_jobs`/`authorize_job` were nonetheless purely job-owner
//! scoped, so the dataset owner saw the EFFECT (their derived processing badge) with
//! no way to open or stop the run — is now FIXED. Both resolve through
//! [`super::authz::resolve_job_reach`], which reads:
//!
//! * **see** (list / get / logs / stream) — creator ∪ EDIT-holders on the scope ∪ admin
//! * **stop** — creator ∪ the scope's OWNER ∪ admin (a third-party editor gets 403)
//!
//! Read `authz.rs` before changing any gate in this file; it carries the derivation,
//! including why `view`-role sharees / project Viewers are excluded here while
//! keeping their own (thinner, redacted) surfaces.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::{Extension, Json};
use futures_util::stream::Stream;
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::{ApiResult, AppError};

use crate::modules::permissions::{active_group_ids, with_permission};

use super::authz::{resolve_job_reach, JobReach};
use super::models::{
    CreateJobRequest, Job, JobDetail, JobListItem, JobListResponse, JobLogPage, JobSettings,
    JobStatus, UpdateJobSettingsRequest,
};
use super::permissions::{JobsSettingsManage, JobsSettingsRead, JobsUse};
use super::repository::JobRepository;
use super::runtime::runtime;
use super::settings::{
    validate_per_tenant_cap, validate_reserved_slots, validate_scheduler_limits,
    validate_sse_admission, JobSettingsRepository, MAX_MAX_CONCURRENT, MIN_MAX_CONCURRENT,
};
use super::sse::{JobStatusFrame, SSEJobEvent};
use crate::modules::permissions::RequirePermissions;
use crate::modules::sandbox::backend::PriorityClass;
use crate::modules::sandbox::spec::{resolve_resource_class, AnalysisSpec};

/// Pagination + scope query for the job list.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct JobsListQuery {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub per_page: Option<i64>,
    /// Filter to jobs scoped to this project (ITEM-67 project jobs panel) via the
    /// `job_scope` JOIN. Absent → all of the caller's (or, for an admin, everyone's)
    /// jobs regardless of scope.
    #[serde(default)]
    pub project_id: Option<Uuid>,
}

impl JobsListQuery {
    /// Clamp to sane bounds (page ≥ 1, per_page 1..=100, default 10).
    fn clamped(&self) -> (i64, i64) {
        let page = self.page.unwrap_or(1).max(1);
        let per_page = self.per_page.unwrap_or(10).clamp(1, 100);
        (page, per_page)
    }
}

fn total_pages(total: i64, per_page: i64) -> i64 {
    if per_page <= 0 {
        0
    } else {
        (total + per_page - 1) / per_page
    }
}

pub fn jobs_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/jobs",
            get_with(list_jobs, list_jobs_docs).post_with(create_job, create_job_docs),
        )
        .api_route("/jobs/{id}", get_with(get_job, get_job_docs))
        .api_route(
            "/jobs/{id}/logs",
            get_with(list_job_logs, list_job_logs_docs),
        )
        .api_route("/jobs/{id}/stop", post_with(stop_job, stop_job_docs))
        .api_route("/jobs/{id}/stream", get_with(stream_job, stream_job_docs))
        .api_route(
            "/job-settings",
            get_with(get_job_settings, get_settings_docs)
                .put_with(update_job_settings, update_settings_docs),
        )
}

// ---------------------------------------------------------------- list / create

async fn list_jobs(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<JobsListQuery>,
) -> ApiResult<Json<JobListResponse>> {
    let (page, per_page) = q.clamped();
    let repo = JobRepository::new(pool);
    // A user sees their own jobs PLUS every job scoped to a dataset/project they may
    // EDIT (see `authz.rs`); an admin sees all. An optional `?project_id=` filters to
    // that project's jobs via the `job_scope` predicate (ITEM-67).
    //
    // `?project_id=` is a FILTER over the already-authorized set, not a gate: naming a
    // project you cannot reach narrows your rows to none rather than answering 404.
    // That is deliberate — adding a `require_project_read` here would turn the panel's
    // "no jobs yet" into an error for a project the caller legitimately reads, and it
    // cannot widen anything, because every candidate row already had to pass the
    // visibility predicate.
    let (jobs, total) = if auth.user.is_admin {
        repo.list_all(q.project_id, page, per_page).await
    } else {
        repo.list_visible_to(
            auth.user.id,
            &active_group_ids(&auth.groups),
            q.project_id,
            page,
            per_page,
        )
        .await
    }
    .map_err(|e| e.to_api_error())?;
    // Grade the PAGE for stop-authority, once, in one query — then STATE it per row.
    //
    // Sight and stop are different rights (`authz.rs`), so a client that rendered a
    // Stop control for every row it was allowed to LIST was offering a third-party
    // editor a button that answers 403. The alternative — the client re-deriving
    // "creator or scope owner" — would be a second copy of an authorization rule in
    // another language, which is the single most-repeated defect this pair of commits
    // has been unwinding. So the answer travels on the wire.
    //
    // An admin controls every job, so their page skips the query entirely rather than
    // encoding `is_admin` into SQL (the Rust gate short-circuits the same way, and
    // keeping the two shaped alike is what makes the parity test meaningful).
    let controllable = if auth.user.is_admin {
        None
    } else {
        let ids: Vec<Uuid> = jobs.iter().map(|j| j.id).collect();
        Some(
            repo.controllable_subset(&ids, auth.user.id, &active_group_ids(&auth.groups))
                .await
                .map_err(|e| e.to_api_error())?,
        )
    };
    let jobs: Vec<JobListItem> = jobs
        .into_iter()
        .map(|job| {
            let can_stop = match &controllable {
                None => true,
                Some(set) => set.contains(&job.id),
            };
            JobListItem { job, can_stop }
        })
        .collect();
    Ok((
        StatusCode::OK,
        Json(JobListResponse {
            jobs,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

fn list_jobs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "List jobs you may see — your own PLUS every job scoped to a dataset or \
             project you may EDIT (admins: all jobs) — newest first; optional \
             ?project_id= scopes to one project's jobs. Each row carries `can_stop`: \
             whether YOU may stop THAT job (its creator, the owner of the dataset or \
             project it runs on, or an admin). Render that answer; do not re-derive \
             it — seeing a job and being allowed to end it are different rights.",
        )
        .id("Jobs.list")
        .tag("jobs")
        .response::<200, Json<JobListResponse>>()
}

/// Resolve the effective priority class: an explicit request value wins, else the
/// analysis spec's `schedule.class`, else the default (`normal` — an AI-/explicit-
/// -run trigger). An unknown value clamps to `normal`. Pure + unit-testable.
pub fn infer_priority(
    requested: Option<&str>,
    spec_class: Option<&str>,
    default: PriorityClass,
) -> PriorityClass {
    match requested.or(spec_class) {
        Some(s) => PriorityClass::clamped(s),
        None => default,
    }
}

async fn create_job(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Json(mut req): Json<CreateJobRequest>,
) -> ApiResult<Json<Job>> {
    if req.job_type.trim().is_empty() {
        return Err(
            AppError::bad_request("INVALID_JOB_TYPE", "job_type is required").to_api_error(),
        );
    }

    // For an analysis job, validate the spec up front (reject a bad spec at
    // create, not at dispatch) + derive the priority from its schedule.class.
    let mut spec_class: Option<String> = None;
    // Requested CPU cores from the analysis spec — feeds the T6 compute-quota estimate (DEC-3).
    // saas-only (INV-3): absent in the default/desktop build, so `create_job` is byte-identical
    // there. `None` for a non-analysis job (defaults to 1 core in `est_core_hours`).
    #[cfg(feature = "saas")]
    let mut spec_cpu: Option<i64> = None;
    if req.job_type == "analysis" {
        let params = req.params.clone().unwrap_or_else(|| serde_json::json!({}));
        let spec = AnalysisSpec::parse(&params).map_err(|e| e.to_api_error())?;
        spec_class = spec.schedule.class.clone();
        #[cfg(feature = "saas")]
        {
            spec_cpu = spec.schedule.cpu;
        }
        // #189 / DEC-4 — the env-id is DERIVED SERVER-SIDE, never trusted from the
        // request body. This endpoint takes a caller-supplied `AnalysisSpec`, and the
        // env registry is OPEN (any well-formed id resolves to its own image repo, with
        // no allowlist — that openness is what lets a new env ship with zero core
        // edits). A trusted `env` here would therefore be a request to mount an
        // arbitrary image. Re-derive it from the registry for the named `analysis_id`
        // and write the result back over whatever arrived.
        //
        // SET THE ONE KEY — do NOT re-encode the whole spec over `req.params`.
        // `AnalysisSpec` has no `#[serde(flatten)] rest`, and several of its fields are
        // `#[serde(default)]` WITHOUT `skip_serializing_if`, so round-tripping the params
        // through it would silently drop every client key the struct does not model and
        // materialize `inputs`/`produces`/`schedule`/`extra_mounts`/`arch` defaults into
        // the stored row — for EVERY analysis job, whether or not it declares an env.
        // That is a lossy rewrite of a persisted request body, and it is not what this
        // change is for.
        let derived = spec.with_declared_env().env;
        let mut params = req.params.take().unwrap_or_else(|| serde_json::json!({}));
        match params.as_object_mut() {
            Some(obj) => {
                match derived {
                    Some(env) => obj.insert("env".into(), serde_json::Value::String(env)),
                    // A caller-supplied env for an analysis that declares none is
                    // REMOVED, not left in place — otherwise the boundary is bypassable
                    // by naming an analysis that happens to declare no env.
                    None => obj.remove("env"),
                };
            }
            // `AnalysisSpec::parse` succeeded above, so the params ARE an object; this
            // arm is unreachable and deliberately changes nothing rather than guessing.
            None => {}
        }
        req.params = Some(params);
    }

    // A job is scoped to a project (workbench) OR a dataset (owner processing) —
    // never both (ITEM-23 / DEC-scope). Reject an ambiguous double-scope up front.
    if req.project_id.is_some() && req.dataset_id.is_some() {
        return Err(AppError::bad_request(
            "AMBIGUOUS_JOB_SCOPE",
            "a job may be scoped to a project OR a dataset, not both",
        )
        .to_api_error());
    }

    // SECURITY: a job that names a `project_id` will have its outputs ingested INTO
    // that project (WorkstoreIngestSink). Require the caller to have EDIT access to
    // it — else a user could write artifacts into another user's project (a foreign
    // project is a 404, no existence leak).
    if let Some(project_id) = req.project_id {
        crate::modules::workstore::authz::require_project_edit(&pool, project_id, auth.user.id)
            .await?;
    }

    // SECURITY (mirror): a `dataset_id` scopes the run's produced artifacts to
    // that dataset (`artifacts.dataset_id`), so it is the dataset analog of the
    // project arm above — and it must be gated the same WAY, not merely in the
    // same PLACE.
    //
    // It used to demand OWNERSHIP, citing "data processing is OWNER-scoped
    // (DEC-scope: the owner's data-prep)". That sentence predates ITEM-2 role
    // enforcement and, since `POST /datasets/{id}/process` shipped behind
    // `require_can_edit`, it described a rule the product no longer had: the SAME
    // capability — enqueue a dataset-scoped analysis job that writes artifacts into
    // this dataset — answered "no" here and "yes" one route over, so a user's
    // authority depended on which endpoint they reached for.
    //
    // `require_can_edit` is the answer that survives, for three reasons:
    //   1. the project arm eight lines up admits a non-owner EDITOR
    //      (`require_project_edit`); demanding OWNERSHIP on the dataset arm made
    //      "mirror" false in the one respect that matters.
    //   2. an `edit` share already grants every other content mutation on the
    //      dataset — rename, upload a file, add a supporting file — and an upload
    //      FIRES a dataset-scoped converter job on its own (`maybe_autoconvert_on_ingest`).
    //      An edit-sharee could therefore already cause dataset-scoped job execution
    //      and artifact writes; refusing them the explicit route removed no authority,
    //      it only removed the honest one. Owner-only is reserved for LIFECYCLE acts
    //      (delete, split, share/unshare), each of which says so at its own gate.
    //   3. the sync layer was already built on this reading — `dataset::sync` and
    //      `publish_dataset_after_terminal` both exist because "an `edit`-role sharee
    //      calls POST /datasets/{id}/process" is a path the system expects.
    //
    // Grades unchanged elsewhere: a `view`-only sharee is **403** (visible, not an
    // editor) and a foreign/nonexistent dataset is **404** (no existence oracle).
    if let Some(dataset_id) = req.dataset_id {
        crate::modules::dataset::repository::DatasetRepository::new(pool.clone())
            .require_can_edit(dataset_id, auth.user.id, &active_group_ids(&auth.groups))
            .await
            .map_err(|e| e.to_api_error())?;
    }

    // Compute T6 — the quota pre-check (design §4.2a). Placed AFTER the scope-authz blocks and
    // BEFORE draft freeze-job resolution + `repo.create`, so a quota refusal enqueues NOTHING
    // (a later placement would leak orphan freeze PRODUCER jobs). Resolves the tenant via
    // `account_of(project|dataset)` (INV-4), builds the frozen `QuotaAsk::Compute` (INV-5), and
    // switches B4's three-arm verdict: Allow/AllowMeteredOverage → proceed; BlockOverQuota → 402
    // `QUOTA_EXCEEDED` (INV-1/INV-2). Fail-open on a scope-less/unresolvable account or a DB read
    // error (DEC-1). saas-gated (INV-3): a desktop build has no quota check and this is byte-
    // identical without the feature.
    #[cfg(feature = "saas")]
    {
        let class = resolve_resource_class(req.resource_class.as_deref());
        super::quota::enforce_compute_quota(
            &pool,
            req.project_id,
            req.dataset_id,
            class.as_str(),
            spec_cpu,
        )
        .await
        .map_err(|e| e.to_api_error())?;
    }

    // Auto-freeze-on-consume (draftable-entity ITEM-8 / INV-4 / DEC-2 final: async
    // job-dependency). Any input referencing an `open` draft is VALIDATED and a freeze
    // PRODUCER job enqueued (find-or-reuse an in-flight one per draft); the CONSUMER is
    // then made `blocked` on those freeze jobs (below, via `create_with_deps`). An
    // already-frozen draft is pinned into `params` now (INV-5). NO producer is ever
    // awaited — the consumer stays `blocked` until the freeze-completion hook pins its
    // `artifact_ref`, so an `open` draft is never staged unpinned (INV-4) and no
    // connection/slot/lock is held across a run. A foreign/nonexistent draft, or one the
    // caller cannot edit, is REFUSED (404/403) BEFORE any job exists (validate-all-first
    // — a partial failure enqueues nothing). A no-op for every existing input kind.
    let mut freeze_deps: Vec<Uuid> = Vec::new();
    if req.job_type == "analysis" {
        if let Some(params) = req.params.take() {
            let resolution = crate::modules::drafts::resolve_draft_inputs_for_create(
                &pool,
                &params,
                auth.user.id,
            )
            .await
            .map_err(|err| err.to_api_error())?;
            req.params = Some(resolution.params);
            freeze_deps = resolution.freeze_job_ids;
        }
    }

    // Resolve + stamp the scheduling fields the runner/scheduler read.
    let priority = infer_priority(
        req.priority_class.as_deref(),
        spec_class.as_deref(),
        PriorityClass::Normal,
    );
    let class = resolve_resource_class(req.resource_class.as_deref());
    req.priority_class = Some(priority.as_str().to_string());
    req.resource_class = Some(class.as_str().to_string());

    let repo = JobRepository::new(pool);
    // A consumer with freeze dependencies is born `blocked` (DEC-2 final); with none it
    // is `queued` exactly as before.
    let job = if freeze_deps.is_empty() {
        repo.create(auth.user.id, &req).await
    } else {
        repo.create_with_deps(auth.user.id, &req, &freeze_deps)
            .await
    }
    .map_err(|e| e.to_api_error())?;
    // Tell the owner's OTHER devices a job appeared (owner-scoped). This device
    // refetches on its own create; sync covers cross-device. No-op seam this
    // round; live8's sync wires it at merge. The scheduler picks the job up on
    // its next tick (no start action for the user).
    super::seams::sync_sink().publish_job_changed(
        auth.user.id,
        super::seams::JobChange::Created,
        job.id,
    );
    // A `blocked` consumer (pending its freeze producer) is 202 Accepted, not 201
    // Created — the work is queued behind a dependency, not yet runnable.
    let status = if job.status == JobStatus::Blocked.as_str() {
        StatusCode::ACCEPTED
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(job)))
}

fn create_job_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Create (enqueue) a job. It is queued FCFS and started automatically. A \
             `project_id` requires EDIT on that project; a `dataset_id` requires EDIT on \
             that dataset (owner or `edit`-role sharee) — the same authority \
             `POST /datasets/{id}/process` requires.",
        )
        .id("Jobs.create")
        .tag("jobs")
        .response::<201, Json<Job>>()
        .response_with::<202, Json<Job>, _>(|r| {
            r.description(
                "The job was enqueued `blocked` behind a draftable freeze producer \
                 (draftable-entity DEC-2); it becomes runnable when the freeze completes.",
            )
        })
        .response_with::<400, (), _>(|r| {
            r.description(
                "Missing job_type, an invalid analysis spec, or both project_id and dataset_id",
            )
        })
        .response_with::<403, (), _>(|r| {
            r.description("Read-only access to the named project/dataset (a `view`-role sharee)")
        })
        .response_with::<404, (), _>(|r| {
            r.description("The named project/dataset is not visible to the caller")
        })
        .response_with::<402, (), _>(|r| {
            r.description(
                "Quota exceeded (`QUOTA_EXCEEDED`): the account's plan compute allowance is used \
                 up (free-tier hard cap, or a paid account past its spend cap). The frontend maps \
                 this to an upgrade surface. SaaS deployments only.",
            )
        })
}

// ---------------------------------------------------------------- detail / stop

/// Fetch a job the caller may SEE, along with how far their reach goes. A job below
/// [`JobReach::See`] is a 404 — never a 403 — because the path parameter is a job id
/// an unauthorized caller has no way to learn, so grading it would be an existence
/// oracle. Callers that MUTATE (only `stop_job`) must additionally check
/// [`JobReach::can_control`]; the split is derived in `authz.rs`.
async fn authorize_job(
    pool: &PgPool,
    repo: &JobRepository,
    id: Uuid,
    auth: &RequirePermissions<(JobsUse,)>,
) -> Result<(Job, JobReach), (StatusCode, AppError)> {
    let job = repo
        .get_any(id)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| AppError::not_found("Job").to_api_error())?;
    let reach = resolve_job_reach(
        pool,
        &job,
        auth.user.id,
        auth.user.is_admin,
        &active_group_ids(&auth.groups),
    )
    .await
    .map_err(|e| e.to_api_error())?;
    if !reach.can_see() {
        return Err(AppError::not_found("Job").to_api_error());
    }
    Ok((job, reach))
}

async fn get_job(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<JobDetail>> {
    let repo = JobRepository::new(pool.clone());
    let (job, reach) = authorize_job(&pool, &repo, id, &auth).await?;
    let logs = repo.list_logs(id).await.map_err(|e| e.to_api_error())?;
    let metrics = repo.list_metrics(id).await.map_err(|e| e.to_api_error())?;
    let milestones = repo
        .list_milestones(id)
        .await
        .map_err(|e| e.to_api_error())?;
    // The reach is already resolved for the gate; state its stop half rather than
    // making the client ask a second question it would have to answer by re-deriving
    // the rule. Same fact the list states, from the same resolver.
    Ok((
        StatusCode::OK,
        Json(JobDetail {
            job,
            can_stop: reach.can_control(),
            logs,
            metrics,
            milestones,
        }),
    ))
}

fn get_job_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Get a job with its captured logs + metric series, plus `can_stop` — \
             whether YOU may stop it. Visible to the job's creator, to anyone who may \
             EDIT the dataset/project it is scoped to, and to admins; anyone else gets \
             404 (a job id is not an existence oracle).",
        )
        .id("Jobs.get")
        .tag("jobs")
        .response::<200, Json<JobDetail>>()
        .response_with::<404, (), _>(|r| r.description("No such job, or not visible to you"))
}

// ------------------------------------------------------------ paged logs (12b)

/// Cursor query for the paged log endpoint. `after_seq` is the stable cursor
/// (`seq` is a per-job monotonic key); `limit` is the page size.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct JobLogsQuery {
    /// Return log lines whose `seq` is strictly greater than this cursor
    /// (0/absent = from the start). Pass back the response's `next_cursor`.
    #[serde(default)]
    pub after_seq: Option<i32>,
    /// Page size (1..=1000, default 500).
    #[serde(default)]
    pub limit: Option<i64>,
}

impl JobLogsQuery {
    /// Clamp to sane bounds (after_seq ≥ 0, limit 1..=1000, default 500).
    fn clamped(&self) -> (i32, i64) {
        let after = self.after_seq.unwrap_or(0).max(0);
        let limit = self.limit.unwrap_or(500).clamp(1, 1000);
        (after, limit)
    }
}

/// Paged log retrieval (ITEM-12b) — the catch-up / scrollback path for a long run
/// (Cell Ranger emits far more than the 10k `GET /jobs/{id}` cap). Forward cursor
/// paging by `seq`; the SSE `GET /jobs/{id}/stream` stays the live/replay path.
/// Owner-or-admin scoped like the other jobs routes (foreign job → 404).
async fn list_job_logs(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
    Query(q): Query<JobLogsQuery>,
) -> ApiResult<Json<JobLogPage>> {
    let repo = JobRepository::new(pool.clone());
    // Authz first (404 for a job the caller may not see — no existence leak), then page.
    let (_job, _reach) = authorize_job(&pool, &repo, id, &auth).await?;
    let (after_seq, limit) = q.clamped();
    let logs = repo
        .list_logs_paged(id, after_seq, limit)
        .await
        .map_err(|e| e.to_api_error())?;
    let total = repo.count_logs(id).await.map_err(|e| e.to_api_error())?;
    // A full page (== limit) MIGHT have more; hand back the last seq as the next
    // cursor. A short/empty page is the end → no cursor.
    let next_cursor = if logs.len() as i64 == limit {
        logs.last().map(|l| l.seq)
    } else {
        None
    };
    Ok((
        StatusCode::OK,
        Json(JobLogPage {
            logs,
            next_cursor,
            total,
        }),
    ))
}

fn list_job_logs_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description(
            "Paged log lines for a long run (forward cursor by seq); catch-up/scrollback. \
             Same visibility as GET /jobs/{id}.",
        )
        .id("Jobs.logs")
        .tag("jobs")
        .response::<200, Json<JobLogPage>>()
}

async fn stop_job(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Job>> {
    let repo = JobRepository::new(pool.clone());
    let (job, reach) = authorize_job(&pool, &repo, id, &auth).await?;

    // SEEING a run and being allowed to END one are different rights. Ending an
    // in-flight run is that run's DELETE, and owner-only is what `799d0cf3` reserved
    // for lifecycle acts — so an editor of the DATA who is neither the run's creator
    // nor the scope's owner may watch it and not kill it. **403, not 404**: they can
    // already see the job through every read route above, so there is no existence
    // left to protect, and 404 here would be a lie about a row they can read.
    if !reach.can_control() {
        return Err(AppError::forbidden(
            "JOB_NOT_YOURS_TO_STOP",
            "Only this job's creator or the owner of the dataset/project it runs on may stop it",
        )
        .to_api_error());
    }

    if JobStatus::from_str(&job.status)
        .map(JobStatus::is_terminal)
        .unwrap_or(false)
    {
        return Err(AppError::conflict("Job is already finished").to_api_error());
    }

    // A RUNNING job is signalled (its executor kills the child + marks it
    // stopped). A QUEUED job is cancelled directly (the scheduler skips it).
    if runtime().signal_cancel(id) {
        // Signalled; return the current row (the executor writes `stopped`).
        Ok((StatusCode::OK, Json(job)))
    } else {
        let stopped = repo
            .mark_stopped(id)
            .await
            .map_err(|e| e.to_api_error())?
            .ok_or_else(|| AppError::conflict("Job is already finished").to_api_error())?;
        // Cancelling a QUEUED job is the one status write with no other emitter.
        // The running path is covered by the executor's `finalize`, which emits once
        // the row actually reaches `stopped`; this branch IS the write, so it owes the
        // frame itself. `mark_stopped` already publishes the DATASET consequence
        // (`publish_dataset_after_terminal`) — the job list is what nothing told.
        //
        // Addressed to `stopped.owner_id`, NOT to `auth.user.id`: `authorize_job`
        // admits an admin acting on ANOTHER user's job, so the actor is not
        // necessarily the owner, and it is the owner's devices that render this row.
        super::seams::sync_sink().publish_job_changed(
            stopped.owner_id,
            super::seams::JobChange::Updated,
            id,
        );
        Ok((StatusCode::OK, Json(stopped)))
    }
}

fn stop_job_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("Stop a running job or cancel a queued one (→ stopped)")
        .id("Jobs.stop")
        .tag("jobs")
        .response::<200, Json<Job>>()
        .response_with::<403, (), _>(|r| {
            r.description(
                "You may see this job but not stop it (not its creator or the scope owner)",
            )
        })
        .response_with::<404, (), _>(|r| r.description("No such job, or not visible to you"))
        .response_with::<409, (), _>(|r| r.description("The job already finished"))
}

// ---------------------------------------------------------------- SSE stream

async fn stream_job(
    auth: RequirePermissions<(JobsUse,)>,
    Extension(pool): Extension<PgPool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, axum::Error>>>> {
    let repo = JobRepository::new(pool.clone());
    let (job, _reach) = authorize_job(&pool, &repo, id, &auth).await?;

    // Read the admin-configurable SSE knobs at-use (#54, INV-5): the keep-alive
    // interval + the subscriber cap. Const fallback on any DB error keeps this
    // byte-identical to the old `KeepAlive::default()` / `MAX_SSE_CLIENTS`.
    let (keep_alive, max_clients) = JobSettingsRepository::new(pool.clone()).sse_config().await;

    // Subscribe FIRST (no gap between the replay snapshot and live frames), then
    // re-read the status to close the race where the job finalized just before
    // we subscribed (its close_job already ran, so our sender would never drop).
    let terminal_now = JobStatus::from_str(&job.status)
        .map(JobStatus::is_terminal)
        .unwrap_or(false);
    let live_rx = if terminal_now {
        None
    } else {
        match runtime().subscribe_with_cap(id, max_clients) {
            Some(rx) => Some(rx),
            None => return Err(AppError::internal_error("job stream registry full").to_api_error()),
        }
    };

    // Replay snapshot (deduped client-side by seq / sampled_at).
    let logs = repo.list_logs(id).await.unwrap_or_default();
    let metrics = repo.list_metrics(id).await.unwrap_or_default();
    // Re-read status after subscribing (race close).
    let current_status = repo
        .get_any(id)
        .await
        .ok()
        .flatten()
        .map(|j| j.status)
        .unwrap_or(job.status);
    let now_terminal = JobStatus::from_str(&current_status)
        .map(JobStatus::is_terminal)
        .unwrap_or(false);

    // If the job finalized between the initial check and our subscribe, its
    // `close_job` already ran — the sender we just registered would otherwise
    // leak forever (a terminal job never broadcasts again to prune it, slowly
    // exhausting the global cap). Remove it now; the stream serves the replay
    // snapshot only.
    if now_terminal && live_rx.is_some() {
        runtime().close_job(id);
    }

    let stream = async_stream::stream! {
        for l in logs {
            yield Ok(SSEJobEvent::Log(l).into());
        }
        for m in metrics {
            yield Ok(SSEJobEvent::Metric(m).into());
        }
        yield Ok(SSEJobEvent::Status(JobStatusFrame { status: current_status }).into());

        // Live frames until the job finalizes (close_job drops the sender). If it
        // turned terminal during/after subscribe, don't hold the stream open.
        if !now_terminal {
            if let Some(mut rx) = live_rx {
                while let Some(ev) = rx.recv().await {
                    yield ev;
                }
            }
        }
    };

    Ok((
        StatusCode::OK,
        Sse::new(stream).keep_alive(KeepAlive::new().interval(keep_alive)),
    ))
}

fn stream_job_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsUse,)>(op)
        .description("SSE stream of a job's log / metric / status frames (text/event-stream)")
        .id("Jobs.stream")
        .tag("jobs")
        // Schema carrier so SSEJobEvent enters types.ts (the live body is SSE).
        .response::<200, Json<SSEJobEvent>>()
}

// ---------------------------------------------------------------- settings

async fn get_job_settings(
    _auth: RequirePermissions<(JobsSettingsRead,)>,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<JobSettings>> {
    let settings = JobSettingsRepository::new(pool)
        .get()
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(settings)))
}

fn get_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsSettingsRead,)>(op)
        .description("Get the jobs concurrency settings")
        .id("Jobs.getSettings")
        .tag("jobs")
        .response::<200, Json<JobSettings>>()
}

async fn update_job_settings(
    auth: RequirePermissions<(JobsSettingsManage,)>,
    Extension(pool): Extension<PgPool>,
    origin: crate::modules::sync::SyncOrigin,
    Json(mut req): Json<UpdateJobSettingsRequest>,
) -> ApiResult<Json<JobSettings>> {
    if let Some(n) = req.max_concurrent_jobs {
        if !(MIN_MAX_CONCURRENT..=MAX_MAX_CONCURRENT).contains(&n) {
            return Err(AppError::unprocessable_entity(
                "INVALID_CONCURRENCY",
                format!("max_concurrent_jobs must be between {MIN_MAX_CONCURRENT} and {MAX_MAX_CONCURRENT}"),
            )
            .to_api_error());
        }
    }
    // T4 (ITEM-6): the per-tenant cap has its own bound (1..64, the DB CHECK),
    // surfaced as a 422 before the write.
    if let Some(n) = req.per_tenant_max_concurrent {
        validate_per_tenant_cap(n).map_err(|e| e.to_api_error())?;
    }
    // SSE + admission knobs (#54): bounds + the cross-field poll<wait rule, surfaced
    // as a typed 422 before the write (mirrors the DB CHECK; validated against the
    // EFFECTIVE wait resolved below once we've read the current row).
    let repo = JobSettingsRepository::new(pool);
    let current = repo.get().await.map_err(|e| e.to_api_error())?;
    validate_sse_admission(&req, current.admission_wait_secs, current.admission_poll_ms)
        .map_err(|e| e.to_api_error())?;
    // Scheduler/reaper knobs (#56): per-field bounds + the cross-field
    // `stale_threshold_secs >= 3×heartbeat_secs` safety guardrail (INV-4), validated
    // against the EFFECTIVE heartbeat/stale (requested-else-current) BEFORE the write so
    // a footgun is a typed 422, never a DB-CHECK 500.
    validate_scheduler_limits(&req, current.heartbeat_secs, current.stale_threshold_secs)
        .map_err(|e| e.to_api_error())?;
    // Enforce the `0 <= reserved < effective_cap` invariant (mirrors the DB CHECK)
    // against the EFFECTIVE cap (the requested new cap if present, else current).
    let effective_cap = req
        .max_concurrent_jobs
        .unwrap_or(current.max_concurrent_jobs);
    match req.reserved_interactive_slots {
        // An EXPLICIT reserved value out of range is a 422 (the admin footgunned).
        Some(reserved) => {
            validate_reserved_slots(reserved, effective_cap).map_err(|e| e.to_api_error())?;
        }
        // No explicit reserved, but lowering the cap could strand the current
        // reserved (>= new cap) → auto-clamp it down so the DB CHECK holds (a cap
        // change never fails on an untouched reserved value).
        None => {
            if current.reserved_interactive_slots >= effective_cap {
                req.reserved_interactive_slots = Some((effective_cap - 1).max(0));
            }
        }
    }
    let settings = repo
        .update(&req, auth.user.id)
        .await
        .map_err(|e| e.to_api_error())?;
    // Deployment-wide singleton: fan to every holder of the read-perm that gates the
    // refetch endpoint (`GET /job-settings`), suppressing the acting admin's own
    // connection. Without this, a second admin's `JobSettings` store showed the old cap
    // until a reload — its `sync:job_settings` subscription had no publisher at all.
    crate::modules::sync::publish(
        crate::modules::sync::SyncEntity::JobSettings,
        crate::modules::sync::SyncAction::Update,
        uuid::Uuid::nil(),
        crate::modules::sync::Audience::perm::<JobsSettingsRead>(),
        origin.0,
    );
    Ok((StatusCode::OK, Json(settings)))
}

fn update_settings_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(JobsSettingsManage,)>(op)
        .description(
            "Update the jobs settings: concurrency cap + reserved interactive slots + \
             per-tenant cap, the SSE (keep-alive, max clients) + admission (wait, poll) knobs, \
             and the scheduler/reaper timing knobs (heartbeat, reaper tick, stale threshold, \
             max reclaims, reclaim batch, dispatch tick, metric tick)",
        )
        .id("Jobs.updateSettings")
        .tag("jobs")
        .response::<200, Json<JobSettings>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-14: priority inference — explicit wins, then schedule.class, then the
    // default; an unknown value clamps to normal.
    #[test]
    fn infer_priority_precedence_and_clamp() {
        // Explicit interactive trigger → interactive.
        assert_eq!(
            infer_priority(Some("interactive"), None, PriorityClass::Normal),
            PriorityClass::Interactive
        );
        // No explicit, no spec class → the default (AI/explicit run → normal).
        assert_eq!(
            infer_priority(None, None, PriorityClass::Normal),
            PriorityClass::Normal
        );
        // The spec's schedule.class is honored when no explicit request.
        assert_eq!(
            infer_priority(None, Some("batch"), PriorityClass::Normal),
            PriorityClass::Batch
        );
        // An explicit request overrides the spec class.
        assert_eq!(
            infer_priority(Some("interactive"), Some("batch"), PriorityClass::Normal),
            PriorityClass::Interactive
        );
        // Unknown clamps to normal.
        assert_eq!(
            infer_priority(Some("bogus"), None, PriorityClass::Interactive),
            PriorityClass::Normal
        );
    }
}
