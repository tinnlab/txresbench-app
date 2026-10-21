//! Wire types for the dataset project-extension.

use schemars::JsonSchema;
use serde::Serialize;

/// Aggregate stats for the datasets attached to a project — served by the
/// extension-owned `GET /projects/{id}/dataset-summary` route (proves the
/// `register_routes` seam) and shown in the datasets panel header.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProjectDatasetSummary {
    /// Number of datasets attached to the project. (Datasets no longer carry domain
    /// counts — DEC-1 — so per-axis element totals were dropped from this summary.)
    pub dataset_count: i64,
}
