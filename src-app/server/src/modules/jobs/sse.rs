//! The per-job SSE event vocabulary. `sse_event_enum!` (txresbench-core) generates
//! `event_name()` / `data()` / `Into<Event>` and keeps the JsonSchema derive so
//! the enum lands in `types.ts` as the stream's 200-response schema.

use schemars::JsonSchema;
use serde::Serialize;
use txresbench_core::sse_event_enum;

use super::models::{JobLog, JobMetric};
use crate::modules::sandbox::backend::{MilestoneFrame, ProgressFrame};

/// A status-transition frame (the stream's terminal signal too).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct JobStatusFrame {
    pub status: String,
}

sse_event_enum! {
    /// Frames pushed on `GET /jobs/{id}/stream`: a captured `log` line, a
    /// resource `metric` sample, or a `status` change. camelCase event names.
    #[derive(Debug, Clone, Serialize, JsonSchema)]
    pub enum SSEJobEvent {
        Log(JobLog),
        Metric(JobMetric),
        Status(JobStatusFrame),
        // A structured analysis-progress frame drained from the sandbox progress
        // FIFO (ITEM-5) — phase + optional pct + message.
        Progress(ProgressFrame),
        // An end-user-facing milestone transition drained from the same FIFO
        // (ITEM-24) — step id + status + structured finding; also persisted.
        Milestone(MilestoneFrame),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;

    // TEST-8: the SSE enum serializes log/metric/status to the expected names.
    #[test]
    fn event_names_are_camel_case() {
        let log = SSEJobEvent::Log(JobLog {
            id: Uuid::nil(),
            job_id: Uuid::nil(),
            seq: 1,
            stream: "stdout".into(),
            content: "hi".into(),
            created_at: Utc::now(),
        });
        assert_eq!(log.event_name(), "log");
        assert!(log.data().unwrap().contains("\"content\":\"hi\""));

        let metric = SSEJobEvent::Metric(JobMetric {
            id: Uuid::nil(),
            job_id: Uuid::nil(),
            sampled_at: Utc::now(),
            cpu_pct: 12.5,
            mem_bytes: 1024,
            mem_peak_bytes: Some(2048),
            pids_current: Some(3),
        });
        assert_eq!(metric.event_name(), "metric");

        let progress = SSEJobEvent::Progress(ProgressFrame {
            phase: "clustering".into(),
            pct: Some(40.0),
            message: Some("leiden".into()),
        });
        assert_eq!(progress.event_name(), "progress");

        let milestone = SSEJobEvent::Milestone(MilestoneFrame {
            id: "embeddings".into(),
            status: "done".into(),
            detail: serde_json::json!({ "count": 3 }),
        });
        assert_eq!(milestone.event_name(), "milestone");
        assert!(milestone.data().unwrap().contains("\"count\":3"));

        let status = SSEJobEvent::Status(JobStatusFrame {
            status: "running".into(),
        });
        assert_eq!(status.event_name(), "status");
        assert!(status.data().unwrap().contains("running"));
    }
}
