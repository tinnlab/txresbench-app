//! Who may reach a FILE — cytoanalyst's answer, and the seam it is injected
//! through.
//!
//! ## Why this module exists
//!
//! `ziee-file` is a generic blob store. Its own scope is `files.user_id`, the
//! UPLOADING actor (`ingest_bytes(&…, auth.user.id, …)`), and `files` carries no
//! `account_id` (DEC-7). In cytoanalyst a file is reached through the DATASET it
//! is linked to, and a dataset belongs to an ACCOUNT — so `files.user_id` records
//! provenance and says nothing about entitlement. The two come apart the moment a
//! member is removed from an organization: the `account_members` row goes, and
//! `files.user_id` still names them, forever.
//!
//! That gap was #170 on the sandbox byte-staging path, and it was the SAME gap,
//! wider, on `ziee-file`'s own mounted HTTP surface — which authorized
//! `GET /files`, `/download`, `/raw`, every version route, the download-token
//! mint and `DELETE` on nothing but `files.user_id`. #170's comment named that
//! surface and recorded that it could not be fixed there because `sdk` was a
//! pinned submodule. This module is that fix's other half: the SDK grew an
//! injected [`ziee_file::seams::FileAccessPolicy`], and
//! [`DatasetFileAccessPolicy`] is cytoanalyst's implementation of it.
//!
//! ## One predicate, two callers
//!
//! [`readable_file_ids`] holds the ONE SQL literal that answers "may this
//! principal read these files". Both callers go through it:
//!
//! - `sandbox::inputs::file_readable_by` — the sandbox byte-staging gate (#170),
//!   now a thin single-id adapter;
//! - [`DatasetFileAccessPolicy`] — the seam the mounted `file_routes` consult.
//!
//! This is deliberate and load-bearing. The predicate has already been the site
//! of a divergence bug: the group-share disjunct was missing `groups.is_active`
//! in one hand-copy and not another, which `841e6111` fixed as the SIXTH such
//! copy. `the_seam_and_file_readable_by_never_disagree` asserts the two callers
//! above can never answer differently.
//!
//! ## What that claim does NOT cover — read this before trusting it
//!
//! "One predicate" is true of the FILE question and only of it. The
//! dataset-visibility union inside the literal below is still a hand-copy shared
//! with `DatasetRepository::is_visible_to` and `workstore::authz::require_dataset_read`;
//! promoting the predicate here MOVED the sandbox/HTTP copy, it did not collapse
//! it into those. That is the direction the divergence has actually bitten, so it
//! is pinned separately by `the_dataset_branch_agrees_with_the_dataset_read_gate`,
//! which compares this predicate against an INDEPENDENT spelling of the same
//! union across a principal matrix. The sibling test above cannot catch it: since
//! the promotion, both sides of ITS assertion call this function.
//!
//! The two callers also COMPOSE this predicate differently, which is a real
//! behavioural difference and not an oversight: the HTTP surface conjoins it with
//! the store's `files.user_id` scope, the sandbox does not. So a co-member with
//! dataset standing is refused another member's file over HTTP while being able
//! to stage the same bytes for analysis — the pre-existing sandbox contract.

use std::collections::HashSet;

use async_trait::async_trait;
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_core::AppError;
use ziee_file::seams::{FileAccess, FileAccessPolicy};

/// The subset of `candidates` that `user_id` may read, PRESERVING the given
/// order.
///
/// This is cytoanalyst's single authority on file readability. `sandbox::inputs::
/// file_readable_by` is a one-element adapter over it, and
/// [`DatasetFileAccessPolicy`] is the HTTP surface's route into it.
///
/// Ordering is restored in Rust rather than in SQL: `= ANY($2)` returns rows in
/// whatever order the planner likes, and the seam's contract is that the caller's
/// candidate order survives (the store hands over ids already sorted
/// `created_at DESC` and pages the result).
pub async fn readable_file_ids(
    pool: &SqlitePool,
    user_id: Uuid,
    candidates: &[Uuid],
) -> Result<Vec<Uuid>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let candidates_json = uuid_list_json(candidates);
    let rows: Vec<Uuid> = sqlx::query_scalar!(
        // A3 (ITEM-6/DEC-15): the dataset branch inlines dataset-visibility (a
        // hand-copy of `require_dataset_read`), so it gains the SAME account-membership
        // union to stay in lock-step — a co-member's sandbox may read a dataset file in
        // the shared account. The cross-account DENY is unchanged (a non-member with no
        // owner/share/membership is still rejected). Behaviour-preserving for personal
        // accounts.
        //
        // H-1 (#147, disposition (c)): the spike's list does not name this predicate,
        // and it decides whether a sandbox may STAGE THE BYTES of a dataset file. Its
        // DATASET branch drops the standalone `d.owner_id = $2` disjunct, in lock-step
        // with `require_dataset_read` (of which this is a hand-copy) and
        // `is_visible_to`: conjoined with current membership it is a strict subset of
        // the role-agnostic membership union that follows.
        //
        // #170 — the FILE-OWNER branch, closed. This is the byte-staging gate: the one
        // hole in the #167/#168/#170 family that leaks CONTENT rather than metadata.
        //
        // `files.user_id` is stamped with the UPLOADING ACTOR (`ingest_bytes(&…,
        // auth.user.id, …)`) and `files` carries no `account_id` (DEC-7), so #147's
        // transform — conjoin the owner branch with membership of the row's account —
        // has no account to name and the branch was left standing. A member removed
        // from an organization could therefore still have a sandbox read the raw bytes
        // of any file THEY had uploaded into that organization's datasets, by naming it
        // from a scope-less analysis job (the job routes gate only when a
        // `project_id`/`dataset_id` is supplied). The dataset itself 404'd for them;
        // the bytes did not.
        //
        // The fix realizes issue option (c)'s GOAL — dataset membership is the sole
        // authority for a dataset-linked file — on the READ side rather than by
        // re-stamping at link time, so it needs no migration. The file-owner branch
        // survives only for a file in NO dataset, which is the legitimate case the
        // issue says the obvious patch breaks ("a user's own uploaded file, in no
        // dataset at all, would stop being readable by their own sandbox"), and it is
        // preserved exactly.
        //
        // SCOPE OF THE CLAIM, stated narrowly on purpose. "The dataset branch is the
        // sole authority" is true OF THIS PREDICATE, not of the system.
        //
        // SUPERSEDED (this branch, and the reason this predicate moved here): the text
        // that stood here said `ziee-file`'s own HTTP surface still authorized
        // `GET /files/{id}/download`, list and DELETE on a bare `files.user_id = $n`,
        // and that it could not be fixed because `sdk` was a pinned submodule. **That
        // is no longer true and must not be read as current.** The pin was moved, the
        // SDK grew an injected `FileAccessPolicy`, and `DatasetFileAccessPolicy` below
        // routes that surface through THIS predicate. The old paragraph is recorded as
        // superseded rather than silently deleted, because it was load-bearing guidance
        // and a reader who remembers it needs to know it was closed, not merely dropped.
        //
        // What remains true of the system: this predicate is not the only way file bytes
        // are reached. `provenance::export::bundle` reaches them through the unscoped
        // `FileRepository::get_by_id` — but it is NOT an ungated path, and an earlier
        // version of this comment read more alarming than the code deserved.
        // `graph::load_project_walk_context` re-evaluates
        // `DatasetRepository::is_visible_to(dataset, caller, groups)` for EVERY dataset
        // it folds in, per request, and skips the ones that fail; the byte-staging
        // branch can only reach file ids that came off a dataset node that survived
        // that filter. A dataset the caller cannot see is skipped and its bytes come
        // out as a HOLE plus a `fetch.txt` line, not as content. For a dataset-linked
        // file that per-dataset check is the same disjunction as this predicate's
        // dataset branch, so the export is if anything NARROWER than this function:
        // it can exercise neither the any-linked-dataset reach nor the loose-file
        // uploader branch. And the two callers of THIS predicate compose it
        // differently — the HTTP surface conjoins it with the store's `files.user_id`
        // scope, the sandbox does not — so a co-member with dataset standing is refused
        // another member's file over HTTP while being able to stage the same bytes for
        // analysis. That asymmetry is the pre-existing sandbox contract (a shared
        // dataset's files are analysable by those the dataset is shared with), not
        // something this branch introduced; it is written down here so the next reader
        // does not mistake the HTTP conjunct for a system-wide boundary.
        //
        // NO legitimate access is lost through the linked case either: a file in the
        // uploader's own PERSONAL-account dataset is admitted by the dataset branch (a
        // personal account's sole member IS the owner), and so is a file in an org
        // dataset whose account they are still a member of, or which they still reach
        // through a surviving share.
        //
        // RESIDUE SCOPE UPDATE (this branch): the paragraph below was written when this
        // predicate governed only sandbox byte-staging. It is now ALSO the authorization
        // for `ziee-file`'s mounted HTTP surface, so the same cascade re-grants a removed
        // member `GET /api/files`, `/download`, `/raw` and `DELETE` — not merely the
        // ability to stage bytes into a sandbox. Same residue, materially wider blast
        // radius. The fix is unchanged and still write-side (`files.account_id`).
        //
        // KNOWN RESIDUE: `dataset_files.dataset_id` is ON DELETE CASCADE and deleting a
        // dataset removes its links but not the `files` rows, so a file returns to
        // "loose" and this branch admits its uploader again. The ex-member cannot trigger
        // it — and neither can an ordinary remaining member, since `delete` requires
        // `owner_id = $2 AND <member>` and the departed member is still the row's owner;
        // the reachable routes are the platform-admin delete and an account teardown.
        // Narrow, then, but the closure is non-monotonic. A read-side predicate cannot fix
        // it — after the cascade there is no surviving signal that the file was ever in
        // an org dataset — so closing it needs the WRITE-side change (`files.account_id`
        // at ingest, or a re-stamp on link), i.e. a migration and an owner decision.
        // Pinned by `a_deleted_dataset_returns_the_removed_uploaders_bytes`.
        //
        // The ONE behaviour that changes beyond the hole: someone who uploaded into
        // SOMEONE ELSE's dataset through an `edit` share, and whose share was later
        // REVOKED, loses sandbox read on that file. That is accepted because it is not
        // SEPARABLE from the hole — a removed member and a revoked sharee are the same
        // database state here (no membership, no share, a `dataset_files` link,
        // `files.user_id` = them), and telling them apart would need standing recorded
        // at upload time, which no column carries.
        //
        // ADJACENT DEFECT, fixed here because it lives in this same literal: the
        // group-share disjunct resolved groups through `user_groups` ALONE, without the
        // `groups.is_active` filter that this predicate's documented lock-step twin
        // `workstore::authz::require_dataset_read` carries. A member of a DISABLED group
        // therefore kept staging this dataset's bytes into a sandbox after every other
        // gate had revoked them. It is the same defect `799d0cf3` collapsed five
        // hand-copies of, and this was a sixth — on the one surface that carries actual
        // file CONTENT. Strictly tightening, with no legitimate loser: `access`,
        // `is_visible_to`, `editable_subset`, `sharee_user_ids` and
        // `require_dataset_read` all already refuse a disabled group's member.
        //
        // BATCH FORM. The literal below is the #170 predicate unchanged except that
        // it selects the MATCHING IDS over a candidate set (`f.id IN (SELECT unhex(j.value)
        // FROM json_each($1) AS j)` — the ITEM-23 JSON1 membership port of PG's
        // `f.id = ANY($1)`, the DEC-8 `uuid[]` → JSON-array-text rule bound in the
        // 32-hex `Uuid::simple()` form; a hyphenated list never matches, the
        // ITEM-15/21 convention) instead of `EXISTS` over one id. The disjunction —
        // the loose-file branch and the dataset branch — is byte-for-byte the decision
        // #170 settled on. It is a set operation because the file LIST route has to
        // filter before it pages and counts, and doing that one `EXISTS` at a time
        // would be a query per row.
        r#"SELECT f.id as "id: Uuid" FROM files f WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j) AND (
               (f.user_id = $2
                AND NOT EXISTS (SELECT 1 FROM dataset_files dfx WHERE dfx.file_id = f.id))
               OR EXISTS (
                 SELECT 1 FROM dataset_files df
                 JOIN datasets d ON d.id = df.dataset_id
                 WHERE df.file_id = f.id AND (
                   d.account_id IN (SELECT am.account_id FROM account_members am
                                     WHERE am.user_id = $2)
                   OR EXISTS (
                     SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id AND (
                          (ds.principal_type = 'user'  AND ds.principal_id = $2)
                       OR (ds.principal_type = 'group' AND ds.principal_id IN (
                             SELECT ug.group_id FROM user_groups ug
                               JOIN groups g ON g.id = ug.group_id AND g.is_active
                              WHERE ug.user_id = $2)) ) ) )
               )
             )"#,
        candidates_json,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let allowed: HashSet<Uuid> = rows.into_iter().collect();
    Ok(candidates
        .iter()
        .copied()
        .filter(|id| allowed.contains(id))
        .collect())
}

/// The subset of `candidates` that `user_id` may **WRITE** — restore a version of,
/// or DELETE — preserving the given order.
///
/// # Why this is a second predicate and not a flag on the first
///
/// A view grant must never destroy data. `readable_file_ids` admits anyone the
/// dataset is VISIBLE to, which includes a bare account member and a `view`-role
/// sharee; letting that set delete would turn a read grant into a data-destruction
/// grant. The owner ruled explicitly that DELETE requires EDIT standing, so the
/// write question needs its own answer.
///
/// # The dataset branch is the `can_edit` union, not a new spelling of it
///
/// The disjunction below is lifted from `DatasetRepository::access`'s `can_edit!`
/// arm — the established answer to "may this principal edit this dataset", already
/// hand-copied once into `editable_subset` and pinned to its original by
/// `editable_subset_matches_access`. This is a third copy, and it is held to the
/// same standard: `the_write_branch_agrees_with_require_can_edit` asserts it
/// against `DatasetRepository::access` across a role matrix, so it cannot drift.
/// Its three disjuncts, unchanged in meaning:
///
/// - the dataset's creator, **conjoined with current membership** (#147 (c) —
///   creator-ownership no longer bypasses removal);
/// - an account `admin`/`owner` (a bare `member` gets read-only — the safe
///   direction, and the reason a `member` who did NOT create the dataset cannot
///   delete its files);
/// - an `edit`-role share (`view` shares are excluded — the whole point).
///
/// # The loose-file branch is unchanged, and must be
///
/// A file linked to NO dataset stays writable by its uploader. Removing that would
/// mean a user could never delete their own unlinked upload, which is the
/// legitimate case #170 records the obvious patch as breaking (INV-3). It is the
/// same disjunct `readable_file_ids` carries, for the same reason.
///
/// # Strictly narrower than read
///
/// Every `can_edit` disjunct implies its `visible` counterpart, so
/// `writable_file_ids ⊆ readable_file_ids` by construction: this can only ever
/// refuse someone `readable_file_ids` would have admitted, never admit someone it
/// would have refused. Asserted by `write_standing_is_a_subset_of_read_standing`.
pub async fn writable_file_ids(
    pool: &SqlitePool,
    user_id: Uuid,
    candidates: &[Uuid],
) -> Result<Vec<Uuid>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let candidates_json = uuid_list_json(candidates);
    let rows: Vec<Uuid> = sqlx::query_scalar!(
        // Group membership is resolved INLINE with `groups.is_active`, exactly as in
        // `readable_file_ids`. `DatasetRepository::access` takes pre-resolved
        // `group_ids` instead and relies on its callers to have filtered inactive
        // groups; resolving here keeps this predicate self-contained and closes that
        // dependency, which is the same defect `841e6111` fixed as a sixth hand-copy.
        // The `f.id` candidate set is the same JSON1 membership form as
        // `readable_file_ids` above (ITEM-23).
        r#"SELECT f.id as "id: Uuid" FROM files f WHERE f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j) AND (
               (f.user_id = $2
                AND NOT EXISTS (SELECT 1 FROM dataset_files dfx WHERE dfx.file_id = f.id))
               OR EXISTS (
                 SELECT 1 FROM dataset_files df
                 JOIN datasets d ON d.id = df.dataset_id
                 WHERE df.file_id = f.id AND (
                   (d.owner_id = $2
                    AND d.account_id IN (SELECT am.account_id FROM account_members am
                                          WHERE am.user_id = $2))
                   OR d.account_id IN (SELECT am.account_id FROM account_members am
                                        WHERE am.user_id = $2 AND am.role IN ('admin','owner'))
                   OR EXISTS (
                     SELECT 1 FROM dataset_shares ds WHERE ds.dataset_id = d.id
                       AND ds.role = 'edit'
                       AND ( (ds.principal_type = 'user'  AND ds.principal_id = $2)
                          OR (ds.principal_type = 'group' AND ds.principal_id IN (
                                SELECT ug.group_id FROM user_groups ug
                                  JOIN groups g ON g.id = ug.group_id AND g.is_active
                                 WHERE ug.user_id = $2)) ) ) )
               )
             )"#,
        candidates_json,
        user_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let allowed: HashSet<Uuid> = rows.into_iter().collect();
    Ok(candidates
        .iter()
        .copied()
        .filter(|id| allowed.contains(id))
        .collect())
}

/// CytoAnalyst's [`FileAccessPolicy`]: reads resolve through [`readable_file_ids`],
/// writes through [`writable_file_ids`].
///
/// # Read standing and write standing are different questions
///
/// [`FileAccess`] distinguishes metadata / content / write / delete, and this impl
/// answers them with TWO predicates, not one:
///
/// - [`FileAccess::ReadMetadata`] and [`FileAccess::ReadContent`] →
///   [`readable_file_ids`] (dataset VISIBLE to the principal);
/// - [`FileAccess::Write`] and [`FileAccess::Delete`] → [`writable_file_ids`]
///   (dataset EDITABLE by the principal).
///
/// The split exists because a view grant must never destroy data. An earlier cut of
/// this policy answered all four with the read predicate, which closed the removed-
/// member hole but left a `view`-role sharee able to DELETE files they had uploaded
/// into someone else's dataset — a read grant that destroys data. The owner ruled
/// that DELETE requires edit standing; this is that ruling.
///
/// `Write` (restore) is gated the same way as `Delete`, deliberately: restore moves
/// the file's head, so a `view` grant could otherwise rewrite what every other
/// reader sees. The prior versions survive, but the visible state does not, and
/// "may look at it" should not carry that.
///
/// Because `writable_file_ids` is a strict subset of `readable_file_ids`, this can
/// only narrow: no principal gains anything from the split.
///
/// # The gap this does NOT close — where the next reader should look
///
/// `AccountRepository::remove_member` deletes ONLY the `account_members` row; it
/// touches neither `dataset_shares` nor `project_shares`. So a member "removed"
/// from an organization who still holds a surviving share keeps whatever that share
/// grants: a `view` share still reaches every read surface here, and — now that
/// DELETE is gated on edit — a surviving **`edit`** share still carries a delete
/// path. Revocation is only as complete as the offboarding flow that performs it,
/// and this predicate cannot see a share that should have been deleted.
///
/// That is #172's territory. It was deliberately left out of the change that added
/// this split (the owner scoped it out), and it is written here rather than in a
/// tracker alone because it is now load-bearing for file BYTES, not merely for
/// metadata: the surviving-share path is the remaining way a removed member reaches
/// content through these routes.
pub struct DatasetFileAccessPolicy {
    pool: SqlitePool,
}

impl DatasetFileAccessPolicy {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The predicate for `access` — the ONE place the read/write split is decided,
    /// so `can_access` and `filter` cannot disagree about which question they are
    /// asking.
    ///
    /// Spelled as an exhaustive match rather than a wildcard: [`FileAccess`] is
    /// `#[non_exhaustive]`, so a variant the SDK adds later cannot be made a compile
    /// error here — but it CAN be made a denial. A wildcard would silently grant a
    /// future kind (publish? share?) whatever the read predicate answers, which is
    /// the fail-OPEN shape this whole module exists to remove.
    async fn resolve(
        &self,
        principal: Uuid,
        candidates: &[Uuid],
        access: FileAccess,
    ) -> Result<Vec<Uuid>, AppError> {
        match access {
            FileAccess::ReadMetadata | FileAccess::ReadContent => {
                readable_file_ids(&self.pool, principal, candidates).await
            }
            FileAccess::Write | FileAccess::Delete => {
                writable_file_ids(&self.pool, principal, candidates).await
            }
            _ => Ok(Vec::new()),
        }
    }
}

#[async_trait]
impl FileAccessPolicy for DatasetFileAccessPolicy {
    async fn can_access(
        &self,
        principal: Uuid,
        file_id: Uuid,
        access: FileAccess,
    ) -> Result<bool, AppError> {
        Ok(!self.resolve(principal, &[file_id], access).await?.is_empty())
    }

    async fn filter(
        &self,
        principal: Uuid,
        candidates: &[Uuid],
        access: FileAccess,
    ) -> Result<Vec<Uuid>, AppError> {
        self.resolve(principal, candidates, access).await
    }
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicate consumes: a JSON array of 32-char lowercase hex strings (the
/// `uuid::Uuid::simple()` form), compared against a 16-byte BLOB column
/// through `unhex()` — `f.id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`.
/// This is the ITEM-15 `ziee-file` convention (its `uuid_list_json`), kept
/// local here because the app's modules are single-driver (DEC-1) and beside
/// the `= ANY($1)` predicate this module serves no other surface. The caller's
/// order is restored in Rust (the `IN` returns rows in whatever order the
/// planner likes), so only the SET membership matters.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}
