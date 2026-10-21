//! The conformance gate, wired to production (artifact-model ITEM-18 / **DEC-12**).
//!
//! `_lib/conformance.py` was built and tested and invoked by NOTHING. This module is
//! what invokes it.
//!
//! ## Where it runs, and why not in ingest
//!
//! DEC-12: **a sandboxed verification job dispatched AFTER ingest**, not from the ingest
//! path itself. The shortcut — have `workstore::ingest` shell out to a byte-reading
//! checker — keeps the ITEM-20 dependency guard green (the server BINARY still parses no
//! format) while making the server's ingest DECISION depend on what the bytes MEAN. That
//! is INV-1's letter kept and its spirit bent, and this branch has already shipped one
//! guard that proved a weaker property than the invariant it was named for. The sandbox
//! is where every other byte-reading step in this system runs, so the gate runs there,
//! and the enforcement stops being a special case.
//!
//! ## What it gates
//!
//! The artifacts that LANDED. Each ingested row is bound back in as an `artifact_ref`
//! input, hardlinked straight out of the content-addressed pool to `/inputs/<artifact-id>`
//! — so what is checked is what a consumer will actually read, not a staging copy that
//! `finalize_analysis` is about to delete. The producer's `structure` declaration rides
//! along in `/inputs/params.json`, copied VERBATIM off the artifact row: the server hands
//! the gate the declaration it stored and forms no opinion of its own about either side.
//!
//! ## The drive loop, and why it is not a scheduler job
//!
//! DIVERGENCE NOTE (read before copying the rationale below). This used to be true of
//! [`super::verify`] as well; it no longer is. A provenance re-run now mints a real
//! `jobs` row (`job_type = "verify"`, born `running`, project-scoped) via
//! `JobRepository::create_running_under_cap`, so it is listed, stoppable and — the part
//! that matters here — ADMITTED UNDER `max_concurrent_jobs` like everything else.
//! Minting a row did NOT require routing through the scheduler and did not hand the run
//! to the ingest sink: the row records and accounts for a run this module still drives
//! itself. THIS gate has not had the same treatment, so the "bypasses the scheduler's
//! concurrency cap" cost stated below is now the LAST such bypass in the jobs module —
//! and it is the worse one, because it fires automatically on every artifact-producing
//! run rather than on an explicit user request. It should get the same row.
//!
//! This spawns + drives the sandbox child directly, exactly like the sibling
//! [`super::verify`] does for a provenance re-run, for the same reason: the run must
//! ingest NOTHING and record NOTHING. Routing it through the scheduler would mean a
//! `job_type` arm in `DispatchRunner`, an `is_analysis` widening in the executor, and a
//! completion seam — and would hand the verification run's own `/outputs` to the ingest
//! sink. The cost, stated rather than hidden: this bypasses the scheduler's concurrency
//! cap, and a server restart mid-verification leaves that batch unverified (its workspace
//! IS reclaimed — the boot `sweep_stale_run_dirs` removes any per-run dir, in EITHER
//! tree, whose name is not a live job id, which no CRASHED verification dir ever is).
//!
//! A workspace whose verification is still RUNNING is a different case, and having no
//! `jobs` row used to make the two indistinguishable: `is_stale_workspace` called a live
//! verification dir stale, and `JobsModule::init` runs `reconcile_orphaned_running` —
//! which finalizes a recovered run, ingests it, and fires [`dispatch_after_ingest`] — and
//! then the sweep, in the SAME task. So a boot sweep could delete the `/inputs` out from
//! under a verification it had itself just started. [`run_gate`] therefore takes a
//! [`super::scheduler::hold_live_workspace`] guard for the whole run, and the sweep asks
//! the in-process register before removing anything. The guard is per-process and
//! released on drop, so a crashed verification's dir goes back to being stale and the
//! next boot still reclaims it.
//!
//! ITEM-17 (outputs staged outside the workspace) does NOT retire that guard. What it
//! protects here is `/inputs` — the hardlinked bytes under `<ws>/inputs`, which are
//! workspace scratch and stay in the workspace. The gate's own `/outputs` verdict moved
//! to the run's staging tree, which the boot sweep reaches too; the SAME registration
//! covers it, because both dirs are named by this run's id.
//!
//! ## What marks an artifact failed
//!
//! [`apply_verdict`], from the verdict the job wrote. DEC-12 accepts the brief window in
//! which a non-conforming artifact is live; it does not accept a warning nobody reads, so
//! a violation flips `artifacts.status` to `failed` (an existing value in that column's
//! `pending|ready|failed` vocabulary) and emits the scope-aware `sync:artifact` nudge so a
//! watching client refetches rather than showing `ready` until reload.
//!
//! **A verdict and a non-verdict are different things** and are treated differently. The
//! gate RAN and found violations ⇒ `failed`. The gate could not run at all (no sandbox on
//! this host, a staging fault, a timeout, an unreadable verdict) ⇒ the rows are left
//! alone. Marking data `failed` on the strength of a crashed checker would be a false
//! statement about bytes that may be perfectly fine — the same dishonesty DEC-12 guards
//! against, pointed the other way.
//!
//! ### The infrastructure fault that WORE a verdict's clothes
//!
//! One class of non-verdict arrives through the verdict channel, and it condemned good
//! data. `conformance.py` reports a staged input whose bytes are not there as an ordinary
//! per-artifact violation (`declared bytes are missing at …`, `error: None`, exit 1), so
//! the whole verdict looked like a reached one and [`apply_verdict`] flipped those rows to
//! `failed`. But an artifact's bytes are hardlinked out of the content-addressed pool by
//! the server itself: `/inputs/<artifact-id>` being absent or emptied cannot be something
//! the PRODUCER did, only something that happened to the staging — the sweep above, an
//! operator `rm`, a filesystem fault. Condemning on it is precisely the false statement
//! this module forbids.
//!
//! So the classification is made from STATE, not from the wording of a violation string
//! that crosses a process boundary: [`staging_fault`] re-checks the paths the server
//! staged, and any loss makes the whole batch INDETERMINATE. A string match on the
//! Python's message would silently revert to condemning the next time that message was
//! reworded; a missing hardlink cannot be reworded.
//!
//! ## Fail-open, but never SILENTLY (the shape, and why this one)
//!
//! That distinction is honest and it is kept. What was NOT defensible is what used to
//! accompany it: an `error!` line and nothing else. A `tracing` record is transient, is
//! not attached to the run whose data is unverified, and — decisively — **no test could
//! observe it**. Combined with a gate test that self-skipped when the sandbox was absent,
//! ONE missing rootfs removed the enforcement and every trace that it was missing, at the
//! same time and without a sound.
//!
//! So every run of the gate now leaves a durable, operator-visible record on the
//! PRODUCING JOB — a `job_logs` row, i.e. the run's own log, which `GET /jobs/{id}`
//! already returns and the UI already shows. All THREE outcomes are recorded, not just
//! the bad one, because that is what makes the absence of a record meaningful:
//!
//! | outcome | `artifacts.status` | the run's log says |
//! |---|---|---|
//! | [`GateOutcome::Conformed`] | untouched (`ready`) | `conformance: OK — N artifact(s) verified` |
//! | [`GateOutcome::Violations`] | `failed` | `conformance: FAILED — …marked failed` |
//! | [`GateOutcome::Indeterminate`] | **untouched** | `conformance: NOT VERIFIED — …UNCHECKED` |
//!
//! An operator reading a run can now tell "verified" from "nobody looked", which is the
//! distinction that was invisible; and `gate_now` RETURNS the outcome, so a test asserts
//! it directly instead of scraping a log stream that libtest captures anyway.
//!
//! The outcome is derived from what the gate **CONCLUDED**, never from what happened to
//! PERSIST. Those came apart: a `set_status` failure dropped the row from the flipped
//! list, and a batch whose every condemnation failed to write recorded
//! `conformance: OK — N artifact(s) verified`. A write error inverted the meaning of the
//! one line an operator reads. [`VerdictApplication`] keeps the two apart — the branch is
//! chosen by the verdict, and rows that were condemned but not written are named in the
//! record as STILL `ready`.
//!
//! What this deliberately does NOT do: mark an unverified artifact `failed` or `pending`.
//! Both would be the server stating something it does not know. The honest answer is that
//! the artifact is `ready` and unverified, and the fix is to say so where somebody can
//! read it.
//!
//! There is deliberately **no off switch** — no config flag, no env var, no manifest key.
//! DEC-8's "no key that can disable, skip, or parameterize it" is the whole structural
//! claim; an operator-facing kill switch is exactly the lever a future red gate would be
//! made green with.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use sqlx::PgPool;
use tokio::io::{AsyncReadExt, BufReader};
use uuid::Uuid;

use crate::modules::sandbox::processors::VERIFY_CONFORMANCE_CODE_REF;
use crate::modules::workstore::catalog::models::Artifact;
use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::models::Job;
use super::runner::{JobRunner, SandboxJobRunner};

/// Wall-clock budget for one verification batch. Generous: `full=True` decodes every
/// chunk of every artifact a run emitted, and a large matrix is gigabytes. It exists so a
/// wedged child can never pin a workspace forever, not to bound normal work.
const VERIFY_WALL_SECS: u64 = 30 * 60;

/// Grace for the stdout/stderr drain tasks after the child exits (mirrors `verify.rs`).
const DRAIN_JOIN_GRACE: Duration = Duration::from_secs(5);

/// Max stderr bytes kept for the diagnostic log line on an indeterminate outcome.
const STDERR_TAIL: usize = 4096;

/// The `artifacts.status` value a non-conforming artifact lands in.
pub const STATUS_FAILED: &str = "failed";

/// The prefix every gate record on a run's log carries, so an operator (or a test) can
/// find all three outcomes with one search and tell "no record" from "a clean record".
pub const GATE_LOG_PREFIX: &str = "conformance:";

/// The marker an INDETERMINATE outcome carries. Distinct words for a distinct state:
/// this is not "failed" (the data may be fine) and not "OK" (nothing was checked).
pub const GATE_LOG_UNVERIFIED: &str = "NOT VERIFIED";

/// What one gate run concluded — three states, because the server does three DIFFERENT
/// things with them and a boolean would collapse the two that must never be confused.
///
/// Returned by [`gate_now`] so the outcome is observable by a caller rather than only by
/// whoever is tailing the logs. That is not a convenience: the previous shape reported
/// an indeterminate run through `tracing` alone, which libtest captures, so no test could
/// distinguish "the gate ran and passed" from "the gate never ran".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateOutcome {
    /// The gate RAN and every submitted artifact agrees with its declaration.
    Conformed { checked: usize },
    /// The gate RAN and CONDEMNED at least one artifact (or the run).
    ///
    /// `failed` is what was written; `unpersisted` is what the verdict condemned and the
    /// status write did NOT apply. The split is load-bearing: this variant is chosen from
    /// the VERDICT, so a failed write can no longer downgrade a condemnation to
    /// [`GateOutcome::Conformed`]. `run_violations` belong to no single row.
    Violations {
        failed: Vec<Uuid>,
        unpersisted: Vec<Uuid>,
        run_violations: usize,
    },
    /// The gate did NOT reach a verdict (no sandbox, a staging fault, a timeout, an
    /// unreadable/unaccountable verdict). **Never a statement about the bytes** — the
    /// artifacts keep the status ingest gave them and are recorded as UNVERIFIED.
    Indeterminate { reason: String },
}

impl GateOutcome {
    /// `true` when the gate reached a verdict about the bytes at all.
    pub fn is_verdict(&self) -> bool {
        !matches!(self, GateOutcome::Indeterminate { .. })
    }

    /// The `(stream, content)` of the one `job_logs` row this outcome writes to the
    /// producing run. Pure, so the wording an operator actually sees is unit-testable
    /// without a database or a sandbox.
    ///
    /// The indeterminate line names every affected artifact id: "something in this run is
    /// unverified" is not actionable, and the ids are what an operator re-runs the gate
    /// over (or inspects by hand) once the sandbox is fixed.
    pub fn log_line(&self, targets: &[GateTarget]) -> (&'static str, String) {
        let ids = |list: &[Uuid]| {
            list.iter()
                .map(Uuid::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        };
        match self {
            GateOutcome::Conformed { checked } => (
                "stdout",
                format!(
                    "{GATE_LOG_PREFIX} OK — {checked} artifact(s) verified against their \
                     declared structure"
                ),
            ),
            GateOutcome::Violations {
                failed,
                unpersisted,
                run_violations,
            } => (
                "stderr",
                format!(
                    "{GATE_LOG_PREFIX} FAILED — {} artifact(s) do not conform to their \
                     declared structure and were marked failed [{}]; {run_violations} \
                     run-level violation(s){}",
                    failed.len(),
                    ids(failed),
                    // Named, never folded into the count above. A condemnation the
                    // server could not write is the one case where the log and the
                    // catalog disagree, and an operator has to be told which rows are
                    // still serving as `ready` so the gate can be re-run over them.
                    if unpersisted.is_empty() {
                        String::new()
                    } else {
                        format!(
                            ". {} further artifact(s) were CONDEMNED but the status write \
                             did NOT persist, so they are still `ready` and unenforced \
                             [{}] — re-run the gate over this run",
                            unpersisted.len(),
                            ids(unpersisted)
                        )
                    }
                ),
            ),
            GateOutcome::Indeterminate { reason } => (
                "stderr",
                format!(
                    "{GATE_LOG_PREFIX} {GATE_LOG_UNVERIFIED} — the gate did not reach a \
                     verdict, so {} artifact(s) from this run are UNCHECKED and keep the \
                     status ingest gave them [{}]. This is not a claim that the data is \
                     bad; it is a claim that nothing verified it. Reason: {reason}",
                    targets.len(),
                    ids(&targets.iter().map(|t| t.artifact_id).collect::<Vec<_>>())
                ),
            ),
        }
    }
}

/// One artifact to gate: the catalog row's id + tenancy scope (for the sync emit) and
/// BOTH of the producer's declarations, carried verbatim.
///
/// `meta` is here because the gate needs it, and it needed it for a specific reason:
/// `structure.key` is optional, so omitting it removed an artifact from the digest check
/// AND from its axis's cross-artifact alignment group — the mechanism for catching
/// row-order misalignment — silently. What refutes that omission is the producer's OTHER
/// declaration on the same row, `meta.is_axis_index: true` ("this artifact IS the axis"),
/// which is the predicate `CatalogRepository::list_dataset_axis_index_candidates` resolves
/// axes by. [`build_gate_manifest`] used to strip `meta`, so the gate could not make the
/// cross-check and the pairing survived only as a comment stating its own consequence.
#[derive(Debug, Clone)]
pub struct GateTarget {
    pub artifact_id: Uuid,
    pub project_id: Option<Uuid>,
    pub dataset_id: Option<Uuid>,
    pub structure: serde_json::Value,
    pub meta: serde_json::Value,
}

impl GateTarget {
    /// The `/inputs`-relative subpath this artifact binds at. The artifact UUID as the
    /// SLOT: it is escape-free by construction, unique within a run, and it is what makes
    /// a violation attributable to ONE catalog row (an `output_id` is only unique per run,
    /// and a producer chooses it).
    ///
    /// **It must go through the runner's own derivation** (ITEM-23): since the runner
    /// names an artifact-backed mount from the artifact rather than from the spec's
    /// `sandbox_subpath`, a path this module computed independently would send the
    /// checker looking for `/inputs/<id>` while the bytes were staged at
    /// `/inputs/<id>.zarr` — "declared bytes are missing", i.e. every conforming Zarr
    /// artifact in the system condemned. One function, used by both, is what makes that
    /// unrepresentable rather than merely unlikely.
    pub fn subpath(&self) -> String {
        crate::modules::sandbox::spec::derive_artifact_mount_name(
            &self.artifact_id.to_string(),
            &self.structure,
        )
    }
}

impl From<&Artifact> for GateTarget {
    fn from(a: &Artifact) -> Self {
        Self {
            artifact_id: a.id,
            project_id: a.project_id,
            dataset_id: a.dataset_id,
            structure: a.structure.clone(),
            meta: a.meta.clone(),
        }
    }
}

/// What the gate DID for one artifact — the receipt behind its appearance in `checked`.
///
/// ## Why the positive control needs a receipt and not a list
///
/// `run_gate` refuses a verdict that does not account for every artifact it submitted,
/// because "everything conformed" and "the checker examined nothing" both serialize as an
/// empty `violations` map. That refusal was **unfireable**: the gate built `checked` as
/// `[e["id"] for e in manifest["outputs"]]`, i.e. from the document THIS SERVER wrote in
/// [`build_gate_manifest`]. Stubbing the gate's `conform_manifest` to return `[]` was
/// reproduced end to end — `checked` came back naming both submitted ids, exit 0, and this
/// module logged "OK — 2 artifact(s) verified against their declared structure" over an
/// artifact nobody had read a byte of.
///
/// So `checked` is now derived, on the gate's side, from counters incremented only by the
/// code that has just read the artifact's bytes off disk, and those counters cross the
/// wire here. `checks == 0` means the gate read nothing for that artifact, whatever its
/// `checked` list says, and [`run_gate`] treats it as unexamined. Two independent places
/// would have to be stubbed to fake it, and neither is reachable from a processor.
///
/// ## `checks` counts COMPLETED READS — the second vacuity, and why there is one quantity
///
/// `checks` used to include declaration-level comparisons (a row's dtype against the copy
/// stamped into a `zarr.json`), plus one unconditional bump at the top of the gate's
/// `conform_artifact`. Those are cheap metadata steps that run BEFORE the container walk,
/// so the walk — the entire substance of this gate — could be removed and the receipt still
/// looked full. Measured end to end with the gate's `_decode_shards` stubbed to `[]`:
/// `checks: 10, shards: 0, chunks: 0, decoded_bytes: 0`, `checked: [the artifact]`,
/// `violations: {}`, exit 0, and this module logging "every ingested artifact conforms to
/// its declaration" over an artifact nothing had decoded.
///
/// The gate's `Evidence.note` verb is gone. `checks` is now raised only by a completed
/// read, and the remaining counters below are that same work broken down, not a second,
/// weaker quantity a later author could key on instead. None of them can move without
/// `checks` moving too.
///
/// ## Earned by the READ, not by reaching the code that performs it
///
/// Counting only byte-reading code was necessary and STILL not sufficient. The gate's
/// container reader recorded its receipt from `len(shards)` — a count derived from the
/// DECLARED grid — ABOVE the loop that opens a shard, so the receipt was earned by
/// entering the function. Measured through the real entry: an `n=0` member (a legal shape
/// the writer emits, with a real but empty chunk plane) returned `checks: 1, chunks: 0,
/// decoded_bytes: 0`, `checked: [the artifact]`, `violations: {}`, exit 0 — which is
/// [`examined`] true, [`accounts_for`] true, nothing condemned, i.e.
/// [`GateOutcome::Conformed`] over an artifact whose bytes were never opened. A member
/// whose shard file had been DELETED returned `checks: 1, shards: 1, decoded_bytes: 0` —
/// a receipt for a file that does not exist.
///
/// Every one of the gate's `Evidence` verbs now takes the RESULT of a completed act
/// (the shard's BYTES, the entries a walk listed, a decompressed length) and is called on
/// the line that completed it, and none of them records anything when their argument says
/// no bytes came back. So `checks > 0` IS "at least one read of this artifact's bytes
/// completed".
///
/// ## An artifact with NOTHING to read is INDETERMINATE
///
/// An `n=0` member, an emptied directory, a directory-shaped `opaque` artifact: legitimate
/// data the gate reads none of. It earns no receipt, so [`accounts_for`] is false, so
/// [`verdict_from_run`] refuses the verdict and [`conclude`] returns
/// [`GateOutcome::Indeterminate`] — the row keeps the status ingest gave it and the run
/// records `NOT VERIFIED`. Not green (the gate names it in `run_violations` too, so
/// neither side is silent), and not `failed`. The gate's own entry documents the identical
/// landing, and `a_conformed_outcome_implies_every_artifact_was_read` drives it through
/// the real [`conclude`].
///
/// A read the OS REFUSES (EACCES/EIO) does NOT land here — the gate reports it as a
/// violation of the artifact it was reading, which [`apply_verdict`] turns into
/// `status = 'failed'`. That is a known, deliberate over-condemnation; the account and the
/// brief for a fix are in the RECORDED LIMITATION block of `_lib/conformance.py`.
///
/// That sentence has been measured FALSE once, and the reason it was false is the reason it
/// is written this precisely. The gate's DEC-8 anti-bypass walk — the check that refutes an
/// `opaque` declaration made over a real Zarr store — enumerated with `Path.rglob`, which
/// silently skips a directory it cannot list. So an `opaque` artifact whose only
/// `zarr.json` sat under a `0o111` subdirectory returned `violations: {}`, `checked: []`,
/// `evidence: {}` and landed exactly HERE, as [`GateOutcome::Indeterminate`] with every row
/// keeping the status ingest gave it — while the identical artifact at `0o755` was
/// condemned. A refused read reaching the indeterminate channel is not a milder outcome
/// than condemnation: it is the mis-declared store continuing to serve, reached by a
/// `chmod` on the producer's own output. All three of the gate's walks now report an
/// unenumerable directory as a violation, so the sentence above is a description again.

///
/// An artifact refused on the FACE of its declaration earns no evidence, because it read
/// nothing. It does not need any: it is named in `violations`, and
/// [`GateVerdict::accounts_for`] is where the two ways of reaching a conclusion meet.
///
/// [`examined`]: GateVerdict::examined
/// [`accounts_for`]: GateVerdict::accounts_for
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
pub struct GateEvidence {
    /// **The discriminator**: how many READS of this artifact's bytes COMPLETED — one per
    /// container part read, one per chunk decompressed, one per payload read whole. It is
    /// NOT the sum of the counters below (those are two act counts and two byte volumes);
    /// the property it carries is the only one either consumer needs: it cannot be non-zero
    /// unless at least one read of these bytes completed.
    ///
    /// It once could. A fourth gate-side verb counted the entries a directory LISTING had
    /// seen, so an `opaque` DIRECTORY reached `checks: 1, shards: 2, read_bytes: 0` and this
    /// server concluded `GateOutcome::Conformed` over an artifact nothing had opened. The
    /// verb is gone, and [`GateVerdict::examined`] no longer takes this field's word for it.
    #[serde(default)]
    pub checks: u64,
    /// Container parts read (a member's shard files). An ACT count, not bytes — see
    /// [`GateVerdict::examined`] for why that distinction is load-bearing. Reported to the
    /// operator by [`conclude`]'s log record.
    #[serde(default)]
    pub shards: u64,
    /// Inner chunks decompressed. An act count; see `shards`.
    #[serde(default)]
    pub chunks: u64,
    /// Bytes of decompressed chunk payload. Bytes that ARRIVED, so it is one of the two
    /// counters [`GateVerdict::examined`] accepts as proof of a read.
    #[serde(default)]
    pub decoded_bytes: u64,
    /// Bytes read whole off disk (a member's shard files; an `opaque` content check). Bytes
    /// that ARRIVED — see `decoded_bytes`.
    #[serde(default)]
    pub read_bytes: u64,
}

/// The verdict `_lib/verify_conformance.py` writes to `/outputs/verdict.json`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GateVerdict {
    /// Every artifact label the gate actually looked at (the positive control: an empty
    /// `checked` with an empty `violations` is a gate that examined NOTHING, not a pass).
    ///
    /// Backed by [`GateEvidence`] on the gate's side: it is derived from counters only a
    /// COMPLETED READ increments (a container part read, a chunk decompressed, a payload
    /// read whole), NOT from the manifest this server handed over, NOT from the
    /// declaration-level comparisons that run before the bytes are touched, NOT from a count
    /// of the work a declared grid says is coming, and NOT from a directory LISTING — that
    /// last one was a real gate-side verb and is what made `Conformed` reachable over an
    /// artifact nothing opened. All four distinctions are the whole value of the field —
    /// see [`GateEvidence`], and [`GateVerdict::examined`], which checks rather than assumes.
    #[serde(default)]
    pub checked: Vec<String>,
    /// `artifact-id → what the gate DID for that artifact`. The receipt behind `checked`.
    #[serde(default)]
    pub evidence: BTreeMap<String, GateEvidence>,
    /// `artifact-id → violations`. Present ⇒ that artifact does not conform.
    ///
    /// **Capped** at `MAX_VIOLATIONS_PER_ARTIFACT` (50) by the gate — see
    /// [`Self::violation_counts`] for the untruncated total.
    #[serde(default)]
    pub violations: BTreeMap<String, Vec<String>>,
    /// `artifact-id → how many violations the gate actually found`, before the cap above.
    ///
    /// The gate has always emitted this and this struct did not declare it, so serde
    /// dropped it on the floor and the true count of a pathologically broken artifact
    /// survived NOWHERE — while the emitter's docstring argued "the count is reported
    /// whole; only the strings are capped, so 'how bad' is never lost". Declared here and
    /// logged by [`conclude`], which is the only surface that outlives the verdict file
    /// (`run_gate` → `cleanup` → `discard_staging` removes the staging tree on every path).
    #[serde(default)]
    pub violation_counts: BTreeMap<String, u64>,
    /// Violations belonging to the run rather than to one artifact.
    ///
    /// **Capped** at `MAX_VIOLATIONS_PER_ARTIFACT` (50) by the gate, exactly like
    /// [`Self::violations`] — see [`Self::run_violation_count`] for the untruncated total.
    #[serde(default)]
    pub run_violations: Vec<String>,
    /// How many run-level violations the gate actually found, before the cap above.
    ///
    /// The run-level twin of [`Self::violation_counts`], and it was the half that did not
    /// exist: `violation_counts` covers the per-ARTIFACT map only, so the run-level list was
    /// capped with its total surviving nowhere, and [`conclude`] logged
    /// `run_violations.len()` — the CAPPED length — as if it were the count. `None` means an
    /// older gate that does not emit it, and [`Self::run_violation_total`] then falls back to
    /// the list length, which is exactly what was being reported before.
    #[serde(default)]
    pub run_violation_count: Option<u64>,
    /// Set when the gate itself could not run (never a statement about the bytes).
    #[serde(default)]
    pub error: Option<String>,
}

impl GateVerdict {
    /// The artifact ids this verdict condemns, parsed back out of their labels.
    ///
    /// **Fallible on purpose.** This used to be `filter_map(|(k, _)| Uuid::parse_str(k).ok())`
    /// — a label that is not a uuid was DROPPED, with no log, no run-level violation and no
    /// error, and the doc here said it "is ignored here and reported by the caller". No
    /// caller could: [`apply_verdict`] iterates the already-parsed ids, and `violations` is
    /// only ever logged inside [`conclude`]'s `Violations` arm, which is not taken when this
    /// list is empty. So a verdict whose only violations sat under malformed keys passed the
    /// evidence control (which reads `checked`/`evidence`, never `violations`) and reached
    /// [`GateOutcome::Conformed`] — "every ingested artifact conforms" over condemned data,
    /// the same family the comment in [`conclude`] says it closed.
    ///
    /// A label this server cannot attribute is not a reason to forget it. There is exactly
    /// ONE place that turns a label into an id, it cannot succeed partially, and every
    /// caller has to handle the failure — so the verdict becomes a non-verdict
    /// ([`GateOutcome::Indeterminate`], statuses untouched) instead of a silent pass. A
    /// non-uuid label can only come from a gate this server did not ask for, which is
    /// exactly the case where its silence must not be read as consent.
    pub fn condemned(&self) -> Result<Vec<Uuid>, String> {
        let mut ids = Vec::new();
        let mut unattributable = Vec::new();
        for (label, _) in self.violations.iter().filter(|(_, v)| !v.is_empty()) {
            match Uuid::parse_str(label) {
                Ok(id) => ids.push(id),
                Err(_) => unattributable.push(label.as_str()),
            }
        }
        if !unattributable.is_empty() {
            return Err(format!(
                "the gate condemned {} label(s) that are not artifact ids ({unattributable:?}) \
                 — this server submits uuid labels only, so a verdict naming something else is \
                 not a verdict about this batch and must not be acted on in part",
                unattributable.len()
            ));
        }
        Ok(ids)
    }

    /// `true` when this verdict carries EVIDENCE that `label`'s bytes were read.
    ///
    /// Membership in `checked` is necessary and not sufficient: the accompanying
    /// [`GateEvidence`] must show at least one byte-reading operation actually performed.
    /// See the type's doc for the two vacuities that made weaker tests worthless.
    ///
    /// **`checks > 0` is necessary and not sufficient either, and this side ENFORCES that
    /// rather than trusting it.** `checks` is the gate's own count of completed reads, and
    /// it has been raised by something that was not a read twice: by a declaration-level
    /// comparison (`note`), and by a directory LISTING (`enumerated`, which let an
    /// `opaque` directory reach `GateOutcome::Conformed` with `read_bytes: 0`). Both times
    /// the property was stated on both sides and checked on neither — this server declared
    /// `checks` "cannot be non-zero unless at least one read of these bytes completed" and
    /// then read only `checks`, so the producer's rule was the ONLY thing holding it up.
    ///
    /// So the two counters that can only come from bytes ARRIVING are read here as well.
    /// The gate now guarantees the same thing structurally (every `Evidence` verb raises
    /// one of them on the line it raises `checks`), which makes this clause exactly
    /// equivalent — and it stays because equivalence maintained by another process's
    /// invariant is not equivalence this one can rely on. `shards`/`chunks` are act counts
    /// and are deliberately NOT accepted in their place: counting acts is how both
    /// regressions were spelled.
    pub fn examined(&self, label: &str) -> bool {
        self.checked.iter().any(|c| c == label)
            && self
                .evidence
                .get(label)
                .is_some_and(|e| e.checks > 0 && e.read_bytes.saturating_add(e.decoded_bytes) > 0)
    }

    /// The run's [`GateEvidence`] summed over every artifact — HOW MUCH the gate read.
    ///
    /// [`conclude`] writes this into the run's log record. That is not decoration: the
    /// gate's own header promised these counters to "an operator who wants to know how much
    /// was actually read", and there was no such surface — `verdict.json` is removed with
    /// the staging tree on every return path of [`run_gate`], and nothing else read
    /// `shards`/`chunks`/`decoded_bytes`/`read_bytes` at all. A counter written by one
    /// process and read by none is a claim nobody can check.
    ///
    /// Saturating, because these are the gate's numbers and a verdict document is not a
    /// place to take an overflow panic.
    pub fn work_done(&self) -> GateEvidence {
        self.evidence
            .values()
            .fold(GateEvidence::default(), |mut acc, e| {
                acc.checks = acc.checks.saturating_add(e.checks);
                acc.shards = acc.shards.saturating_add(e.shards);
                acc.chunks = acc.chunks.saturating_add(e.chunks);
                acc.decoded_bytes = acc.decoded_bytes.saturating_add(e.decoded_bytes);
                acc.read_bytes = acc.read_bytes.saturating_add(e.read_bytes);
                acc
            })
    }

    /// How many run-level violations the gate FOUND — the untruncated total, which is what
    /// an operator needs and what [`conclude`] logs.
    ///
    /// `run_violations.len()` is the number that SURVIVED the gate's 50-string cap, so it
    /// reads as the count and stops being it exactly when the batch is worst. It is kept as
    /// the fallback and only as that: a gate too old to emit `run_violation_count` reports
    /// what it always reported, and the fallback can never UNDERSTATE the emitted total (a
    /// `max` guards a truncated list arriving beside an absent or smaller count).
    pub fn run_violation_total(&self) -> usize {
        let capped = self.run_violations.len();
        match self.run_violation_count {
            Some(n) => usize::try_from(n).unwrap_or(usize::MAX).max(capped),
            None => capped,
        }
    }

    /// `true` when this verdict reached a CONCLUSION about `label` — it either read the
    /// artifact's bytes ([`Self::examined`]) or named a violation against it.
    ///
    /// Those are the only two ways a gate concludes anything; silence is neither, and
    /// silence is what [`verdict_from_run`]'s positive control exists to refuse. The
    /// disjunction is not a softer `examined`: a declaration this suite refuses on its face
    /// (no `encoding`, an encoding it does not implement, bytes that are not a store at
    /// all) is reached without opening a byte, so requiring a receipt for it would turn a
    /// perfectly good CONDEMNATION into an indeterminate batch — leaving the bad artifact
    /// serving as `ready`, and its innocent siblings unverified with it.
    ///
    /// The invariant that matters survives intact, because the two branches lead to
    /// different outcomes: a condemned artifact forces [`GateOutcome::Violations`], so
    /// **[`GateOutcome::Conformed`] still implies every artifact in the batch was
    /// `examined`, i.e. that its bytes were read.** `a_conformed_outcome_implies_every_
    /// artifact_was_read` pins exactly that — through [`conclude`], on real
    /// [`GateOutcome`]s, because the load-bearing half of the implication is which ARM is
    /// taken and no assertion over a [`GateVerdict`] alone can observe it. The gate's own
    /// entry states the identical rule (`_lib/verify_conformance.py`, the `unaccounted`
    /// list).
    pub fn accounts_for(&self, label: &str) -> bool {
        self.examined(label)
            || self
                .violations
                .get(label)
                .is_some_and(|violations| !violations.is_empty())
    }
}

// ── the spec ────────────────────────────────────────────────────────────────────

/// The manifest handed to the gate at `/inputs/params.json` — the same
/// `{"outputs": [{id, path, structure, meta}]}` shape `conform_outputs` reads off an
/// emitted `/outputs/manifest.json`, so the production gate and the CLI check the same
/// document.
///
/// `structure` and `meta` are the artifact row's columns, cloned. Nothing is synthesized,
/// merged or defaulted here: the server is handing the PRODUCER's declarations to the
/// checker, which is the only role INV-1 leaves it in this exchange.
///
/// **`meta` used to be stripped**, and that quietly disabled a check. `structure.key` is
/// optional, so a producer omitting it dropped its artifact out of the key-digest check AND
/// out of its axis's cross-artifact alignment group — the mechanism for catching row-order
/// misalignment — writing nothing at all to do it. What refutes the omission is
/// `meta.is_axis_index: true` on the same row ("this artifact IS the axis", the predicate
/// this server resolves axes by), and the gate could not see it. An emitted
/// `/outputs/manifest.json` carries `meta` on every entry, so stripping it here also meant
/// the production gate and the CLI were reading DIFFERENT documents about the same artifact.
pub fn build_gate_manifest(targets: &[GateTarget]) -> serde_json::Value {
    serde_json::json!({
        "outputs": targets
            .iter()
            .map(|t| serde_json::json!({
                "id": t.artifact_id.to_string(),
                "path": t.subpath(),
                "structure": t.structure,
                "meta": t.meta,
            }))
            .collect::<Vec<_>>()
    })
}

/// The `AnalysisSpec` (as `Job.params`) for one verification batch. Pure + unit-testable.
pub fn build_verify_spec(targets: &[GateTarget]) -> serde_json::Value {
    serde_json::json!({
        "language": "python",
        "code_ref": VERIFY_CONFORMANCE_CODE_REF,
        "inputs": targets
            .iter()
            .map(|t| serde_json::json!({
                "slot": t.artifact_id.to_string(),
                "artifact_ref": t.artifact_id,
                "sandbox_subpath": t.subpath(),
            }))
            .collect::<Vec<_>>(),
        "params": build_gate_manifest(targets),
        "timeout_secs": VERIFY_WALL_SECS,
    })
}

/// The synthetic `Job` carrying that spec. It has NO row in `jobs` and NO `job_scope`
/// row, so nothing about this run is ever ingested or recorded — this module owns the
/// drive loop and never touches the ingest sink, the provenance recorder, or the
/// scheduler. `owner_id` is the OWNER OF THE RUN whose outputs are being gated:
/// `materialize_inputs` authorizes every `artifact_ref` against it, and the producer of
/// an artifact can always read it, so the gate can never see bytes that user could not.
fn verify_job(verify_id: Uuid, owner_id: Uuid, params: serde_json::Value) -> Job {
    Job {
        id: verify_id,
        owner_id,
        job_type: "analysis".to_string(),
        name: format!("conformance-{verify_id}"),
        status: "running".to_string(),
        params,
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        exit_code: None,
        error: None,
        pid: None,
        priority_class: "normal".to_string(),
        resource_class: "cpu-sandbox".to_string(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    }
}

// ── the drive loop ──────────────────────────────────────────────────────────────

/// Run the gate over `targets`, UNDER the box-wide concurrency cap, and return its
/// verdict.
///
/// `Err` means INDETERMINATE — the gate did not reach a verdict about the bytes (no
/// sandbox, a staging fault, a timeout, an unparseable verdict, **or no compute slot**).
/// It is never a claim that the artifacts are bad; see the module doc.
///
/// ## Admission (the bypass named in the module doc, now closed)
///
/// This gate spawns a full bwrap child and used to do it with no admission check of any
/// kind — the last such bypass in the module, and the worst one, because it fires
/// automatically on every artifact-producing run rather than on an explicit user
/// request. A box with `max_concurrent_jobs = 2` running 2 analysis jobs could have 4
/// sandbox children the moment both finalized, with every admission mechanism in the
/// process reporting itself satisfied.
///
/// It now claims a slot through the SAME statement as the scheduler and
/// `provenance::verify` (`admission::admit_within` → `create_running_under_cap`). The
/// row is `job_type = "conformance"`, NOT `"analysis"`: `reconcile_orphaned_running`
/// FINALIZES and INGESTS an orphaned running *analysis* job at boot, and a gate run must
/// never reach the catalog.
///
/// ## Why this one WAITS where `/sandbox/execute` refuses
///
/// Nobody is holding a socket: [`dispatch_after_ingest`] detaches this. So a bounded
/// wait is free, and it is strictly better than refusing a run that would have been
/// admissible a moment later — which is the common case here, because the producing
/// run's OWN `jobs` row is still `running` when it dispatches its gate (the gate is
/// spawned from inside `finalize_analysis`; `repo.finish` runs when that returns). A
/// gate that refused instantly would therefore almost never run at small caps.
///
/// The wait is bounded by [`admission::ADMISSION_WAIT`] and its expiry is a TERMINAL,
/// RECORDED answer — `Err` here becomes `GateOutcome::Indeterminate`, which
/// [`conclude`] writes to the producing run's `job_logs` where an operator meets it.
/// That is the difference between a bounded queue and a hang: this one always ends, and
/// says so. Artifact statuses are left ALONE, per the module's verdict-vs-non-verdict
/// rule — "the box was busy" is not a statement about the bytes.
pub async fn run_gate(
    pool: &PgPool,
    owner_id: Uuid,
    targets: &[GateTarget],
) -> Result<GateVerdict, String> {
    if targets.is_empty() {
        return Ok(GateVerdict::default());
    }
    let verify_id = Uuid::new_v4();

    // ADMISSION, before the workspace hold and before any child. `Ok(None)` = the budget
    // expired with the pool still full; `Err` = the database is broken, which is a
    // different fact and must not be reported as a busy box.
    //
    // The (wait budget, poll interval) are the admin-configurable `admission_wait_secs`
    // / `admission_poll_ms` (#54, INV-5), read at-use here with a const fallback.
    let (admission_wait, admission_poll) =
        super::settings::JobSettingsRepository::new(pool.clone())
            .admission_config()
            .await;
    match super::admission::admit_within(
        pool,
        verify_id,
        owner_id,
        "conformance",
        &format!("conformance-{verify_id}"),
        serde_json::json!({ "artifacts": targets.len() }),
        targets.iter().find_map(|t| t.project_id),
        admission_wait,
        admission_poll,
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(format!(
                "the compute pool (max_concurrent_jobs) stayed full for {}s, so the gate \
                 never started; the artifacts are UNCHECKED, not bad",
                admission_wait.as_secs()
            ))
        }
        Err(e) => return Err(format!("conformance gate admission failed: {e}")),
    }

    // From here the slot is HELD and must be released on every return path — including
    // the `?` below. `run_gate_admitted` owns all of them so this tail cannot be missed.
    let result = run_gate_admitted(pool, owner_id, targets, verify_id).await;
    super::admission::close_slot(
        pool,
        verify_id,
        // A verdict naming violations is a job that COMPLETED — the gate did exactly what
        // it was asked. Only a gate that could not reach a verdict failed.
        result.as_ref().err().map(String::as_str),
    )
    .await;
    result
}

/// The drive loop proper, run with a concurrency slot already claimed under `verify_id`.
/// Split out so [`run_gate`]'s release tail covers every one of its return paths.
async fn run_gate_admitted(
    pool: &PgPool,
    owner_id: Uuid,
    targets: &[GateTarget],
    verify_id: Uuid,
) -> Result<GateVerdict, String> {
    // Hold the workspace out of the boot stale-workspace sweep for the WHOLE run. Taken
    // before the dir can exist, dropped on every return path below, and per-process — so
    // a crashed verification's dir is stale again and still gets reclaimed. Without it a
    // boot sweep deletes the `/inputs` of a verification the same boot just dispatched.
    let _workspace_hold = super::scheduler::hold_live_workspace(verify_id);
    let job = verify_job(verify_id, owner_id, build_verify_spec(targets));

    let registry = std::sync::Arc::new(
        crate::modules::sandbox::backend::local_bwrap::BackendRegistry::new(pool.clone()),
    );
    let runner = SandboxJobRunner::new(pool.clone(), registry);
    let mut spawned = runner
        .spawn(&job)
        .await
        .map_err(|e| format!("conformance job spawn failed: {e}"))?;

    // Hold the sandbox guards (cgroup scope / seccomp / FIFO drain) for the child's
    // whole life; both run dirs are removed after the verdict is read.
    let _guards = spawned.guards.take();
    let workspace = spawned.workspace.take();
    // ITEM-17: the gate writes its verdict to `/outputs`, which is now a dir in the
    // run's staging tree — the `inputs/` the staging-fault classifier reads is still
    // workspace scratch, so the classification needs BOTH.
    let staging = spawned.outputs_staging.take();

    // Drain stdout AND stderr in SEPARATE tasks: a child filling one pipe while holding
    // the other open deadlocks a single sequential reader.
    let stdout = spawned.child.stdout.take();
    let stderr = spawned.child.stderr.take();
    let drain_out = tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut sink = Vec::new();
            let _ = BufReader::new(o).read_to_end(&mut sink).await;
        }
    });
    let drain_err = tokio::spawn(async move {
        let mut sink = Vec::new();
        if let Some(e) = stderr {
            let _ = BufReader::new(e).read_to_end(&mut sink).await;
        }
        sink
    });

    let budget = Duration::from_secs(VERIFY_WALL_SECS);
    let exit_code = match tokio::time::timeout(budget, spawned.child.wait()).await {
        Ok(Ok(status)) => status.code().unwrap_or(-1),
        other => {
            let reason = match other {
                Err(_) => format!("conformance job exceeded its {VERIFY_WALL_SECS}s budget"),
                Ok(Err(e)) => format!("conformance job wait failed: {e}"),
                Ok(Ok(_)) => unreachable!("the first arm matched every successful wait"),
            };
            // Kill + reap so the child is never leaked, then reclaim the workspace.
            let _ = spawned.child.start_kill();
            let _ = spawned.child.wait().await;
            drain_out.abort();
            drain_err.abort();
            cleanup(&workspace, &staging).await;
            drop(_guards);
            return Err(reason);
        }
    };

    let stderr_tail = match tokio::time::timeout(DRAIN_JOIN_GRACE, async {
        let _ = drain_out.await;
        drain_err.await.unwrap_or_default()
    })
    .await
    {
        Ok(bytes) => tail_utf8(&bytes),
        Err(_) => String::new(),
    };

    // Classified BEFORE either dir is reclaimed: both legs of `verdict_from_run`
    // read the very paths `cleanup` is about to remove.
    let result = match (workspace.as_ref(), staging.as_ref()) {
        (Some(ws), Some(stg)) => verdict_from_run(ws, stg, targets).await,
        _ => Err("conformance job produced no run dirs".to_string()),
    };
    cleanup(&workspace, &staging).await;
    drop(_guards);

    result.map_err(|e| {
        format!(
            "{e} (exit {exit_code}){}",
            if stderr_tail.is_empty() {
                String::new()
            } else {
                format!("; stderr tail: {stderr_tail}")
            }
        )
    })
}

/// `Some(reason)` when the staging the SERVER built for this run is no longer intact.
///
/// This is the classifier that keeps an infrastructure fault from being read as a verdict.
/// Every path checked here was created by the server, never by the producer:
///
/// * `<ws>/inputs/params.json` — the manifest carrying the producer's declarations. Absent
///   ⇒ the gate had nothing to check the bytes AGAINST.
/// * `<ws>/inputs/<artifact-id>` — the artifact's bytes, hardlinked out of the
///   content-addressed pool. Absent, or an emptied directory ⇒ the gate had nothing to
///   check. A producer cannot cause either: the bytes were already ingested and hashed, so
///   an absent hardlink is the staging having been destroyed under a live run.
///
/// Any loss makes the WHOLE batch indeterminate, not just the affected row. A workspace
/// that lost one hardlink may have lost others, and the server cannot tell which lines of
/// the verdict were reached against real bytes — so it declines to act on any of them.
///
/// Deliberately state-based rather than a match on `conformance.py`'s
/// `declared bytes are missing at …` wording: that string crosses a process boundary, and
/// a classification anchored to it silently reverts to condemning the day it is reworded.
///
/// Known limit, stated rather than implied: a deletion INSIDE a multi-file artifact that
/// leaves the directory non-empty is not detected here (the server does not re-walk a
/// merkle manifest it did not record). [`super::scheduler::hold_live_workspace`] removes
/// the only known producer of that shape — the boot sweep — and the emptied-directory case
/// is what a `remove_dir_all` over a bind-mounted workspace actually leaves behind.
pub async fn staging_fault(workspace: &Path, targets: &[GateTarget]) -> Option<String> {
    let inputs = workspace.join("inputs");
    let params = inputs.join("params.json");
    if !tokio::fs::try_exists(&params).await.unwrap_or(false) {
        return Some(format!(
            "the gate's input staging was destroyed while it ran: {} is gone, so the \
             declarations it checks the bytes against were not there. This is a fault in \
             the staging, NOT a statement about the artifacts",
            params.display()
        ));
    }
    for t in targets {
        let staged = inputs.join(t.subpath());
        let meta = match tokio::fs::metadata(&staged).await {
            Ok(m) => m,
            Err(e) => {
                return Some(format!(
                    "the bytes staged for artifact {} at {} are gone ({e}) — they are \
                     hardlinked out of the content-addressed store by the server, so \
                     their absence is a staging fault, never something the producer \
                     declared wrongly",
                    t.artifact_id,
                    staged.display()
                ));
            }
        };
        if meta.is_dir() {
            let emptied = match tokio::fs::read_dir(&staged).await {
                Ok(mut rd) => matches!(rd.next_entry().await, Ok(None)),
                Err(e) => {
                    return Some(format!(
                        "the directory staged for artifact {} at {} could not be read \
                         ({e}) — a staging fault, not a verdict",
                        t.artifact_id,
                        staged.display()
                    ));
                }
            };
            if emptied {
                return Some(format!(
                    "the directory staged for artifact {} at {} is EMPTY — its members \
                     were removed while the gate ran (a `remove_dir_all` over a workspace \
                     whose mounts are busy leaves exactly this), so the gate saw no bytes. \
                     A staging fault, not a verdict",
                    t.artifact_id,
                    staged.display()
                ));
            }
        }
    }
    None
}

/// The verdict for one finished gate run, or `Err` = INDETERMINATE.
///
/// Three refusals, in the order that yields the most actionable reason:
///  1. the staging the server built is gone ([`staging_fault`]) — an infrastructure fault
///     that `conformance.py` reports through the violation channel, so it MUST be
///     intercepted before the verdict is believed;
///  2. no verdict, or an unparseable one;
///  3. a verdict that examined fewer artifacts than were submitted (the positive control).
///
/// Public so the whole classification is drivable from a test without a sandbox — the
/// condemn-vs-indeterminate decision is the security-relevant part of this module, and it
/// used to be reachable only through a spawned child.
///
/// Takes BOTH of the run's dirs (ITEM-17): the input staging it checks for an
/// infrastructure fault is workspace scratch, while the verdict the gate wrote to
/// `/outputs` is in the run's output STAGING dir.
pub async fn verdict_from_run(
    workspace: &Path,
    staging: &Path,
    targets: &[GateTarget],
) -> Result<GateVerdict, String> {
    if let Some(fault) = staging_fault(workspace, targets).await {
        return Err(fault);
    }
    let verdict = read_verdict(staging).await?;
    if let Some(err) = &verdict.error {
        return Err(format!("the gate reported an internal failure: {err}"));
    }
    // POSITIVE CONTROL on the verdict itself. "No violations" and "examined nothing"
    // produce the identical empty `violations` map, and the second one read as a pass is
    // the exact failure mode a gate must not have — a green line for a run the checker
    // never looked at. So the verdict has to account for every artifact submitted, or it
    // is not a verdict.
    //
    // Accounting means a CONCLUSION, not membership in a list — the bytes were read
    // (`GateVerdict::examined`, backed by counters only a COMPLETED read increments) or a
    // violation was named against the artifact. This is also the arm an artifact with
    // NOTHING TO READ takes (see `GateEvidence`): it reaches neither, so the verdict is
    // refused and the batch is INDETERMINATE rather than green or condemned. `checked`
    // used to be built by the gate as
    // `[e["id"] for e in manifest["outputs"]]` — a copy of what this server sent — so a
    // gate that read nothing returned a fully-accounted verdict and this control could not
    // fire (reproduced: a stubbed `conform_manifest` produced `checked: [both ids]`, exit
    // 0, and an "OK — 2 artifact(s) verified" log line).
    //
    // See `GateVerdict::accounts_for` for why the disjunction is not a weakening: a
    // condemned artifact forces the `Violations` outcome, so `Conformed` still implies
    // every artifact's bytes were read.
    let unaccounted: Vec<String> = targets
        .iter()
        .map(|t| t.artifact_id.to_string())
        .filter(|id| !verdict.accounts_for(id))
        .collect();
    if !unaccounted.is_empty() {
        return Err(format!(
            "the gate returned a verdict that neither read nor condemned {} of {} \
             submitted artifact(s) ({unaccounted:?}) — an artifact the gate reached no \
             conclusion about is not a passing one, and `checked` without a non-zero \
             evidence tally is not evidence",
            unaccounted.len(),
            targets.len()
        ));
    }
    Ok(verdict)
}

async fn read_verdict(staging: &Path) -> Result<GateVerdict, String> {
    let path = crate::modules::sandbox::outputs::outputs_dir(staging).join("verdict.json");
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        format!(
            "the conformance job wrote no verdict at {}: {e}",
            path.display()
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|e| format!("the conformance verdict is malformed: {e}"))
}

/// Reclaim BOTH of a gate run's dirs (ITEM-17). The gate ingests nothing, so its
/// staging has no consumer once the verdict has been read, on every return path.
async fn cleanup(workspace: &Option<std::path::PathBuf>, staging: &Option<std::path::PathBuf>) {
    if let Some(ws) = workspace {
        if let Err(e) = tokio::fs::remove_dir_all(ws).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "conformance workspace cleanup failed");
            }
        }
    }
    if let Some(stg) = staging {
        crate::modules::sandbox::outputs::discard_staging(stg).await;
    }
}

fn tail_utf8(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(STDERR_TAIL);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

// ── applying the verdict ────────────────────────────────────────────────────────

/// What applying one verdict actually DID, kept separate from what the verdict said.
///
/// The two used to be conflated, and the conflation inverted the operator's only signal: a
/// `set_status` error dropped the row from the flipped list, and a batch whose every
/// condemnation failed to write reported `conformance: OK`. So the outcome is derived from
/// `condemned` (what the gate CONCLUDED) while `flipped`/`unpersisted` record what reached
/// the catalog.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerdictApplication {
    /// Condemned by the verdict AND submitted by this batch — the conclusion, whatever
    /// happened to persist.
    pub condemned: Vec<Uuid>,
    /// Written: `artifacts.status = 'failed'` committed.
    pub flipped: Vec<Uuid>,
    /// Condemned but NOT written — the status update errored, or matched no row. These
    /// artifacts are still serving as `ready` and the record has to say so.
    pub unpersisted: Vec<Uuid>,
}

/// Mark every condemned artifact `failed` and emit its scope-aware sync nudge.
///
/// Only artifacts THIS batch submitted are touched: a verdict naming an id outside
/// `targets` is refused rather than acted on. The verdict comes back from a sandboxed
/// process over a file, and "the checker can fail arbitrary rows" is not a capability it
/// needs in order to do its job.
///
/// `Err` when the verdict names a violation under a label that is not an artifact id — see
/// [`GateVerdict::condemned`]. Nothing is written in that case, and [`conclude`] turns it
/// into an indeterminate outcome: a verdict this server cannot attribute is one it cannot
/// enforce, and enforcing the attributable half of it would be reporting a conclusion over
/// data the rest of the verdict condemns.
pub async fn apply_verdict(
    pool: &PgPool,
    targets: &[GateTarget],
    verdict: &GateVerdict,
) -> Result<VerdictApplication, String> {
    let condemned = verdict.condemned()?;
    let repo = CatalogRepository::new(pool.clone());
    let mut applied = VerdictApplication::default();
    for id in condemned {
        let Some(target) = targets.iter().find(|t| t.artifact_id == id) else {
            tracing::error!(artifact_id = %id, "conformance verdict named an artifact this batch did not submit; ignored");
            continue;
        };
        applied.condemned.push(id);
        match repo.set_status(id, STATUS_FAILED).await {
            Ok(true) => {}
            Ok(false) => {
                // No row matched. The condemnation still stands as a conclusion, and
                // "we could not enforce it" is not the same statement as "it conformed".
                tracing::error!(artifact_id = %id, "conformance: the condemned artifact row no longer exists, so `failed` was not applied");
                applied.unpersisted.push(id);
                continue;
            }
            Err(e) => {
                tracing::error!(artifact_id = %id, error = ?e, "conformance: marking the artifact failed did not persist");
                applied.unpersisted.push(id);
                continue;
            }
        }
        applied.flipped.push(id);
        // §7 notify-and-refetch: a DETACHED emit (origin None) so a watching client
        // refetches the row instead of showing `ready` until the next reload.
        match (target.project_id, target.dataset_id) {
            (Some(pid), _) => {
                crate::modules::workstore::sync::publish_artifact(
                    pool,
                    pid,
                    crate::modules::sync::SyncAction::Update,
                    id,
                    crate::modules::sync::Actor::detached(),
                )
                .await;
            }
            (None, Some(did)) => {
                crate::modules::workstore::sync::publish_artifact_for_dataset(
                    pool,
                    did,
                    crate::modules::sync::SyncAction::Update,
                    id,
                    crate::modules::sync::Actor::detached(),
                )
                .await;
            }
            (None, None) => {}
        }
    }
    Ok(applied)
}

// ── the production entry point ──────────────────────────────────────────────────

/// Gate a run's freshly-ingested artifacts, in the background.
///
/// Called by [`super::seams::WorkstoreIngestSink`] once `ingest_run_outputs` has
/// committed, i.e. AFTER ingest (DEC-12). Detached deliberately: the gate decodes every
/// byte of every artifact, and blocking `finalize_analysis` on it would hold the run's
/// workspace open for the duration and turn a non-conforming artifact into a FAILED RUN
/// (the run succeeded — it is the data that is wrong). That detachment IS the
/// brief-liveness window DEC-12 accepts by name.
pub fn dispatch_after_ingest(
    pool: PgPool,
    owner_id: Uuid,
    job_id: Uuid,
    run_id: Uuid,
    artifacts: &[Artifact],
) {
    let targets: Vec<GateTarget> = artifacts.iter().map(GateTarget::from).collect();
    if targets.is_empty() {
        return;
    }
    tokio::spawn(async move {
        gate_now(&pool, owner_id, job_id, run_id, &targets).await;
    });
}

/// The awaited body of [`dispatch_after_ingest`] — run the gate, apply the verdict,
/// RECORD the outcome on the producing run, and return what happened. Separated so a
/// caller that WANTS to wait for the verdict (a test, a future synchronous mode) takes
/// the identical path rather than a re-implementation.
///
/// `job_id` is the run's own `jobs` row: the outcome record is a `job_logs` line against
/// it, which is the operator-visible surface (`GET /jobs/{id}` → `logs`) that makes an
/// indeterminate outcome legible instead of silent. Distinct from `run_id`, which is the
/// provenance node and only coincides with the job id by default (DEC-G).
pub async fn gate_now(
    pool: &PgPool,
    owner_id: Uuid,
    job_id: Uuid,
    run_id: Uuid,
    targets: &[GateTarget],
) -> GateOutcome {
    let result = run_gate(pool, owner_id, targets).await;
    conclude(pool, job_id, run_id, targets, result).await
}

/// The CONSEQUENCE half of [`gate_now`]: turn what came back from the gate into the
/// artifact statuses and the run's operator-visible record, and return the outcome.
///
/// Split out because the condemn-vs-leave-alone decision is the security-relevant part of
/// this module and used to be reachable only by spawning a sandbox child — so on a host
/// without one, nothing tested it. `result` is exactly what [`run_gate`] returns:
/// `Ok(verdict)` = the gate reached a verdict about the bytes, `Err(reason)` = it did not.
pub async fn conclude(
    pool: &PgPool,
    job_id: Uuid,
    run_id: Uuid,
    targets: &[GateTarget],
    result: Result<GateVerdict, String>,
) -> GateOutcome {
    let outcome = match result {
        // A verdict naming a violation under a label that is not an artifact id is not a
        // verdict this server can enforce; it lands in the same arm as "the gate could not
        // run" rather than having its unattributable half quietly dropped.
        Ok(verdict) => match apply_verdict(pool, targets, &verdict).await {
            Err(reason) => {
                tracing::error!(
                    %run_id,
                    violations = ?verdict.violations,
                    "conformance: the verdict could not be attributed; artifact statuses left unchanged: {reason}"
                );
                GateOutcome::Indeterminate { reason }
            }
            // The branch is chosen by what the gate CONCLUDED (`condemned`), never by
            // what reached the catalog (`flipped`). Reading `flipped` here is what let a
            // failed status write report `conformance: OK` over condemned data.
            Ok(applied) if applied.condemned.is_empty() && verdict.run_violations.is_empty() => {
                let read = verdict.work_done();
                tracing::info!(
                    %run_id,
                    checked = verdict.checked.len(),
                    shards = read.shards,
                    chunks = read.chunks,
                    decoded_bytes = read.decoded_bytes,
                    read_bytes = read.read_bytes,
                    "conformance: every ingested artifact conforms to its declaration"
                );
                GateOutcome::Conformed {
                    checked: verdict.checked.len(),
                }
            }
            Ok(applied) => {
                tracing::error!(
                    %run_id,
                    violation_counts = ?verdict.violation_counts,
                    failed = ?applied.flipped,
                    unpersisted = ?applied.unpersisted,
                    // The COUNT is the untruncated one and the strings beside it are the
                    // capped list, the same split this record already makes for the
                    // per-artifact map. `run_violations.len()` was standing in for the
                    // count and silently stopped being it above the cap.
                    run_violation_count = verdict.run_violation_total(),
                    run_violations = ?verdict.run_violations,
                    violations = ?verdict.violations,
                    "conformance: non-conforming artifact(s) marked failed"
                );
                GateOutcome::Violations {
                    failed: applied.flipped,
                    unpersisted: applied.unpersisted,
                    run_violations: verdict.run_violation_total(),
                }
            }
        },
        Err(reason) => {
            // INDETERMINATE — not a verdict about the bytes. The rows keep whatever
            // status ingest gave them; a deployment where this is the norm has a gate
            // that is not gating, which is what the level says AND what the run's own
            // log now says, where an operator will actually meet it.
            tracing::error!(
                %run_id,
                artifacts = targets.len(),
                "conformance: the gate did NOT reach a verdict; artifact statuses left unchanged: {reason}"
            );
            GateOutcome::Indeterminate { reason }
        }
    };
    record_outcome(pool, job_id, targets, &outcome).await;
    outcome
}

/// Append the outcome to the PRODUCING RUN's log — the durable, operator-visible half of
/// [`gate_now`].
///
/// Best-effort by design: this runs after the run has already succeeded and its artifacts
/// are already committed, so a DB hiccup here must not take anything else down. It is
/// logged at `warn!` rather than swallowed, because "the record of the gate is missing"
/// is itself a thing an operator needs to know (§6 — never silently swallow).
async fn record_outcome(
    pool: &PgPool,
    job_id: Uuid,
    targets: &[GateTarget],
    outcome: &GateOutcome,
) {
    let (stream, content) = outcome.log_line(targets);
    let repo = super::repository::JobRepository::new(pool.clone());
    let seq = match repo.next_log_seq(job_id).await {
        Ok(seq) => seq,
        Err(e) => {
            tracing::warn!(%job_id, error = ?e, "conformance: could not resolve the run's next log seq");
            return;
        }
    };
    if let Err(e) = repo.append_log(job_id, seq, stream, &content).await {
        tracing::warn!(
            %job_id, error = ?e,
            "conformance: the gate outcome was NOT recorded on the run — the verdict \
             stands, but an operator reading this run will not see it"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(structure: serde_json::Value) -> GateTarget {
        GateTarget {
            artifact_id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            dataset_id: None,
            structure,
            meta: serde_json::json!({}),
        }
    }

    /// The `evidence` map a REAL gate run returns for `targets` — one non-zero tally per
    /// artifact. Every verdict fixture below needs it, because a verdict without evidence
    /// is (correctly) not a verdict any more: see [`GateEvidence`].
    ///
    /// The numbers are a tally the gate can actually PRODUCE, and that is not pedantry:
    /// this fixture used to read `{checks: 12, arrays: 1, shards: 1, chunks: 1,
    /// decoded_bytes: 4096}` — 12 checks over 3 recorded acts — which is impossible under
    /// either reading of `checks` and so certified a state no gate can reach. Below is one
    /// shard file read (`shards`/`read_bytes`) plus one chunk decompressed out of it
    /// (`chunks`/`decoded_bytes`), which is two completed reads, hence `checks: 2`.
    fn evidence_for(targets: &[GateTarget]) -> serde_json::Value {
        evidence_of(targets, ONE_SHARD_ONE_CHUNK)
    }

    /// A receipt shape, as the gate serializes it: `(checks, shards, chunks, decoded, read)`.
    type Receipt = (u64, u64, u64, u64, u64);

    /// One shard file read plus one chunk decompressed out of it — the `zarr_v3` shape
    /// [`evidence_for`] hands every fixture.
    const ONE_SHARD_ONE_CHUNK: Receipt = (2, 1, 1, 4096, 213);

    /// A 14-byte `opaque` FILE read whole: the SMALLEST receipt a real gate emits, and the
    /// reason the byte counters below are a variable rather than a constant.
    const ONE_SMALL_OPAQUE_READ: Receipt = (1, 0, 0, 0, 14);

    /// **The refuted shape.** An `opaque` DIRECTORY holding two entries, LISTED and never
    /// opened: measured out of the real gate as `checks: 1, shards: 2, chunks: 0,
    /// decoded_bytes: 0, read_bytes: 0`, and it reached `GateOutcome::Conformed{checked: 1}`
    /// through the real `verdict_from_run` + `conclude`. The gate can no longer produce it;
    /// this side no longer accepts it either, and `a_conformed_outcome_implies_every_
    /// artifact_was_read` drives exactly this value to prove the second half.
    const A_LISTING_ONLY: Receipt = (1, 2, 0, 0, 0);

    /// The `evidence` map for `targets`, every artifact carrying `receipt`.
    ///
    /// Parameterized deliberately. [`evidence_for`] pinned `decoded_bytes: 4096` for every
    /// fixture in this module, which made the Conformed arm of
    /// `a_conformed_outcome_implies_every_artifact_was_read` STRUCTURALLY unable to observe
    /// the property it is named for: the only way that arm could have failed is on evidence
    /// whose byte counters are zero, and no test in the file could produce any. The bug it
    /// was blind to shipped and was found by hand.
    fn evidence_of(targets: &[GateTarget], receipt: Receipt) -> serde_json::Value {
        let (checks, shards, chunks, decoded_bytes, read_bytes) = receipt;
        serde_json::Value::Object(
            targets
                .iter()
                .map(|t| {
                    (
                        t.artifact_id.to_string(),
                        serde_json::json!({
                            "checks": checks, "shards": shards, "chunks": chunks,
                            "decoded_bytes": decoded_bytes, "read_bytes": read_bytes
                        }),
                    )
                })
                .collect(),
        )
    }

    /// A pool that NEVER connects, so [`conclude`] can be driven in a unit test.
    ///
    /// Every query through it fails, which is exactly the condition the outcome must be
    /// chosen INDEPENDENTLY of: the arm comes from what the verdict CONCLUDED, never from
    /// what reached the catalog (`a_condemnation_that_did_not_persist_is_still_a_
    /// condemnation`). So a test that cares only about which arm is taken needs no
    /// database, and the security-relevant decision stops being reachable only from a
    /// suite that spawns a server.
    fn offline_pool() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            // Bounded, or a refused connect would be retried until the 30s default.
            .acquire_timeout(Duration::from_millis(250))
            .connect_lazy("postgres://gate-unit-test@127.0.0.1:1/none")
            .expect("a lazy pool is built without connecting")
    }

    // The spec the gate runs under: the reserved verification `code_ref`, one
    // `artifact_ref` input per ingested row bound at its own uuid, and the producer's
    // `structure` carried VERBATIM into the manifest the gate reads.
    //
    // The verbatim leg is the one that matters. If the server ever normalized,
    // defaulted or merged anything into `structure` on the way through, the gate would
    // be checking the bytes against the SERVER's idea of the declaration rather than the
    // producer's — a gate that can never fail the exact class of mismatch it exists for.
    #[test]
    fn the_spec_binds_every_artifact_and_carries_the_declaration_verbatim() {
        let declared = serde_json::json!({
            "encoding": "zarr_v3",
            "kind": "table",
            "n": 8,
            "axis": "rows",
            "columns": [{ "path": "value", "dtype": "float32", "inner_chunk": 4096 }],
        });
        let a = target(declared.clone());
        let b = target(serde_json::json!({ "encoding": "opaque", "media_type": "text/html" }));
        let targets = vec![a.clone(), b.clone()];

        let spec = build_verify_spec(&targets);
        assert_eq!(spec["language"], "python");
        assert_eq!(spec["code_ref"], VERIFY_CONFORMANCE_CODE_REF);
        assert!(spec.get("script").is_none(), "never an inline script");

        let inputs = spec["inputs"].as_array().expect("inputs");
        assert_eq!(inputs.len(), 2, "one input per ingested artifact");
        for (input, t) in inputs.iter().zip(&targets) {
            assert_eq!(input["artifact_ref"], serde_json::json!(t.artifact_id));
            assert_eq!(input["sandbox_subpath"], t.subpath());
            assert!(
                t.subpath().starts_with(&t.artifact_id.to_string()),
                "the mount is still attributable to ONE catalog row"
            );
        }
        // ITEM-23 — the spec's subpath and the MANIFEST's path are the same derived
        // name, and it carries the declared store form. These two agreeing is what
        // makes the checker look where the runner staged; asserted together, because
        // either alone would pass while they disagreed.
        assert_eq!(
            a.subpath(),
            format!("{}.zarr", a.artifact_id),
            "a `zarr_v3` declaration stages under the store form it declares"
        );
        assert_eq!(
            b.subpath(),
            b.artifact_id.to_string(),
            "opaque adds nothing"
        );

        let outputs = spec["params"]["outputs"].as_array().expect("gate manifest");
        assert_eq!(outputs.len(), 2);
        assert_eq!(
            outputs[0]["id"],
            a.artifact_id.to_string(),
            "labelled by row id"
        );
        // The path the CHECKER is told to read == the path the RUNNER will stage at
        // (both `subpath()`), which is the ITEM-23 agreement.
        assert_eq!(outputs[0]["path"], a.subpath());
        assert_eq!(outputs[0]["path"], inputs[0]["sandbox_subpath"]);
        assert_eq!(
            outputs[0]["structure"], declared,
            "the producer's declaration reaches the gate byte-for-byte"
        );
    }

    /// **`meta` reaches the gate, and it is what falsifies a MISSING `structure.key`.**
    ///
    /// `structure.key` is optional, so a producer that omits it drops its artifact out of
    /// the key-digest check AND out of its axis's cross-artifact alignment group — the
    /// mechanism for catching row-order misalignment — by writing nothing at all. The only
    /// thing that refutes the omission is the producer's OTHER declaration on the same row,
    /// `meta.is_axis_index: true` ("this artifact IS the axis"), which is the predicate
    /// `list_dataset_axis_index_candidates` resolves axes by.
    ///
    /// [`build_gate_manifest`] STRIPPED `meta`, so the gate could not make that
    /// cross-check and the pairing existed only as a comment stating its own consequence.
    /// An emitted `/outputs/manifest.json` carries `meta` on every entry, so stripping it
    /// also meant the production gate and `python3 -m conformance` were reading different
    /// documents about the same artifact.
    #[test]
    fn the_gate_manifest_carries_meta_so_a_missing_key_can_be_falsified() {
        let axis_meta = serde_json::json!({ "is_axis_index": true, "name": "cells_index" });
        let mut a = target(serde_json::json!({
            "encoding": "zarr_v3", "kind": "table", "n": 3, "axis": "cells",
            "columns": [{ "path": "values", "kind": "string" }],
        }));
        a.meta = axis_meta.clone();
        let b = target(serde_json::json!({ "encoding": "opaque", "media_type": "text/html" }));

        let outputs = build_gate_manifest(&[a.clone(), b.clone()]);
        let entries = outputs["outputs"].as_array().expect("gate manifest");
        assert_eq!(
            entries[0]["meta"], axis_meta,
            "`meta.is_axis_index` must reach the gate VERBATIM — it is the declaration the \
             gate falsifies a missing `structure.key` against, and stripping it turned an \
             absent key into a silent opt-out from the alignment check (DEC-8)"
        );
        assert_eq!(
            entries[1]["meta"],
            serde_json::json!({}),
            "an empty `meta` is still carried: absence and `{{}}` must not be the same \
             document to the gate"
        );
        // The whole entry shape, so nothing else drifts from what `conform_manifest` reads.
        assert_eq!(
            entries[0]
                .as_object()
                .expect("entry")
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["id", "meta", "path", "structure"],
            "the gate manifest entry is exactly {{id, path, structure, meta}}"
        );
    }

    // A verdict condemns exactly the artifacts it lists — and only ones this batch
    // submitted. An empty violation list is not a condemnation.
    #[test]
    fn a_verdict_condemns_only_what_it_names() {
        let a = target(serde_json::json!({}));
        let b = target(serde_json::json!({}));
        let stranger = Uuid::new_v4();

        let verdict: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "checked": [a.artifact_id.to_string(), b.artifact_id.to_string()],
            "violations": {
                a.artifact_id.to_string(): ["value: does not decode"],
                b.artifact_id.to_string(): [],
                stranger.to_string(): ["not ours"],
            },
            "run_violations": [],
        }))
        .expect("verdict deserializes");

        let condemned = verdict.condemned().expect("every label is an artifact id");
        assert!(condemned.contains(&a.artifact_id), "a violated");
        assert!(
            !condemned.contains(&b.artifact_id),
            "an EMPTY list is not a violation"
        );
        assert!(
            condemned.contains(&stranger),
            "parsed, so `apply_verdict` can refuse it explicitly rather than silently"
        );
        assert_eq!(condemned.len(), 2);
    }

    // A label nobody can attribute is REPORTED, not dropped.
    //
    // This used to be `filter_map(… .ok())` and this file's own test CERTIFIED the drop
    // (`assert_eq!(condemned.len(), 2, "a non-uuid label is not an artifact")`), while the
    // doc claimed the caller reported it. No caller could — so a verdict whose only
    // violations sat under malformed keys sailed past the evidence control (which reads
    // `checked`/`evidence`, never `violations`) and reached `Conformed`: "every ingested
    // artifact conforms" logged over condemned data. The verdict is now refused whole.
    #[test]
    fn a_label_that_is_not_an_artifact_id_is_refused_not_dropped() {
        let a = target(serde_json::json!({}));
        let verdict: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "checked": [a.artifact_id.to_string()],
            "evidence": evidence_for(std::slice::from_ref(&a)),
            "violations": { "not-a-uuid": ["something is wrong with something"] },
            "run_violations": [],
        }))
        .expect("verdict deserializes");

        let err = verdict.condemned().expect_err(
            "an unattributable condemnation is not a conclusion this server can act on",
        );
        assert!(
            err.contains("not-a-uuid") && err.contains("not artifact ids"),
            "the label must be NAMED in the refusal, or it is dropped by another route: {err}"
        );
        // …and the artifact IS accounted for by the evidence control, which is exactly why
        // dropping the key used to end in `Conformed` rather than anywhere visible.
        assert!(verdict.accounts_for(&a.artifact_id.to_string()));
    }

    // `Conformed` implies every artifact's BYTES WERE READ — the property the
    // `examined`-or-condemned disjunction in `accounts_for` must not weaken.
    //
    // `accounts_for` lets a condemned-but-unread artifact through the positive control (a
    // face-refusable declaration is concluded without opening a byte, and demanding a
    // receipt for it would turn a good condemnation into an indeterminate batch). That is
    // safe only because the two branches lead to DIFFERENT OUTCOMES.
    //
    // This test used to restate that rather than test it: its body built two `GateVerdict`s
    // and called only `accounts_for`/`examined`/`condemned`, so the load-bearing step ("a
    // condemnation forces the Violations arm, never Conformed") appeared only inside an
    // `assert!` MESSAGE — a proposition that assertion cannot observe. It now drives the
    // real `conclude` and matches on the real `GateOutcome`, which is where the arm is
    // chosen. `offline_pool` is what makes that reachable without a server: the arm comes
    // from what the verdict CONCLUDED, never from what reached the catalog.
    #[tokio::test]
    async fn a_conformed_outcome_implies_every_artifact_was_read() {
        let a = target(serde_json::json!({}));
        let id = a.artifact_id.to_string();
        let targets = vec![a.clone()];
        let pool = offline_pool();
        let job = Uuid::new_v4();

        let verdict_with = |receipt| {
            serde_json::json!({
                "schema": 1,
                "checked": [id.clone()],
                "evidence": evidence_of(&targets, receipt),
                "violations": {},
                "run_violations": [],
            })
        };

        // (1) READ + no violation ⇒ Conformed. The positive control: without it, an
        // implementation that never returns Conformed satisfies every other leg.
        //
        // Driven over the receipt SHAPES a real gate emits, not one hardcoded fixture. The
        // second is the smallest of them (a 14-byte `opaque` file), and it matters that the
        // arm is exercised by a value whose byte counters are a variable: with `evidence_for`
        // alone this leg could only ever be fed `decoded_bytes: 4096`, which is why leg (1b)
        // below — a receipt that IS zero — was unreachable and the bug it describes shipped.
        for receipt in [ONE_SHARD_ONE_CHUNK, ONE_SMALL_OPAQUE_READ] {
            let clean: GateVerdict = serde_json::from_value(verdict_with(receipt)).unwrap();
            assert!(clean.examined(&id), "{receipt:?} is a completed read");
            assert_eq!(
                conclude(&pool, job, job, &targets, Ok(clean)).await,
                GateOutcome::Conformed { checked: 1 },
                "a verdict that read the bytes and named nothing is the ONLY way to \
                 Conformed ({receipt:?})"
            );
        }

        // (1b) A RECEIPT WITH NO BYTES BEHIND IT ⇒ never Conformed.
        //
        // `A_LISTING_ONLY` is not invented for this test: it is the tally the gate really
        // returned for an `opaque` DIRECTORY, whose two entries it LISTED and never opened,
        // and this arm really did answer `Conformed { checked: 1 }` for it. The gate can no
        // longer produce it — its `enumerated` verb is deleted — and `examined` no longer
        // accepts it, so the property holds even if a future gate regresses again. Without
        // this leg the Conformed arm cannot observe its own name.
        let listing_only: GateVerdict =
            serde_json::from_value(verdict_with(A_LISTING_ONLY)).unwrap();
        assert!(
            !listing_only.examined(&id) && !listing_only.accounts_for(&id),
            "`checks: 1` over a directory LISTING is not a read of the artifact's bytes"
        );
        let refused = verdict_from_run_refusal(&targets, &verdict_with(A_LISTING_ONLY)).await;
        match conclude(&pool, job, job, &targets, Err(refused)).await {
            GateOutcome::Indeterminate { reason } => assert!(
                reason.contains(&id),
                "the artifact whose receipt carried no bytes must be named: {reason}"
            ),
            other => {
                panic!("a receipt with zero bytes behind it must NOT reach Conformed: {other:?}")
            }
        }

        // (2) CONDEMNED WITHOUT A RECEIPT ⇒ Violations, never Conformed. This is the leg
        // `accounts_for`'s disjunction makes possible, and the whole reason it is safe.
        let condemned_only: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "checked": [],
            "evidence": {},
            "violations": { id.clone(): ["structure declares no `encoding`"] },
            "run_violations": [],
        }))
        .unwrap();
        assert!(
            condemned_only.accounts_for(&id) && !condemned_only.examined(&id),
            "a condemnation accounts for an artifact whose bytes were never read"
        );
        match conclude(&pool, job, job, &targets, Ok(condemned_only)).await {
            GateOutcome::Violations { unpersisted, .. } => assert_eq!(
                unpersisted,
                vec![a.artifact_id],
                "the offline pool cannot write, and the condemnation still stands"
            ),
            other => panic!(
                "a condemned artifact must force the Violations arm of `conclude`: {other:?}"
            ),
        }

        // (3) NO RECEIPT AND NO VIOLATION ⇒ Indeterminate. Silence is not a conclusion, and
        // this is where an artifact with NOTHING TO READ (an `n=0` member, an emptied
        // directory, bytes the OS refuses) lands: `verdict_from_run` refuses the verdict, so
        // the row keeps the status ingest gave it rather than being passed OR condemned.
        let silent_json = serde_json::json!({
            "schema": 1, "checked": [id.clone()], "evidence": {}, "violations": {},
        });
        let silent: GateVerdict = serde_json::from_value(silent_json.clone()).unwrap();
        assert!(
            !silent.accounts_for(&id),
            "a `checked` listing with no evidence and no violation is silence, and silence \
             is not a conclusion"
        );
        let refused = verdict_from_run_refusal(&targets, &silent_json).await;
        match conclude(&pool, job, job, &targets, Err(refused)).await {
            GateOutcome::Indeterminate { reason } => assert!(
                reason.contains(&id),
                "the artifact nothing was read for must be named: {reason}"
            ),
            other => panic!("silence must not be a verdict about the bytes: {other:?}"),
        }
    }

    /// The refusal [`verdict_from_run`] produces for the verdict document `verdict`,
    /// obtained by running the real thing over a staged run rather than by re-spelling its
    /// message here.
    ///
    /// Panics if the verdict is NOT refused — so this helper cannot quietly turn a verdict
    /// the accounting accepts into an indeterminate outcome.
    async fn verdict_from_run_refusal(
        targets: &[GateTarget],
        verdict: &serde_json::Value,
    ) -> String {
        let root = std::env::temp_dir().join(format!("gate-accounting-{}", Uuid::new_v4()));
        let staging = root.join("staging");
        let inputs = root.join("inputs");
        let outputs = crate::modules::sandbox::outputs::outputs_dir(&staging);
        std::fs::create_dir_all(&inputs).expect("inputs");
        std::fs::create_dir_all(&outputs).expect("outputs");
        std::fs::write(inputs.join("params.json"), b"{}").expect("params");
        for t in targets {
            std::fs::write(inputs.join(t.subpath()), b"staged bytes").expect("staged");
        }
        std::fs::write(
            outputs.join("verdict.json"),
            serde_json::to_vec(verdict).unwrap(),
        )
        .expect("verdict");
        let refusal = verdict_from_run(&root, &staging, targets)
            .await
            .err()
            .expect("the accounting must refuse a verdict that reached no conclusion");
        let _ = std::fs::remove_dir_all(&root);
        refusal
    }

    // An internal gate failure is NOT a verdict about the bytes: it carries `error`, and
    // `run_gate` turns that into `Err` so the caller leaves every status alone.
    #[test]
    fn an_internal_gate_failure_is_not_a_verdict() {
        let verdict: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1, "error": "the conformance module did not import: No module named 'conformance'"
        }))
        .expect("error verdict deserializes");
        assert!(verdict.error.is_some());
        assert!(
            verdict.condemned().expect("no labels at all").is_empty(),
            "a crashed checker condemns nothing"
        );
    }

    // An empty batch never spawns anything (the ingest of a run that produced nothing).
    #[tokio::test]
    async fn an_empty_batch_is_a_no_op() {
        let verdict = GateVerdict::default();
        assert!(verdict.condemned().expect("no labels at all").is_empty());
        assert!(build_verify_spec(&[])["inputs"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    // Every number the gate takes the trouble to send arrives here and is READ by something.
    //
    // Three of them were not. `violation_counts` — the untruncated per-artifact count, whose
    // whole purpose is to survive the 50-violation cap — was not declared on `GateVerdict`,
    // so serde discarded it and "how bad" was lost exactly when it mattered. And
    // `shards`/`chunks` were deserialized and read by nothing at all: `examined` looked only
    // at `checks`, `log_line` at none of them, and the verdict FILE that supposedly carried
    // them for an operator is removed by `run_gate`'s `cleanup` on every return path.
    //
    // A field written by one process and read by none is a claim nobody can check, which is
    // the same defect as a guard nobody runs. This asserts the wire survives the boundary
    // and that `work_done` — what `conclude` logs — actually adds up what arrived.
    #[test]
    fn every_number_the_gate_sends_is_received_and_read() {
        let a = target(serde_json::json!({}));
        let b = target(serde_json::json!({}));
        let targets = vec![a.clone(), b.clone()];
        let verdict: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "checked": [a.artifact_id.to_string(), b.artifact_id.to_string()],
            "evidence": evidence_of(&targets, ONE_SHARD_ONE_CHUNK),
            "violations": { a.artifact_id.to_string(): ["one of very many"] },
            // The gate emits this whole, while `violations` above is capped at 50.
            "violation_counts": { a.artifact_id.to_string(): 317 },
            "run_violations": [],
        }))
        .expect("verdict deserializes");

        assert_eq!(
            verdict.violation_counts.get(&a.artifact_id.to_string()),
            Some(&317),
            "the untruncated count must SURVIVE the process boundary — undeclared, serde \
             drops it silently and the cap loses the only number it exists to preserve"
        );
        let (checks, shards, chunks, decoded, read) = ONE_SHARD_ONE_CHUNK;
        assert_eq!(
            verdict.work_done(),
            GateEvidence {
                checks: checks * 2,
                shards: shards * 2,
                chunks: chunks * 2,
                decoded_bytes: decoded * 2,
                read_bytes: read * 2,
            },
            "the run total `conclude` logs is the SUM over artifacts; two identical \
             receipts must not read as one"
        );
    }

    // The same cap, the same lost number, on the RUN-level list — where `violation_counts`
    // never reached, because it is built from the per-ARTIFACT map only.
    //
    // `conclude` logged `run_violations.len()` and put it in `GateOutcome::Violations`, so
    // the figure an operator reads was the number of strings that SURVIVED the gate's 50-cap,
    // not the number found — it silently stopped being the count exactly when the batch was
    // worst. `run_violation_total` reads the count the gate now emits whole, and falls back
    // to the list length for a gate too old to emit one.
    #[test]
    fn the_run_level_violation_count_survives_the_gates_cap() {
        let capped: Vec<String> = (0..50).map(|i| format!("run finding #{i}")).collect();
        let verdict: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "run_violations": capped,
            "run_violation_count": 56,
        }))
        .expect("verdict deserializes");
        assert_eq!(verdict.run_violations.len(), 50, "the STRINGS are capped");
        assert_eq!(
            verdict.run_violation_total(),
            56,
            "the COUNT must not be: `run_violations.len()` reports the survivors of the cap, \
             which understates the run precisely when it is worst"
        );

        // A gate that does not emit the field reports what it always reported — never less.
        let old: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "run_violations": ["one finding"],
        }))
        .expect("verdict deserializes");
        assert_eq!(old.run_violation_total(), 1);
        // …and a count SMALLER than the list that arrived cannot shrink it either.
        let inconsistent: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "run_violations": ["a", "b", "c"],
            "run_violation_count": 1,
        }))
        .expect("verdict deserializes");
        assert_eq!(
            inconsistent.run_violation_total(),
            3,
            "a total below the strings actually delivered is not a total"
        );
    }

    // A verdict that examined NOTHING deserializes to the same empty `violations` map a
    // clean verdict does. `verdict_from_run` refuses it (see the positive-control
    // block there); this pins the discriminator the refusal is built on, so a future edit
    // that drops it from the wire fails here rather than silently turning every run green.
    //
    // The discriminator is `checked` AND its `evidence` tally. A `checked` list on its own
    // proved nothing, because the gate built it by copying the ids out of the manifest THIS
    // SERVER sent — so the third case below (a full `checked` list with no evidence behind
    // it) is the exact verdict a gate that read nothing used to return, and it must not
    // count as an examination.
    #[test]
    fn a_clean_verdict_and_an_empty_one_are_distinguishable() {
        let a = target(serde_json::json!({}));
        let id = a.artifact_id.to_string();
        let clean: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1,
            "checked": [id.clone()],
            "evidence": evidence_for(std::slice::from_ref(&a)),
            "violations": {},
        }))
        .unwrap();
        let vacuous: GateVerdict =
            serde_json::from_value(serde_json::json!({ "schema": 1, "violations": {} })).unwrap();
        let unearned: GateVerdict = serde_json::from_value(serde_json::json!({
            "schema": 1, "checked": [id.clone()], "evidence": {}, "violations": {},
        }))
        .unwrap();

        assert!(
            clean.condemned().expect("uuid labels").is_empty()
                && vacuous.condemned().expect("no labels at all").is_empty()
        );
        assert_eq!(clean.checked, vec![id.clone()]);
        assert!(
            clean.examined(&id),
            "a listing WITH a non-zero tally is an examination"
        );
        assert!(
            vacuous.checked.is_empty() && !vacuous.examined(&id),
            "the thing separating `everything conformed` from `nothing was looked at` is \
             `checked` + its evidence — both must survive the wire"
        );
        assert!(
            !unearned.examined(&id),
            "a `checked` list with no evidence behind it is what a gate that read nothing \
             returns — the field used to be copied straight out of the manifest the server \
             sent, so listing alone can never be the proof"
        );
    }

    // ── the outcome record: fail-open, but never SILENTLY ────────────────────
    //
    // An indeterminate outcome leaves every status alone — correct, and the reason the
    // enforcement used to vanish without a sound when a host had no sandbox. The wording
    // below is what an operator reads on the run, so it is pinned here rather than left
    // to whoever next edits a format string.

    #[test]
    fn the_three_outcomes_render_records_nobody_can_confuse() {
        let targets = vec![target(serde_json::json!({})), target(serde_json::json!({}))];

        let (stream, ok) = GateOutcome::Conformed { checked: 2 }.log_line(&targets);
        assert_eq!(stream, "stdout");
        assert!(ok.contains("OK") && ok.contains('2'));
        assert!(!ok.contains(GATE_LOG_UNVERIFIED) && !ok.contains("FAILED"));

        let (stream, bad) = GateOutcome::Violations {
            failed: vec![targets[0].artifact_id],
            unpersisted: vec![],
            run_violations: 1,
        }
        .log_line(&targets);
        assert_eq!(stream, "stderr");
        assert!(bad.contains("FAILED") && bad.contains(&targets[0].artifact_id.to_string()));
        assert!(
            !bad.contains(&targets[1].artifact_id.to_string()),
            "a verdict names the rows it condemned, not the whole batch"
        );
        assert!(!bad.contains(GATE_LOG_UNVERIFIED));
        assert!(
            !bad.contains("CONDEMNED but"),
            "with nothing unpersisted the record must not hint at a write failure"
        );

        let (stream, unverified) = GateOutcome::Indeterminate {
            reason: "the analysis sandbox is not available".into(),
        }
        .log_line(&targets);
        assert_eq!(stream, "stderr");
        assert!(unverified.contains(GATE_LOG_UNVERIFIED) && unverified.contains("UNCHECKED"));
        assert!(
            unverified.contains("the analysis sandbox is not available"),
            "an operator needs the REASON, not just the fact"
        );
        assert!(
            !unverified.contains("FAILED"),
            "'nothing verified this' must not read as 'this is bad' — that is the \
             distinction the whole fail-open shape rests on"
        );
        for t in &targets {
            assert!(
                unverified.contains(&t.artifact_id.to_string()),
                "every UNVERIFIED artifact is named: 'something in this run is \
                 unverified' is not actionable"
            );
        }
    }

    #[test]
    fn only_a_reached_verdict_counts_as_one() {
        assert!(GateOutcome::Conformed { checked: 1 }.is_verdict());
        assert!(GateOutcome::Violations {
            failed: vec![Uuid::new_v4()],
            unpersisted: vec![],
            run_violations: 0
        }
        .is_verdict());
        assert!(
            !GateOutcome::Indeterminate {
                reason: "no sandbox".into()
            }
            .is_verdict(),
            "a gate that could not run has not judged the bytes — treating this as a \
             verdict is exactly the false statement DEC-12 forbids, pointed the other way"
        );
    }

    // ── the infrastructure fault that wore a verdict's clothes ────────────────

    /// Stage the classifier fixture in the TWO-TREE shape a production run has
    /// (ITEM-17), which is the shape [`verdict_from_run`] takes: `inputs/params.json`
    /// plus one staged path per target in the WORKSPACE, and the verdict under
    /// `outputs/` in a separate output STAGING tree. Returns `(workspace, staging)`.
    ///
    /// The two halves are read by different legs of the classifier — `staging_fault`
    /// looks only at the workspace, `read_verdict` only at the staging — so a fixture
    /// that hands one dir to both cannot show either leg reading the dir it was given.
    async fn stage_run_dirs(
        targets: &[GateTarget],
        verdict: serde_json::Value,
        dir_targets: &[Uuid],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let run = Uuid::new_v4();
        let base = std::env::temp_dir().join(format!("conformance-run-{run}"));
        let ws = base.join("sandboxes").join(run.to_string());
        let staging = base.join("run-staging").join(run.to_string());
        let inputs = ws.join("inputs");
        let outputs = crate::modules::sandbox::outputs::outputs_dir(&staging);
        tokio::fs::create_dir_all(&inputs)
            .await
            .expect("inputs dir");
        tokio::fs::create_dir_all(&outputs)
            .await
            .expect("outputs dir");
        tokio::fs::write(inputs.join("params.json"), b"{}")
            .await
            .expect("params.json");
        for t in targets {
            if dir_targets.contains(&t.artifact_id) {
                let dir = inputs.join(t.subpath());
                tokio::fs::create_dir_all(&dir).await.expect("staged dir");
                tokio::fs::write(dir.join("zarr.json"), b"{}")
                    .await
                    .expect("staged member");
            } else {
                tokio::fs::write(inputs.join(t.subpath()), b"declared bytes")
                    .await
                    .expect("staged blob");
            }
        }
        tokio::fs::write(
            outputs.join("verdict.json"),
            serde_json::to_vec(&verdict).unwrap(),
        )
        .await
        .expect("verdict.json");
        (ws, staging)
    }

    /// Bytes the server staged going missing is an INFRASTRUCTURE FAULT, not a verdict.
    ///
    /// `conformance.py` reports an unreachable `/inputs/<id>` as an ordinary per-artifact
    /// violation (`declared bytes are missing at …`, `error: None`, exit 1). That verdict
    /// is indistinguishable at the wire from "these bytes disagree with their declaration",
    /// so it used to CONDEMN — and the trigger was real: the boot sweep could delete a
    /// live verification's workspace out from under it. Bytes are hardlinked out of the
    /// content-addressed pool BY THE SERVER, so their absence can only be a staging fault.
    ///
    /// The NEGATIVE CONTROL is the whole point: the identical verdict over intact staging
    /// is still believed and still condemns. Otherwise this test would pass against a
    /// change that simply stopped the gate condemning anything.
    #[tokio::test]
    async fn missing_staged_bytes_are_an_infrastructure_fault_not_a_condemnation() {
        let a = target(serde_json::json!({ "encoding": "opaque", "media_type": "text/plain" }));
        let b = target(serde_json::json!({ "encoding": "opaque", "media_type": "text/plain" }));
        let targets = vec![a.clone(), b.clone()];
        // Verbatim the shape `verify_conformance.py` writes when the bytes are not there —
        // `evidence` included, since the entry emits it for every artifact it examined and
        // `verdict_from_run`'s positive control now requires it.
        let condemning = serde_json::json!({
            "schema": 1,
            "checked": [a.artifact_id.to_string(), b.artifact_id.to_string()],
            "evidence": evidence_for(&targets),
            "violations": {
                a.artifact_id.to_string(): [
                    format!("{}: declared bytes are missing at /inputs/{}", a.artifact_id, a.artifact_id)
                ],
            },
            "run_violations": [],
        });

        // (1) POSITIVE CONTROL — intact staging: the verdict is reached and it condemns.
        let (ws, stg) = stage_run_dirs(&targets, condemning.clone(), &[]).await;
        let verdict = verdict_from_run(&ws, &stg, &targets)
            .await
            .expect("intact staging yields a verdict");
        assert_eq!(
            verdict.condemned().expect("uuid labels"),
            vec![a.artifact_id],
            "the gate must still condemn on a reached verdict"
        );
        assert!(staging_fault(&ws, &targets).await.is_none());

        // (2) THE FIX — the same verdict, with the bytes made unreachable. The loss is
        // in the WORKSPACE and the verdict is in the staging tree, untouched: an intact
        // condemning verdict over destroyed inputs is exactly the pair that has to be
        // classified as a fault rather than believed.
        tokio::fs::remove_file(ws.join("inputs").join(a.subpath()))
            .await
            .expect("make the staged bytes unreachable");
        let reason = verdict_from_run(&ws, &stg, &targets).await.expect_err(
            "missing staged bytes must NOT be reported as a verdict — the artifacts \
                 would be marked `failed` on the strength of an infrastructure fault",
        );
        assert!(
            reason.contains(&a.artifact_id.to_string()) && reason.contains("staging fault"),
            "the reason must name the artifact and say it is a staging fault: {reason}"
        );

        // (3) …and the same for an EMPTIED directory artifact, which is what a
        // `remove_dir_all` over a workspace with busy bind mounts actually leaves.
        let (ws2, stg2) = stage_run_dirs(&targets, condemning, &[b.artifact_id]).await;
        assert!(verdict_from_run(&ws2, &stg2, &targets).await.is_ok());
        tokio::fs::remove_file(ws2.join("inputs").join(b.subpath()).join("zarr.json"))
            .await
            .expect("empty the staged directory");
        let reason = verdict_from_run(&ws2, &stg2, &targets)
            .await
            .expect_err("an emptied staged directory is a staging fault too");
        assert!(reason.contains("EMPTY"), "{reason}");

        // (4) The declaration document going missing is the same class.
        let (ws3, stg3) = stage_run_dirs(&targets, serde_json::json!({ "schema": 1 }), &[]).await;
        tokio::fs::remove_file(ws3.join("inputs").join("params.json"))
            .await
            .expect("remove params.json");
        assert!(verdict_from_run(&ws3, &stg3, &targets)
            .await
            .is_err_and(|r| r.contains("params.json")));

        // (5) The failure mode that only EXISTS once the two trees are separable:
        // intact inputs, but the run's STAGING tree gone. It must classify as "no
        // verdict" — the run was not judged — and NOT as an input-staging fault, so
        // the two indeterminate channels stay distinguishable to an operator. A
        // co-located fixture could not even construct this case: removing "the dir"
        // took the inputs with it and always produced a staging fault.
        //
        // What kills a classifier that reads the verdict from the WORKSPACE is case
        // (1), not this one — under the old single-dir fixture both reads hit the
        // same path, so that mutation was invisible. Verified by mutation.
        let (ws4, stg4) = stage_run_dirs(&targets, serde_json::json!({ "schema": 1 }), &[]).await;
        tokio::fs::remove_dir_all(&stg4)
            .await
            .expect("remove the output staging tree");
        let reason = verdict_from_run(&ws4, &stg4, &targets)
            .await
            .expect_err("a run whose verdict is gone has not been judged");
        assert!(
            reason.contains("wrote no verdict"),
            "losing the STAGING tree is a missing verdict, not an input-staging fault — \
             the two legs read different trees: {reason}"
        );
        assert!(
            staging_fault(&ws4, &targets).await.is_none(),
            "the inputs are intact; only the verdict is gone"
        );

        for dir in [ws, ws2, ws3, ws4, stg, stg2, stg3] {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }

    // ── the outcome comes from the CONCLUSION, not from what persisted ────────

    /// A condemning verdict whose status writes all failed must never render `OK`.
    ///
    /// The branch used to be chosen from the flipped list, so a `set_status` error dropped
    /// the row and the run recorded `conformance: OK — N artifact(s) verified` over data
    /// the gate had condemned. That inverted the meaning of the one line an operator reads.
    #[test]
    fn a_condemnation_that_did_not_persist_is_still_a_condemnation() {
        let a = target(serde_json::json!({}));
        let b = target(serde_json::json!({}));
        let targets = vec![a.clone(), b.clone()];

        // Every condemnation failed to write: `flipped` is EMPTY, which is exactly the
        // shape that used to read as a clean pass.
        let all_failed_to_write = GateOutcome::Violations {
            failed: vec![],
            unpersisted: vec![a.artifact_id],
            run_violations: 0,
        };
        let (stream, line) = all_failed_to_write.log_line(&targets);
        assert_eq!(stream, "stderr");
        assert!(
            !line.contains("OK"),
            "a condemning verdict whose writes all failed must not read as OK: {line}"
        );
        assert!(
            line.contains("FAILED") && line.contains("CONDEMNED but"),
            "the record must say the rows were condemned AND that the write did not \
             persist: {line}"
        );
        assert!(
            line.contains(&a.artifact_id.to_string()),
            "…naming the rows that are still `ready`: {line}"
        );
        assert!(all_failed_to_write.is_verdict(), "it IS a verdict");

        // The partial case names both sets, and does not fold the unwritten ones into the
        // "were marked failed" count.
        let (_, mixed) = GateOutcome::Violations {
            failed: vec![a.artifact_id],
            unpersisted: vec![b.artifact_id],
            run_violations: 0,
        }
        .log_line(&targets);
        assert!(
            mixed.contains("1 artifact(s) do not conform") && mixed.contains("1 further"),
            "{mixed}"
        );
    }

    /// `VerdictApplication` keeps the conclusion and the write apart, which is the datum
    /// `conclude` branches on. A verdict naming a stranger row contributes to neither.
    #[test]
    fn an_application_records_the_conclusion_separately_from_the_write() {
        let applied = VerdictApplication {
            condemned: vec![Uuid::new_v4(), Uuid::new_v4()],
            flipped: vec![Uuid::new_v4()],
            unpersisted: vec![Uuid::new_v4()],
        };
        assert_eq!(applied.condemned.len(), 2);
        assert!(
            !applied.condemned.is_empty(),
            "`conclude` branches on this, never on `flipped` — an empty `flipped` with a \
             non-empty `condemned` is the write-failure case that used to report OK"
        );
        assert_eq!(VerdictApplication::default().condemned.len(), 0);
    }
}
