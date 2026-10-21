//! **The read half of the conformance gate** (ITEM-18 / DEC-12).
//!
//! `jobs::conformance` writes `artifacts.status = 'failed'` when an artifact's BYTES
//! disagree with its producer-declared `structure`. That write was wired and nothing
//! read it: every serve, stage and promote path loaded the row with
//! `CatalogRepository::get` and used it, so DEC-12's accepted cost — "a non-conforming
//! artifact is briefly live before the job flags it" — described a window that never
//! closed. The flag was set; nothing acted on it.
//!
//! This module is what acts on it.
//!
//! ## The rule, per surface
//!
//! A `failed` artifact is one whose bytes lie about how to decode them. Two different
//! parties ask about it and they need opposite answers:
//!
//! * **The OWNER must be able to SEE it.** Otherwise the flag produces an artifact that
//!   cannot be found, cannot be inspected, and — worst — cannot be DELETED (delete
//!   resolves the row by id, so hiding the row strands its blob forever). So the catalog
//!   LISTING keeps it, `GET /artifacts/{id}` answers `200`, and `status` travels on the
//!   wire on both `Artifact` and `ListedArtifact`.
//!
//!   **The wire is as far as it goes today, and that is a real gap, not a completed
//!   surface.** Nothing under `ui/src` reads an artifact's `status`, and
//!   [`ERR_NOT_CONFORMING`] has no frontend reference at all: a condemned artifact is
//!   listed and labelled exactly like a `ready` one, so the only place a user currently
//!   MEETS the condemnation is the 409 on a byte route, whose message (see
//!   [`not_conforming`]) is then the whole explanation. That message is written to stand
//!   alone for precisely this reason. Making the listing show the condemnation is the
//!   frontend half of ITEM-18 and it is NOT done — do not read this bullet as a claim that
//!   it is. The server half below is what is actually enforced.
//! * **A CONSUMER must never touch it.** Serving the bytes to a decoder that will apply
//!   the very `structure` the gate just disproved, staging them into a job, or promoting
//!   them into a Dataset (which carries no status column at all, so promotion launders
//!   the condemnation permanently) each produce a plausible-looking wrong answer. That is
//!   the silent-wrong failure this whole branch exists to remove.
//!
//! ## Why a TYPE and not a `status == "ready"` at each call site
//!
//! A predicate repeated at N call sites has the same shape as the bug it fixes: the N+1th
//! author writes the load and forgets the check, and nothing tells them. So consumption is
//! expressed as a type. [`ConsumableArtifact`] has no public constructor other than
//! [`ConsumableArtifact::try_new`], which refuses a non-`ready` row; every byte-serving,
//! job-staging and promote path takes one. "Consume this artifact" and "check its status"
//! are therefore the same expression, and a new consumer that forgets the check does not
//! compile — it has an `Artifact` where a `ConsumableArtifact` is required.
//!
//! ## One status code, one error code
//!
//! Every refusal is **409 `ARTIFACT_NOT_CONFORMING`**, deliberately uniform.
//!
//! * **Not 404.** The catalog listing just showed this artifact and `GET /artifacts/{id}`
//!   answers `200` for it. Denying its existence on the byte route would make the API
//!   contradict itself, and would tell a user whose chart went blank nothing about why.
//! * **409, not 422.** The request is well-formed and so is the resource's declaration;
//!   what refuses it is the resource's *current state* — it was `ready` when the run
//!   finished and the gate condemned it afterwards. That is exactly `409 Conflict`.
//! * **The same code everywhere.** A client that learns one code recognises the condition
//!   on every surface. Per-surface codes for one condition are how the next drift starts.
//!
//! ## Ordering: authorize first, then refuse
//!
//! Callers run their authorization gate BEFORE constructing a `ConsumableArtifact`. A
//! principal who may not read the artifact must get the scope's own `404`, never a `409` —
//! a `409` confirms the row exists, so checking conformance first would turn this into a
//! cross-tenant existence oracle.

use std::ops::Deref;

use ziee_core::AppError;

use super::catalog::models::Artifact;

/// The only `artifacts.status` value whose bytes the server will hand out or feed to a
/// job. The other two are `pending` (ingest has not committed the row's bytes) and
/// `failed` (the conformance gate condemned them) — neither is consumable, and the check
/// is written as "is it ready" rather than "is it failed" so a status added later is
/// non-consumable until someone decides otherwise (INV-2: absence of a decision is not a
/// privilege).
pub const STATUS_READY: &str = "ready";

/// The error code a CONDEMNED artifact's refusal carries. Public so tests — and the
/// frontend — name it rather than matching on prose.
pub const ERR_NOT_CONFORMING: &str = "ARTIFACT_NOT_CONFORMING";

/// A GATHERED artifact whose alignment can no longer be resolved (ITEM-30).
///
/// **A distinct status, not a reuse of `failed`, because it is a different CLAIM.** `failed`
/// means the conformance gate condemned the bytes: the data is wrong, and the fix is to
/// delete the artifact or re-run its producer. `unresolvable` means the artifact's own
/// declaration is fine and its SOURCES are gone or changed — nothing about it is wrong, and
/// the fix is to restore the source. Collapsing the two would tell a user to delete work
/// that is intact.
///
/// Adding a fourth value is safe by construction here, and deliberately so: every read of
/// `status` in this tree is a positive `== STATUS_READY` test rather than an exhaustive
/// match, which the module docs above state is exactly so "a status added later is
/// non-consumable until someone decides otherwise". So this value is refused everywhere that
/// matters the moment it exists, before a single call site is updated.
/// **NOTHING IN THE SERVER WRITES THIS STATUS** (blind audit, finding 13).
///
/// It is read — `try_new` refuses it, the byte route answers 409 `ARTIFACT_UNRESOLVABLE`, and
/// stage 3 renders it — but the only writer is the debug seed plan (`SeedPlan.artifacts[].
/// status`, compiled out of release) and a test's raw `UPDATE`. There is no detector: nothing
/// notices that an alignment or a source went missing and moves an artifact into it.
///
/// **So the integration coverage guards the CALL and not the INSTALLATION.** Every test that
/// reaches this state puts the row there itself; a deployment never will. Recorded here
/// rather than left as an inference from green tests, because the shape — a state with
/// readers, no writer, and passing tests — reads exactly like working code.
///
/// Wiring a detector is the open work: the serve path already discovers both conditions (a
/// missing alignment and a missing source artifact, each refused by name in `gather_exec`),
/// so the detector is a write at those two points rather than a new mechanism.
pub const STATUS_UNRESOLVABLE: &str = "unresolvable";

/// The error code an UNRESOLVABLE artifact's refusal carries.
///
/// Separate from [`ERR_NOT_CONFORMING`] so a client can tell "your data is wrong" from "the
/// data this was built from is missing" WITHOUT parsing prose. Stage 3's surface renders
/// them differently — one offers delete/re-run, the other names the missing source and
/// offers to restore it — and a shared code would force that decision back onto message
/// matching.
pub const ERR_UNRESOLVABLE: &str = "ARTIFACT_UNRESOLVABLE";

/// An artifact the server is willing to serve, stage, or promote.
///
/// Constructible ONLY through [`ConsumableArtifact::try_new`]. See the module docs for
/// why this is a type and not a predicate.
///
/// `Deref<Target = Artifact>` so a holder reads the row's fields normally; the guarantee
/// is on CONSTRUCTION, which is the step a call site cannot skip.
///
/// The one way back out to an owned [`Artifact`] is [`ConsumableArtifact::into_inner`],
/// which is narrower than it looks: the check has already run by then, so handing the row
/// on cannot skip it. Its sibling `as_artifact` WAS deleted (`e8026318`, "`Deref` already
/// does it") and [`not_conforming`] was made private, both for having no caller — see
/// `into_inner`'s own doc for the caller that keeps it.
#[derive(Debug, Clone)]
pub struct ConsumableArtifact(Artifact);

impl ConsumableArtifact {
    /// Admit `artifact` for consumption, or refuse it with a 409.
    ///
    /// Call this AFTER the surface's authorization gate — see the module docs on ordering.
    pub fn try_new(artifact: Artifact) -> Result<Self, AppError> {
        if artifact.status == STATUS_READY {
            return Ok(Self(artifact));
        }
        if artifact.status == STATUS_UNRESOLVABLE {
            return Err(unresolvable(&artifact));
        }
        Err(not_conforming(&artifact))
    }

    /// Consume the wrapper and yield the row.
    ///
    /// **Kept because it has a production caller**, unlike the two siblings that were
    /// removed for lacking one (`e8026318` deleted `as_artifact` — "`Deref` already does
    /// it" — and [`not_conforming`] was made private). `dataset::routes`' promote handler
    /// calls it: promote hands the row on to code that owns it, so a borrow through
    /// [`Deref`] does not serve. A dead-code sweep that gets as far as this line should
    /// check `dataset/routes.rs` before concluding otherwise — that call is the reason the
    /// method is here, and `promote_refuses_a_condemned_artifact` covers the path.
    pub fn into_inner(self) -> Artifact {
        self.0
    }
}

impl Deref for ConsumableArtifact {
    type Target = Artifact;
    fn deref(&self) -> &Artifact {
        &self.0
    }
}

/// The refusal, written once — the only reason it is a function of its own. It is
/// PRIVATE: [`ConsumableArtifact::try_new`] is the sole route to it, and that is the
/// point of the type. A second caller reaching past the constructor to answer 409 on its
/// own judgement of readiness is the per-call-site predicate this module exists to
/// replace, so it does not get a public entry point to do it through.
///
/// (It was `pub`, justified by "a caller that has already established non-readiness by
/// another route". No such caller was ever written. `e8026318` deleted the sibling
/// `as_artifact` for the same reason and left this one, so the visibility now matches
/// what actually calls it.)
///
/// The message names the artifact, its status, and the remedy: a user who meets this
/// needs to know it is the DATA that is wrong (the producing run itself succeeded), and
/// that the row is theirs to delete or re-produce.
fn not_conforming(artifact: &Artifact) -> AppError {
    AppError::new(
        axum::http::StatusCode::CONFLICT,
        ERR_NOT_CONFORMING,
        format!(
            "artifact {} is status='{}', so its bytes are not served or consumed: the \
             post-ingest conformance gate found them to disagree with the `structure` \
             their producer declared. The producing run itself succeeded — it is the data \
             that is wrong. The row stays listed (and its metadata readable) so you can \
             inspect it; delete it, or re-run its producer, to clear the condemnation.",
            artifact.id, artifact.status,
        ),
    )
}

/// The refusal for a gathered artifact whose sources cannot be resolved (ITEM-30).
///
/// **Names the missing source.** INV-9 requires invalidation to be loud and to say WHAT is
/// missing — "never render short or empty" — and an error that says only "unreadable" sends
/// the user looking through every dataset they own. The name comes from `meta.unresolved_source`,
/// written when the invalidation is detected; if it is absent the message says so rather than
/// inventing a plausible id.
fn unresolvable(artifact: &Artifact) -> AppError {
    let missing = artifact
        .meta
        .get("unresolved_source")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("(the invalidation did not record which source)");
    AppError::new(
        axum::http::StatusCode::CONFLICT,
        ERR_UNRESOLVABLE,
        format!(
            "artifact {} is status='{}': it is GATHERED, and the alignment it reads through \
             can no longer be resolved — missing or changed source: {missing}. Its own \
             declaration is intact and nothing about it is wrong, so deleting it is not the \
             fix; restore or re-attach that source. The row stays listed so you can see what \
             it needs.",
            artifact.id, artifact.status,
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use uuid::Uuid;

    fn row(status: &str) -> Artifact {
        Artifact {
            id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "expression".into(),
            datatype: "single-cell/expression".into(),
            object_key: Some("sha256:aa".into()),
            is_multifile: false,
            content_hash: "sha256:aa".into(),
            structure: serde_json::json!({ "encoding": "zarr_v3" }),
            meta: serde_json::json!({}),
            role: "artifact".into(),
            status: status.into(),
            stored_bytes: 1,
            logical_bytes: Some(1),
            created_by: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            hidden: false,
            representation_of: None,
        }
    }

    // POSITIVE LEG: the ordinary artifact is admitted, and reads through the wrapper.
    // Without this the refusal assertions below would pass on a constructor that refused
    // everything, which is a different bug wearing the same green.
    #[test]
    fn a_ready_artifact_is_consumable_and_derefs_to_its_row() {
        let a = row(STATUS_READY);
        let id = a.id;
        let c = ConsumableArtifact::try_new(a).expect("a ready artifact is consumable");
        assert_eq!(c.id, id, "Deref reaches the row's fields");
        assert_eq!(
            c.status, STATUS_READY,
            "…including the one that admitted it"
        );
        // `into_inner` is exercised because `dataset::routes`' promote handler calls it,
        // not as a stand-in for a caller that does not exist.
        assert_eq!(c.into_inner().id, id, "into_inner yields the owned row");
    }

    // NEGATIVE LEG: the status the conformance gate writes.
    #[test]
    fn a_failed_artifact_is_refused_with_409_not_conforming() {
        let err = ConsumableArtifact::try_new(row("failed"))
            .expect_err("the gate condemned this artifact; it is not consumable");
        assert_eq!(
            err.status_code(),
            409,
            "not 404 — the row is listed and its metadata is readable, so denying its \
             existence here would make the API contradict itself"
        );
        assert_eq!(err.error_code(), ERR_NOT_CONFORMING);
    }

    // The check is "is it ready", not "is it failed": a status nobody has decided about
    // is non-consumable by default. `pending` is the live case (ingest in flight);
    // `quarantined` stands in for a value added later.
    #[test]
    fn every_non_ready_status_is_refused_not_only_failed() {
        for status in ["pending", "quarantined", "", "READY", "ready "] {
            let err = ConsumableArtifact::try_new(row(status))
                .err()
                .unwrap_or_else(|| panic!("status {status:?} must not be consumable"));
            assert_eq!(err.error_code(), ERR_NOT_CONFORMING, "status {status:?}");
            assert_eq!(err.status_code(), 409, "status {status:?}");
        }
    }

    /// ITEM-30 — `unresolvable` is a DIFFERENT refusal from `failed`, not a relabelling.
    ///
    /// The two states make opposite claims about whose fault it is and what fixes it:
    /// `failed` says the bytes are wrong (delete it, or re-run the producer), `unresolvable`
    /// says the artifact is intact and its SOURCE is gone (restore the source). A client that
    /// could not tell them apart would offer to delete work that is fine.
    ///
    /// nc: give `unresolvable` the `ERR_NOT_CONFORMING` code — i.e. treat it as just another
    /// non-ready status. Both assertions below go red, and the surface stage 3 builds on this
    /// would have no way to distinguish the two except by parsing prose.
    #[test]
    fn unresolvable_refuses_with_its_own_code_not_the_conformance_one() {
        let err = ConsumableArtifact::try_new(row(STATUS_UNRESOLVABLE))
            .err()
            .expect("an unresolvable artifact must not be consumable");
        assert_eq!(err.error_code(), ERR_UNRESOLVABLE);
        assert_ne!(
            err.error_code(),
            ERR_NOT_CONFORMING,
            "the two states must be distinguishable WITHOUT parsing prose — they recommend \
             opposite fixes"
        );
        assert_eq!(err.status_code(), 409);
    }

    /// INV-9 — the refusal NAMES the missing source, and admits it when it cannot.
    ///
    /// "Never render short or empty" applies to the error too: an artifact that says only
    /// "unreadable" sends the user through every dataset they own.
    ///
    /// nc: drop the `meta.unresolved_source` lookup and emit a generic message. The first
    /// assertion goes red. The SECOND leg is the one that stops the fix being a fabricated
    /// id: with no recorded source the message must SAY so, not invent a plausible uuid.
    #[test]
    fn the_unresolvable_refusal_names_the_missing_source() {
        let mut a = row(STATUS_UNRESOLVABLE);
        a.meta = serde_json::json!({ "unresolved_source": "dataset 9f3c-…-titled 'donor A'" });
        let err = ConsumableArtifact::try_new(a).err().unwrap();
        assert!(
            err.to_string().contains("donor A"),
            "the refusal must name what is missing: {err}"
        );

        let bare = ConsumableArtifact::try_new(row(STATUS_UNRESOLVABLE))
            .err()
            .unwrap();
        assert!(
            bare.to_string().contains("did not record"),
            "with no recorded source the message must ADMIT that rather than invent one: {bare}"
        );
    }

    /// The control that keeps the two tests above honest: `failed` is untouched.
    ///
    /// Without it, a change that routed EVERY non-ready status to the new refusal would pass
    /// both tests above while silently breaking the condemnation surface.
    #[test]
    fn failed_still_refuses_with_the_conformance_code() {
        let err = ConsumableArtifact::try_new(row("failed")).err().unwrap();
        assert_eq!(err.error_code(), ERR_NOT_CONFORMING);
        assert!(err.to_string().contains("conformance gate"));
    }

    // The refusal is written ONCE, and `try_new` is the only route to it. That is the
    // whole reason it is a separate function, so it is the thing worth pinning: the
    // constructor must ANSWER with that message rather than grow a second one beside it,
    // which is the drift a single spelling exists to prevent.
    #[test]
    fn the_constructors_refusal_is_the_one_shared_message() {
        let a = row("failed");
        let direct = not_conforming(&a);
        let via = ConsumableArtifact::try_new(a.clone())
            .expect_err("the gate condemned this artifact; it is not consumable");
        assert_eq!(via.to_string(), direct.to_string());
        assert_eq!(via.error_code(), direct.error_code());
        assert_eq!(via.status_code(), direct.status_code());
    }

    // The message has to say WHICH artifact and WHAT state — an operator meeting this in
    // a log or a toast needs to be able to act on it.
    #[test]
    fn the_refusal_names_the_artifact_and_its_status() {
        let a = row("failed");
        let id = a.id;
        let msg = not_conforming(&a).to_string();
        assert!(msg.contains(&id.to_string()), "{msg}");
        assert!(msg.contains("failed"), "{msg}");
    }
}
