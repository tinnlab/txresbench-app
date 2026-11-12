//! `ProjectScope` — the **single project-authz chokepoint** every platform endpoint
//! resolves through instead of re-implementing `effective_permission +
//! .can_edit()/.is_owner()`.
//!
//! It promotes the inline `resolve()` proto-guard the project handlers grew (owner
//! short-circuit + accepted-share level, `None` ⇒ 404 "invisible") into a reusable
//! struct with guard methods, an admin-override variant, and the small cross-part
//! seams P10 OWNS and downstream parts (P1 data-API, P6 workbench, P9 MCP)
//! consume: [`project_audience`] (sync fan-out set), [`authz_precedence`] (two-level
//! authz ordering), and the [`SafetyTier`] role→MCP-safety map.
//!
//! **Two-level authz (DEC-4).** OUTER = the app-RBAC capability gate
//! (`RequirePermissions<(P,)>` extractor, enforced structurally BEFORE the handler
//! body → 403 first); INNER = the project role resolved here (404/403 in the body).
//! [`authz_precedence`] makes that ordering explicit + testable.
//!
//! **Admin override (DEC-13, R8).** [`ProjectScope::resolve`] applies NO override —
//! it is the behavior-preserving base guard the owner-facing endpoints use.
//! [`ProjectScope::resolve_admin`] additionally resolves a `project::admin::manage` /
//! root-admin holder to Owner-equivalent on ANY existing project; a NON-admin gets
//! exactly their ACL (never widened).

use uuid::Uuid;

use txresbench_core::AppError;

use super::models::{EffectivePermission, Project};
use super::repository::ProjectRepository;

/// The acting user's resolved access to one project.
#[derive(Debug, Clone)]
pub struct ProjectScope {
    /// The resolved project row (so a handler needn't re-fetch it).
    pub project: Project,
    pub project_id: Uuid,
    pub user_id: Uuid,
    pub perm: EffectivePermission,
    /// True when `perm` came from an admin override (`project::admin::manage` /
    /// root-admin), NOT a real owner/share ACL. Endpoints that must not act as an
    /// admin-impersonating-owner can branch on this.
    pub admin_override: bool,
}

impl ProjectScope {
    /// Resolve WITHOUT admin override — the base guard for owner-facing endpoints.
    /// `Ok(None)` ⇒ the project is invisible to the user (the caller maps to 404, the
    /// owner-scoped-invisible idiom).
    pub async fn resolve(
        repo: &ProjectRepository,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<ProjectScope>, AppError> {
        let perm = repo.effective_permission(project_id, user_id).await?;
        let project = repo.get(project_id).await?;
        Ok(resolve_decision(perm, project, project_id, user_id))
    }

    /// Resolve WITH admin override: a project admin (`is_project_admin == true`)
    /// resolves to Owner-equivalent on ANY existing project; a non-admin resolves to
    /// exactly their ACL (NO widening — R8). `Ok(None)` ⇒ 404 (project absent, or a
    /// non-admin with no ACL).
    ///
    /// The caller computes `is_project_admin` at the endpoint, where the acting
    /// `User`/`Group`s are in hand, e.g.
    /// `principal_holds(&auth.user, &auth.groups, ProjectAdminManage::PERMISSION)`
    /// (root-admins short-circuit `principal_holds` to `true`). Keeping the flag
    /// out of `scope.rs` decouples this seam from the identity types.
    pub async fn resolve_admin(
        repo: &ProjectRepository,
        project_id: Uuid,
        user_id: Uuid,
        is_project_admin: bool,
    ) -> Result<Option<ProjectScope>, AppError> {
        let perm = repo.effective_permission(project_id, user_id).await?;
        let project = repo.get(project_id).await?;
        Ok(resolve_admin_decision(
            perm,
            project,
            project_id,
            user_id,
            is_project_admin,
        ))
    }

    /// A3 (ITEM-1, PROV-A3-2): the account-aware resolver — the named 3rd-rung
    /// chokepoint API downstream items (A4) resolve through. Resolves BOTH the
    /// account-membership rung (mid) and the within-project ACL (inner) in one call.
    /// `Ok(None)` ⇒ 404 when the project is absent, foreign, OR the user is neither a
    /// member of the project's account nor an owner/accepted-sharee (the
    /// cross-account existence-oracle guard, INV-1).
    ///
    /// The membership rung is realized INSIDE `effective_permission` (DEC-12), which
    /// already folds owner ∪ accepted-share ∪ account-membership-floor into its
    /// `Option<EffectivePermission>` — so this constructor is `resolve` under a name
    /// that documents the account-awareness. Behaviour-identical to `resolve` for
    /// personal-account (single-member) users (INV-4).
    pub async fn resolve_in_account(
        repo: &ProjectRepository,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<ProjectScope>, AppError> {
        let perm = repo.effective_permission(project_id, user_id).await?;
        let project = repo.get(project_id).await?;
        Ok(resolve_decision(perm, project, project_id, user_id))
    }

    /// A3 (ITEM-8/DEC-11): the account-aware admin-override resolver. A platform/
    /// project admin transcends tenancy (reaches ANY existing project as
    /// Owner-equivalent, `admin_override=true`), exactly as `resolve_admin` transcends
    /// the within-project ACL; a NON-admin gets exactly their membership-gated ACL
    /// (no widening — R8). The membership rung is folded into `effective_permission`
    /// (DEC-12), so a non-admin account co-member resolves at their graded floor and a
    /// non-member ⇒ `None` (404).
    pub async fn resolve_admin_in_account(
        repo: &ProjectRepository,
        project_id: Uuid,
        user_id: Uuid,
        is_project_admin: bool,
    ) -> Result<Option<ProjectScope>, AppError> {
        let perm = repo.effective_permission(project_id, user_id).await?;
        let project = repo.get(project_id).await?;
        Ok(resolve_admin_decision(
            perm,
            project,
            project_id,
            user_id,
            is_project_admin,
        ))
    }

    /// Owner|Editor may edit; a Viewer 403s.
    pub fn require_can_edit(&self) -> Result<(), AppError> {
        self.require_role(
            EffectivePermission::Editor,
            "You do not have edit access to this project",
        )
    }

    /// Owner-only (share / transfer / delete); Editor|Viewer 403.
    pub fn require_owner(&self) -> Result<(), AppError> {
        self.require_role(
            EffectivePermission::Owner,
            "Only the project owner may perform this action",
        )
    }

    /// Generic: require at least `min` (Owner > Editor > Viewer). 403 otherwise.
    pub fn require_at_least(&self, min: EffectivePermission) -> Result<(), AppError> {
        self.require_role(min, "You do not have sufficient access to this project")
    }

    fn require_role(&self, min: EffectivePermission, msg: &'static str) -> Result<(), AppError> {
        if role_rank(self.perm) >= role_rank(min) {
            Ok(())
        } else {
            Err(AppError::forbidden("FORBIDDEN", msg))
        }
    }

    pub fn can_edit(&self) -> bool {
        self.perm.can_edit()
    }
    pub fn is_owner(&self) -> bool {
        self.perm.is_owner()
    }
}

/// Owner > Editor > Viewer as a total order for `require_role`.
fn role_rank(p: EffectivePermission) -> u8 {
    match p {
        EffectivePermission::Owner => 3,
        EffectivePermission::Editor => 2,
        EffectivePermission::Viewer => 1,
    }
}

/// Pure base resolution (no override): both the ACL and the row must be present.
fn resolve_decision(
    perm: Option<EffectivePermission>,
    project: Option<Project>,
    project_id: Uuid,
    user_id: Uuid,
) -> Option<ProjectScope> {
    match (perm, project) {
        (Some(perm), Some(project)) => Some(ProjectScope {
            project,
            project_id,
            user_id,
            perm,
            admin_override: false,
        }),
        _ => None,
    }
}

/// Pure admin-override resolution (unit-tested — R8 no-widening).
/// - a real ACL wins (admin_override=false) even for an admin (their own project);
/// - an admin with no ACL reaches an existing project as Owner (admin_override=true);
/// - a non-admin with no ACL, or a missing project, ⇒ `None` (404).
fn resolve_admin_decision(
    perm: Option<EffectivePermission>,
    project: Option<Project>,
    project_id: Uuid,
    user_id: Uuid,
    is_project_admin: bool,
) -> Option<ProjectScope> {
    match (perm, project) {
        (Some(perm), Some(project)) => Some(ProjectScope {
            project,
            project_id,
            user_id,
            perm,
            admin_override: false,
        }),
        (None, Some(project)) if is_project_admin => Some(ProjectScope {
            project,
            project_id,
            user_id,
            perm: EffectivePermission::Owner,
            admin_override: true,
        }),
        _ => None,
    }
}

/// The project's sync fan-out set — the users who may currently see this project.
/// ONE helper the platform result-write path (P1/ITEM-13) and every project-mutating
/// handler call instead of re-deriving owner + recipients per emit site.
///
/// ## #168 — derived from CURRENT membership, not from `projects.owner_id`
///
/// This used to be `(project.owner_id, accepted_recipient_ids)`. That is a DELIVERY
/// audience, and it was addressed off a column that removal does not touch: after
/// #147 a member removed from an organization correctly 404s on every project they
/// created there **and kept receiving live sync frames for it** — unable to fetch the
/// resource, still told in real time whenever it changed.
///
/// The audience is now the project's account's CURRENT membership ∪ its accepted-share
/// recipients, which is #168's stated fix and is exactly the set
/// `ProjectRepository::effective_permission` resolves to `Some` for: every recipient
/// this adds could already READ the project (an account member floors at ≥Viewer), and
/// every recipient it removes had already lost the ability to. It repairs a second,
/// quieter defect in the same motion — an account Owner who can open a co-member's
/// project was previously never told when it changed.
///
/// `None` ⇒ nobody may see it, so there is no frame to send; every call site skips the
/// emit, the same arm they already had for a resolution error. See
/// [`crate::modules::sync::owner_scoped_audience`] for the anchor rule (the row's own
/// owner keeps the slot whenever they are still in the audience, so the ordinary case
/// — including `origin` self-echo suppression — is byte-identical).
///
/// A surviving accepted share still puts a NON-member in the audience: a share is a
/// separate grant, and #172 (whether it should outlive membership) is an open owner
/// decision this must not answer by accident.
pub async fn project_audience(
    repo: &ProjectRepository,
    project_id: Uuid,
) -> Result<Option<(Uuid, Vec<Uuid>)>, AppError> {
    let project = repo
        .get(project_id)
        .await?
        .ok_or_else(|| AppError::not_found("Project"))?;
    let audience = repo.audience_user_ids(project_id).await?;
    Ok(crate::modules::sync::owner_scoped_audience(
        project.owner_id,
        audience,
    ))
}

/// Two-level authz precedence (DEC-4): the OUTER app-RBAC capability (403) is
/// enforced BEFORE the INNER project role (404). `has_capability` is what the
/// `RequirePermissions<(P,)>` extractor enforces structurally before the handler
/// body; this makes the ordering explicit + testable for endpoints that resolve
/// the capability in-body. Returns the resolved scope on success.
pub fn authz_precedence(
    has_capability: bool,
    scope: Option<ProjectScope>,
) -> Result<ProjectScope, AppError> {
    if !has_capability {
        return Err(AppError::forbidden(
            "INSUFFICIENT_PERMISSIONS",
            "You do not have permission to use this feature",
        ));
    }
    scope.ok_or_else(|| AppError::not_found("Project"))
}

/// A3 (ITEM-1, DEC-3): the THREE-level authz precedence, extending
/// [`authz_precedence`] with the mid **account-membership** rung between the outer
/// RBAC capability (403) and the inner project ACL (404), matching design §6's
/// precedence table:
///
/// ```text
/// outer  RBAC capability      → 403 if missing
/// mid    account membership   → 404 if not a member
/// inner  within-project ACL   → 404 if no resolved scope
/// ```
///
/// A non-capability holder 403s BEFORE any resource is resolved (no existence
/// oracle); a capability-holding non-member 404s (INV-1); a member with a resolved
/// scope succeeds. `is_member` is the membership predicate for resources with NO
/// orthogonal share path; the production project GET path folds membership ∪ share ∪
/// owner into the `scope` Option via [`ProjectScope::resolve_in_account`], so a
/// non-member who reaches via an accepted share still resolves a `Some(scope)` there.
/// This pure helper documents + tests the canonical ordering.
pub fn authz_precedence_in_account(
    has_capability: bool,
    is_member: bool,
    scope: Option<ProjectScope>,
) -> Result<ProjectScope, AppError> {
    if !has_capability {
        return Err(AppError::forbidden(
            "INSUFFICIENT_PERMISSIONS",
            "You do not have permission to use this feature",
        ));
    }
    if !is_member {
        return Err(AppError::not_found("Project"));
    }
    scope.ok_or_else(|| AppError::not_found("Project"))
}

// ---------------------------- MCP safety tier (P9 boundary) ----------------------------

/// The per-contribution MCP safety hint vocabulary (PLATFORM_ARCHITECTURE §0.4.2).
/// Ordered `ReadRun < Mutating < Destructive` so `tier <= role_max_safety(role)`
/// is the allow check. P10 OWNS this + the role map (ITEM-14); P9 wires it into
/// per-project MCP tool generation + the approval flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SafetyTier {
    ReadRun,
    Mutating,
    Destructive,
}

impl SafetyTier {
    /// Parse a declared `safety:` hint string; unknown ⇒ `None`.
    pub fn from_hint(hint: &str) -> Option<SafetyTier> {
        match hint {
            "read-run" => Some(SafetyTier::ReadRun),
            "mutating" => Some(SafetyTier::Mutating),
            "destructive" => Some(SafetyTier::Destructive),
            _ => None,
        }
    }

    pub fn as_hint(self) -> &'static str {
        match self {
            SafetyTier::ReadRun => "read-run",
            SafetyTier::Mutating => "mutating",
            SafetyTier::Destructive => "destructive",
        }
    }
}

/// The MAX MCP tool safety tier a project role may invoke (DEC-10):
/// Viewer → read-run only; Editor → + mutating; Owner → + destructive.
pub fn role_max_safety(role: EffectivePermission) -> SafetyTier {
    match role {
        EffectivePermission::Viewer => SafetyTier::ReadRun,
        EffectivePermission::Editor => SafetyTier::Mutating,
        EffectivePermission::Owner => SafetyTier::Destructive,
    }
}

/// May `role` invoke a tool whose safety hint is `tier`?
pub fn role_allows_safety(role: EffectivePermission, tier: SafetyTier) -> bool {
    tier <= role_max_safety(role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn project_row(owner: Uuid) -> Project {
        let now = Utc::now();
        Project {
            id: Uuid::new_v4(),
            owner_id: owner,
            account_id: Uuid::new_v4(),
            name: "S".into(),
            description: String::new(),
            created_at: now,
            updated_at: now,
        }
    }

    fn scope_with(perm: EffectivePermission) -> ProjectScope {
        ProjectScope {
            project: project_row(Uuid::new_v4()),
            project_id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            perm,
            admin_override: false,
        }
    }

    // TEST-2: guard methods map roles → 403/Ok.
    #[test]
    fn guards_enforce_role_floor() {
        let owner = scope_with(EffectivePermission::Owner);
        let editor = scope_with(EffectivePermission::Editor);
        let viewer = scope_with(EffectivePermission::Viewer);

        assert!(owner.require_owner().is_ok());
        assert!(owner.require_can_edit().is_ok());
        assert!(editor.require_owner().is_err(), "editor is not owner");
        assert!(editor.require_can_edit().is_ok());
        assert!(viewer.require_can_edit().is_err(), "viewer cannot edit");
        assert!(viewer.require_owner().is_err());
        assert!(viewer.require_at_least(EffectivePermission::Viewer).is_ok());
        assert!(editor.require_at_least(EffectivePermission::Owner).is_err());
    }

    // TEST-3: admin-override decision matrix (no widening).
    #[test]
    fn admin_override_reaches_but_never_widens() {
        let uid = Uuid::new_v4();
        let sid = Uuid::new_v4();
        let s = project_row(Uuid::new_v4());

        // real ACL always wins (admin or not) — no override flag.
        let got = resolve_admin_decision(
            Some(EffectivePermission::Viewer),
            Some(s.clone()),
            sid,
            uid,
            true,
        )
        .expect("real ACL resolves");
        assert_eq!(got.perm, EffectivePermission::Viewer);
        assert!(!got.admin_override, "a real ACL is never an override");

        // admin with NO ACL reaches an existing project as Owner (override).
        let got = resolve_admin_decision(None, Some(s.clone()), sid, uid, true)
            .expect("admin reaches foreign project");
        assert_eq!(got.perm, EffectivePermission::Owner);
        assert!(got.admin_override);

        // NON-admin with no ACL → None (NO widening — R8).
        assert!(resolve_admin_decision(None, Some(s.clone()), sid, uid, false).is_none());
        // missing project → None even for an admin.
        assert!(resolve_admin_decision(None, None, sid, uid, true).is_none());
        // base (no-override) resolve never elevates.
        assert!(resolve_decision(None, Some(s), sid, uid).is_none());
    }

    // TEST-6: two-level precedence — capability 403 BEFORE project 404.
    #[test]
    fn authz_precedence_is_capability_then_scope() {
        let viewer = scope_with(EffectivePermission::Viewer);
        // (false, Some) → 403
        assert!(authz_precedence(false, Some(viewer.clone())).is_err());
        // (false, None) → 403 (capability fires BEFORE the project check)
        let err = authz_precedence(false, None).unwrap_err();
        assert!(
            format!("{err:?}").contains("INSUFFICIENT_PERMISSIONS")
                || err.to_api_error().0.as_u16() == 403
        );
        // (true, None) → 404
        assert!(authz_precedence(true, None).is_err());
        // (true, Some) → Ok
        assert!(authz_precedence(true, Some(viewer)).is_ok());
    }

    // A3 TEST-1: the pure 3-level `authz_precedence_in_account` ordering —
    // capability(403) → membership(404) → inner-scope(404).
    #[test]
    fn authz_precedence_in_account_is_capability_then_membership_then_scope() {
        let member = scope_with(EffectivePermission::Viewer);
        // no capability → 403, BEFORE any membership/resource resolve.
        let err = authz_precedence_in_account(false, false, None).unwrap_err();
        assert!(
            format!("{err:?}").contains("INSUFFICIENT_PERMISSIONS")
                || err.to_api_error().0.as_u16() == 403
        );
        assert!(authz_precedence_in_account(false, true, Some(member.clone())).is_err());
        // capability + NON-member → 404 (cross-account existence guard, INV-1).
        let err = authz_precedence_in_account(true, false, Some(member.clone())).unwrap_err();
        assert_eq!(err.to_api_error().0.as_u16(), 404);
        // capability + member + None scope → 404.
        assert_eq!(
            authz_precedence_in_account(true, true, None)
                .unwrap_err()
                .to_api_error()
                .0
                .as_u16(),
            404
        );
        // capability + member + Some scope → Ok.
        assert!(authz_precedence_in_account(true, true, Some(member)).is_ok());
    }

    // A3 TEST-2: `resolve_admin_in_account` R8 no-widening (reuses the pure
    // `resolve_admin_decision` the account-aware resolver folds into): a real ACL
    // wins (no override); a platform admin with no ACL reaches as Owner (override);
    // a non-admin non-member ⇒ None (404).
    #[test]
    fn resolve_admin_in_account_no_widening() {
        let uid = Uuid::new_v4();
        let sid = Uuid::new_v4();
        let s = project_row(Uuid::new_v4());
        // a resolved membership/ACL (Some perm) always wins, override=false.
        let got = resolve_admin_decision(
            Some(EffectivePermission::Viewer),
            Some(s.clone()),
            sid,
            uid,
            true,
        )
        .expect("resolved ACL");
        assert_eq!(got.perm, EffectivePermission::Viewer);
        assert!(!got.admin_override);
        // platform admin, no membership/ACL → reaches existing project as Owner.
        let got = resolve_admin_decision(None, Some(s.clone()), sid, uid, true)
            .expect("admin transcends tenancy");
        assert_eq!(got.perm, EffectivePermission::Owner);
        assert!(got.admin_override);
        // non-admin non-member (None perm) → None (404), no widening.
        assert!(resolve_admin_decision(None, Some(s), sid, uid, false).is_none());
    }

    // TEST-15: role → SafetyTier map + hint parsing + ordering.
    #[test]
    fn safety_tier_map_and_parse() {
        use EffectivePermission::*;
        assert_eq!(role_max_safety(Viewer), SafetyTier::ReadRun);
        assert_eq!(role_max_safety(Editor), SafetyTier::Mutating);
        assert_eq!(role_max_safety(Owner), SafetyTier::Destructive);

        // viewer: only read-run
        assert!(role_allows_safety(Viewer, SafetyTier::ReadRun));
        assert!(!role_allows_safety(Viewer, SafetyTier::Mutating));
        assert!(!role_allows_safety(Viewer, SafetyTier::Destructive));
        // editor: + mutating, not destructive
        assert!(role_allows_safety(Editor, SafetyTier::Mutating));
        assert!(!role_allows_safety(Editor, SafetyTier::Destructive));
        // owner: all
        assert!(role_allows_safety(Owner, SafetyTier::Destructive));

        assert_eq!(SafetyTier::from_hint("read-run"), Some(SafetyTier::ReadRun));
        assert_eq!(
            SafetyTier::from_hint("mutating"),
            Some(SafetyTier::Mutating)
        );
        assert_eq!(
            SafetyTier::from_hint("destructive"),
            Some(SafetyTier::Destructive)
        );
        assert_eq!(SafetyTier::from_hint("bogus"), None);
        assert_eq!(SafetyTier::ReadRun.as_hint(), "read-run");
        assert!(SafetyTier::ReadRun < SafetyTier::Mutating);
        assert!(SafetyTier::Mutating < SafetyTier::Destructive);
    }
}
