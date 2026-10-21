//! The dataset supporting-file integration-completion hook (ITEM-11/20).
//!
//! `DatasetIntegrationSink` implements the jobs `IntegrationSink` seam: when a
//! supporting file's INTEGRATE (kind-processor) job finalizes, it (i) captures the
//! coverage summary into `dataset_files.integration_summary`, and (ii) emits
//! `sync:dataset` to the dataset's owner + sharees so their devices live-refresh the
//! derived per-file status. It is INSTALLED from `DatasetModule::init` (its pool
//! baked in) so the jobs module never imports the dataset module — mirroring the P4
//! `RunRecorder` seam.
//!
//! Per-file STATUS is derived from the job row in `repository::list_files`, so this
//! hook is NOT the status writer — only the coverage summary + the live sync nudge.

use async_trait::async_trait;
use sqlx::PgPool;

use crate::modules::jobs::models::Job;
use crate::modules::jobs::seams::IntegrationSink;
use crate::modules::sandbox::outputs::ProducedOutput;
use crate::modules::sandbox::spec::AnalysisSpec;
use crate::modules::sync::SyncAction;

use super::repository::DatasetRepository;

/// The dataset-side integration-completion sink (pool baked in at install).
pub struct DatasetIntegrationSink {
    pool: PgPool,
}

impl DatasetIntegrationSink {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl IntegrationSink for DatasetIntegrationSink {
    async fn on_integrate_finalized(&self, job: &Job, success: bool, outputs: &[ProducedOutput]) {
        // Parse the integrate spec → the annotation file id (slot `annotation`,
        // `dataset_file_ref`) + the target dataset id (the `axis_index` ref's
        // `dataset_id` — the Job row carries no dataset column).
        let Ok(spec) = AnalysisSpec::parse(&job.params) else {
            tracing::warn!(job_id = %job.id, "integrate finalize: unparseable spec; skipping");
            return;
        };
        let file_id = spec
            .inputs
            .iter()
            .find(|i| i.slot == "annotation")
            .and_then(|i| i.dataset_file_ref);
        let dataset_id = spec
            .inputs
            .iter()
            .find_map(|i| i.dataset_axis_index.as_ref().map(|r| r.dataset_id));
        let (Some(file_id), Some(dataset_id)) = (file_id, dataset_id) else {
            tracing::warn!(job_id = %job.id, "integrate finalize: missing annotation/axis_index inputs; skipping");
            return;
        };

        let repo = DatasetRepository::new(self.pool.clone());

        // On success, capture the coverage summary — by contract the hidden output
        // with `id == "integration_summary"`, whose `meta` is `{matched,total,…}` —
        // else a minimal marker so the UI shows "integrated". On failure, leave the
        // summary untouched (the derived status already reads `failed`).
        if success {
            let summary = outputs
                .iter()
                .find(|o| o.id == "integration_summary")
                .map(|o| o.meta.clone())
                .unwrap_or_else(|| serde_json::json!({ "status": "integrated" }));
            if let Err(err) = repo
                .set_integration_summary(dataset_id, file_id, Some(summary))
                .await
            {
                tracing::warn!(job_id = %job.id, %dataset_id, %file_id, "integrate finalize: write summary failed: {err}");
            }
        }

        // §7 notify-and-refetch: emit `sync:dataset` to the owner + sharees (a DETACHED
        // finalize, so `Actor::detached` suppresses nobody) and their connected devices
        // live-refresh the derived per-file status + coverage without a manual reload.
        //
        // This site had the AUDIENCE right and still carried a fourth private copy of
        // the fan-out loop, hand-skipping `uid != owner`. That is the duplication
        // `fan_out_owner_scoped` was extracted to end — and it mattered here, because the
        // sibling leg of this very same job completion (the terminal transition) was
        // resolving a DIFFERENT audience from a copy that looked just as reasonable.
        crate::modules::dataset::sync::publish_dataset_change(
            &self.pool,
            dataset_id,
            SyncAction::Update,
            crate::modules::sync::Actor::detached(),
        )
        .await;
        tracing::info!(job_id = %job.id, %dataset_id, %file_id, success, "supporting-file integrate finalized (summary + sync)");
    }
}
