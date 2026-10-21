//! Who may SEE a job, and who may STOP one.
//!
//! `799d0cf3` settled who may CREATE a job scoped to a thing — the same gate as every
//! other content mutation on that thing (`require_can_edit` / `require_project_edit`),
//! with owner-only reserved for LIFECYCLE acts — and named the companion hole it did
//! not close: a job row is owned by whoever CREATED it, so an `edit`-role sharee or a
//! project Editor running a job on someone else's dataset/project produced a row that
//! the owner of that dataset/project could not list, open, read the logs of, or stop.
//! They saw its EFFECT (the derived processing badge) and had no authority over it.
//!
//! ## The rule
//!
//! A job has two kinds of principal, and they do NOT get the same rights:
//!
//! * **[`JobReach::See`]** — the job's creator, everyone who may EDIT the thing it
//!   acts on, and admins. This grants nothing new: every EDIT-holder could have
//!   enqueued this exact job themselves, and an editor NEEDS to see it — "is this
//!   dataset busy" is the question you must answer before uploading into it or
//!   starting a competing run.
//! * **[`JobReach::Control`]** — strictly narrower: the job's creator, the OWNER of
//!   the thing it acts on, and admins. Ending an in-flight run is that run's DELETE,
//!   and `799d0cf3` reserved lifecycle acts to the owner. A third-party editor is an
//!   editor of the DATA, not of somebody else's RUN.
//!
//! So sight and stop-authority genuinely differ, and the difference is exactly one
//! principal: the editor who is neither the creator nor the owner of the scope.
//!
//! **"The job's creator" means a creator who still has STANDING on the job's scope**
//! (#167). Creating a job is not a permanent grant over it: a member removed from the
//! account keeps `jobs.owner_id` — removal changes no row on `jobs` — and kept
//! `Control` over every job they had started inside the organization, indefinitely,
//! including its raw log stream and its `error` string. See
//! `creator_retains_standing` (below) for the predicate, for the option it picks out
//! of #167's list, and for the consequence #167 names that it does not design away.
//!
//! ## Why readers are excluded, when `provenance` shows runs to readers
//!
//! `GET /provenance/runs` admits any project Viewer, and the dataset badge admits any
//! sharee — so it is fair to ask why `/jobs` does not. Because `/jobs` is strictly
//! heavier than either: it serves the run's raw log stream and the engine's raw error
//! string, which `enrich_items` and `get_dataset` deliberately redact for anyone who
//! cannot edit the dataset. Admitting readers here would UNDO that redaction while
//! claiming to fix an authorization gap. Readers keep the thinner surfaces that were
//! built for them; those remain unchanged.
//!
//! ## Grading
//!
//! Anything below `See` answers **404**, never 403: the path parameter is a job id an
//! unauthorized caller has no way to learn, so a 403 would be an existence oracle.
//! The single 403 in the surface is `See`-but-not-`Control` on `stop` — that caller
//! can already see the job, so there is no existence left to protect.

use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use super::models::Job;
use super::repository::{JobRepository, JobScope};
use crate::modules::dataset::repository::{DatasetAccess, DatasetRepository};
use crate::modules::project::{EffectivePermission, ProjectRepository};

/// How far a caller reaches into one job. Ordered: `Control` implies `See`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum JobReach {
    /// Invisible — every job-scoped route answers 404.
    None,
    /// May list / open / read logs / stream, but `stop` is 403.
    See,
    /// May do all of the above AND stop the run.
    Control,
}

impl JobReach {
    pub fn can_see(self) -> bool {
        self >= JobReach::See
    }
    pub fn can_control(self) -> bool {
        self == JobReach::Control
    }
}

/// Resolve `user_id`'s reach over `job`.
///
/// Deliberately built out of the SAME helpers the create gate uses
/// (`DatasetRepository::access`, `ProjectRepository::effective_permission`) rather
/// than a fresh predicate: `799d0cf3`'s second finding was a hand-copied share
/// predicate that had silently drifted from its original, and the list query
/// (which cannot call these, being SQL) is held to this one by
/// `a_job_is_listed_exactly_when_it_can_be_opened` in the integration suite.
///
/// A SCOPE-LESS job (no `job_scope` row, or one whose target has since been deleted —
/// `JobRepository::job_scope` is existence-aware) has no second principal, so it stays
/// creator-and-admin-only. That is the pre-existing behavior, preserved.
///
/// A3 (ITEM-5/DEC-14): account-membership reach is inherited TRANSITIVELY, with no
/// predicate edit here — `effective_permission` (project arm) and
/// `DatasetRepository::access` (dataset arm) are now account-aware, so a member of
/// `account_of(job's project/dataset)` reaches the job at their graded role (account
/// Owner→Control, Admin→See, bare Member→Viewer⇒None, keeping the deliberate
/// "Viewers do not see raw job logs" redaction rule). Behaviour-preserving for
/// personal accounts.
///
/// #167: the CREATOR short-circuit is no longer unconditional. `is_admin` still
/// short-circuits first (platform staff transcend tenancy, as everywhere else); the
/// creator arm is conjoined with `creator_retains_standing` on the job's scope, so a
/// member removed from the account stops reaching — with `Control`, i.e. the STOP gate
/// and the raw log stream — every job they created there. It still yields `Control`
/// rather than the scope's graded reach: gating the arm is the fix, downgrading it
/// would strand the edit-sharee who legitimately started the run (DEC-2).
pub async fn resolve_job_reach(
    pool: &PgPool,
    job: &Job,
    user_id: Uuid,
    is_admin: bool,
    group_ids: &[Uuid],
) -> Result<JobReach, AppError> {
    if is_admin {
        return Ok(JobReach::Control);
    }
    let scope = JobRepository::job_scope(pool, job.id).await?;
    // #167 — the CREATOR short-circuit, gated. `jobs` carries no `account_id`, so
    // #147's transform ("conjoin the owner branch with membership of the row's
    // account") has no account to name here; the conjunct is instead STANDING on the
    // job's SCOPE. See `creator_retains_standing` for the predicate and for the
    // decision it embodies — including the case #167 names that it does not preserve.
    if job.owner_id == user_id && creator_retains_standing(pool, &scope, user_id, group_ids).await?
    {
        return Ok(JobReach::Control);
    }
    match scope {
        Some(JobScope::Dataset(dataset_id)) => {
            let repo = DatasetRepository::new(pool.clone());
            match repo.access(dataset_id, user_id, group_ids).await? {
                DatasetAccess::CanEdit => {
                    // The dataset's OWNER controls; any other editor only watches.
                    //
                    // H-1 (#147): `is_current_owner`, NOT `owner_of`. `access` returns
                    // `CanEdit` through THREE disjuncts and one of them — the
                    // `dataset_shares role='edit'` union — is deliberately preserved by
                    // this branch. So a member removed from the account who still holds
                    // (or is in a group holding) an edit share on the dataset they
                    // created reached `CanEdit`, and a bare `owner_of` comparison then
                    // handed them `Control`, which is the STOP gate: they could kill the
                    // account's running jobs. `controllable_subset` — this function's SQL
                    // mirror — was conjoined with membership in the same change, so
                    // leaving this as `owner_of` also made the two graders disagree for
                    // exactly that principal (listed as un-stoppable, stoppable in fact).
                    //
                    // Scope of that agreement claim, stated precisely: the two graders
                    // now agree on the DATASET arm (this line and
                    // `controllable_subset`'s `d.owner_id = $2 AND <member>` are the
                    // same predicate). They still diverge on the PROJECT arm, where
                    // this function grants `Control` on `EffectivePermission::Owner` —
                    // which `account_role_floor` also produces for an account `owner`
                    // who did NOT create the project — while `controllable_subset`
                    // requires `p.owner_id = $2`. That divergence is PRE-EXISTING on
                    // main, is not introduced or fixed here, and closing it would be a
                    // widening; it is reported separately.
                    if repo.is_current_owner(dataset_id, user_id).await? {
                        Ok(JobReach::Control)
                    } else {
                        Ok(JobReach::See)
                    }
                }
                DatasetAccess::ViewOnly | DatasetAccess::NotVisible => Ok(JobReach::None),
            }
        }
        Some(JobScope::Project(project_id)) => {
            let repo = ProjectRepository::new(pool.clone());
            Ok(
                match repo.effective_permission(project_id, user_id).await? {
                    Some(EffectivePermission::Owner) => JobReach::Control,
                    Some(EffectivePermission::Editor) => JobReach::See,
                    Some(EffectivePermission::Viewer) | None => JobReach::None,
                },
            )
        }
        None => Ok(JobReach::None),
    }
}

/// Does the job's CREATOR still have any standing on the job's scope? The conjunct
/// #167 adds to the creator short-circuit, and the whole judgment of that fix.
///
/// ## What this is, stated without spin
///
/// This IS the predicate #167 calls "the obvious fix", and #167 objects to it:
///
/// > The obvious fix — gate the creator short-circuit on the job's scope still being
/// > visible to them — removes legitimate access in an unrelated case: a user who
/// > legitimately ran a job on someone else's dataset through an `edit` share would
/// > lose their own job the day that share is revoked.
///
/// That consequence is real and is NOT designed away here: revoke an `edit` sharee's
/// share and they lose `Control` of the run they started on that dataset. It is
/// shipped anyway, for two reasons that are worth stating rather than burying.
///
/// **First, every alternative in the issue is worse or out of reach.** Option (a) —
/// "gate the creator arm on the scope's account membership" — strands that same
/// sharee IMMEDIATELY rather than on revocation, because she is not a member of that
/// account and never was; standing is strictly more permissive than the option the
/// issue proposes. Option (b) (give `jobs` an `account_id`) is a migration plus a
/// stamping change on every creation path, and option (c) (reap a leaver's jobs) is
/// an offboarding-flow change — both are owner decisions, and neither is needed to
/// close the hole.
///
/// **Second, a revoked share is itself a deliberate revocation.** The dataset's owner
/// saying "you no longer have business with this dataset" and the run in question
/// having been performed ON that dataset are not independent facts. Whether that
/// should also end the sharee's authority over their own run is exactly the question
/// #172 leaves open, and it is the owner's to answer — recorded, not resolved.
///
/// ## The predicate
///
/// Standing is `DatasetAccess != NotVisible` (membership ∪ ANY share) for a dataset
/// scope and `effective_permission().is_some()` (membership-floor ∪ accepted share ∪
/// membership-gated ownership) for a project scope. A removed member has neither, so
/// they fail it; an edit-sharee, a bare account member, a personal-account owner and
/// a removed member whose SHARE survives (#172) all pass it.
///
/// The test that would go RED if this stranded the sharee is
/// `an_edit_sharee_keeps_control_of_the_job_they_started` in
/// `tests/account/removal_revokes_test.rs`, which asserts her `Control` directly.
/// NOT `the_batched_stop_grader_and_the_per_job_gate_agree`, which an earlier draft of
/// this comment cited: that test asserts the two graders AGREE and that some principal
/// is admitted and some refused. Strand `eddie` and both graders move together, so it
/// stays green — its greenness is evidence about drift between the graders, and none at
/// all about over-tightening. Citing it was the same kind of unchecked claim this
/// module's history is full of, so the citation is corrected rather than dropped.
///
/// It is deliberately *visibility*, not *edit*: a bare account `member` who created a
/// job on a co-member's dataset reaches only `ViewOnly` there, and taking their own
/// run away from them would be an over-tightening one rung down.
///
/// ## Known residue (not closed here)
///
/// `job_scope` is existence-aware, so a job whose dataset/project is later DELETED
/// becomes scope-less and its creator's `Control` returns. The ex-member cannot trigger
/// it — and neither, in fact, can an ordinary remaining member: `DatasetRepository::
/// delete` requires `owner_id = $2 AND <member>`, and the departed member is still the
/// row's `owner_id`, so the reachable routes are the platform-admin delete and an
/// account teardown. Narrow, then; but the closure is non-monotonic and that is worth
/// stating rather than rounding to "closed". A read-side predicate cannot fix it: an
/// orphaned scope carries no account, so refusing it would equally strip a CURRENT
/// member's own job after an ordinary cleanup. Closing it needs option (b). Pinned by
/// `a_deleted_scope_returns_the_removed_creators_reach` so it is visible.
///
/// ## Scope-less jobs
///
/// `None` ⇒ `true`, unchanged. A scope-less job (no `job_scope` row, or one whose
/// target has since been deleted — [`JobRepository::job_scope`] is existence-aware)
/// has no second principal and no account to require membership of, so it stays
/// creator-and-admin-only. That is #167 option (a) as filed, and the residue it
/// leaves is recorded (DEC-3) and asserted rather than left silent.
async fn creator_retains_standing(
    pool: &PgPool,
    scope: &Option<JobScope>,
    user_id: Uuid,
    group_ids: &[Uuid],
) -> Result<bool, AppError> {
    match scope {
        None => Ok(true),
        Some(JobScope::Dataset(dataset_id)) => {
            let repo = DatasetRepository::new(pool.clone());
            Ok(repo.access(*dataset_id, user_id, group_ids).await? != DatasetAccess::NotVisible)
        }
        Some(JobScope::Project(project_id)) => {
            let repo = ProjectRepository::new(pool.clone());
            Ok(repo.effective_permission(*project_id, user_id).await?.is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ordering is what `can_see`/`can_control` are built on, and it is the one
    /// place a widening could hide: if `See` ever sorted at or above `Control`, every
    /// `stop` gate in the module would silently open to third-party editors.
    #[test]
    fn control_implies_see_and_see_does_not_imply_control() {
        assert!(JobReach::Control > JobReach::See);
        assert!(JobReach::See > JobReach::None);

        assert!(JobReach::Control.can_see() && JobReach::Control.can_control());
        assert!(JobReach::See.can_see() && !JobReach::See.can_control());
        assert!(!JobReach::None.can_see() && !JobReach::None.can_control());
    }
}
