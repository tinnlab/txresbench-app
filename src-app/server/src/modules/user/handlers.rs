//! User + group admin handlers. Port of ziee's `modules/user/handlers` over
//! ziee-auth's `UserRepository`/`GroupRepository` (via `Extension<AuthContext>`),
//! with the ziee-domain cascade (skill/file/hub cleanup on delete) stripped.
//!
//! ## Realtime sync
//!
//! These handlers own the `SyncEntity::{User, Group}` emits. `ziee-auth` publishes
//! NEITHER — it has no `AuthSyncEntity::User`/`::Group` call site anywhere — so before
//! this the frontend's `sync:user` (`Users.store`) and `sync:group` (`UserGroups.store`)
//! subscriptions had no publisher in any layer and could never fire: an admin's edit was
//! invisible to every OTHER admin's open table until a reload.
//!
//! Audience is the read-perm that gates the client's refetch endpoint
//! (`users::read` / `groups::read`), and `origin` suppresses the acting admin's own
//! echo — their store already has the response.
//!
//! Membership and permission edits ALSO fan a `Session` signal to the AFFECTED user with
//! `origin: None`: that user is not the actor, they must always receive it, and their
//! client re-bootstraps `/auth/me` rather than waiting out the 60s re-check.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_auth::auth::context::AuthContext;
use ziee_auth::auth::password::hash_password;
use ziee_core::{ApiResult, AppError};

use super::permissions::*;
use super::types::*;
use crate::modules::account::AccountRepository;
use crate::modules::permissions::{principal_holds, RequirePermissions};
use crate::modules::sync::{
    publish, publish_session_to_users, Audience, SyncAction, SyncEntity, SyncOrigin,
};

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Minimum password length (mirrors ziee's validator lower bound).
fn check_password(pw: &str) -> Result<(), (StatusCode, AppError)> {
    if pw.len() < 8 || pw.len() > 72 || pw.contains('\0') {
        return Err(e(AppError::bad_request(
            "WEAK_PASSWORD",
            "Password must be 8–72 bytes and contain no NUL",
        )));
    }
    Ok(())
}

// ============================= USERS =============================

pub async fn list_users(
    auth: RequirePermissions<(UsersRead,)>,
    Extension(ctx): Extension<AuthContext>,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<PaginationQuery>,
) -> ApiResult<Json<AdminUserListResponse>> {
    let (page, per_page) = q.clamped();
    let (mut users, total) = ctx.user().list(page, per_page).await.map_err(e)?;
    // Non-admins see a PII-reduced view.
    if !auth.user.is_admin {
        for u in users.iter_mut() {
            u.email = String::new();
            u.permissions = vec![];
            u.last_login_at = None;
        }
    }

    // Batched personal-account resolution (#43) — ONE query for the whole page (no N+1), read-only
    // (a GET never ensures/creates an account). A user with no personal account is absent from the
    // map ⇒ `personal_account_id: None`.
    let user_ids: Vec<Uuid> = users.iter().map(|u| u.id).collect();
    let personal = AccountRepository::new(pool.clone())
        .personal_accounts_of(&user_ids)
        .await
        .map_err(e)?;

    // saas: attach per-account billing state, but ONLY for a caller holding `is_admin ||
    // billing::admin` (DEC-1 / INV-1) — the read must not widen the premium/credit audience beyond
    // what the design gates. One batched query over the page's resolved account ids.
    #[cfg(feature = "saas")]
    let billing_map = {
        use crate::modules::billing::permissions::BillingAdmin;
        use crate::modules::permissions::PermissionCheck;
        let may_see_billing = auth.user.is_admin
            || principal_holds(&auth.user, &auth.groups, BillingAdmin::PERMISSION);
        if may_see_billing {
            let account_ids: Vec<Uuid> = personal.values().copied().collect();
            crate::modules::billing::repository::account_billing_summaries(&pool, &account_ids)
                .await
                .map_err(e)?
        } else {
            std::collections::HashMap::new()
        }
    };

    let items = users
        .into_iter()
        .map(|u| {
            let personal_account_id = personal.get(&u.id).copied();
            #[cfg(feature = "saas")]
            let billing = personal_account_id
                .and_then(|aid| billing_map.get(&aid))
                .map(|s| UserBillingSummary {
                    premium: s.premium,
                    plan_id: s.plan_id.clone(),
                    credit_balance_cents: s.credit_balance_cents,
                });
            AdminUserListItem {
                user: u,
                personal_account_id,
                #[cfg(feature = "saas")]
                billing,
            }
        })
        .collect();

    Ok((
        StatusCode::OK,
        Json(AdminUserListResponse {
            users: items,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

pub async fn get_user(
    _auth: RequirePermissions<(UsersRead,)>,
    Extension(ctx): Extension<AuthContext>,
    Path(user_id): Path<Uuid>,
) -> ApiResult<Json<ziee_auth::User>> {
    let user = ctx
        .user()
        .get_by_id(user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("User")))?;
    Ok((StatusCode::OK, Json(user)))
}

pub async fn create_user(
    auth: RequirePermissions<(UsersCreate,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Json(req): Json<CreateUserRequest>,
) -> ApiResult<Json<ziee_auth::User>> {
    if req.username.trim().is_empty() || req.email.trim().is_empty() {
        return Err(e(AppError::bad_request(
            "INVALID_INPUT",
            "Username and email are required",
        )));
    }
    check_password(&req.password)?;

    // Self-escalation guard: a non-admin may only grant permissions it holds.
    if let Some(perms) = &req.permissions {
        for p in perms {
            if !principal_holds(&auth.user, &auth.groups, p) {
                return Err(e(AppError::forbidden(
                    "PERMISSION_ESCALATION",
                    "Cannot grant a permission you do not hold",
                )));
            }
        }
    }

    let users = ctx.user();
    let groups = ctx.group();
    if users.get_by_username(&req.username).await.map_err(e)?.is_some() {
        return Err(e(AppError::conflict("Username")));
    }
    if users.get_by_email(&req.email).await.map_err(e)?.is_some() {
        return Err(e(AppError::conflict("Email")));
    }

    let hash = hash_password(&req.password)
        .map_err(|_| e(AppError::internal_error("Failed to hash password")))?;
    let user = users
        .create(
            &req.username,
            &req.email,
            Some(hash),
            req.display_name.clone(),
            req.permissions.clone(),
        )
        .await
        .map_err(e)?;

    // Best-effort: add to the default group.
    if let Ok(Some(default)) = groups.get_default().await {
        let _ = users.assign_to_group(user.id, default.id, None).await;
    }

    // A5 ITEM-1: synchronously ensure the created user owns EXACTLY ONE personal
    // account (INV-1) before the 201 — an admin-created user is tenant-ready the
    // instant creation returns, not only at their first login (the backstop). A1's
    // `ensure_personal_account` is idempotent (`ON CONFLICT`), so a subsequent
    // backstop pass for the same user is a no-op. The error is SURFACED, not
    // swallowed: creation must not report success with the tenancy invariant unmet.
    // Name = `username` (DEC-4, mirrors A1's backfill).
    crate::modules::account::AccountRepository::new(ctx.pool().clone())
        .ensure_personal_account(user.id, &req.username)
        .await
        .map_err(e)?;

    publish(SyncEntity::User, SyncAction::Create, user.id, Audience::perm::<UsersRead>(), origin.0);
    Ok((StatusCode::CREATED, Json(user)))
}

pub async fn update_user(
    _auth: RequirePermissions<(UsersEdit,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(user_id): Path<Uuid>,
    Json(req): Json<UpdateUserRequest>,
) -> ApiResult<Json<ziee_auth::User>> {
    let users = ctx.user();
    let existing = users
        .get_by_id(user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("User")))?;

    // Never disable an admin.
    if existing.is_admin && req.is_active == Some(false) {
        return Err(e(AppError::bad_request(
            "CANNOT_DISABLE_ADMIN",
            "Administrators cannot be deactivated",
        )));
    }

    // Username/display_name only (email + permissions are intentionally not
    // editable here — priv-esc/takeover hardening).
    let mut user = users
        .update(user_id, req.username.clone(), None, req.display_name.clone(), None)
        .await
        .map_err(e)?;

    if let Some(active) = req.is_active {
        users.set_active(user_id, active).await.map_err(e)?;
        user.is_active = active;
        // Their sign-in state changed, so THEIR devices must re-bootstrap /auth/me now
        // rather than at the next 60s re-check. `origin: None` — the affected user is
        // not the acting admin, so there is nothing of theirs to suppress.
        publish_session_to_users(&[user_id], None);
    }

    publish(SyncEntity::User, SyncAction::Update, user_id, Audience::perm::<UsersRead>(), origin.0);
    Ok((StatusCode::OK, Json(user)))
}

pub async fn toggle_user_active(
    _auth: RequirePermissions<(UsersToggleStatus,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(user_id): Path<Uuid>,
) -> ApiResult<Json<UserActiveStatusResponse>> {
    let users = ctx.user();
    let user = users
        .get_by_id(user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("User")))?;
    if user.is_admin && user.is_active {
        return Err(e(AppError::bad_request(
            "CANNOT_DISABLE_ADMIN",
            "Administrators cannot be deactivated",
        )));
    }
    let new_active = !user.is_active;
    users.set_active(user_id, new_active).await.map_err(e)?;
    publish(SyncEntity::User, SyncAction::Update, user_id, Audience::perm::<UsersRead>(), origin.0);
    publish_session_to_users(&[user_id], None);
    Ok((
        StatusCode::OK,
        Json(UserActiveStatusResponse {
            user_id,
            is_active: new_active,
        }),
    ))
}

pub async fn reset_user_password(
    auth: RequirePermissions<(UsersResetPassword,)>,
    Extension(ctx): Extension<AuthContext>,
    Json(req): Json<ResetPasswordRequest>,
) -> ApiResult<StatusCode> {
    check_password(&req.new_password)?;
    let users = ctx.user();
    let target = users
        .get_by_id(req.user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("User")))?;
    if target.is_admin && !auth.user.is_admin {
        return Err(e(AppError::forbidden(
            "CANNOT_RESET_ADMIN_PASSWORD",
            "Only an administrator can reset an administrator's password",
        )));
    }
    let hash = hash_password(&req.new_password)
        .map_err(|_| e(AppError::internal_error("Failed to hash password")))?;
    users.update_password(req.user_id, &hash).await.map_err(e)?;

    // END EVERY SESSION THE TARGET HOLDS. An admin reset is the response to a
    // COMPROMISED account, so leaving the pre-reset sessions alive leaves the
    // attacker exactly where they were: the new password locks the front door while
    // the intruder is still inside. Self-service `change_password` already revoked
    // (`ziee-auth`); this path — the one that exists FOR the compromise case — did
    // nothing at all, so the stronger credential rotation was the weaker revocation.
    //
    // `end_session_atomically` rather than `revoke_all_for_user`, because the pair is
    // what actually ends a session and it must not tear half:
    //   * it bumps `users.token_version`, which invalidates every already-issued
    //     ACCESS token at the next request (`jwt_extractor::verify_token_version` /
    //     the resolver's folded epoch read) instead of at `exp` — up to 24h away by
    //     default, i.e. an attacker's whole working day;
    //   * it revokes the whitelisted refresh tokens, so the attacker cannot simply
    //     mint a fresh pair;
    //   * both in ONE transaction, because a bump that committed without the revoke
    //     would hand the session straight back on the next `/auth/refresh`.
    //
    // Errors PROPAGATE (500). A reset that rotated the credential but silently failed
    // to revoke is precisely the state the caller must not be told is a success.
    ziee_auth::auth::refresh_tokens::end_session_atomically(ctx.pool(), req.user_id)
        .await
        .map_err(e)?;

    // Their sign-in state changed, so the target's OWN devices re-bootstrap now and
    // land on the login screen, rather than sitting on an authenticated-looking UI
    // whose every request 401s. `origin: None` — the acting admin is not the target,
    // so there is nothing of theirs to suppress. (Before this the handler published
    // nothing at all; the drawer's stale `user.updated` echo was deleted in 8fc271b4.)
    publish_session_to_users(&[req.user_id], None);
    Ok((StatusCode::NO_CONTENT, StatusCode::NO_CONTENT))
}

pub async fn delete_user(
    _auth: RequirePermissions<(UsersDelete,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(user_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    // `delete_if_not_admin` is TOCTOU-safe (guards `is_admin = FALSE` in SQL).
    // NOTE: ziee's domain cascade (skill/file/hub on-disk cleanup) is dropped —
    // CytoAnalyst has no such artifacts yet.
    let deleted = ctx.user().delete_if_not_admin(user_id).await.map_err(e)?;
    if !deleted {
        return Err(e(AppError::forbidden(
            "CANNOT_DELETE_ADMIN",
            "Administrators cannot be deleted",
        )));
    }
    publish(SyncEntity::User, SyncAction::Delete, user_id, Audience::perm::<UsersRead>(), origin.0);
    Ok((StatusCode::NO_CONTENT, StatusCode::NO_CONTENT))
}

// ============================= GROUPS =============================

pub async fn list_groups(
    _auth: RequirePermissions<(GroupsRead,)>,
    Extension(ctx): Extension<AuthContext>,
    Query(q): Query<PaginationQuery>,
) -> ApiResult<Json<GroupListResponse>> {
    let (page, per_page) = q.clamped();
    let (groups, total) = ctx.group().list(page, per_page).await.map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(GroupListResponse {
            groups,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

pub async fn get_group(
    _auth: RequirePermissions<(GroupsRead,)>,
    Extension(ctx): Extension<AuthContext>,
    Path(group_id): Path<Uuid>,
) -> ApiResult<Json<ziee_auth::Group>> {
    let group = ctx
        .group()
        .get_by_id(group_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Group")))?;
    Ok((StatusCode::OK, Json(group)))
}

pub async fn create_group(
    auth: RequirePermissions<(GroupsCreate,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Json(req): Json<CreateGroupRequest>,
) -> ApiResult<Json<ziee_auth::Group>> {
    if req.name.trim().is_empty() {
        return Err(e(AppError::bad_request("INVALID_INPUT", "Group name is required")));
    }
    for p in &req.permissions {
        if !principal_holds(&auth.user, &auth.groups, p) {
            return Err(e(AppError::forbidden(
                "PERMISSION_ESCALATION",
                "Cannot grant a permission you do not hold",
            )));
        }
    }
    let groups = ctx.group();
    if groups.get_by_name(&req.name).await.map_err(e)?.is_some() {
        return Err(e(AppError::conflict("Group name")));
    }
    let group = groups
        .create(&req.name, req.description.clone(), req.permissions.clone())
        .await
        .map_err(e)?;
    publish(SyncEntity::Group, SyncAction::Create, group.id, Audience::perm::<GroupsRead>(), origin.0);
    Ok((StatusCode::CREATED, Json(group)))
}

pub async fn update_group(
    auth: RequirePermissions<(GroupsEdit,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(group_id): Path<Uuid>,
    Json(req): Json<UpdateGroupRequest>,
) -> ApiResult<Json<ziee_auth::Group>> {
    let groups = ctx.group();
    let existing = groups
        .get_by_id(group_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Group")))?;

    // System groups (Administrators/Users) are protected.
    if existing.is_system
        && (req.name.is_some() || req.is_active == Some(false) || req.permissions.is_some())
    {
        return Err(e(AppError::bad_request(
            "SYSTEM_GROUP",
            "System groups' name, permissions, and active status cannot be changed",
        )));
    }
    if let Some(perms) = &req.permissions {
        for p in perms {
            if !principal_holds(&auth.user, &auth.groups, p) {
                return Err(e(AppError::forbidden(
                    "PERMISSION_ESCALATION",
                    "Cannot grant a permission you do not hold",
                )));
            }
        }
    }
    let group = groups
        .update(
            group_id,
            req.name.clone(),
            req.description.clone(),
            req.permissions.clone(),
            req.is_active,
        )
        .await
        .map_err(e)?;
    publish(SyncEntity::Group, SyncAction::Update, group_id, Audience::perm::<GroupsRead>(), origin.0);
    // A permission or active-state edit changes what every MEMBER is allowed to do, so
    // their clients re-bootstrap /auth/me instead of running on a stale permission set
    // until the stream's 60s re-check. One batched registry pass (`publish_session_to_users`).
    if req.permissions.is_some() || req.is_active.is_some() {
        if let Ok(members) = groups.get_member_ids(group_id).await {
            publish_session_to_users(&members, None);
        }
    }
    Ok((StatusCode::OK, Json(group)))
}

pub async fn delete_group(
    _auth: RequirePermissions<(GroupsDelete,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path(group_id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let groups = ctx.group();
    let existing = groups
        .get_by_id(group_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Group")))?;
    if existing.is_system {
        return Err(e(AppError::bad_request(
            "SYSTEM_GROUP",
            "System groups cannot be deleted",
        )));
    }
    // Snapshot the membership BEFORE the delete cascades the join rows away.
    let members = groups.get_member_ids(group_id).await.unwrap_or_default();
    groups.delete(group_id).await.map_err(e)?;
    publish(SyncEntity::Group, SyncAction::Delete, group_id, Audience::perm::<GroupsRead>(), origin.0);
    publish_session_to_users(&members, None);
    Ok((StatusCode::NO_CONTENT, StatusCode::NO_CONTENT))
}

pub async fn get_group_members(
    auth: RequirePermissions<(GroupsRead,)>,
    Extension(ctx): Extension<AuthContext>,
    Path(group_id): Path<Uuid>,
    Query(q): Query<PaginationQuery>,
) -> ApiResult<Json<UserListResponse>> {
    let (page, per_page) = q.clamped();
    let groups = ctx.group();
    groups
        .get_by_id(group_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Group")))?;
    let (mut users, total) = groups.get_members(group_id, page, per_page).await.map_err(e)?;
    if !auth.user.is_admin {
        for u in users.iter_mut() {
            u.email = String::new();
            u.permissions = vec![];
            u.last_login_at = None;
        }
    }
    Ok((
        StatusCode::OK,
        Json(UserListResponse {
            users,
            total,
            page,
            per_page,
            total_pages: total_pages(total, per_page),
        }),
    ))
}

pub async fn assign_user_to_group(
    auth: RequirePermissions<(GroupsAssignUsers,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Json(req): Json<AssignUserToGroupRequest>,
) -> ApiResult<StatusCode> {
    let users = ctx.user();
    let groups = ctx.group();
    users
        .get_by_id(req.user_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("User")))?;
    let group = groups
        .get_by_id(req.group_id)
        .await
        .map_err(e)?
        .ok_or_else(|| e(AppError::not_found("Group")))?;
    // A non-admin can't assign into a privileged (system) group or grant perms
    // they lack.
    if !auth.user.is_admin {
        if group.is_system {
            return Err(e(AppError::forbidden(
                "CANNOT_ASSIGN_PRIVILEGED_GROUP",
                "Only an administrator can assign users to a system group",
            )));
        }
        for p in &group.permissions {
            if !principal_holds(&auth.user, &auth.groups, p) {
                return Err(e(AppError::forbidden(
                    "PERMISSION_ESCALATION",
                    "Cannot assign a group granting a permission you do not hold",
                )));
            }
        }
    }
    users
        .assign_to_group(req.user_id, req.group_id, Some(auth.user.id))
        .await
        .map_err(e)?;
    publish(SyncEntity::Group, SyncAction::Update, req.group_id, Audience::perm::<GroupsRead>(), origin.0);
    publish_session_to_users(&[req.user_id], None);
    Ok((StatusCode::NO_CONTENT, StatusCode::NO_CONTENT))
}

pub async fn remove_user_from_group(
    _auth: RequirePermissions<(GroupsAssignUsers,)>,
    Extension(ctx): Extension<AuthContext>,
    origin: SyncOrigin,
    Path((user_id, group_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    ctx.user()
        .remove_from_group(user_id, group_id)
        .await
        .map_err(e)?;
    publish(SyncEntity::Group, SyncAction::Update, group_id, Audience::perm::<GroupsRead>(), origin.0);
    publish_session_to_users(&[user_id], None);
    Ok((StatusCode::NO_CONTENT, StatusCode::NO_CONTENT))
}
