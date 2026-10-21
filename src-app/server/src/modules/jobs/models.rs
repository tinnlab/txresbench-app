//! Jobs wire + DB types.
//!
//! `status` is stored as plain text (mirrors `modules/dataset`) rather than a
//! sqlx-typed enum, so the runtime `query_as` path stays simple; `JobStatus`
//! gives typed logic + str conversions on top.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// The scheduling vocabularies are owned by the sandbox backend seam (text-stored
// on the jobs row, like `JobStatus`). Re-exported so the jobs module + the
// generated OpenAPI reference one definition.
pub use crate::modules::sandbox::backend::{PriorityClass, ResourceClass};

/// Job lifecycle state. Serializes snake_case to match the DB text values and
/// the frontend badge vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    /// Waiting on one or more job dependencies that are not yet `completed`
    /// (ITEM-19). NOT claimable by the scheduler; transitions to `queued` when all
    /// deps complete, or cascades to `failed` if a dep fails.
    Blocked,
    Queued,
    Running,
    Completed,
    Failed,
    Stopped,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Blocked => "blocked",
            JobStatus::Queued => "queued",
            JobStatus::Running => "running",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Stopped => "stopped",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "blocked" => JobStatus::Blocked,
            "queued" => JobStatus::Queued,
            "running" => JobStatus::Running,
            "completed" => JobStatus::Completed,
            "failed" => JobStatus::Failed,
            "stopped" => JobStatus::Stopped,
            _ => return None,
        })
    }

    /// Terminal states can never transition again (stop is a no-op on them).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Stopped
        )
    }
}

/// A row of `jobs`. Owner-scoped (`owner_id`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct Job {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub job_type: String,
    pub name: String,
    /// One of `queued|running|completed|failed|stopped` (see [`JobStatus`]).
    pub status: String,
    pub params: serde_json::Value,
    /// FCFS ordering key.
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    /// OS pid of the running child (null unless running). Internal-ish but
    /// harmless for the owner's own job.
    pub pid: Option<i32>,
    /// Scheduling priority class (`interactive|normal|batch`). See [`PriorityClass`].
    pub priority_class: String,
    /// Resource topology (`cpu-sandbox` today). See [`ResourceClass`].
    pub resource_class: String,
    /// Requested CPU cores (null = the class default; clamped to the admin ceiling).
    pub req_cpu: Option<i32>,
    /// Requested memory bytes (null = the class default; clamped to the ceiling).
    pub req_mem_bytes: Option<i64>,
    /// Provenance run id (P4 owns the semantics).
    ///
    /// NOTE (ITEM-68): a job carries NO scope column. Its tenancy scope (a project
    /// OR a dataset) lives in the single-source-of-truth `job_scope` table — read
    /// via [`super::repository::JobRepository::job_scope`]. `jobs` is scope-agnostic.
    pub run_id: Option<Uuid>,
}

/// Create-job request. `params` is opaque to the scheduler and passed through to
/// the runner.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateJobRequest {
    pub job_type: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    /// Requested priority class (`interactive|normal|batch`). Absent → the server
    /// infers from the trigger; an unknown value clamps to `normal`.
    #[serde(default)]
    pub priority_class: Option<String>,
    /// Requested resource class (`cpu-sandbox` today). Absent/unknown → `cpu-sandbox`.
    #[serde(default)]
    pub resource_class: Option<String>,
    /// Owning project id (analysis jobs; drives ingest scoping). When set, a
    /// `job_scope(scope_kind='project')` row is persisted at create (ITEM-68).
    #[serde(default)]
    pub project_id: Option<Uuid>,
    /// Owning dataset id (ITEM-23 / DEC-scope): a data-processing run is
    /// OWNER-scoped to a dataset (no project). When set, a
    /// `job_scope(scope_kind='dataset')` row is persisted at create (ITEM-68) so
    /// the finalize ingest tags the produced `artifacts.dataset_id` with this
    /// dataset. Mutually exclusive with `project_id` (a job is project- OR
    /// dataset-scoped, not both — the create handler rejects both as
    /// `AMBIGUOUS_JOB_SCOPE`).
    #[serde(default)]
    pub dataset_id: Option<Uuid>,
}

/// A captured log line (`job_logs`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct JobLog {
    pub id: Uuid,
    pub job_id: Uuid,
    pub seq: i32,
    pub stream: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

/// A recorded end-user-facing milestone transition (`job_milestones`, ITEM-24 /
/// DEC-25) — the DECLARED, PERSISTED step timeline the person who LAUNCHED the run
/// reads while it runs, distinct from raw `job_logs` (for whoever debugs the run)
/// and from the fine progress %. Mirrors [`JobLog`]. `detail` carries the
/// structured, data-determined finding the script emitted (e.g. `{rows, columns}`,
/// `{count, names}`); persisting it fixes "progress lost on reconnect" and yields a
/// provenance-friendly step timeline.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct JobMilestone {
    pub id: Uuid,
    pub job_id: Uuid,
    /// The manifest-declared step id (e.g. `read`, `detect_counts`, `write_output`).
    pub milestone_id: String,
    /// One of `started|done|failed`.
    pub status: String,
    /// The structured finding payload the script emitted (defaults to `{}`).
    pub detail: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

/// A resource sample (`job_metrics`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct JobMetric {
    pub id: Uuid,
    pub job_id: Uuid,
    pub sampled_at: DateTime<Utc>,
    pub cpu_pct: f32,
    pub mem_bytes: i64,
    /// Whole-cgroup-subtree peak memory (bytes) if a cgroup scope was present
    /// (ITEM-25); null on the single-pid `ProcSampler` fallback.
    pub mem_peak_bytes: Option<i64>,
    /// Current process count in the cgroup subtree (null on the sysinfo fallback).
    pub pids_current: Option<i32>,
}

/// One row of the job list: the job, plus the caller-relative facts a client needs
/// to render it. Shaped after `DatasetListItem` (`dataset` + its derived
/// processing fields), which is this codebase's established way to hand a client a
/// row together with what the SERVER says about it for THIS caller.
///
/// [`Self::can_stop`] exists because `11e622bf` made sight and stop-authority
/// genuinely different: a third-party editor may list a job and gets **403** on
/// `POST /jobs/{id}/stop`. A client that rendered Stop for every active row was
/// therefore offering a refusal the user could not have predicted — and the fix is
/// NOT for the client to re-derive "creator or scope owner", because that is a
/// SECOND copy of an authorization rule, which is the defect this sweep has now
/// found six times. The server answers the question; the client renders the answer.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobListItem {
    pub job: Job,
    /// Whether THIS caller may stop THIS job — the creator, the owner of the
    /// dataset/project it is scoped to, or an admin. Read it; do not re-derive it.
    /// It says nothing about whether the job is still RUNNING: a client still has
    /// to check `status`, because stopping a finished job is a 409, not a 403.
    pub can_stop: bool,
}

/// Job detail: the job plus its captured logs + metric series (for the drawer
/// detail view / reload).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobDetail {
    pub job: Job,
    /// Same fact as [`JobListItem::can_stop`], on the detail wire — so a surface
    /// that opened a job directly (a deep link, a reload) renders its Stop control
    /// from the same server-stated answer the list uses, not from a guess.
    pub can_stop: bool,
    pub logs: Vec<JobLog>,
    pub metrics: Vec<JobMetric>,
    /// The end-user-facing milestone timeline (ITEM-24), oldest first — so a
    /// reload / reconnect replays the step ticker, not just the live stream.
    pub milestones: Vec<JobMilestone>,
}

/// A bounded page of a job's captured log lines (ITEM-12b — long-job scrollback).
/// `next_cursor` is the `seq` to pass back as `?after_seq=` for the next forward
/// page (null = the end of the log as of this read); `total` is the full line
/// count so a client knows the page is a WINDOW, never a silent truncation.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobLogPage {
    pub logs: Vec<JobLog>,
    pub next_cursor: Option<i32>,
    pub total: i64,
}

/// Paginated job list (mirrors the user module's list response).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobListResponse {
    pub jobs: Vec<JobListItem>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
    pub total_pages: i64,
}

/// The singleton `job_settings` row (concurrency cap).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct JobSettings {
    pub max_concurrent_jobs: i32,
    /// Interactive slots held in reserve so a batch burst never head-of-line-
    /// blocks a just-arrived interactive re-run (soft admission, DEC-B).
    pub reserved_interactive_slots: i32,
    /// T4 (§6 `$per_tenant_cap`): the max jobs ONE owner may have `running` at
    /// once, folded into the multi-worker-safe claim UPDATE. Distinct from the
    /// GLOBAL `max_concurrent_jobs` (both are enforced inside the claim, DEC-1).
    pub per_tenant_max_concurrent: i32,
    /// SSE keep-alive/heartbeat interval, seconds (#54). Read at each
    /// `GET /jobs/{id}/stream` connect; default 15 == the axum `KeepAlive::default()`.
    pub sse_keep_alive_secs: i64,
    /// Global cap on concurrent per-job SSE subscribers (#54, OOM guard). Read at
    /// each stream connect; default 256 == `runtime::MAX_SSE_CLIENTS`.
    pub sse_max_clients: i32,
    /// Detached-admit wait budget, seconds (#54). Default 15 == `ADMISSION_WAIT`.
    pub admission_wait_secs: i64,
    /// Admit poll interval, milliseconds (#54). Default 250 == `ADMISSION_POLL`.
    pub admission_poll_ms: i64,
    /// Worker heartbeat cadence, seconds (#56). Read at each scheduler-loop
    /// iteration; default 10 == `ReaperLimits::default().heartbeat`.
    pub heartbeat_secs: i64,
    /// Reaper single-leader sweep cadence, seconds (#56). Default 15 ==
    /// `ReaperLimits::default().reaper_tick`.
    pub reaper_tick_secs: i64,
    /// Stale-reclaim threshold, seconds (#56): a `running` row whose heartbeat is
    /// older than this is reclaimed as dead. Default 45 == `ReaperLimits::default()
    /// .stale_threshold`. Bounded `>= 3 * heartbeat_secs` so a live worker is never
    /// reclaimed (INV-4 / DEC-3).
    pub stale_threshold_secs: i64,
    /// Poison-job discard-at-max: a row reclaimed this many times is failed, not
    /// re-queued (#56). Default 5 == `ReaperLimits::default().max_reclaims`.
    pub max_reclaims: i32,
    /// Bounded reclaim/discard batch per sweep (#56). Default 100 ==
    /// `ReaperLimits::default().reclaim_batch`.
    pub reclaim_batch: i64,
    /// Dispatch (claim) loop cadence, milliseconds (#56). Default 500 == the inline
    /// `interval(Duration::from_millis(500))` it replaces.
    pub dispatch_tick_ms: i64,
    /// CPU/RSS metric sampling cadence, seconds (#56). Read once per job execution;
    /// default 1 == the inline `interval(Duration::from_secs(1))` it replaces.
    pub metric_tick_secs: i64,
    pub updated_at: DateTime<Utc>,
    /// Audit: the acting admin who last PUT these settings (#54; mirrors billing
    /// INV-4). Stamped server-side from the caller, never from the wire body; null
    /// until the first PUT.
    pub updated_by: Option<Uuid>,
}

/// Partial update to `job_settings`.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct UpdateJobSettingsRequest {
    #[serde(default)]
    pub max_concurrent_jobs: Option<i32>,
    #[serde(default)]
    pub reserved_interactive_slots: Option<i32>,
    #[serde(default)]
    pub per_tenant_max_concurrent: Option<i32>,
    #[serde(default)]
    pub sse_keep_alive_secs: Option<i64>,
    #[serde(default)]
    pub sse_max_clients: Option<i32>,
    #[serde(default)]
    pub admission_wait_secs: Option<i64>,
    #[serde(default)]
    pub admission_poll_ms: Option<i64>,
    // Scheduler/reaper timing knobs (#56) — all optional partial-update fields.
    #[serde(default)]
    pub heartbeat_secs: Option<i64>,
    #[serde(default)]
    pub reaper_tick_secs: Option<i64>,
    #[serde(default)]
    pub stale_threshold_secs: Option<i64>,
    #[serde(default)]
    pub max_reclaims: Option<i32>,
    #[serde(default)]
    pub reclaim_batch: Option<i64>,
    #[serde(default)]
    pub dispatch_tick_ms: Option<i64>,
    #[serde(default)]
    pub metric_tick_secs: Option<i64>,
    // NOTE: no `updated_by` on the wire — it is stamped server-side from the acting
    // admin (INV-4). A body carrying it is ignored (there is no field to deserialize).
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 (partial): JobStatus serde round-trips snake_case and terminal check.
    #[test]
    fn job_status_serializes_snake_case() {
        for (s, txt) in [
            (JobStatus::Queued, "\"queued\""),
            (JobStatus::Running, "\"running\""),
            (JobStatus::Completed, "\"completed\""),
            (JobStatus::Failed, "\"failed\""),
            (JobStatus::Stopped, "\"stopped\""),
        ] {
            assert_eq!(serde_json::to_string(&s).unwrap(), txt);
            assert_eq!(JobStatus::from_str(s.as_str()), Some(s));
        }
    }

    #[test]
    fn terminal_states() {
        assert!(JobStatus::Completed.is_terminal());
        assert!(JobStatus::Failed.is_terminal());
        assert!(JobStatus::Stopped.is_terminal());
        assert!(!JobStatus::Queued.is_terminal());
        assert!(!JobStatus::Running.is_terminal());
    }

    // TEST-19: PriorityClass/ResourceClass round-trip + a Job carries the new
    // scheduling/provenance columns; class defaults are normal / cpu-sandbox.
    #[test]
    fn scheduling_classes_and_job_columns() {
        assert_eq!(
            PriorityClass::from_str("interactive"),
            Some(PriorityClass::Interactive)
        );
        assert_eq!(
            ResourceClass::from_str("cpu-sandbox"),
            Some(ResourceClass::CpuSandbox)
        );

        let job = Job {
            id: Uuid::nil(),
            owner_id: Uuid::nil(),
            job_type: "analysis".into(),
            name: "t".into(),
            status: "queued".into(),
            params: serde_json::json!({}),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            error: None,
            pid: None,
            priority_class: PriorityClass::Normal.as_str().into(),
            resource_class: ResourceClass::CpuSandbox.as_str().into(),
            req_cpu: None,
            req_mem_bytes: None,
            run_id: None,
        };
        assert_eq!(job.priority_class, "normal", "default priority is normal");
        assert_eq!(
            job.resource_class, "cpu-sandbox",
            "default resource is cpu-sandbox"
        );
    }
}
