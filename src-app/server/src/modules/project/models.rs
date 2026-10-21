//! Project wire + DB types.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Max project name length (chars). DEC-15.
pub const PROJECT_NAME_MAX: usize = 200;
/// Max description length (bytes). DEC-15.
pub const PROJECT_DESCRIPTION_MAX: usize = 64 * 1024;
/// Max datasets attachable to one project. DEC-14.
pub const PROJECT_MAX_DATASETS: i64 = 100;

/// The acting user's effective permission on a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectivePermission {
    Owner,
    Editor,
    Viewer,
}

impl EffectivePermission {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectivePermission::Owner => "owner",
            EffectivePermission::Editor => "editor",
            EffectivePermission::Viewer => "viewer",
        }
    }
    /// Owner + editor may edit metadata + attach/detach datasets.
    pub fn can_edit(self) -> bool {
        matches!(
            self,
            EffectivePermission::Owner | EffectivePermission::Editor
        )
    }
    /// Only the owner may share / transfer / delete.
    pub fn is_owner(self) -> bool {
        matches!(self, EffectivePermission::Owner)
    }
    pub fn from_share_level(level: &str) -> EffectivePermission {
        match level {
            "editor" => EffectivePermission::Editor,
            _ => EffectivePermission::Viewer,
        }
    }
}

/// A project row.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct Project {
    pub id: Uuid,
    pub owner_id: Uuid,
    /// The account this project belongs to (A2 ownership key). `owner_id` is
    /// retained alongside, re-scoped to "the creating/responsible member within
    /// the account" — authz still runs on `owner_id` until A3 flips it.
    pub account_id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A project as returned to a user, annotated with their effective permission and
/// the dataset count (derived — no denormalized column).
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct ProjectDto {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// `owner` | `editor` | `viewer`.
    pub effective_permission: String,
    pub dataset_count: i64,
}

impl ProjectDto {
    pub fn from_project(project: Project, perm: EffectivePermission, dataset_count: i64) -> Self {
        Self {
            id: project.id,
            owner_id: project.owner_id,
            name: project.name,
            description: project.description,
            created_at: project.created_at,
            updated_at: project.updated_at,
            effective_permission: perm.as_str().to_string(),
            dataset_count,
        }
    }
}

/// The acting user's access to one project — P10's bootstrap seam INTO the P6
/// workbench shell (read `{role, can_edit}` without loading the full `ProjectDto`).
/// Served by `GET /projects/{id}/access`.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProjectAccessDto {
    pub project_id: Uuid,
    /// `owner` | `editor` | `viewer`.
    pub role: String,
    pub can_edit: bool,
    pub is_owner: bool,
}

/// Paged projects list.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProjectListResponse {
    pub projects: Vec<ProjectDto>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateProjectRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// Metadata update. Both fields optional (absent → keep). Project has no nullable
/// column, so no tri-state is needed.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateProjectRequest {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// Query params for the paged projects list.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ProjectListQuery {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub per_page: Option<i64>,
    /// Case-insensitive substring filter on name (ILIKE).
    #[serde(default)]
    pub search: Option<String>,
}

// ----------------------------- datasets -----------------------------

/// Paged datasets-in-project list.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProjectDatasetsResponse {
    pub datasets: Vec<crate::modules::dataset::models::Dataset>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

// ----------------------------- shares -----------------------------

/// A project-share row.
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct ProjectShare {
    pub id: Uuid,
    pub project_id: Uuid,
    pub owner_id: Uuid,
    pub recipient_id: Uuid,
    pub permission_level: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// A share annotated with the recipient's identity (for the owner's "Shared
/// with" panel).
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct ProjectShareDto {
    pub id: Uuid,
    pub project_id: Uuid,
    pub recipient_id: Uuid,
    pub recipient_username: String,
    pub recipient_email: String,
    pub permission_level: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ProjectSharesResponse {
    pub shares: Vec<ProjectShareDto>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateShareRequest {
    pub email: String,
    /// `viewer` | `editor`.
    pub permission_level: String,
}

// ----------------------------- transfers -----------------------------

#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct ProjectTransfer {
    pub id: Uuid,
    pub project_id: Uuid,
    pub from_user_id: Uuid,
    pub to_user_id: Uuid,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateTransferRequest {
    pub email: String,
}

// ----------------------------- settings -----------------------------

#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct ProjectSettings {
    pub transfer_enabled: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct UpdateProjectSettingsRequest {
    pub transfer_enabled: bool,
}

// ----------------------------- admin (cross-user) -----------------------------

/// Max ids in one bulk (multi-select) admin operation. DEC-7.
pub const ADMIN_BATCH_MAX: usize = 500;

/// A project row for the cross-user admin table: the project + its owner's identity
/// (name/email/active) + derived counts + status flags + activity.
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct AdminProjectRow {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub owner_username: String,
    pub owner_email: String,
    pub owner_display_name: Option<String>,
    pub owner_is_active: bool,
    pub dataset_count: i64,
    pub share_count: i64,
    pub transfer_pending: bool,
    /// TRUE when the owner is deactivated — the orphan-reclamation signal.
    pub is_orphaned: bool,
    /// GREATEST(project.updated_at, MAX dataset.updated_at) — jobs carry no project link.
    pub last_activity: DateTime<Utc>,
}

/// A user option for the admin change-owner / share / reassign pickers.
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct AdminUserOption {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub display_name: Option<String>,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminUserSearchResponse {
    pub users: Vec<AdminUserOption>,
}

/// Query for the admin user-search picker endpoint.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct AdminUserSearchQuery {
    /// ILIKE substring on username OR email (empty → the first page of users).
    #[serde(default)]
    pub search: Option<String>,
}

/// Deployment-wide overview stats (unfiltered — the "state of the deployment").
#[derive(Debug, Clone, Serialize, JsonSchema, FromRow)]
pub struct AdminProjectStats {
    pub total_projects: i64,
    pub distinct_owners: i64,
    pub orphaned_count: i64,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminProjectListResponse {
    pub rows: Vec<AdminProjectRow>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
    pub stats: AdminProjectStats,
}

/// Full admin drill-down for one project.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct AdminProjectDetail {
    pub project: Project,
    pub owner_username: String,
    pub owner_email: String,
    pub owner_display_name: Option<String>,
    pub owner_is_active: bool,
    pub shares: Vec<ProjectShareDto>,
    pub datasets: Vec<crate::modules::dataset::models::Dataset>,
    pub transfer: Option<ProjectTransfer>,
}

/// Query params for the admin cross-user list.
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct AdminProjectListQuery {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub per_page: Option<i64>,
    /// ILIKE substring on project name.
    #[serde(default)]
    pub search: Option<String>,
    /// Filter to one owner.
    #[serde(default)]
    pub owner_id: Option<Uuid>,
    /// One of `orphaned | private | shared | empty` (else ignored).
    #[serde(default)]
    pub status: Option<String>,
    /// One of `updated | created | name | owner | datasets` (default `updated`).
    #[serde(default)]
    pub sort: Option<String>,
}

impl AdminProjectListQuery {
    /// Clamp paging: page floors at 1, per_page defaults 10, clamps [1,200].
    pub fn paging(&self) -> (i64, i64) {
        (
            self.page.unwrap_or(1).max(1),
            self.per_page.unwrap_or(10).clamp(1, 200),
        )
    }
    /// Canonical sort key (whitelist; unknown → `updated`).
    pub fn sort_key(&self) -> &'static str {
        match self.sort.as_deref() {
            Some("created") => "created",
            Some("name") => "name",
            Some("owner") => "owner",
            Some("datasets") => "datasets",
            _ => "updated",
        }
    }
    /// Canonical status filter (whitelist; unknown/None → no filter).
    pub fn status_filter(&self) -> Option<&'static str> {
        match self.status.as_deref() {
            Some("orphaned") => Some("orphaned"),
            Some("private") => Some("private"),
            Some("shared") => Some("shared"),
            Some("empty") => Some("empty"),
            _ => None,
        }
    }
}

/// Admin forced change of a project's owner (immediate, no accept — DEC-2/3).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AdminChangeOwnerRequest {
    pub new_owner_id: Uuid,
    /// Keep the previous owner as an accepted editor share (default false — DEC-3).
    #[serde(default)]
    pub keep_old_as_editor: bool,
}

/// Admin share-on-behalf (by recipient id; `viewer` | `editor`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AdminShareRequest {
    pub recipient_id: Uuid,
    pub permission_level: String,
}

/// Reassign ALL of one owner's projects to another (offboarding accelerator).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AdminReassignRequest {
    pub from_owner_id: Uuid,
    pub to_owner_id: Uuid,
}

/// Multi-select bulk reassign of specific projects (DEC-7).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BatchReassignRequest {
    pub project_ids: Vec<Uuid>,
    pub to_owner_id: Uuid,
}

/// Multi-select bulk delete of specific projects.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct BatchDeleteRequest {
    pub project_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BatchFailure {
    pub id: Uuid,
    pub error: String,
}

/// Partial-failure result for a bulk op: one bad id doesn't abort the rest.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct BatchResult {
    pub succeeded: Vec<Uuid>,
    pub failed: Vec<BatchFailure>,
}

/// Validate a project name (non-empty, ≤ cap). Returns the trimmed name.
pub fn validate_name(name: &str) -> Result<String, &'static str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Project name is required");
    }
    if trimmed.chars().count() > PROJECT_NAME_MAX {
        return Err("Project name is too long (max 200 characters)");
    }
    Ok(trimmed.to_string())
}

/// Validate a description (≤ cap bytes).
pub fn validate_description(desc: &str) -> Result<(), &'static str> {
    if desc.len() > PROJECT_DESCRIPTION_MAX {
        return Err("Project description is too long (max 64 KiB)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_validation() {
        assert!(validate_name("  ").is_err());
        assert!(validate_name("").is_err());
        assert_eq!(validate_name("  My Project  ").unwrap(), "My Project");
        let long: String = "x".repeat(PROJECT_NAME_MAX + 1);
        assert!(validate_name(&long).is_err());
        assert!(validate_name(&"x".repeat(PROJECT_NAME_MAX)).is_ok());
    }

    #[test]
    fn description_validation() {
        assert!(validate_description("ok").is_ok());
        assert!(validate_description(&"x".repeat(PROJECT_DESCRIPTION_MAX + 1)).is_err());
    }

    #[test]
    fn admin_query_whitelists_sort_status_and_clamps_paging() {
        let q = AdminProjectListQuery::default();
        assert_eq!(q.paging(), (1, 10), "defaults: page 1, per_page 10");
        assert_eq!(q.sort_key(), "updated", "default sort");
        assert_eq!(q.status_filter(), None, "no status filter by default");

        let q = AdminProjectListQuery {
            page: Some(0),
            per_page: Some(9999),
            sort: Some("bogus".into()),
            status: Some("bogus".into()),
            ..Default::default()
        };
        assert_eq!(
            q.paging(),
            (1, 200),
            "page floors at 1, per_page clamps to 200"
        );
        assert_eq!(q.sort_key(), "updated", "unknown sort → updated");
        assert_eq!(q.status_filter(), None, "unknown status → no filter");

        for (s, want) in [
            ("name", "name"),
            ("owner", "owner"),
            ("created", "created"),
            ("datasets", "datasets"),
        ] {
            let q = AdminProjectListQuery {
                sort: Some(s.into()),
                ..Default::default()
            };
            assert_eq!(q.sort_key(), want);
        }
        for s in ["orphaned", "private", "shared", "empty"] {
            let q = AdminProjectListQuery {
                status: Some(s.into()),
                ..Default::default()
            };
            assert_eq!(q.status_filter(), Some(s));
        }
    }

    #[test]
    fn effective_permission_semantics() {
        assert!(EffectivePermission::Owner.can_edit());
        assert!(EffectivePermission::Owner.is_owner());
        assert!(EffectivePermission::Editor.can_edit());
        assert!(!EffectivePermission::Editor.is_owner());
        assert!(!EffectivePermission::Viewer.can_edit());
        assert_eq!(
            EffectivePermission::from_share_level("editor"),
            EffectivePermission::Editor
        );
        assert_eq!(
            EffectivePermission::from_share_level("viewer"),
            EffectivePermission::Viewer
        );
        assert_eq!(
            EffectivePermission::from_share_level("bogus"),
            EffectivePermission::Viewer
        );
    }
}
