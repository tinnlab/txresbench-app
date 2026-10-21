//! User + group admin routers (aide-documented). Operation IDs match ziee's so
//! the generated ApiClient exposes `ApiClient.User.*` / `ApiClient.UserGroup.*`.

use aide::axum::routing::{get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::handlers::*;
use super::permissions::*;
use super::types::*;

pub fn user_router() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/users",
            get_with(list_users, list_users_docs).post_with(create_user, create_user_docs),
        )
        .api_route(
            "/users/reset-password",
            post_with(reset_user_password, reset_password_docs),
        )
        .api_route(
            "/users/{user_id}",
            get_with(get_user, get_user_docs)
                .post_with(update_user, update_user_docs)
                .delete_with(delete_user, delete_user_docs),
        )
        .api_route(
            "/users/{user_id}/toggle-active",
            post_with(toggle_user_active, toggle_active_docs),
        )
}

pub fn group_router() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/groups",
            get_with(list_groups, list_groups_docs).post_with(create_group, create_group_docs),
        )
        .api_route(
            "/groups/assign",
            post_with(assign_user_to_group, assign_docs),
        )
        .api_route(
            "/groups/{group_id}",
            get_with(get_group, get_group_docs)
                .post_with(update_group, update_group_docs)
                .delete_with(delete_group, delete_group_docs),
        )
        .api_route(
            "/groups/{group_id}/members",
            get_with(get_group_members, members_docs),
        )
        .api_route(
            "/groups/{user_id}/{group_id}/remove",
            aide::axum::routing::delete_with(remove_user_from_group, remove_docs),
        )
}

// ---- user docs ----
fn list_users_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersRead,)>(op)
        .id("User.list")
        .tag("user")
        .response::<200, Json<AdminUserListResponse>>()
}
fn create_user_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersCreate,)>(op)
        .id("User.create")
        .tag("user")
        .response::<201, Json<ziee_auth::User>>()
}
fn get_user_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersRead,)>(op)
        .id("User.get")
        .tag("user")
        .response::<200, Json<ziee_auth::User>>()
}
fn update_user_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersEdit,)>(op)
        .id("User.update")
        .tag("user")
        .response::<200, Json<ziee_auth::User>>()
}
fn delete_user_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersDelete,)>(op)
        .id("User.delete")
        .tag("user")
        .response::<204, ()>()
}
fn toggle_active_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersToggleStatus,)>(op)
        .id("User.toggleActive")
        .tag("user")
        .response::<200, Json<UserActiveStatusResponse>>()
}
fn reset_password_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(UsersResetPassword,)>(op)
        .id("User.resetPassword")
        .tag("user")
        .response::<204, ()>()
}

// ---- group docs (operation namespace: UserGroup) ----
fn list_groups_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsRead,)>(op)
        .id("UserGroup.list")
        .tag("user-group")
        .response::<200, Json<GroupListResponse>>()
}
fn create_group_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsCreate,)>(op)
        .id("UserGroup.create")
        .tag("user-group")
        .response::<201, Json<ziee_auth::Group>>()
}
fn get_group_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsRead,)>(op)
        .id("UserGroup.get")
        .tag("user-group")
        .response::<200, Json<ziee_auth::Group>>()
}
fn update_group_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsEdit,)>(op)
        .id("UserGroup.update")
        .tag("user-group")
        .response::<200, Json<ziee_auth::Group>>()
}
fn delete_group_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsDelete,)>(op)
        .id("UserGroup.delete")
        .tag("user-group")
        .response::<204, ()>()
}
fn members_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsRead,)>(op)
        .id("UserGroup.getMembers")
        .tag("user-group")
        .response::<200, Json<UserListResponse>>()
}
fn assign_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsAssignUsers,)>(op)
        .id("UserGroup.assignUser")
        .tag("user-group")
        .response::<204, ()>()
}
fn remove_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(GroupsAssignUsers,)>(op)
        .id("UserGroup.removeUser")
        .tag("user-group")
        .response::<204, ()>()
}
