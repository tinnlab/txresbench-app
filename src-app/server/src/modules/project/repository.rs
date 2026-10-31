//! Project persistence. Uses sqlx COMPILE-TIME `query_as!`/`query!` macros (the
//! canonical pattern — see `dataset/repository.rs`): every query is verified
//! against the build DB's real schema at `cargo check` time. `timestamptz`
//! columns need the `col as "col: DateTime<Utc>"` override (ziee-auth pulls
//! sqlx's `time` feature, whose default is `OffsetDateTime`). Every read is
//! owner-/recipient-scoped; a foreign project reads as `None` → 404 (no leak).
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver):
//! `uuid` columns are 16-byte BLOBs and `timestamptz` columns are canonical
//! RFC3339-UTC TEXT (DEC-8's map), so the plugin `<ident: Type>` overrides the
//! PG macro inference cannot produce are written out explicitly everywhere
//! the DB type differs from the Rust type — `id as "id: Uuid"`,
//! `created_at as "created_at: DateTime<Utc>"`. The serialization-substitution
//! note (PG row locks → `BEGIN IMMEDIATE`) is at [`Self::attach_dataset_capped`]
//! and [`Self::initiator_still_owner_locked`]; the `now()` → `strftime` rewrite
//! convention is at [`Self::update`]; the SQLITE_BUSY/-UNIQUE error-code maps
//! are at [`Self::map_lock_timeout`] / [`Self::create_transfer`].

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::dataset::models::Dataset;

use super::models::{
    AdminProjectDetail, AdminProjectRow, AdminProjectStats, EffectivePermission, Project,
    ProjectDto, ProjectSettings, ProjectShare, ProjectShareDto, ProjectTransfer,
};

/// A3 (DEC-12): grade a coarse ACCOUNT role into the within-project inner-role
/// FLOOR a bare account member gets. `owner→Owner, admin→Editor, member→Viewer`.
/// Account membership never confers project-**Owner** to a non-owning member unless
/// they are the account **Owner** — destructive owner-only acts (delete/transfer/
/// share) stay with the real `owner_id`, explicit shares, or the platform-admin
/// override. Parses via `AccountRole::from_str` (guideline §6 — never `unwrap` a DB
/// enum string).
fn account_role_floor(role: &str) -> Result<EffectivePermission, AppError> {
    use crate::modules::account::AccountRole;
    Ok(match AccountRole::from_str(role)? {
        AccountRole::Owner => EffectivePermission::Owner,
        AccountRole::Admin => EffectivePermission::Editor,
        AccountRole::Member => EffectivePermission::Viewer,
    })
}

/// The higher-privilege of two optional effective permissions (Owner > Editor >
/// Viewer); `None` only when both are `None`. Used to MAX an accepted-share level
/// with the account-membership floor so neither path can DOWNgrade the other.
fn max_permission(
    a: Option<EffectivePermission>,
    b: Option<EffectivePermission>,
) -> Option<EffectivePermission> {
    fn rank(p: EffectivePermission) -> u8 {
        match p {
            EffectivePermission::Owner => 3,
            EffectivePermission::Editor => 2,
            EffectivePermission::Viewer => 1,
        }
    }
    match (a, b) {
        (Some(x), Some(y)) => Some(if rank(x) >= rank(y) { x } else { y }),
        (Some(x), None) => Some(x),
        (None, b) => b,
    }
}

/// One pending transfer cancelled by the offboarding hook
/// ([`ProjectRepository::cancel_pending_transfers_for_removed_member`], #171 (a)).
///
/// Carries BOTH parties because both must be told the offer is gone: the removal is
/// performed by a third party (a platform admin), so neither party's device has a
/// local mutation of its own to echo, and without a frame each would keep rendering
/// a pending transfer that no longer exists. Not an API type — it never crosses the
/// wire; the removal route still answers 204 with no body (DEC-10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CancelledTransfer {
    pub id: Uuid,
    pub project_id: Uuid,
    pub from_user_id: Uuid,
    pub to_user_id: Uuid,
}

/// The SQLite bound for [`ProjectRepository::accept_transfer`]'s transaction
/// (DEC-27, ported). Generous relative to the work it bounds (a handful of
/// single-row writes), so it fires only on genuine contention. A FIXED bound
/// rather than an admin setting: it is a safety ceiling on a security-critical
/// transaction, not a product knob, and an operator who could raise it could
/// re-create the outage it exists to prevent. An earlier revision added "and
/// one who could lower it to 0 could disable the durable half of the #171 gate
/// by making it always time out" — both halves of that were false, and it is
/// corrected rather than deleted: in Postgres `lock_timeout = 0` DISABLES the
/// timeout (an unbounded wait), so 0 restores the old behaviour; and a gate
/// that always timed out would fail CLOSED, refusing every accept, not letting
/// transfers through. The argument for a fixed constant stands on its first
/// sentence alone.
///
/// SQLite port: the PG `SET LOCAL lock_timeout = '3s'` statement does not
/// exist — the engine has one lock (the database write lock), and its wait is
/// bounded by the CONNECTION'S `busy_timeout` (5000 ms per
/// PROV-sqlite-store-1, set on the pool). The bound is therefore not a
/// per-transaction constant any more; it is a pool-wide pragma, and this port
/// deliberately does not try to re-create a tighter per-transaction bound
/// (SQLite offers none — the timeout-expiry shape is preserved instead: an
/// expired `busy_timeout` surfaces as `SQLITE_BUSY`, which
/// [`Self::map_lock_timeout`] turns into the same retryable `409
/// TRANSFER_BUSY` the PG `55P03`/`40P01` codes did).

pub struct ProjectRepository {
    pool: SqlitePool,
}

impl ProjectRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // ------------------------- project core -------------------------

    /// Behaviour-preserving create — stamps the owner's personal account (A2 DEC-7).
    /// The lazy backstop `ensure_personal_account_for` yields the personal account
    /// (A1 baseline for a pre-existing owner; created here until A5's signup hook
    /// lands). Kept for callers with NO active-account request context (tests,
    /// admin/derived paths); the user-facing handler uses [`create_in_account`].
    pub async fn create(
        &self,
        owner_id: Uuid,
        name: &str,
        description: &str,
    ) -> Result<Project, AppError> {
        let account_id =
            crate::modules::account::scope::ensure_personal_account_for(&self.pool, owner_id)
                .await?;
        self.create_in_account(owner_id, account_id, name, description)
            .await
    }

    /// A4 ITEM-7: create stamped with an EXPLICIT `account_id` — the ACTIVE account
    /// (`ActiveAccount`, PROV-A4-1) the request is acting under. Membership of that
    /// account is proven by the extractor (a non-member is 404'd before the write).
    /// For a solo user the active account IS their personal account == what A2
    /// stamped, so `create_project` stays behaviour-preserving (INV-2's solo half).
    pub async fn create_in_account(
        &self,
        owner_id: Uuid,
        account_id: Uuid,
        name: &str,
        description: &str,
    ) -> Result<Project, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            Project,
            r#"INSERT INTO projects (id, owner_id, account_id, name, description)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", name, description,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            owner_id,
            account_id,
            name,
            description,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get(&self, id: Uuid) -> Result<Option<Project>, AppError> {
        sqlx::query_as!(
            Project,
            r#"SELECT id as "id: Uuid", owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", name, description,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM projects WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The acting user's effective permission on a project, or `None` if invisible.
    ///
    /// A3 (DEC-12): the account-membership rung. After the unchanged owner-branch
    /// (→Owner) and accepted-share branch (→share level), a THIRD branch floors the
    /// inner role by the caller's role in the project's `account_id`
    /// (`owner→Owner, admin→Editor, member→Viewer`, MAX'd with any share). A bare
    /// account co-member (not owner, no share) therefore reaches at ≥Viewer; a
    /// non-member (no owner/share/membership) stays `None` (⇒404) — the cross-account
    /// existence-oracle guard (INV-1). Behaviour-preserving for personal accounts:
    /// their single member IS the owner, so the owner-branch fires and the new branch
    /// never does (INV-4). This one widening flips every consumer that routes through
    /// this chokepoint (`resolve`/`resolve_admin`, workstore, provenance, jobs).
    pub async fn effective_permission(
        &self,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<EffectivePermission>, AppError> {
        // One query resolves owner + the project's account + the caller's membership
        // role in that account (indexed by `idx_account_members_user`).
        let owner = sqlx::query!(
            r#"SELECT p.owner_id as "owner_id: Uuid",
                      (SELECT am.role FROM account_members am
                        WHERE am.account_id = p.account_id AND am.user_id = $2)
                          as "member_role?"
               FROM projects p WHERE p.id = $1"#,
            project_id,
            user_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let Some(row) = owner else {
            return Ok(None);
        };
        // H-1 (#147, disposition (c)): the creator branch is conjoined with CURRENT
        // membership of the project's account. `projects.owner_id` is the creating
        // member, `projects.account_id` is the tenant, and deleting an
        // `account_members` row changes neither — so an unconditional owner branch
        // meant a removed member kept `Owner` (read, write, delete, transfer, share)
        // on every project they had created in the organization, forever. Requiring
        // membership here is what makes removal a revocation, at the chokepoint
        // rather than at ~30 call sites.
        //
        // It removes NO legitimate access: `owner_id` is a member of `account_id` by
        // construction — `create` stamps the owner's personal account (which
        // `ensure_personal_account_for` seeds with an `owner` membership),
        // `create_in_account` takes the ACTIVE account whose membership the
        // `ActiveAccount` extractor has already proven, and both ownership moves
        // (`accept_transfer`, `admin_change_owner`) re-stamp `account_id` to the NEW
        // owner's personal account. The only reachable `owner ∧ ¬member` state is a
        // removal. Behaviour-preserving for personal accounts (INV-11c): their sole
        // member IS the owner, so `member_role` is always `Some` there.
        //
        // A removed member falls THROUGH to the share ∪ account-floor branches below,
        // i.e. to whatever accepted share they still hold, else `None` ⇒ 404. Note
        // this deliberately does NOT change DEC-12's grant model (#140 is an open
        // owner decision): no floor value and no role filter moves.
        if row.owner_id == user_id && row.member_role.is_some() {
            return Ok(Some(EffectivePermission::Owner));
        }
        let level = sqlx::query!(
            "SELECT permission_level FROM project_shares \
             WHERE project_id = $1 AND recipient_id = $2 AND status = 'accepted'",
            project_id,
            user_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let share = level.map(|r| EffectivePermission::from_share_level(&r.permission_level));
        // A3 account-membership floor (DEC-12), MAX'd with any accepted share.
        let account_floor = row
            .member_role
            .as_deref()
            .map(account_role_floor)
            .transpose()?;
        Ok(max_permission(share, account_floor))
    }

    /// List projects visible to `user_id` (owned ∪ accepted-shares), paged, with
    /// effective permission + dataset count, optional ILIKE name search.
    pub async fn list_visible(
        &self,
        user_id: Uuid,
        search: Option<&str>,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<ProjectDto>, i64), AppError> {
        let per_page = per_page.clamp(1, 100);
        let page = page.max(1);
        let offset = (page - 1) * per_page;

        // A3 (DEC-5/DEC-12): the `owner_id = $1` visibility disjunct widens to
        // "projects whose `account_id` is in the caller's memberships", PRESERVING
        // the orthogonal accepted-share union (`sh.id IS NOT NULL`). The CASE gains
        // the mirror `COALESCE(sh.permission_level, 'viewer')` so a bare account
        // co-member (widened row, no share) reports the Viewer floor and
        // `effective_permission!` stays non-null. Behaviour-preserving for personal
        // accounts (the widened-member rows never exist there — the single member is
        // the owner, caught by the first CASE arm). Uses `idx_account_members_user`
        // + `idx_projects_account_created`.
        //
        // H-1 (#147): the `owner` CASE arm is conjoined with current membership, to
        // stay in lock-step with `effective_permission`. The WHERE clause already
        // requires membership ∪ an accepted share, so this changes no ROW — only the
        // label on the one row it could disagree about: a removed ex-owner still
        // reachable through an accepted share is now labelled by that share's level,
        // exactly as `effective_permission` now reports it, instead of `owner`.
        // SQLite port (DEC-11/DEC-12): the `name ILIKE '%' || $2 || '%'`
        // predicate became `instr(lower(name), lower($2)) > 0` — substring
        // containment with ASCII-only folding, the PG-ILIKE equivalent on the
        // ASCII project-name domain (documented limitation, DEC-11 — a
        // Unicode-insensitive search is the recorded upgrade path); the
        // `$2::text` cast went with it (the typed bind carries the NULL on
        // the `None` search leg). `GREATEST(a, b)` (not an SQLite scalar) is
        // `MAX(a, b)` — SQLite's scalar multi-arg `max()`.
        let projects = sqlx::query_as!(
            ProjectDto,
            r#"SELECT s.id as "id: Uuid", s.owner_id as "owner_id: Uuid", s.name, s.description,
                      s.created_at as "created_at: DateTime<Utc>",
                      s.updated_at as "updated_at: DateTime<Utc>",
                      CASE WHEN s.owner_id = $1
                                AND s.account_id IN (SELECT am.account_id
                                                       FROM account_members am
                                                      WHERE am.user_id = $1)
                           THEN 'owner'
                           ELSE CASE MAX(
                                  CASE sh.permission_level WHEN 'editor' THEN 2
                                                           WHEN 'viewer' THEN 1 ELSE 0 END,
                                  COALESCE((SELECT CASE am.role WHEN 'owner' THEN 3
                                                                WHEN 'admin' THEN 2 ELSE 1 END
                                              FROM account_members am
                                             WHERE am.account_id = s.account_id
                                               AND am.user_id = $1), 0))
                                WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' ELSE 'viewer' END
                           END
                          as "effective_permission!",
                      (SELECT count(*) FROM project_datasets sd WHERE sd.project_id = s.id)
                          as "dataset_count!"
               FROM projects s
               LEFT JOIN project_shares sh
                 ON sh.project_id = s.id AND sh.recipient_id = $1 AND sh.status = 'accepted'
               WHERE (s.account_id IN (SELECT am.account_id FROM account_members am
                                        WHERE am.user_id = $1)
                      OR sh.id IS NOT NULL)
                 AND ($2 IS NULL OR instr(lower(s.name), lower($2)) > 0)
               ORDER BY s.created_at DESC LIMIT $3 OFFSET $4"#,
            user_id,
            search,
            per_page,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let total = sqlx::query_scalar!(
            r#"SELECT count(*) as "count!" FROM projects s
               LEFT JOIN project_shares sh
                 ON sh.project_id = s.id AND sh.recipient_id = $1 AND sh.status = 'accepted'
               WHERE (s.account_id IN (SELECT am.account_id FROM account_members am
                                        WHERE am.user_id = $1)
                      OR sh.id IS NOT NULL)
                 AND ($2 IS NULL OR instr(lower(s.name), lower($2)) > 0)"#,
            user_id,
            search,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((projects, total))
    }

    pub async fn update(
        &self,
        id: Uuid,
        name: Option<&str>,
        description: Option<&str>,
    ) -> Result<Project, AppError> {
        // fetch_optional → 404 (not 500) if the project was deleted mid-request.
        // SQLite port: `now()` → the canonical Rust/RFC3339 clock text
        // (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`) — the same DEC-8/DEC-12
        // rewrite every module's write clock uses (ITA-17 convention).
        sqlx::query_as!(
            Project,
            r#"UPDATE projects SET
                 name = COALESCE($2, name),
                 description = COALESCE($3, description),
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", name, description,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            name,
            description,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?
        .ok_or_else(|| AppError::not_found("Project"))
    }

    /// Delete a project inside a caller-owned transaction (so extension cleanup
    /// hooks and the project-row delete commit atomically). This is the ONLY delete
    /// path — the former bare `delete` was removed so no caller can bypass the
    /// extension `on_project_deleted` hooks (see `project::lifecycle`).
    pub async fn delete_in_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        id: Uuid,
    ) -> Result<(), AppError> {
        sqlx::query!("DELETE FROM projects WHERE id = $1", id)
            .execute(&mut **tx)
            .await
            .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Duplicate a project inside a caller-owned transaction (so extension
    /// deep-copy hooks and the new project row commit atomically). The
    /// `(copy N)` collision check runs on the SAME tx (single-tx collision-safe;
    /// two concurrent duplicates in separate txs can't see each other's
    /// uncommitted rows — acceptable, projects have no unique-name constraint).
    pub async fn duplicate_in_tx(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        source: &Project,
    ) -> Result<Project, AppError> {
        let mut n = 1;
        let name = loop {
            let candidate = format!("{} (copy {n})", source.name);
            // A3 (ITEM-2): the copy-name collision check scopes to the source's
            // ACCOUNT, not its owner — a duplicated project must not name-collide
            // within the account it lives in. Behaviour-preserving for personal
            // accounts (the account's projects == the owner's projects).
            let exists = sqlx::query_scalar!(
                r#"SELECT EXISTS(SELECT 1 FROM projects WHERE account_id = $1 AND name = $2) as "exists!: bool""#,
                source.account_id,
                candidate,
            )
            .fetch_one(&mut **tx)
            .await
            .map_err(AppError::database_error)?;
            if !exists {
                break candidate;
            }
            n += 1;
            if n > 10_000 {
                break format!("{} (copy {})", source.name, Uuid::new_v4());
            }
        };
        let id = Uuid::new_v4();
        // A2: the copy is owned by the SAME owner as the source, so it inherits
        // the source's account (`source.account_id`) — no lookup needed, and it
        // stays consistent even mid-transaction.
        sqlx::query_as!(
            Project,
            r#"INSERT INTO projects (id, owner_id, account_id, name, description)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id as "id: Uuid", owner_id as "owner_id: Uuid", account_id as "account_id!: Uuid", name, description,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            source.owner_id,
            source.account_id,
            name,
            source.description,
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(AppError::database_error)
    }

    // ------------------------- datasets -------------------------

    pub async fn dataset_count(&self, project_id: Uuid) -> Result<i64, AppError> {
        sqlx::query_scalar!(
            r#"SELECT count(*) as "count!" FROM project_datasets WHERE project_id = $1"#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// True if `dataset_id` exists (referential-integrity guard for attach).
    pub async fn dataset_exists(&self, dataset_id: Uuid) -> Result<bool, AppError> {
        sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM datasets WHERE id = $1) as "exists!: bool""#,
            dataset_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Attach a dataset to a project (M:N — a dataset may belong to many projects),
    /// enforcing the per-project cap ATOMICALLY (the project row is locked
    /// `FOR UPDATE`). Re-attaching an already-attached dataset is a no-op.
    /// `Ok(false)` = cap hit (→ 422).
    pub async fn attach_dataset_capped(
        &self,
        project_id: Uuid,
        dataset_id: Uuid,
        max: i64,
    ) -> Result<bool, AppError> {
        // Serialization port (ITEM-17 #7 / ITEM-15 precedent): SQLite has no
        // row locks, so the PG `FOR UPDATE` is gone and the WRITE lock is the
        // mechanism — the transaction opens `BEGIN IMMEDIATE`, and the
        // project row's once-locking SELECT survives as the horizontal read
        // (its row was discarded under PG too; only the lock mattered). The
        // per-project cap is therefore serialized at the database-write-lock
        // grain, the same widening the account module documented.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        // SQLite's `1` literal has NULL type affinity, so the sqlx macro needs
        // the explicit `<ident: Type>` override (the row is discarded either way).
        sqlx::query!(
            r#"SELECT 1 as "one: i64" FROM projects WHERE id = $1"#,
            project_id
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let already = sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM project_datasets WHERE project_id = $1 AND dataset_id = $2) as "exists!: bool""#,
            project_id,
            dataset_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        if !already {
            let count = sqlx::query_scalar!(
                r#"SELECT count(*) as "count!" FROM project_datasets WHERE project_id = $1"#,
                project_id,
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(AppError::database_error)?;
            if count >= max {
                tx.rollback().await.map_err(AppError::database_error)?;
                return Ok(false);
            }
        }
        sqlx::query!(
            "INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2) \
             ON CONFLICT (project_id, dataset_id) DO NOTHING",
            project_id,
            dataset_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(true)
    }

    pub async fn detach_dataset(
        &self,
        project_id: Uuid,
        dataset_id: Uuid,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "DELETE FROM project_datasets WHERE project_id = $1 AND dataset_id = $2",
            project_id,
            dataset_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    pub async fn list_datasets(
        &self,
        project_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<Dataset>, i64), AppError> {
        let per_page = per_page.clamp(1, 100);
        let page = page.max(1);
        let offset = (page - 1) * per_page;
        // `d.`-qualified: `datasets` and `project_datasets` BOTH have `created_at`.
        let datasets = sqlx::query_as!(
            Dataset,
            r#"SELECT d.id as "id: Uuid", d.name, d.owner_id as "owner_id: Uuid", d.account_id as "account_id!: Uuid", d.datatype,
                      d.metadata as "metadata: serde_json::Value",
                      d.source, d.source_artifact_id as "source_artifact_id: Uuid", d.content_hash,
                      d.created_at as "created_at: DateTime<Utc>",
                      d.updated_at as "updated_at: DateTime<Utc>"
               FROM datasets d
               JOIN project_datasets sd ON sd.dataset_id = d.id
               WHERE sd.project_id = $1 ORDER BY sd.created_at DESC LIMIT $2 OFFSET $3"#,
            project_id,
            per_page,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let total = self.dataset_count(project_id).await?;
        Ok((datasets, total))
    }

    // ------------------------- shares -------------------------

    pub async fn upsert_share(
        &self,
        project_id: Uuid,
        owner_id: Uuid,
        recipient_id: Uuid,
        level: &str,
    ) -> Result<ProjectShare, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            ProjectShare,
            r#"INSERT INTO project_shares
                 (id, project_id, owner_id, recipient_id, permission_level, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')
               ON CONFLICT (project_id, recipient_id) DO UPDATE SET
                 permission_level = EXCLUDED.permission_level,
                 status = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id as "id: Uuid", project_id as "project_id: Uuid", owner_id as "owner_id: Uuid", recipient_id as "recipient_id: Uuid", permission_level, status,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            project_id,
            owner_id,
            recipient_id,
            level,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn active_share_exists(
        &self,
        project_id: Uuid,
        recipient_id: Uuid,
    ) -> Result<bool, AppError> {
        sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM project_shares
                 WHERE project_id = $1 AND recipient_id = $2 AND status IN ('pending','accepted')) as "exists!: bool""#,
            project_id,
            recipient_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// User ids with an ACCEPTED share on this project (the extra project-change sync
    /// audience so editors/viewers see live updates).
    pub async fn accepted_recipient_ids(&self, project_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query!(
            "SELECT recipient_id as \"recipient_id: Uuid\" FROM project_shares WHERE project_id = $1 AND status = 'accepted'",
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.recipient_id).collect())
    }

    /// Everyone who may currently see this project: the CURRENT members of its
    /// account ∪ its accepted-share recipients. The set
    /// [`crate::modules::project::scope::project_audience`] fans sync frames to
    /// (#168), and — deliberately — the same set
    /// [`Self::effective_permission`] resolves to `Some` for, read from the other
    /// direction (given a project, who; rather than given a user, what).
    ///
    /// The membership arm is the whole point: `projects.owner_id` is the creating
    /// member and a removal changes neither it nor `account_id`, so an audience
    /// derived from `owner_id` keeps addressing a removed member forever. The
    /// accepted-share arm is preserved untouched — a share is an orthogonal grant
    /// (#172).
    pub async fn audience_user_ids(&self, project_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query_scalar!(
            r#"SELECT DISTINCT uid as "id!: Uuid" FROM (
                 SELECT am.user_id AS uid
                   FROM projects p
                   JOIN account_members am ON am.account_id = p.account_id
                  WHERE p.id = $1
                 UNION
                 SELECT ps.recipient_id
                   FROM project_shares ps
                  WHERE ps.project_id = $1 AND ps.status = 'accepted'
               ) audience
               ORDER BY 1"#,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows)
    }

    pub async fn get_share(&self, id: Uuid) -> Result<Option<ProjectShare>, AppError> {
        sqlx::query_as!(
            ProjectShare,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", owner_id as "owner_id: Uuid", recipient_id as "recipient_id: Uuid", permission_level, status,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM project_shares WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn list_shares_for_project(
        &self,
        project_id: Uuid,
    ) -> Result<Vec<ProjectShareDto>, AppError> {
        sqlx::query_as!(
            ProjectShareDto,
            r#"SELECT sh.id as "id: Uuid", sh.project_id as "project_id: Uuid", sh.recipient_id as "recipient_id: Uuid",
                      u.username as recipient_username, u.email as recipient_email,
                      sh.permission_level, sh.status,
                      sh.created_at as "created_at: DateTime<Utc>"
               FROM project_shares sh JOIN users u ON u.id = sh.recipient_id
               WHERE sh.project_id = $1 ORDER BY sh.created_at DESC"#,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn set_share_status(
        &self,
        id: Uuid,
        recipient_id: Uuid,
        status: &str,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE project_shares SET status = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = $1 AND recipient_id = $2 AND status = 'pending'",
            id,
            recipient_id,
            status,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Revoke a share you granted.
    ///
    /// H-1 (#147): this is one of the project mutations that does NOT funnel through
    /// `ProjectScope::resolve` → `effective_permission` (`handlers::revoke_share`
    /// calls it directly), so it never inherited that fix. A member removed from the
    /// account otherwise kept authority over the account's project ACL — able to
    /// revoke the REMAINING members' shares on a project they can no longer even
    /// open. The share-owner branch is conjoined with current membership of the
    /// PROJECT's account, the same transform as every other site.
    ///
    /// The OTHER handler-scoped mutations in this module were swept with it. The
    /// sweep's outcome is recorded here so the next reader does not have to redo it —
    /// as a per-method disposition, deliberately NOT as a claim that the list is
    /// closed (four separate "this is the only…" claims on this branch were each
    /// wrong, and one of them concealed a live bug for four audit rounds):
    ///
    /// * [`Self::cancel_transfer`] — a site, gated, then deliberately UN-gated. See
    ///   its own doc and DEC-16.
    /// * `accept_share` / `decline_share` — not sites: scoped to the RECIPIENT of an
    ///   offer, and a recipient is deliberately not required to be an account
    ///   member.
    ///
    ///   A share leaves the row IN the account, so the recipient's reach is the
    ///   orthogonal share union this branch preserves by design.
    /// * `accept_transfer` — **filed as #171, and now FIXED; this entry is kept
    ///   because the reasoning that left it open is the useful part.**
    ///   `accept_transfer` re-stamps
    ///   `projects.account_id` to the recipient's PERSONAL account — it moves the
    ///   resource OUT of the tenant — so it was never an "orthogonal union" like the
    ///   share pair above, and grouping it with them is what made the gap invisible.
    ///   It was left alone HERE because gating it on recipient membership would break
    ///   transfers outright (a transfer's whole purpose is to hand a project to
    ///   someone who is NOT a member) — that remains true and is now pinned by
    ///   INV-3/TEST-5 — and because the real fix was #147 disposition (a), then out
    ///   of scope (that branch's DEC-2).
    ///
    ///   #171 closed it with BOTH remedies, neither depending on the other: removal
    ///   cancels the departing member's pending transfers in BOTH directions
    ///   ([`Self::cancel_pending_transfers_for_removed_member`], called inside
    ///   `remove_member`'s transaction), AND [`Self::accept_transfer`] re-validates
    ///   at accept time that the INITIATOR still resolves as project `Owner`. The
    ///   recipient's membership is still not consulted, and must not be.
    /// * `decline_transfer` — not a site. Scoped to the recipient, and it only ever
    ///   REFUSES a resource; a removed member declining an offer moves nothing.
    ///   Deliberately left reachable so an accept-side gate can never trap an
    ///   unwanted offer in the recipient's queue (TEST-6).
    /// * `create_project` and `update_settings` — also skip `effective_permission`;
    ///   gated instead by the `ActiveAccount` extractor (which 404s a non-member) and
    ///   by `ProjectSettingsManage`. Not sites.
    ///
    /// Scope of the above: `handlers.rs` only. `admin_handlers.rs` has its own
    /// handler-scoped mutations that likewise skip `effective_permission`; they are a
    /// class, gated as a class by the `ProjectAdminManage` platform permission, and
    /// are not enumerated here. **Nor is the list above offered as exhaustive** — the
    /// three previous revisions of this comment each claimed a closed set and each
    /// was wrong, and the first of them ("`revoke_share` is the ONE…") hid
    /// `cancel_transfer` from four audit rounds. Treat it as a set of dispositions
    /// that were checked, not as a boundary.
    ///
    /// (An earlier revision of this comment claimed `revoke_share` was the ONE such
    /// mutation. That was false, and the claim is what hid `cancel_transfer` from
    /// four successive audit rounds.)
    pub async fn revoke_share(&self, id: Uuid, owner_id: Uuid) -> Result<bool, AppError> {
        // SQLite port: `DELETE FROM t alias` is not SQLite grammar (the bare
        // alias form errors "near ps"; even `AS` is newer-only), and the
        // outer-table alias in the EXISTS also has to go — the membership
        // conjunct is expressed with a `project_id IN (SELECT …)` subquery
        // instead (same rows: the share's project must live in an account the
        // caller is a member of).
        let res = sqlx::query!(
            "DELETE FROM project_shares \
             WHERE id = $1 AND owner_id = $2 \
               AND project_id IN (SELECT p.id FROM projects p \
                                   WHERE p.account_id IN (SELECT am.account_id \
                                                            FROM account_members am \
                                                           WHERE am.user_id = $2))",
            id,
            owner_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    // ------------------------- transfers -------------------------

    pub async fn create_transfer(
        &self,
        project_id: Uuid,
        from_user_id: Uuid,
        to_user_id: Uuid,
    ) -> Result<ProjectTransfer, AppError> {
        let id = Uuid::new_v4();
        sqlx::query_as!(
            ProjectTransfer,
            r#"INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status)
               VALUES ($1, $2, $3, $4, 'pending')
               RETURNING id as "id: Uuid", project_id as "project_id: Uuid", from_user_id as "from_user_id: Uuid", to_user_id as "to_user_id: Uuid", status,
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            id,
            project_id,
            from_user_id,
            to_user_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|err| {
            // Lost the race against `uq_project_transfers_pending` → intended 409.
            // SQLite port: the violation surfaces as the EXTENDED result code
            // `2067` (SQLITE_CONSTRAINT_UNIQUE — sqlx-sqlite reports the
            // extended code as its decimal string, measured in
            // sqlx-sqlite 0.8.6 `error.rs`; `1555` PRIMARYKEY is the same
            // race in the unlikely event the composite PK fires first).
            if let sqlx::Error::Database(db) = &err {
                if matches!(db.code().as_deref(), Some("2067") | Some("1555")) {
                    return AppError::new(
                        StatusCode::CONFLICT,
                        "TRANSFER_PENDING",
                        "A transfer of this project is already pending",
                    );
                }
            }
            AppError::database_error(err)
        })
    }

    /// Map a lock-wait expiry to an honest, RETRYABLE refusal instead of
    /// letting it fall through to `AppError::database_error`'s
    /// `500 SYSTEM_DATABASE_ERROR` (DEC-30).
    ///
    /// The distinction is the whole reason the bound is worth having. A 500 with
    /// "An internal database error occurred" is byte-identical to a genuine internal
    /// fault, carries no retry signal, and the accept path's only consumer prints it
    /// verbatim — so a user who merely raced a concurrent membership change would be
    /// told the server is broken. `409 TRANSFER_BUSY` says what actually happened and
    /// what to do about it. Anything that is NOT a busy expiry still maps to
    /// `database_error`, so a real fault is not disguised as contention.
    ///
    /// SQLite port: the PG SQLSTATEs `55P03`/`40P01` never occur on this
    /// engine. The equivalent wait-expiry is the connection `busy_timeout`
    /// expiring, which surfaces as the extended code `5` (`SQLITE_BUSY`), and
    /// its extended cousins `261`/`517`/`773` (`SQLITE_BUSY_RECOVERY`/
    /// `SQLITE_BUSY_SNAPSHOT`/`SQLITE_BUSY_TIMEOUT`). All are transient
    /// contention this request lost, safe to retry, and NOT an internal fault.
    fn map_lock_timeout(err: sqlx::Error) -> AppError {
        if let sqlx::Error::Database(db) = &err {
            if matches!(
                db.code().as_deref(),
                Some("5") | Some("261") | Some("517") | Some("773")
            ) {
                return AppError::new(
                    StatusCode::CONFLICT,
                    "TRANSFER_BUSY",
                    "This project is being modified right now; please try again",
                );
            }
        }
        AppError::database_error(err)
    }

    /// The single refusal for #171 (b), so the pre-transaction check and the locked
    /// in-transaction re-assert cannot drift into answering differently. The message
    /// is deliberately bare: it tells the recipient the offer is dead, and names no
    /// role, no account and no event (DEC-19).
    fn transfer_revoked() -> AppError {
        AppError::new(
            StatusCode::CONFLICT,
            "TRANSFER_REVOKED",
            "This ownership transfer is no longer valid and cannot be accepted",
        )
    }

    /// #171 (b), the DURABLE half's predicate, as a NAMED function rather than SQL
    /// inlined in [`Self::accept_transfer`].
    ///
    /// It is named for one reason: a test can call THIS, and therefore pin the real
    /// thing. The lock-step test that holds this in agreement with
    /// [`Self::effective_permission`] originally re-typed the predicate into the test
    /// file, so the two "agreeing" spellings were the test's copy and itself — the
    /// production SQL could be reverted to its existence-only form with the whole
    /// suite green. Caught by the mutation battery, not by review.
    ///
    /// `true` iff `user_id` would resolve as project `Owner` on `project_id`: the
    /// creator branch (`p.owner_id`, conjoined with membership by the JOIN, as H-1
    /// requires) or the account-`owner` role floor. A share can never reach `Owner`
    /// ([`EffectivePermission::from_share_level`] tops out at `Editor`), so those two
    /// are the whole condition.
    ///
    /// **`FOR SHARE OF am, p` is the point, not an optimisation.** It takes a share
    /// lock on the initiator's membership row AND on the project row, so a concurrent
    /// `remove_member` DELETE, `set_role` UPDATE, or `admin_change_owner` re-stamp
    /// cannot commit while this transaction holds them, and this SELECT cannot pass
    /// while one is in flight — it blocks, then re-evaluates against the settled
    /// tuples under READ COMMITTED.
    ///
    /// **`p` is in that list because of a verified defect, not for symmetry.** With
    /// only `am` locked, Postgres's EvalPlanQual re-checks the qual using the NEW
    /// tuple for the LOCKED relation but the PRE-BLOCK snapshot tuple for the
    /// unlocked one — so the `p.owner_id = $2` disjunct passed on a stale `owner_id`
    /// after a concurrent writer had committed a change to it. The creator half of
    /// the gate was therefore only as strong as READ COMMITTED while its comment
    /// claimed it was as strong as the lock. That is exactly the argument that
    /// removed the `users.is_active` conjunct (DEC-23), and it applied verbatim to
    /// `p.owner_id` — which was left in, so the fix is to lock `p` rather than to
    /// drop the disjunct the gate needs.
    ///
    /// Locking `p` here also REMOVES a pre-existing deadlock cycle (DEC-25): both this
    /// transaction and `admin_change_owner` now take `projects` before
    /// `project_transfers`, where before they took them in opposite orders and a
    /// reproducible ABBA deadlock existed between them. `accept_transfer` was going to
    /// lock this row a few statements later anyway (it UPDATEs it); taking it earlier
    /// changes only the ORDER, and to the safe one.
    ///
    /// **`p` is taken `FOR UPDATE`, not `FOR SHARE`, and that is not tidiness
    /// (DEC-34).** A SHARE lock here would be UPGRADED to exclusive by the
    /// `UPDATE projects` later in the same transaction, and share-then-upgrade is the
    /// classic deadlock generator: two concurrent accepts of the SAME transfer — a
    /// recipient double-submit, which the pending-unique index makes the same row —
    /// both took the compatible share, then one queued to upgrade while the other
    /// queued behind its transfer-row lock. That was REPRODUCED (SQLSTATE 40P01,
    /// "while updating tuple … in relation `project_transfers`"), and it turned what
    /// used to be a clean `Ok(false)` ⇒ 404 for the loser into an opaque 500. Taking
    /// the mode this transaction will actually need, at the moment it first touches
    /// the row, removes the upgrade and therefore the cycle. `am` stays `FOR SHARE`:
    /// this transaction never writes it, and a shared lock is what lets two accepts of
    /// DIFFERENT projects by the same initiator proceed in parallel.
    ///
    /// See `accept_transfer`'s doc for the full ordering argument and for what this
    /// deliberately does NOT cover.
    ///
    /// **SQLite port — the lock mechanism above does not exist here.** SQLite has
    /// no row locks and no `FOR SHARE`/`FOR UPDATE` (probed: `near "FOR"` is the
    /// prepare error), so the substitution is the transaction's own
    /// `BEGIN IMMEDIATE` write lock: the caller ([`Self::accept_transfer`])
    /// opens that, and this SELECT is a plain read inside it. The lock grain
    /// widens from two rows to the database file (the same substitution and
    /// the same documented widening as the account module, ITEM-17 #7) — a
    /// concurrent `remove_member`/`set_role`/`admin_change_owner` cannot
    /// commit its writes while this transaction holds the write lock, so the
    /// re-assert cannot pass on a stale membership either. The EvalPlanQual
    /// and upgrade-deadlock analyses were specific to Postgres's row-lock
    /// model: SQLite's single-writer serialization has no share-to-upgrade
    /// ladder, and `BEGIN IMMEDIATE` acquires the reserved lock up front, so
    /// the ABBA cycle DEC-25 removed is structurally absent (every writer
    /// takes the one lock at the one moment).
    pub async fn initiator_still_owner_locked(
        conn: &mut SqliteConnection,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<bool, AppError> {
        let row = sqlx::query!(
            "SELECT am.user_id FROM projects p \
               JOIN account_members am \
                 ON am.account_id = p.account_id AND am.user_id = $2 \
              WHERE p.id = $1 \
                AND (p.owner_id = $2 OR am.role = 'owner')",
            project_id,
            user_id,
        )
        .fetch_optional(&mut *conn)
        .await
        .map_err(Self::map_lock_timeout)?;
        Ok(row.is_some())
    }

    /// #171 (a) — **the offboarding half.** Cancel every still-pending transfer that
    /// a departing member is a party to, on the projects of the account they are
    /// leaving. Runs on the CALLER'S connection so it commits inside
    /// [`crate::modules::account::AccountRepository::remove_member`]'s transaction
    /// (DEC-6): a committed removal whose transfer cancellation silently did not
    /// happen is exactly the half-applied state this is here to prevent, and it is
    /// the shape #147's INV-11d already refuses for the reassignment half.
    ///
    /// **Both directions, deliberately** (#171 names both as reachable):
    ///
    /// * `from_user_id` — a transfer the departing member INITIATED. Their sanction
    ///   for moving the project out of the tenant left with their membership, so the
    ///   offer must not survive them. (The accept-time re-validation in
    ///   [`Self::accept_transfer`] independently refuses this same case — that
    ///   redundancy is the point, not an oversight; see DEC-1/INV-4.)
    /// * `to_user_id` — a transfer OFFERED TO the departing member. This is #171's
    ///   first path and the one an accept-time check structurally cannot reach: the
    ///   initiator's authority is intact there (an account owner offered the project
    ///   and is still an account owner), so the only signal is the recipient's lost
    ///   membership — and consulting THAT at accept time is precisely the
    ///   recipient-membership gate #171 forbids, because it is indistinguishable
    ///   from the legitimate transfer-to-an-external-collaborator this capability
    ///   exists to serve. This arm is that path's only mechanism, by necessity (DEC-14).
    ///
    /// **Scoped to `p.account_id = $1`, which is load-bearing.** A departing member
    /// keeps their personal account and any other org they belong to; over-deleting
    /// here would silently destroy transfers that removal has no business touching,
    /// which is as much a defect as under-deleting. Pinned by TEST-8.
    ///
    /// DELETE rather than a `cancelled` status (DEC-5): `project_transfers_status_check`
    /// admits only `pending|accepted|declined`, [`Self::cancel_transfer`] already
    /// releases a row this way, and DELETE is what frees
    /// `uq_project_transfers_pending` so the account can transfer the project again.
    ///
    /// Returns the cancelled rows so the caller can fan out the sync frames both
    /// parties need (DEC-10).
    pub async fn cancel_pending_transfers_for_removed_member(
        conn: &mut SqliteConnection,
        account_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<CancelledTransfer>, AppError> {
        // SQLite port: `DELETE … USING` is not SQLite grammar (probed:
        // `near "t"`), so the `projects` join is expressed as the
        // `id IN (SELECT …)` form — the projected rows, the predicate and the
        // RETURNING are byte-equivalent to the PG statement. The write lock
        // that replaced the PG row locks belongs to the caller's transaction
        // (`remove_member` opens it `BEGIN IMMEDIATE` — the account module's
        // call contract, unchanged here — and this function runs on that
        // connection, never opening one of its own).
        let rows = sqlx::query!(
            r#"DELETE FROM project_transfers
                WHERE id IN (SELECT t.id FROM project_transfers t
                              JOIN projects p ON p.id = t.project_id
                             WHERE t.status = 'pending'
                               AND p.account_id = $1
                               AND (t.from_user_id = $2 OR t.to_user_id = $2))
             RETURNING id as "id!: Uuid", project_id as "project_id!: Uuid",
                       from_user_id as "from_user_id!: Uuid", to_user_id as "to_user_id!: Uuid""#,
            account_id,
            user_id,
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            .map(|r| CancelledTransfer {
                id: r.id,
                project_id: r.project_id,
                from_user_id: r.from_user_id,
                to_user_id: r.to_user_id,
            })
            .collect())
    }

    pub async fn pending_transfer_exists(&self, project_id: Uuid) -> Result<bool, AppError> {
        sqlx::query_scalar!(
            r#"SELECT EXISTS(SELECT 1 FROM project_transfers WHERE project_id = $1 AND status = 'pending') as "exists!: bool""#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get_transfer(&self, id: Uuid) -> Result<Option<ProjectTransfer>, AppError> {
        sqlx::query_as!(
            ProjectTransfer,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", from_user_id as "from_user_id: Uuid", to_user_id as "to_user_id: Uuid", status,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM project_transfers WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Owner cancels a pending transfer they initiated (recovery from an
    /// unresponsive recipient). Scoped to `from_user_id` + status='pending'.
    /// Cancel a still-pending transfer you initiated.
    ///
    /// H-1 (#147) — **deliberately NOT membership-gated. This is the one site the
    /// branch's transform was applied to and then REVERTED, and the reasoning is
    /// recorded here because the revert is the finding.**
    ///
    /// It was conjoined with membership of the project's account like every other
    /// site. A blind audit then showed the change was an over-tightening with no
    /// security benefit, in the exact direction #147 warns about:
    ///
    /// * `uq_project_transfers_pending` is `UNIQUE (project_id) WHERE status =
    ///   'pending'`, and `create_transfer` refuses while one is open. So a pending
    ///   row BLOCKS the project's transfer capability, and cancelling RELEASES it.
    /// * The predicate is already scoped to `from_user_id`, so a removed member can
    ///   only cancel a transfer THEY initiated. There is no reachable attack, for two
    ///   reasons: the cancel is RELEASE-ONLY (it can only delete a row that blocks),
    ///   and it is NOT DURABLE — they cannot re-create one, because `create_transfer`
    ///   runs through `effective_permission`, whose owner branch now requires
    ///   membership. A spite-cancel is recoverable by any account owner, who resolves
    ///   as project-`Owner` on every project in the account via `account_role_floor`
    ///   and can simply issue a new transfer.
    /// * Gating it therefore cost the account a non-destructive way to clear the row
    ///   and bought nothing. With the initiator removed, the remaining routes are all
    ///   worse: the recipient declining, deleting the project (the
    ///   `project_transfers_project_id_fkey ON DELETE CASCADE` clears it — destructive,
    ///   so not a real remedy), or a PLATFORM admin running `admin_change_owner`.
    ///   `remove_member` does not cascade to `project_transfers`, and there is no
    ///   owner/admin cancel path.
    ///
    /// Closing a hole that does not exist, at the cost of a real capability, is the
    /// failure mode this branch is under instruction to refuse. The genuine question
    /// underneath — should removal cancel or reassign the member's pending transfers?
    /// — belongs to #147 disposition (a), which is out of scope (DEC-2).
    ///
    /// **#171 UPDATE — that genuine question has since been answered "cancel", and
    /// the answer REMOVES this method's third bullet rather than contradicting it.**
    /// `remove_member` now does cascade to `project_transfers`
    /// ([`Self::cancel_pending_transfers_for_removed_member`]), so the stranding cost
    /// the revert was protecting against — "with the initiator removed, the remaining
    /// routes are all worse" — no longer arises: the row is released by the removal
    /// itself, inside the same transaction. This method is STILL deliberately
    /// un-gated, for the reason that was always the real one (bullet 2: the cancel is
    /// release-only and not durable), and `removal_revokes_test.rs`'s TEST-35 still
    /// protects the revert. Do not re-apply the membership conjunct here.
    ///
    /// **And #171 (b) creates a NEW instance of the same stranding class, which is
    /// recorded here rather than left for the next reader to discover (DEC-20).** The
    /// accept-time gate refuses on ANY withdrawal of the initiator's authority, and
    /// DEMOTION is one that removal does not clear: after an account `owner` who
    /// offered someone else's project is demoted to `member`, that pending row can
    /// never be accepted, yet it still occupies `uq_project_transfers_pending` and so
    /// blocks `create_transfer` from issuing a replacement. Two release paths remain
    /// and both are deliberately open — the initiator's own [`Self::cancel_transfer`]
    /// (this method, un-gated, which is part of why the revert was right) and the
    /// recipient's [`Self::decline_transfer`]. There is still no account-owner/admin
    /// cancel path; that gap predates #171 and is not widened by it, but it is now
    /// reachable from one more state.
    pub async fn cancel_transfer(&self, id: Uuid, from_user_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "DELETE FROM project_transfers \
             WHERE id = $1 AND from_user_id = $2 AND status = 'pending'",
            id,
            from_user_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Accept a transfer: swap `projects.owner_id`, re-point the project's shares to
    /// the new owner (so they can manage them), mark accepted — atomically.
    ///
    /// #171 (b) — **the accept-time half.** This method re-stamps
    /// `projects.account_id` to the recipient's PERSONAL account, i.e. it moves the
    /// resource OUT of the tenant. Until this branch it was scoped to `to_user_id` +
    /// `status = 'pending'` and nothing else: nothing re-validated that the party who
    /// initiated the move still had the authority to make it, so a transfer opened by
    /// a member who was SINCE REMOVED still completed on the recipient's accept and
    /// took the organization's project with it.
    ///
    /// The gate is now: the INITIATOR must still resolve as project `Owner` — exactly
    /// the authority `handlers::create_transfer` demanded of them at create time
    /// (`resolve_scope(..).require_owner()`).
    ///
    /// **It is checked TWICE, and the second check IS a second spelling.** An earlier
    /// revision of this comment said the gate "is computed by CALLING
    /// `effective_permission`, never by re-spelling its predicate inline … this needs
    /// no new predicate of its own". That was true when written and this branch then
    /// made it FALSE, which is precisely the failure this module keeps repeating, so
    /// it is corrected rather than quietly dropped:
    ///
    /// 1. **Pre-transaction** — `effective_permission` is CALLED, through the single
    ///    chokepoint, so the create-time and accept-time answers cannot drift. It
    ///    needs no predicate of its own: H-1 already conjoined the creator branch with
    ///    current membership, so a removed initiator resolves to `None` for free.
    /// 2. **Inside the transaction** — [`Self::initiator_still_owner_locked`], a
    ///    hand-written predicate, because the chokepoint CANNOT be called there: it
    ///    takes its own pool connection (the AUD-7 constraint this whole method is
    ///    arranged around), and a durable answer requires a locked read on this
    ///    transaction. That is a genuine second spelling of one condition, accepted
    ///    deliberately (DEC-22) and contained the way this repo already contains the
    ///    #147 predicates — a lock-step test (TEST-15) that calls the PRODUCTION
    ///    predicate, never a transcription of it (DEC-24).
    ///
    /// This is deliberately REDUNDANT with
    /// [`Self::cancel_pending_transfers_for_removed_member`], which deletes the same
    /// row at removal time. The owner chose both halves explicitly (DEC-1) because
    /// this is the class of bug where a single mechanism failing silently is the
    /// whole problem; neither half may depend on the other, and each is proven to
    /// refuse with the other demonstrably not firing (INV-4, TEST-3/TEST-4).
    ///
    /// What it does NOT check, on purpose: whether the RECIPIENT is a member of the
    /// project's account. That is the obvious fix and it is wrong — a transfer's
    /// whole purpose is to hand a project to someone who is not a member, so gating
    /// on it would strand transfers entirely (#171, DEC-2, INV-3, TEST-5). This module has
    /// already made that exact mistake once, at [`Self::cancel_transfer`].
    ///
    /// "Authority" is TWO things, because this product offboards two ways. Removing
    /// the `account_members` row is one; **deactivating the user (`users.is_active`)
    /// is the other**, and it is first-class here — `create_transfer` already refuses
    /// an `INACTIVE_RECIPIENT`, and the project-admin surface reports a project whose
    /// owner is deactivated as `is_orphaned`. `effective_permission` reads only
    /// `projects` + `account_members` and never joins `users`, so an authority check
    /// built on it ALONE left the whole of #171 reachable through the deactivation
    /// door: the hook never runs (no membership row was deleted) and the initiator
    /// still resolves as `Owner`. Both conditions are therefore checked (DEC-17).
    ///
    /// They are NOT equally protected, and the difference matters enough to state
    /// here rather than 100 lines down in the body: membership is re-checked under a
    /// row lock inside the transaction, `is_active` is checked ONCE, before it,
    /// unlocked. So the removal door is closed against a concurrent offboarding and
    /// the deactivation door is closed against a sequential one — see the body and
    /// DEC-23 for exactly what remains. This is not the RECIPIENT's `is_active` —
    /// that is `create_transfer`'s concern and is unchanged.
    ///
    /// Refuses with `409 TRANSFER_REVOKED`, distinct from the `404` a cancelled or
    /// absent row yields (`Ok(false)`). The distinction is not cosmetic: it is what
    /// makes the two halves independently attributable, so "each half works alone"
    /// is falsifiable rather than a claim (DEC-8).
    ///
    /// **What that 409 does disclose, stated accurately (DEC-19).** An earlier
    /// revision of this comment said "it is no oracle — the recipient is a party to
    /// the transfer and already knows it exists". That defends the wrong thing: the
    /// existence of the row was never the secret. 409-vs-200 tells the RECIPIENT —
    /// who is very often a pure outsider to the tenant, by design — that the
    /// initiator's standing inside that organization has changed. That is a real, if
    /// small, disclosure, accepted deliberately: the recipient must be told the offer
    /// is dead, and collapsing it into the 404 would make the two halves
    /// indistinguishable and "each half works alone" unfalsifiable. It is narrowed to
    /// what the recipient needs — the message names no role, no account and no event,
    /// and the recipient/pending pre-check below keeps a NON-party on the 404 path so
    /// the distinction is never visible to a stranger.
    pub async fn accept_transfer(&self, id: Uuid, to_user_id: Uuid) -> Result<bool, AppError> {
        // #171 (b): resolve the row and re-validate the INITIATOR before anything
        // else. Outside the transaction because `effective_permission` takes its own
        // pool connection — the same AUD-7 constraint that keeps
        // `ensure_personal_account_for` below out of the outer tx.
        //
        // BEING OUTSIDE THE TX IS A CHECK-THEN-ACT WINDOW, and an earlier revision of
        // this comment claimed it was "closed durably by the offboarding hook". That
        // was FALSE, in the ordering that matters: if this check passes and then the
        // transactional claim below commits first, the hook's DELETE blocks on the
        // claimed row, wakes to find `status = 'accepted'`, deletes nothing — and the
        // project has already left the tenant while the removal reports success. The
        // hook LOSES that race; it does not close it. (Recorded as the false claim it
        // was: this module has a history of confident comments hiding live bugs.)
        //
        // What actually closes it is the locked re-assert INSIDE the transaction
        // below (DEC-18). This pre-check is kept because it is the one that computes
        // FULL authority through the chokepoint; the in-tx one is its durable half.
        let Some(pending) = self.get_transfer(id).await? else {
            return Ok(false);
        };
        // Recipient/pending scoping, unchanged in effect — the UPDATE below still
        // enforces it; this pre-check only lets us read `from_user_id` first, and
        // keeps a foreign or already-settled transfer on the 404 path rather than
        // letting it reach the authority check (no oracle, no behaviour change).
        if pending.to_user_id != to_user_id || pending.status != "pending" {
            return Ok(false);
        }
        let initiator_active = self.user_active_status(pending.from_user_id).await? == Some(true);
        if !initiator_active
            || self
                .effective_permission(pending.project_id, pending.from_user_id)
                .await?
                != Some(EffectivePermission::Owner)
        {
            return Err(Self::transfer_revoked());
        }
        // A2 (ITEM-6): resolve the new owner's personal account BEFORE opening the
        // transaction (AUD-7): `ensure_personal_account_for` acquires its own pool
        // connection + inner tx, which must not nest inside the outer tx (deadlock
        // hazard on a small pool). It is the idempotent re-stamp target — a transfer
        // moves the resource into the new owner's personal account (org/ActiveAccount
        // context is A4).
        let new_account =
            crate::modules::account::scope::ensure_personal_account_for(&self.pool, to_user_id)
                .await?;
        // SQLite port: `BEGIN IMMEDIATE` — the write lock up front, so the
        // locked-assert SELECT below cannot pass on stale rows and no later
        // statement in this transaction can fail with SQLITE_BUSY after the
        // gate has been evaluated (the ITEM-15/17 substitution; the PG
        // `FOR SHARE`/`FOR UPDATE` lock-order analysis does not transfer —
        // SQLite serializes all writers on the one file lock).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        // #171 (b) — BOUND every lock wait in this transaction (DEC-27, ported).
        //
        // The locked re-assert below is what makes the gate durable, and it also makes
        // this transaction a WAITER and a HOLDER of contended rows. SQLite bounds the
        // wait differently from the PG deployment the original argument was written
        // for: the connection's `busy_timeout` (5000 ms, PROV-sqlite-store-1) is the
        // one bound, applied by the engine at every lock acquisition. Unbounded, the
        // cost is the same class as the PG version — this transaction parks one of a
        // 10-connection pool indefinitely while holding the write lock, and a stuck
        // accept can stall membership administration for that whole account and, once
        // the pool drains, every unrelated endpoint in the process. A lock wait must
        // not be able to become an outage.
        //
        // Bounded, a pathological wait fails THIS request and nothing else, and it
        // fails CLOSED: the transfer does not complete, which is the safe direction
        // for a security gate. The caller can retry — and is TOLD so (DEC-30):
        // `Self::map_lock_timeout` turns the `SQLITE_BUSY` expiry into
        // `409 TRANSFER_BUSY` rather than letting it fall through to a generic
        // `500 SYSTEM_DATABASE_ERROR` that no client can distinguish from a real
        // fault and no UI can act on.
        // #171 (b), DURABLE HALF (DEC-18) — re-assert the initiator's AUTHORITY inside
        // this transaction, under a row lock, BEFORE claiming the transfer. What the
        // predicate is, why it re-checks the ROLE and not merely that a membership row
        // exists, and why the lock is the whole mechanism are documented ONCE, on
        // [`Self::initiator_still_owner_locked`]. They are deliberately NOT restated
        // here: an earlier revision carried a near-verbatim copy of that argument at
        // both sites, which is two things to keep in sync by hand and one to forget.
        //
        // Lock ORDER, stated accurately: `remove_member` takes `FOR UPDATE` on the
        // account's OWNER rows (which need not include the initiator's row at all),
        // then DELETEs the target's row, then DELETEs from `project_transfers`. So the
        // two are deadlock-free not because they lock the same rows in the same order,
        // but because `remove_member` never acquires a `project_transfers` lock BEFORE
        // its `account_members` locks, and this transaction takes `account_members`
        // before `project_transfers`. (A separate, PRE-EXISTING cycle exists in this
        // module between `admin_change_owner` — `projects` then `project_transfers` —
        // and this method — `project_transfers` then `projects`. It is neither
        // introduced nor widened here, and is filed rather than silently patched:
        // DEC-25.)
        //
        // What this does NOT cover, precisely (DEC-23): `users.is_active`. It is
        // checked once, above, outside the transaction. An `AND u.is_active` conjunct
        // was tried here and removed, because `users` is not locked and READ COMMITTED
        // takes the statement snapshot at statement START — so in every case where
        // this SELECT actually BLOCKS, the only case the lock exists for, it is
        // guaranteed to read the PRE-block value. It was NOT, however, a strict no-op:
        // in the NON-blocking case its snapshot is strictly later than the pre-check's,
        // so it would have caught a deactivation committing in the window between them.
        // That narrow window is the accepted cost of making the `is_active` check
        // verifiable at all — with the condition in two places, deleting either alone
        // left the whole suite green (AUD-8). A guard that hides its own deletion is
        // not defence in depth.
        let still_authorized =
            Self::initiator_still_owner_locked(&mut tx, pending.project_id, pending.from_user_id)
                .await?;
        if !still_authorized {
            tx.rollback().await.map_err(AppError::database_error)?;
            return Err(Self::transfer_revoked());
        }
        let claimed = sqlx::query!(
            "UPDATE project_transfers SET status = 'accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
            id,
            to_user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(Self::map_lock_timeout)?;
        if claimed.rows_affected() == 0 {
            tx.rollback().await.map_err(AppError::database_error)?;
            return Ok(false);
        }
        sqlx::query!(
            "UPDATE projects SET owner_id = $2, account_id = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = (SELECT project_id FROM project_transfers WHERE id = $1)",
            id,
            to_user_id,
            new_account,
        )
        .execute(&mut *tx)
        .await
        .map_err(Self::map_lock_timeout)?;
        // The new owner should not also hold a residual share on their own project.
        sqlx::query!(
            "DELETE FROM project_shares WHERE recipient_id = $2 \
             AND project_id = (SELECT project_id FROM project_transfers WHERE id = $1)",
            id,
            to_user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(Self::map_lock_timeout)?;
        // Re-point remaining shares to the NEW owner (revoke_share is owner-scoped).
        sqlx::query!(
            "UPDATE project_shares SET owner_id = $2 \
             WHERE project_id = (SELECT project_id FROM project_transfers WHERE id = $1)",
            id,
            to_user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(Self::map_lock_timeout)?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(true)
    }

    pub async fn decline_transfer(&self, id: Uuid, to_user_id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE project_transfers SET status = 'declined', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
            id,
            to_user_id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    // ------------------------- settings -------------------------

    pub async fn get_settings(&self) -> Result<ProjectSettings, AppError> {
        let row = sqlx::query_as!(
            ProjectSettings,
            r#"SELECT transfer_enabled as "transfer_enabled: bool", updated_at as "updated_at: DateTime<Utc>"
               FROM project_settings WHERE singleton = true"#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.unwrap_or(ProjectSettings {
            transfer_enabled: true,
            updated_at: chrono::Utc::now(),
        }))
    }

    pub async fn update_settings(
        &self,
        transfer_enabled: bool,
    ) -> Result<ProjectSettings, AppError> {
        sqlx::query_as!(
            ProjectSettings,
            r#"INSERT INTO project_settings (singleton, transfer_enabled, updated_at)
               VALUES (true, $1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
               ON CONFLICT (singleton) DO UPDATE SET
                 transfer_enabled = EXCLUDED.transfer_enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING transfer_enabled as "transfer_enabled: bool", updated_at as "updated_at: DateTime<Utc>""#,
            transfer_enabled,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // ------------------------- admin (cross-user) -------------------------
    // These BYPASS owner-scoping (admin-only, gated by the caller). `get`/`delete`
    // above are already id-only (the owner 404-guard lives in the owner handlers,
    // not here), so they are reused directly for admin get/delete.

    /// Cross-user project list: every project + owner identity + derived counts +
    /// status flags + size proxy + last-activity. `search`/`owner`/`status` filter;
    /// `sort` ∈ updated|created|name|owner|datasets (whitelisted by the caller).
    /// Returns (rows, filtered_total, deployment_stats).
    pub async fn admin_list_all(
        &self,
        search: Option<&str>,
        owner_id: Option<Uuid>,
        status: Option<&str>,
        sort: &str,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<AdminProjectRow>, i64, AdminProjectStats), AppError> {
        let per_page = per_page.clamp(1, 200);
        let page = page.max(1);
        let offset = (page - 1) * per_page;

        let rows = sqlx::query_as!(
            AdminProjectRow,
            r#"SELECT s.id as "id: Uuid", s.owner_id as "owner_id: Uuid", s.name, s.description,
                  s.created_at as "created_at: DateTime<Utc>",
                  s.updated_at as "updated_at: DateTime<Utc>",
                  u.username as "owner_username!", u.email as "owner_email!",
                  u.display_name as "owner_display_name",
                  u.is_active as "owner_is_active!: bool",
                  (SELECT count(*) FROM project_datasets sd WHERE sd.project_id = s.id) as "dataset_count!",
                  (SELECT count(*) FROM project_shares sh WHERE sh.project_id = s.id AND sh.status IN ('pending','accepted')) as "share_count!",
                  EXISTS(SELECT 1 FROM project_transfers t WHERE t.project_id = s.id AND t.status = 'pending') as "transfer_pending!: bool",
                  (NOT u.is_active) as "is_orphaned!: bool",
                  MAX(s.updated_at,
                    COALESCE((SELECT MAX(d.updated_at) FROM datasets d JOIN project_datasets sd ON sd.dataset_id = d.id WHERE sd.project_id = s.id), s.updated_at))
                    as "last_activity!: DateTime<Utc>"
               FROM projects s JOIN users u ON u.id = s.owner_id
               WHERE ($1 IS NULL OR instr(lower(s.name), lower($1)) > 0)
                 AND ($2 IS NULL OR s.owner_id = $2)
                 AND ($3 IS NULL
                      OR ($3 = 'orphaned' AND NOT u.is_active)
                      OR ($3 = 'private'  AND NOT EXISTS(SELECT 1 FROM project_shares sh WHERE sh.project_id = s.id AND sh.status IN ('pending','accepted')))
                      OR ($3 = 'shared'   AND EXISTS(SELECT 1 FROM project_shares sh WHERE sh.project_id = s.id AND sh.status IN ('pending','accepted')))
                      OR ($3 = 'empty'    AND NOT EXISTS(SELECT 1 FROM project_datasets sd WHERE sd.project_id = s.id)))
               ORDER BY
                 CASE WHEN $4 = 'name'     THEN s.name END ASC,
                 CASE WHEN $4 = 'owner'    THEN u.username END ASC,
                 CASE WHEN $4 = 'created'  THEN s.created_at END DESC,
                 CASE WHEN $4 = 'datasets' THEN (SELECT count(*) FROM project_datasets sd WHERE sd.project_id = s.id) END DESC,
                 s.updated_at DESC
               LIMIT $5 OFFSET $6"#,
            search,
            owner_id,
            status,
            sort,
            per_page,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let total = sqlx::query_scalar!(
            r#"SELECT count(*) as "count!" FROM projects s JOIN users u ON u.id = s.owner_id
               WHERE ($1 IS NULL OR instr(lower(s.name), lower($1)) > 0)
                 AND ($2 IS NULL OR s.owner_id = $2)
                 AND ($3 IS NULL
                      OR ($3 = 'orphaned' AND NOT u.is_active)
                      OR ($3 = 'private'  AND NOT EXISTS(SELECT 1 FROM project_shares sh WHERE sh.project_id = s.id AND sh.status IN ('pending','accepted')))
                      OR ($3 = 'shared'   AND EXISTS(SELECT 1 FROM project_shares sh WHERE sh.project_id = s.id AND sh.status IN ('pending','accepted')))
                      OR ($3 = 'empty'    AND NOT EXISTS(SELECT 1 FROM project_datasets sd WHERE sd.project_id = s.id)))"#,
            search,
            owner_id,
            status,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // SQLite port: `COUNT(*) FILTER (WHERE …)` has no SQLite form —
        // the DEC-12 rewrite is `COALESCE(SUM(CASE WHEN … THEN 1 ELSE 0 END), 0)`
        // (the COALESCE turns the empty-set NULL from the aggregate SUM into
        // the 0 the PG FILTER counted); `GREATEST(a, b)` → `MAX(a, b)` above
        // (the scalar multi-arg form; the ORDER BY CASE expressions are
        // unchanged).
        let stats = sqlx::query_as!(
            AdminProjectStats,
            r#"SELECT count(*) as "total_projects!",
                      count(DISTINCT s.owner_id) as "distinct_owners!",
                      COALESCE(SUM(CASE WHEN NOT u.is_active THEN 1 ELSE 0 END), 0) as "orphaned_count!"
               FROM projects s JOIN users u ON u.id = s.owner_id"#,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        Ok((rows, total, stats))
    }

    /// Full admin drill-down for one project (None if the project is absent).
    pub async fn admin_get_detail(&self, id: Uuid) -> Result<Option<AdminProjectDetail>, AppError> {
        let Some(project) = self.get(id).await? else {
            return Ok(None);
        };
        let owner = sqlx::query!(
            r#"SELECT username, email, display_name, is_active as "is_active: bool" FROM users WHERE id = $1"#,
            project.owner_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        let shares = self.list_shares_for_project(id).await?;
        let (datasets, _) = self.list_datasets(id, 1, 100).await?;
        let transfer = self.get_pending_transfer(id).await?;
        Ok(Some(AdminProjectDetail {
            owner_username: owner
                .as_ref()
                .map(|o| o.username.clone())
                .unwrap_or_default(),
            owner_email: owner.as_ref().map(|o| o.email.clone()).unwrap_or_default(),
            owner_display_name: owner.as_ref().and_then(|o| o.display_name.clone()),
            owner_is_active: owner.as_ref().map(|o| o.is_active).unwrap_or(false),
            project,
            shares,
            datasets,
            transfer,
        }))
    }

    /// The pending transfer on a project, if any (admin detail).
    pub async fn get_pending_transfer(
        &self,
        project_id: Uuid,
    ) -> Result<Option<ProjectTransfer>, AppError> {
        sqlx::query_as!(
            ProjectTransfer,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", from_user_id as "from_user_id: Uuid", to_user_id as "to_user_id: Uuid", status,
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM project_transfers WHERE project_id = $1 AND status = 'pending'
               ORDER BY created_at DESC LIMIT 1"#,
            project_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The active-status of a user: `None` = no such user, `Some(false)` =
    /// deactivated, `Some(true)` = active. Lets admin mutations reject an absent
    /// target (400) distinctly from a deactivated one (422 — a deactivated owner
    /// would instantly orphan the project + get an unseeable notification).
    pub async fn user_active_status(&self, user_id: Uuid) -> Result<Option<bool>, AppError> {
        let row = sqlx::query!(r#"SELECT is_active as "is_active: bool" FROM users WHERE id = $1"#, user_id)
            .fetch_optional(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(row.map(|r| r.is_active))
    }

    /// Ids of every project owned by `owner_id` (the reassign-all source set).
    pub async fn projects_owned_by(&self, owner_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query!("SELECT id as \"id: Uuid\" FROM projects WHERE owner_id = $1", owner_id)
            .fetch_all(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.id).collect())
    }

    /// Admin forced owner change (immediate, no accept). Re-points the project's
    /// shares to the new owner, optionally keeps the OLD owner as an accepted
    /// editor, and cancels any pending transfer. Returns the OLD owner id (for the
    /// sync fan-out + notification), or None if the project is absent.
    pub async fn admin_change_owner(
        &self,
        project_id: Uuid,
        new_owner_id: Uuid,
        keep_old_as_editor: bool,
    ) -> Result<Option<Uuid>, AppError> {
        // A2 (ITEM-6): resolve the new owner's personal account BEFORE the tx
        // (AUD-7 — `ensure_personal_account_for` opens its own connection + inner
        // tx, which must not nest inside the outer tx). Idempotent, so ensuring it
        // even in the absent/no-op branches is harmless (the account already exists
        // for any real owner).
        let new_account =
            crate::modules::account::scope::ensure_personal_account_for(&self.pool, new_owner_id)
                .await?;
        // SQLite port: `BEGIN IMMEDIATE` for the write lock (the row-select
        // `FOR UPDATE` has no SQLite form — the ITEM-17 #7 substitution); the
        // SELECT below is the existence probe it always was.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let row = sqlx::query!("SELECT owner_id as \"owner_id: Uuid\" FROM projects WHERE id = $1", project_id,)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::database_error)?;
        let Some(row) = row else {
            tx.rollback().await.map_err(AppError::database_error)?;
            return Ok(None);
        };
        let old_owner_id = row.owner_id;
        if old_owner_id == new_owner_id {
            tx.commit().await.map_err(AppError::database_error)?;
            return Ok(Some(old_owner_id)); // no-op
        }
        // A2 (ITEM-6): re-stamp `account_id` to the NEW owner's personal account
        // (resolved above, before the tx — AUD-7).
        sqlx::query!(
            "UPDATE projects SET owner_id = $2, account_id = $3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1",
            project_id,
            new_owner_id,
            new_account,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        // The new owner must not also hold a residual share on their own project.
        sqlx::query!(
            "DELETE FROM project_shares WHERE project_id = $1 AND recipient_id = $2",
            project_id,
            new_owner_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        // Re-point remaining shares to the new owner (owner_id backs revoke scoping).
        sqlx::query!(
            "UPDATE project_shares SET owner_id = $2 WHERE project_id = $1",
            project_id,
            new_owner_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        if keep_old_as_editor {
            let sid = Uuid::new_v4();
            sqlx::query!(
                "INSERT INTO project_shares (id, project_id, owner_id, recipient_id, permission_level, status) \
                 VALUES ($1, $2, $3, $4, 'editor', 'accepted') \
                 ON CONFLICT (project_id, recipient_id) DO UPDATE SET \
                   owner_id = EXCLUDED.owner_id, permission_level = 'editor', \
                   status = 'accepted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
                sid,
                project_id,
                new_owner_id,
                old_owner_id,
            )
            .execute(&mut *tx)
            .await
            .map_err(AppError::database_error)?;
        }
        // Any pending owner-accept transfer is now moot.
        sqlx::query!(
            "DELETE FROM project_transfers WHERE project_id = $1 AND status = 'pending'",
            project_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(Some(old_owner_id))
    }

    /// Search users for the admin owner/share pickers (ILIKE username OR email;
    /// the SQLite port is the DEC-11 `instr(lower(…), lower(?)) > 0` ASCII fold).
    /// Empty query → the first `limit` users. Scoped to admins by the caller.
    pub async fn admin_search_users(
        &self,
        search: Option<&str>,
        limit: i64,
    ) -> Result<Vec<super::models::AdminUserOption>, AppError> {
        let limit = limit.clamp(1, 50);
        sqlx::query_as!(
            super::models::AdminUserOption,
            r#"SELECT id as "id: Uuid", username, email, display_name, is_active as "is_active: bool"
               FROM users
               WHERE ($1 IS NULL
                      OR instr(lower(username), lower($1)) > 0
                      OR instr(lower(email), lower($1)) > 0)
               ORDER BY username ASC LIMIT $2"#,
            search,
            limit,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Admin revoke of ANY share (no owner scoping). `false` = no such share.
    pub async fn admin_revoke_share(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM project_shares WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }
}
