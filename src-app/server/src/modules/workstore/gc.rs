//! Standing content-addressed blob-GC union sweep (ITEM-14, the P1 half of the
//! DEC-13 seam split). A boot-time + periodic (~`gc_interval_hours`) sweep that
//! reclaims blobs referenced by NO live table. It re-derives orphans from the
//! live referencing tables, so it needs NO `GcManifest` — the manifest that
//! P10's `on_project_deleted` collects is a delete-time OPTIMIZATION; this sweep is
//! the safety net that reclaims blobs after a crash or an orphaned staging temp.
//!
//! **Separate physical stores.** The workstore has its OWN blob store
//! (`<root>/workstore/blobs`), distinct from txresbench-file's (`<root>/files`), so the
//! workstore GC union is the workstore's own referencing tables. `blob_refs()`
//! is the ONE enumeration point (so adding P4's run-artifact link table can't be
//! forgotten); txresbench-file `files.checksum` is documented as an additional source
//! for the day a physical store is shared.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::catalog::repository::{BlobRefRow, CatalogRepository};
use super::object_store::{decode_manifest, ContentKey, GcReport, ObjectStore};
use super::partition::StoreClaim;
use super::presence::presence_of_key;
use super::settings::WorkstoreSettings;

/// Build the live keep-set from the catalog's blob refs. `resolve_members` maps a
/// multi-file artifact's manifest key to its member blob keys — injected so this
/// is unit-testable without a store (ITEM-14 reachability). The keep-set is the
/// UNION every referencing table contributes (the `blob_refs()` registry).
///
/// **`resolve_members` returns a `Result`, and the failure PROPAGATES.** That is
/// the whole point of the signature: this function's output decides what gets
/// UNLINKED, so a resolver that could answer "I don't know" with an empty list
/// would silently produce a keep-set missing live members, and the sweep would
/// free them. There is no safe way to fold "I could not enumerate" into a
/// membership answer — the only correct outcome is that no keep-set is produced
/// at all and the caller abandons the sweep.
///
/// ## Why not sweep the part it CAN attribute
///
/// The obvious relief for a store that has stopped reclaiming — free the blobs we
/// are sure about, refuse the rest — has no safe version, and the reason is
/// structural rather than a matter of care:
///
/// * A sweep frees the COMPLEMENT of the keep-set. Blobs an unreadable manifest
///   makes unnameable are, by construction, in that complement.
/// * They cannot be excluded, because excluding them means naming them, which is
///   the operation that just failed. Nothing else distinguishes them: a
///   content-addressed member blob is bytes under a hash, indistinguishable from an
///   orphan by age, size, path or content.
/// * Restricting the free to blobs some OTHER manifest names buys nothing — those
///   are already IN the keep-set and were never candidates.
/// * "The manifest is absent, so its members are probably gone too" is a guess, and
///   the case where it is wrong is the recoverable one: a partial restore that
///   brought back members before their manifest, whose members a partial sweep would
///   then destroy for good.
///
/// So the safe partial sweep is the empty sweep, and the honest thing to do with a
/// store that cannot be enumerated is to say so — see [`SweepDiagnosis`].
pub fn keep_set(
    refs: &[BlobRefRow],
    mut resolve_members: impl FnMut(&str) -> Result<Vec<String>, AppError>,
) -> Result<HashSet<String>, AppError> {
    let mut keep = HashSet::new();
    for r in refs {
        // Every artifact keeps its object_key (a data blob, or a manifest blob).
        keep.insert(r.object_key.clone());
        if r.is_multifile {
            // A multi-file artifact also keeps every member blob.
            for m in resolve_members(&r.object_key)? {
                keep.insert(m);
            }
        }
    }
    // (Future referencing tables enumerated HERE — the single registry point:
    //  txresbench-file `files.checksum` (if a shared store), P4 run-artifact links.)
    Ok(keep)
}

/// Resolve a manifest blob to its member blob keys.
///
/// **Every failure is an `Err` — a missing, unreadable or corrupt manifest never
/// degrades to "this artifact has no members."** It previously did, and the
/// consequence was data loss rather than a stale sweep: [`keep_set`] folded the
/// empty list straight into the keep-set, [`ObjectStore::gc`] unlinks everything
/// NOT in the keep-set, and so an artifact whose manifest could not be read had
/// its member blobs freed while the artifact row stayed live. The comment that
/// stood here claimed the members were "left to a later sweep"; there was nothing
/// left to sweep.
///
/// The `Err` wedges the sweep for as long as the manifest stays unreadable, which
/// is deliberate: a sweep is a space OPTIMISATION and its failure is loud,
/// logged and retried every cycle, while the alternative is an unrecoverable
/// delete. Uncertainty is not a licence to reclaim.
///
/// The error is returned bare — it names a `sha256:…` and nothing else, which is
/// all this function knows. Turning it into something an operator can act on is
/// [`enumerate_members`]' job, and that is the only place that speaks: a
/// per-manifest log here as well would be a second voice saying a worse version of
/// the same thing, once per broken manifest.
pub(crate) async fn members_of(
    store: &dyn ObjectStore,
    manifest_key: &str,
) -> Result<Vec<String>, AppError> {
    let key = ContentKey::parse(manifest_key);
    let bytes = store.get(&key).await?;
    decode_manifest(&bytes).map(|m| m.into_values().collect())
}

// ---------------------------------------------------------------------------
// The diagnosis: what the sweep says when it cannot enumerate
// ---------------------------------------------------------------------------

/// One artifact the sweep could not enumerate, described in
/// [`super::presence`]'s vocabulary.
///
/// The fields are deliberately the ones
/// [`ArtifactBytesRow`](super::presence::ArtifactBytesRow) carries: the same
/// question is being answered ("are this artifact's bytes in this store?") and it
/// must not get two different answers depending on which surface asked.
#[derive(Debug, Clone)]
pub struct UnenumerableArtifact {
    pub artifact_id: Uuid,
    /// The project whose `GET /projects/{id}/artifacts/bytes-presence` lists this
    /// row alongside every other affected one. `None` for a dataset-scoped artifact.
    pub project_id: Option<Uuid>,
    /// The producer's own id for this output — how a person recognises it.
    pub output_id: String,
    /// The manifest blob whose members could not be named.
    pub object_key: String,
    /// `present` | `absent` | `indeterminate` — [`BytesPresence::label`](super::presence::BytesPresence::label).
    ///
    /// `present` is a real outcome, not a contradiction: the enumerating read can
    /// fail transiently and a re-check a moment later find the manifest right there.
    /// Saying so is the point — it tells the operator this one is a hiccup, not a
    /// hole in their store.
    pub presence: String,
    /// The presence report's plain-language sentence for `presence`. Says the bytes
    /// are not in THIS STORE; never asserts that anything removed them.
    pub detail: String,
    /// What the enumerating read itself returned, preserved verbatim.
    pub cause: String,
}

/// Why a sweep was abandoned, as something an operator can act on.
///
/// The sweep's failure used to reach a human as `sweep failed; will retry` — a
/// statement about the SWEEPER. This is the statement about their DATA that was
/// missing: which artifacts have no readable manifest, whether that is an absence
/// or a fault, which projects to look in, and that nothing was (or will be)
/// reclaimed until it is resolved.
#[derive(Debug, Clone)]
pub struct SweepDiagnosis {
    /// Every blob reference the keep-set pass looked at.
    pub refs_checked: usize,
    /// The subset it could not enumerate — one entry per affected CATALOG ROW, so a
    /// single missing manifest shared by three artifacts reports all three.
    pub unenumerable: Vec<UnenumerableArtifact>,
}

/// How many affected artifacts the summary names before it stops and defers to the
/// per-project report. The presence module's rule, restated: this is a diagnosis,
/// not an inventory — and an 89-artifact incident must not produce a log line no
/// one reads.
const NAMED_IN_SUMMARY: usize = 5;

impl SweepDiagnosis {
    fn count_labelled(&self, label: &str) -> usize {
        self.unenumerable
            .iter()
            .filter(|u| u.presence == label)
            .count()
    }

    /// Artifacts whose bytes are NOT in this store.
    pub fn absent(&self) -> usize {
        self.count_labelled("absent")
    }

    /// Artifacts the store could not answer for. Its own counter, never folded into
    /// [`Self::absent`]: "I could not look" and "it is not here" are different facts
    /// and only one of them is about the operator's data.
    pub fn indeterminate(&self) -> usize {
        self.count_labelled("indeterminate")
    }

    /// The distinct projects to point the operator at, in first-seen order.
    pub fn projects(&self) -> Vec<Uuid> {
        let mut seen = HashSet::new();
        self.unenumerable
            .iter()
            .filter_map(|u| u.project_id)
            .filter(|p| seen.insert(*p))
            .collect()
    }

    /// The operator-facing explanation: what could not be enumerated, why, what the
    /// consequence is, and where to see the rest.
    pub fn summary(&self) -> String {
        let named: Vec<String> = self
            .unenumerable
            .iter()
            .take(NAMED_IN_SUMMARY)
            .map(|u| {
                let project = u
                    .project_id
                    .map(|p| format!(" in project {p}"))
                    .unwrap_or_default();
                format!(
                    "artifact {} \"{}\"{project} [{}]: {} — its manifest blob is {} \
                     (the enumerating read returned: {})",
                    u.artifact_id, u.output_id, u.presence, u.detail, u.object_key, u.cause
                )
            })
            .collect();
        let more = self.unenumerable.len().saturating_sub(named.len());
        let more = if more > 0 {
            format!("; …and {more} more.")
        } else {
            ".".to_string()
        };
        let projects = self.projects();
        let where_to_look = if projects.is_empty() {
            String::new()
        } else {
            let list: Vec<String> = projects.iter().map(|p| p.to_string()).collect();
            format!(
                " GET /api/projects/{{project_id}}/artifacts/bytes-presence lists every \
                 artifact of a project whose bytes are not in this store; affected \
                 projects: {}.",
                list.join(", ")
            )
        };
        format!(
            "workstore.gc: the sweep was ABANDONED and NOTHING was reclaimed. {} of {} \
             cataloged blob references could not be enumerated ({} whose bytes are not in \
             this store, {} the store could not answer for). A multi-file artifact's \
             members are named only by its manifest, so an unreadable manifest leaves the \
             sweep unable to tell those members from orphans — and the only safe \
             complement to unlink is the empty one. No blob will be reclaimed on any \
             cycle until those bytes are back in this store or the affected catalog rows \
             are removed. {}{}{}",
            self.unenumerable.len(),
            self.refs_checked,
            self.absent(),
            self.indeterminate(),
            named.join("; "),
            more,
            where_to_look,
        )
    }

    /// The abandonment, as the error the sweep returns. The message IS the
    /// diagnosis, so every existing caller that logs the error (`spawn_loop`, the
    /// project-delete post-commit path) reports it without knowing this type exists.
    pub fn abandon(&self) -> AppError {
        AppError::internal_error(self.summary())
    }
}

/// Resolve every multi-file ref's member list — or, if ANY of them cannot be
/// resolved, the [`SweepDiagnosis`] for ALL of them.
///
/// The `Err` side is a diagnosis rather than the first `AppError` because that
/// first error is not the extent of the problem: an operator told about one broken
/// artifact fixes it and meets the next one on the following cycle, and the
/// incident this comes from had 83 blobs missing. So the pass runs to completion
/// and reports everything it could not enumerate.
///
/// Only multi-file refs can be unenumerable: a single-file artifact has no member
/// list to resolve, so the sweep never reads its bytes to build the keep-set, and
/// whether they are present is the presence report's business rather than the
/// sweep's.
///
/// Each distinct manifest key is read ONCE and its verdict fanned back out to every
/// catalog row naming it — content-addressed dedup means one absent manifest can
/// affect several artifacts, and each of those is a row the operator has to deal
/// with.
pub(crate) async fn enumerate_members(
    store: &dyn ObjectStore,
    refs: &[BlobRefRow],
) -> Result<HashMap<String, Vec<String>>, SweepDiagnosis> {
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    let mut causes: HashMap<String, String> = HashMap::new();
    for r in refs {
        if !r.is_multifile
            || members.contains_key(&r.object_key)
            || causes.contains_key(&r.object_key)
        {
            continue;
        }
        match members_of(store, &r.object_key).await {
            Ok(m) => {
                members.insert(r.object_key.clone(), m);
            }
            // NOT `?` — see above.
            Err(e) => {
                causes.insert(r.object_key.clone(), e.to_string());
            }
        }
    }
    if causes.is_empty() {
        return Ok(members);
    }
    // WHY each one could not be read, in the presence report's vocabulary — asked
    // once per distinct manifest key.
    let mut verdicts: HashMap<&str, (String, String)> = HashMap::new();
    for key in causes.keys() {
        let p = presence_of_key(store, key, true).await;
        verdicts.insert(key.as_str(), (p.label().to_string(), p.detail()));
    }
    let unenumerable = refs
        .iter()
        .filter_map(|r| {
            let cause = causes.get(&r.object_key)?;
            let (presence, detail) = verdicts.get(r.object_key.as_str())?;
            Some(UnenumerableArtifact {
                artifact_id: r.artifact_id,
                project_id: r.project_id,
                output_id: r.output_id.clone(),
                object_key: r.object_key.clone(),
                presence: presence.clone(),
                detail: detail.clone(),
                cause: cause.clone(),
            })
        })
        .collect();
    Err(SweepDiagnosis {
        refs_checked: refs.len(),
        unenumerable,
    })
}

/// Build the keep-set for `refs` against `store` — the DB-free half of
/// [`GcSweeper::collect_keep`], so the reclamation decision is testable against a
/// real store without a database.
pub(crate) async fn resolve_keep(
    store: &dyn ObjectStore,
    refs: &[BlobRefRow],
) -> Result<HashSet<String>, AppError> {
    // Resolve multi-file members up front (async), then fold synchronously.
    //
    // The refusal on failure is UNCHANGED and must stay so: a keep-set missing live
    // members would have the sweep unlink them, and there is no safe partial answer
    // — members are named only by their manifest, so the blobs an unreadable
    // manifest makes unattributable are exactly the ones the complement would free
    // (see [`keep_set`]'s "Why not sweep the part it CAN attribute"). What changes
    // is that the refusal now explains itself.
    let member_map = enumerate_members(store, refs)
        .await
        .map_err(|diagnosis| diagnosis.abandon())?;
    // A map MISS is an error, not an empty member list — the same rule as
    // `members_of`, restated at the one place a future refactor could reintroduce
    // the swallow by forgetting to pre-resolve a ref.
    keep_set(refs, |k| {
        member_map.get(k).cloned().ok_or_else(|| {
            AppError::internal_error(format!(
                "workstore.gc: members of {k} were never resolved; refusing to build a \
                 keep-set that would treat them as unreferenced"
            ))
        })
    })
}

/// Run one sweep over `store` for an already-read set of `refs`: build the
/// keep-set, then reclaim what it does not cover. The composition
/// [`GcSweeper::sweep`] uses — extracted so the "an unreadable manifest must not
/// free live blobs" property is asserted on the REAL path rather than a
/// test-local replica of it.
pub(crate) async fn sweep_refs(
    store: &dyn ObjectStore,
    refs: &[BlobRefRow],
    min_age_secs: u64,
) -> Result<GcReport, AppError> {
    let keep = resolve_keep(store, refs).await?;
    store.gc(&keep, min_age_secs).await
}

/// The workstore blob-GC sweeper.
pub struct GcSweeper {
    pool: SqlitePool,
    store: Arc<dyn ObjectStore>,
    /// Which catalog owns `store`'s root. A sweeper cannot be built without one:
    /// the keep-set comes from `pool`'s catalog and everything outside it is
    /// unlinked, so a store this catalog does not own is a store whose contents
    /// this sweeper cannot attribute. See `partition`'s module doc — an
    /// unattributable sweep is how a peer worktree's live blobs were freed.
    claim: StoreClaim,
}

impl GcSweeper {
    pub fn new(pool: SqlitePool, store: Arc<dyn ObjectStore>, claim: StoreClaim) -> Self {
        Self { pool, store, claim }
    }

    /// The precondition of every free: this catalog owns the store root, and the
    /// root it owns is the one the store will actually walk. Checked BEFORE any
    /// catalog read, so a sweeper pointed at a store it cannot attribute does not
    /// even query the database.
    async fn verify_ownership(&self) -> Result<(), AppError> {
        self.claim.verify_covers(self.store.store_root()).await
    }

    /// Compute the live keep-set: every live artifact's object_key + (for
    /// multi-file artifacts) every member blob key, resolved via the manifest.
    ///
    /// Fails if ANY manifest cannot be enumerated — see [`members_of`]. A partial
    /// keep-set is worse than none, because the caller unlinks by its complement.
    pub async fn collect_keep(&self) -> Result<HashSet<String>, AppError> {
        let repo = CatalogRepository::new(self.pool.clone());
        let refs = repo.all_blob_refs().await?;
        resolve_keep(self.store.as_ref(), &refs).await
    }

    /// Post-commit refcount-gated free of the blobs a project delete MARKED into
    /// P10's `GcManifest` (ITEM-14, the P10/P1 seam split — DEC-13). Frees a
    /// marked blob ONLY when its hash has no surviving storage-ref in the live
    /// keep-set — so a blob shared by another project's artifact SURVIVES (the
    /// dedup-corruption guard, P10 R1). Only workstore-sourced refs (`source ==
    /// "catalog"`) are freed here; other sources (e.g. txresbench-file dataset matrix
    /// blobs) are the concern of their own store's sweep.
    pub async fn sweep_marked(
        &self,
        manifest: &crate::modules::project::GcManifest,
    ) -> Result<GcReport, AppError> {
        // Same rule as the full sweep: free nothing from a store this catalog
        // does not own. A marked hash is a hash under content-addressed dedup —
        // a peer catalog's live blob can carry the very same one.
        self.verify_ownership().await?;
        let keep = self.collect_keep().await?;
        let mut report = GcReport::default();
        for r in &manifest.refs {
            if r.source != "catalog" {
                continue;
            }
            report.scanned += 1;
            if keep.contains(&r.hash) {
                // Still referenced (e.g. a duplicate project shares the blob) — keep.
                continue;
            }
            let key = ContentKey::parse(&r.hash);
            // Learn the blob's physical length BEFORE unlinking. A blob whose length we cannot
            // read — an already-absent blob (a dedup-shared blob a prior project-delete freed) or
            // a transport blip on the HEAD — yields `None`, and MUST NOT be counted-as-freed or
            // recorded as a byte-delta: `delete` is idempotent (NotFound → Ok), so `is_ok()` alone
            // would count a phantom free, and emitting a −0 delta would assert a FALSE "freed 0
            // bytes of this hash" that breaks the signed-sum-reconciles-to-0 contract (an unknown
            // length leaves the +delta unmatched for T5 to reconcile against live store contents,
            // exactly as the orphan-sweep caveat already does — never a fabricated 0). Mirrors
            // local_fs's `remove_file`, which does not count an absent file.
            let len = match self.store.stat(&key).await {
                Ok(s) => Some(s.len),
                Err(_) => None,
            };
            if self.store.delete(&key).await.is_ok() {
                if let Some(len) = len {
                    report.freed += 1;
                    report.freed_bytes += len;
                }
            }
        }
        if report.freed > 0 {
            tracing::info!(
                freed = report.freed,
                freed_bytes = report.freed_bytes,
                "workstore.gc: post-commit refcount sweep freed marked blobs"
            );
        }
        Ok(report)
    }

    /// Run one full sweep: reclaim every stored blob not in the live keep-set AND
    /// older than the grace window (the crash/orphan backstop).
    ///
    /// Reclaims NOTHING when the keep-set cannot be built in full (an unreadable
    /// manifest, a database error): the sweep returns `Err` and `spawn_loop`
    /// retries on the next cycle. When the cause is an unenumerable artifact, that
    /// `Err` carries a [`SweepDiagnosis`] naming which ones and why — the sweep
    /// stopping is a symptom, and the symptom is not the thing the operator needs
    /// to be told about.
    pub async fn sweep(&self) -> Result<GcReport, AppError> {
        // BEFORE anything is read or unlinked: confirm this catalog still owns
        // the store root. Partitioning should make a mismatch unreachable; if it
        // is ever reachable anyway, the blobs here belong to a catalog whose
        // keep-set we do not have, and the complement we are about to unlink is
        // that catalog's live data.
        self.verify_ownership().await?;
        let repo = CatalogRepository::new(self.pool.clone());
        let refs = repo.all_blob_refs().await?;
        // Read-at-use (INV-4, issue #54): the orphan-grace window (seconds) is the
        // admin setting `gc_grace_secs`. A blob younger than this is spared — it may
        // be a live-but-uncommitted ingest write (ingest `put`s before it commits
        // the catalog row), which is why the setting has a bounded FLOOR (DEC-3).
        // `settings_cache::get` falls back to the compiled default (3600s) on a DB
        // error, so this is byte-preserving when unset (INV-1).
        let grace = super::settings_cache::get(&self.pool).await.gc_grace_secs_u64();
        let report = sweep_refs(self.store.as_ref(), &refs, grace).await?;
        if report.freed > 0 {
            tracing::info!(
                freed = report.freed,
                freed_bytes = report.freed_bytes,
                scanned = report.scanned,
                "workstore.gc: reclaimed orphaned blobs"
            );
        }
        Ok(report)
    }

    /// Spawn the standing periodic sweep (boot-time + every `interval_hours`),
    /// mirroring `mcp/tool_calls/prune.rs`. Best-effort: a sweep error is logged
    /// and the loop continues (the next sweep self-heals).
    ///
    /// The failure log is `error!`, not `warn!`, and it carries the whole diagnosis
    /// rather than a summary of the sweeper's mood. `sweep failed; will retry` was
    /// technically true and told an operator nothing: not that artifacts in their
    /// store have no bytes, and not that reclamation has stopped for as long as that
    /// stays true. Both are in the message now, because
    /// [`SweepDiagnosis::abandon`] puts them there.
    pub fn spawn_loop(self: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                // Read-at-use each cycle (INV-4, issue #54): `gc_enabled` toggles the
                // sweep live and `gc_interval_hours` sets the next cadence — both take
                // effect WITHOUT a server restart. `settings_cache::get` falls back to
                // the compiled defaults on a DB error, so an unset deployment behaves
                // byte-identically to the old fixed loop (INV-1). The loop is spawned
                // unconditionally (DEC-5); a disabled cycle just sleeps.
                let settings = super::settings_cache::get(&self.pool).await;
                let (enabled, period) = gc_cycle_plan(&settings);
                if enabled {
                    if let Err(e) = self.sweep().await {
                        tracing::error!(
                            error = %e,
                            retry_in_hours = settings.gc_interval_hours_u64(),
                            "workstore.gc: sweep abandoned; no blob was reclaimed this cycle"
                        );
                    }
                } else {
                    tracing::debug!("workstore.gc: sweep skipped (gc_enabled=false)");
                }
                tokio::time::sleep(period).await;
            }
        });
    }
}

/// The per-cycle GC decision, read-at-use from the CURRENT settings (INV-4, issue
/// #54): whether the standing loop sweeps this cycle (`gc_enabled`) and how long it
/// sleeps until the next (`gc_interval_hours`). Pure, so the loop's consumption of
/// the live settings is unit-testable without spawning the task.
pub(crate) fn gc_cycle_plan(settings: &WorkstoreSettings) -> (bool, Duration) {
    (
        settings.gc_enabled,
        Duration::from_secs(settings.gc_interval_hours_u64() * 3600),
    )
}

/// Entry point the project-delete chokepoint calls post-commit (P10's
/// `sweep_gc_manifest` delegates here). Builds a sweeper from the global object
/// store + pool and frees the marked, now-unreferenced blobs. If the store isn't
/// initialized (a delete before boot wiring — not a real runtime path), it's a
/// no-op and the standing reaper self-heals.
pub async fn sweep_marked_manifest(
    pool: &SqlitePool,
    manifest: &crate::modules::project::GcManifest,
) -> Result<(), AppError> {
    let Some(store) = super::try_get_object_store() else {
        return Ok(());
    };
    // No boot-installed ownership claim ⇒ no attributable store ⇒ free nothing.
    // Same degradation as a missing store: the standing sweep (which is only
    // spawned WITH a claim) reclaims later.
    let Some(claim) = super::try_get_store_claim() else {
        return Ok(());
    };
    let sweeper = GcSweeper::new(pool.clone(), store, claim);
    sweeper.sweep_marked(manifest).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::workstore::object_store::{
        BlobLink, ByteStream, LocalFsStore, MultiFilePut, ObjectStat,
    };
    use std::path::{Path, PathBuf};

    fn refrow(key: &str, multi: bool) -> BlobRefRow {
        named_refrow(key, multi, "expression")
    }

    // TEST-9 [covers ITEM-6]: the standing GC loop reads `gc_enabled` +
    // `gc_interval_hours` from the CURRENT settings each cycle (read-at-use, INV-4)
    // — flipping either changes the cycle plan WITHOUT a restart.
    #[test]
    fn gc_cycle_plan_reads_live_settings() {
        // Defaults: enabled, 6h cadence.
        let d = WorkstoreSettings::defaults();
        let (enabled, period) = gc_cycle_plan(&d);
        assert!(enabled);
        assert_eq!(period, Duration::from_secs(6 * 3600));

        // gc_enabled=false → the cycle skips the sweep.
        let off = WorkstoreSettings { gc_enabled: false, ..d.clone() };
        assert!(!gc_cycle_plan(&off).0, "a disabled setting skips the sweep this cycle");

        // A changed cadence takes effect on the next cycle's sleep.
        let faster = WorkstoreSettings { gc_interval_hours: 1, ..d.clone() };
        assert_eq!(gc_cycle_plan(&faster).1, Duration::from_secs(3600));

        // A degenerate 0 floors to a 1h period (never a zero-period spin).
        let degenerate = WorkstoreSettings { gc_interval_hours: 0, ..d };
        assert_eq!(gc_cycle_plan(&degenerate).1, Duration::from_secs(3600));
    }

    // TEST-17 [covers ITEM-6]: the full sweep HONORS its grace window — `sweep_refs`
    // passes `min_age_secs` into `store.gc`, so an orphan YOUNGER than the grace is
    // SPARED and (grace disabled) reclaimed: the grace VALUE controls whether a blob
    // is freed. `sweep()` feeds this `min_age_secs` from `gc_grace_secs` via
    // `settings_cache::get` — the SAME read-at-use mechanism TEST-3 proves end-to-end
    // through ingest. (This test exercises the `sweep_refs` primitive directly; it does
    // not re-prove the settings_cache→sweep wiring, which TEST-3 covers.)
    #[tokio::test]
    async fn sweep_refs_honors_grace_window() {
        let dir = std::env::temp_dir().join(format!("txr-gc-grace-{}", uuid::Uuid::new_v4()));
        let store = LocalFsStore::new(dir.clone());
        store.put(b"orphan-bytes").await.expect("put orphan");

        // Empty keep-set → the orphan is a reclaim candidate. A large grace (7 days)
        // spares a just-written blob (younger than the grace).
        let spared = sweep_refs(&store, &[], 604_800).await.expect("sweep (spared)");
        assert_eq!(spared.freed, 0, "a fresh orphan younger than the grace is spared");

        // Grace disabled (0) → the SAME orphan is now reclaimed. The grace value is
        // what changed the outcome — the read-at-use knob is load-bearing.
        let freed = sweep_refs(&store, &[], 0).await.expect("sweep (freed)");
        assert_eq!(freed.freed, 1, "with the grace disabled the orphan is reclaimed");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A ref with a recognisable `output_id`, for the tests that assert the sweep's
    /// diagnosis names the ARTIFACT rather than an opaque `sha256:…`.
    fn named_refrow(key: &str, multi: bool, output_id: &str) -> BlobRefRow {
        in_project(Some(Uuid::new_v4()), key, multi, output_id)
    }

    /// …with the owning project chosen by the caller, so a test can put two
    /// artifacts in ONE project (or in none at all).
    fn in_project(project_id: Option<Uuid>, key: &str, multi: bool, output_id: &str) -> BlobRefRow {
        BlobRefRow {
            artifact_id: Uuid::new_v4(),
            project_id,
            output_id: output_id.to_string(),
            object_key: key.to_string(),
            is_multifile: multi,
        }
    }

    #[test]
    fn keep_set_covers_object_keys_and_multifile_members() {
        let refs = vec![
            refrow("sha256:single", false),
            refrow("sha256:manifest", true),
        ];
        let keep = keep_set(&refs, |k| {
            Ok(if k == "sha256:manifest" {
                vec!["sha256:m1".into(), "sha256:m2".into()]
            } else {
                vec![]
            })
        })
        .unwrap();
        assert!(keep.contains("sha256:single"));
        assert!(keep.contains("sha256:manifest"));
        assert!(keep.contains("sha256:m1"));
        assert!(keep.contains("sha256:m2"));
        assert_eq!(keep.len(), 4);
    }

    #[test]
    fn a_blob_is_deletable_iff_absent_from_the_union() {
        // The reachability rule: deletable iff its hash appears in NO referencing
        // table (here: the artifacts union). An orphan is not in keep.
        let refs = vec![refrow("sha256:live", false)];
        let keep = keep_set(&refs, |_| Ok(vec![])).unwrap();
        assert!(keep.contains("sha256:live"), "referenced blob is kept");
        assert!(
            !keep.contains("sha256:orphan"),
            "orphan is not kept → deletable"
        );
    }

    /// A failing member resolver produces NO keep-set at all, rather than one
    /// that silently omits the members it could not enumerate. The pure half of
    /// the rule; `a_manifest_read_error_never_frees_its_members` asserts the same
    /// thing against a real store and real deletion.
    #[test]
    fn keep_set_propagates_a_resolver_failure_instead_of_keeping_nothing() {
        let refs = vec![refrow("sha256:manifest", true)];
        let err = keep_set(&refs, |_| Err(AppError::internal_error("EMFILE")))
            .expect_err("an unresolvable member list must abort the keep-set");
        assert!(
            err.to_string().contains("EMFILE"),
            "the cause survives: {err}"
        );
    }

    // ---- the store-backed half -------------------------------------------------

    fn tmp_store() -> (PathBuf, LocalFsStore) {
        let dir = std::env::temp_dir().join(format!("txr-gc-test-{}", uuid::Uuid::new_v4()));
        (dir.clone(), LocalFsStore::new(dir))
    }

    /// A store that fails ONE key's `get` with a non-absence transport error and
    /// delegates everything else to a real [`LocalFsStore`].
    ///
    /// This is the fd-exhaustion shape: the blob is present and the artifact is
    /// live, but the read cannot be served right now. It is the exact condition a
    /// sweep is most likely to meet, because a sweep walks every blob in the pool.
    struct FailingManifestStore {
        inner: LocalFsStore,
        fail_key: String,
        /// Every `get` this store served, so a test can assert the enumeration
        /// pass reads each distinct manifest ONCE however many catalog rows name
        /// it. Without it, "read once per key" is only a comment.
        gets: std::sync::atomic::AtomicUsize,
    }

    impl FailingManifestStore {
        fn wrapping(inner: LocalFsStore, fail_key: impl Into<String>) -> Self {
            Self {
                inner,
                fail_key: fail_key.into(),
                gets: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn gets(&self) -> usize {
            self.gets.load(std::sync::atomic::Ordering::SeqCst)
        }
        /// A key no blob will ever have — for the tests that want the COUNTER but
        /// not the injected fault.
        const NO_FAULT: &'static str = "sha256:not-a-key";
    }

    #[async_trait::async_trait]
    impl ObjectStore for FailingManifestStore {
        fn store_root(&self) -> Option<&Path> {
            self.inner.store_root()
        }
        async fn put(&self, bytes: &[u8]) -> Result<ContentKey, AppError> {
            self.inner.put(bytes).await
        }
        async fn put_prefix(
            &self,
            members: &[(String, Vec<u8>)],
        ) -> Result<MultiFilePut, AppError> {
            self.inner.put_prefix(members).await
        }
        async fn get(&self, key: &ContentKey) -> Result<Vec<u8>, AppError> {
            self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if key.as_str() == self.fail_key {
                return Err(AppError::internal_error(
                    "workstore: read blob failed: Too many open files (os error 24)",
                ));
            }
            self.inner.get(key).await
        }
        async fn get_range(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<Vec<u8>, AppError> {
            self.inner.get_range(key, offset, length).await
        }
        async fn get_stream(
            &self,
            key: &ContentKey,
            offset: u64,
            length: u64,
        ) -> Result<ByteStream, AppError> {
            self.inner.get_stream(key, offset, length).await
        }
        async fn link_blob(&self, key: &ContentKey, dest: &Path) -> BlobLink {
            self.inner.link_blob(key, dest).await
        }
        async fn stat(&self, key: &ContentKey) -> Result<ObjectStat, AppError> {
            self.inner.stat(key).await
        }
        async fn exists(&self, key: &ContentKey) -> Result<bool, AppError> {
            self.inner.exists(key).await
        }
        async fn delete(&self, key: &ContentKey) -> Result<(), AppError> {
            self.inner.delete(key).await
        }
        async fn resolve_member(
            &self,
            manifest_key: &ContentKey,
            member_path: &str,
        ) -> Result<ContentKey, AppError> {
            self.inner.resolve_member(manifest_key, member_path).await
        }
        async fn gc(
            &self,
            keep: &HashSet<String>,
            min_age_secs: u64,
        ) -> Result<GcReport, AppError> {
            self.inner.gc(keep, min_age_secs).await
        }
    }

    /// THE data-loss guard: when a live multi-file artifact's manifest cannot be
    /// read, the sweep must free NOTHING.
    ///
    /// Before the fix, `members_of` answered any `Err` with an empty member list,
    /// [`keep_set`] folded that in as "this artifact keeps nothing", and
    /// `store.gc` unlinked every member blob of a live artifact. The negative
    /// control below reproduces exactly that, so the "still there" assertion here
    /// is known to be capable of failing.
    #[tokio::test]
    async fn a_manifest_read_error_never_frees_its_members() {
        let (dir, inner) = tmp_store();
        let put = inner
            .put_prefix(&[
                ("zarr.json".to_string(), b"{\"shape\":[4]}".to_vec()),
                ("c/0".to_string(), b"MEMBER-ZERO".to_vec()),
                ("c/1".to_string(), b"MEMBER-ONE".to_vec()),
            ])
            .await
            .unwrap();
        let members: Vec<ContentKey> = put.members.iter().map(|m| m.blob.clone()).collect();
        assert_eq!(members.len(), 3);

        let store = FailingManifestStore::wrapping(inner.clone(), put.object_key.as_str());
        let refs = vec![refrow(put.object_key.as_str(), true)];

        // min_age 0 — no grace window to hide behind; if the sweep ran it WOULD
        // delete (see the control).
        let err = sweep_refs(&store, &refs, 0)
            .await
            .expect_err("a sweep that cannot enumerate a live artifact's members must FAIL");
        assert!(
            err.to_string().contains("Too many open files"),
            "the transport cause must survive to the operator: {err}"
        );

        for m in &members {
            assert!(
                inner.exists(m).await.unwrap(),
                "member blob {m} was reclaimed because its manifest could not be read — \
                 that is live data, permanently gone"
            );
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    // ---- the DIAGNOSIS: what the sweep says when it cannot enumerate ------------
    //
    // The refusal above is correct and stays. What was wrong is that the refusal
    // explained nothing: the operator's log read `sweep failed; will retry`, which
    // says the SWEEPER is unhappy and not that artifacts in their store have no
    // bytes. In the incident that produced this, 83 blobs were gone and the log
    // never mentioned them. These tests assert the OUTCOME of the refusal — that it
    // names the artifacts and says, in the presence report's words, why.

    /// A multi-file artifact whose MANIFEST IS NOT IN THE STORE (a plain absence, not
    /// a transport fault — the incident's actual shape).
    ///
    /// The sweep must still refuse, and its refusal must name that artifact: the id,
    /// the producer's `output_id`, the project to look in, and the presence report's
    /// own sentence for what is wrong. Asserting only `is_err()` would prove nothing
    /// the pre-diagnosis code did not already do — it returned `Err` too, saying
    /// "Blob not found".
    #[tokio::test]
    async fn an_absent_manifest_makes_the_sweep_name_the_artifact_it_could_not_enumerate() {
        let (dir, store) = tmp_store();
        // A live orphan, so a sweep that DID run would have something to free.
        let orphan = store.put(b"nobody references this").await.unwrap();
        // A ref to a manifest that was never stored: the catalog row is live, the
        // bytes are not here.
        let ghost = format!("sha256:{}", "e".repeat(64));
        let missing = named_refrow(&ghost, true, "expression_matrix");

        let err = sweep_refs(&store, std::slice::from_ref(&missing), 0)
            .await
            .expect_err("a sweep that cannot enumerate a live artifact must refuse");
        let msg = err.to_string();

        assert!(
            msg.contains(&missing.artifact_id.to_string()),
            "the diagnosis must name the ARTIFACT, not just complain: {msg}"
        );
        assert!(
            msg.contains("expression_matrix"),
            "…by the id its producer gave it, which is how a person recognises it: {msg}"
        );
        assert!(
            msg.contains(&missing.project_id.unwrap().to_string()),
            "…and the project to go and look in: {msg}"
        );
        assert!(
            msg.contains("not in this store"),
            "…in the presence report's vocabulary, so the two surfaces say one thing: {msg}"
        );
        assert!(
            msg.contains("bytes-presence"),
            "…pointing at the read-only report that enumerates the rest: {msg}"
        );
        assert!(
            msg.contains(&ghost),
            "…and the manifest blob's content identity, which is what an operator \
             restoring a store matches on (the presence report carries it for the same \
             reason): {msg}"
        );
        assert!(
            !msg.to_lowercase().contains("deleted")
                && !msg.to_lowercase().contains("lost")
                && !msg.to_lowercase().contains("corrupt"),
            "the sweep does not know who removed the bytes and must not accuse: {msg}"
        );

        assert!(
            store.exists(&orphan).await.unwrap(),
            "the refusal itself is unchanged: an unenumerable store frees NOTHING"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// The diagnosis covers EVERY artifact it could not enumerate, not the first one
    /// it tripped over. `resolve_keep` used to `?` out of its loop, so an operator
    /// with five broken artifacts was told about one, fixed it, and met the next on
    /// the following cycle.
    #[tokio::test]
    async fn the_diagnosis_names_every_unenumerable_artifact_not_just_the_first() {
        let (dir, store) = tmp_store();
        let a = named_refrow(&format!("sha256:{}", "a".repeat(64)), true, "first_out");
        let b = named_refrow(&format!("sha256:{}", "b".repeat(64)), true, "second_out");
        let c = named_refrow(&format!("sha256:{}", "c".repeat(64)), true, "third_out");

        let err = sweep_refs(&store, &[a.clone(), b.clone(), c.clone()], 0)
            .await
            .expect_err("none of the three can be enumerated");
        let msg = err.to_string();
        for r in [&a, &b, &c] {
            assert!(
                msg.contains(&r.output_id) && msg.contains(&r.artifact_id.to_string()),
                "artifact {} ({}) is affected and went unmentioned: {msg}",
                r.artifact_id,
                r.output_id
            );
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// **Uncertainty is not absence** — the presence module's central rule, now load-
    /// bearing in the sweep's diagnosis too. A manifest the store could not READ is
    /// `indeterminate`; a manifest that is not THERE is `absent`. Telling an owner
    /// their data is gone because a descriptor ran out is the same class of mistake
    /// as freeing a blob whose manifest could not be read.
    #[tokio::test]
    async fn a_store_fault_is_diagnosed_indeterminate_and_an_absence_is_diagnosed_absent() {
        let (dir, inner) = tmp_store();
        let put = inner
            .put_prefix(&[
                ("zarr.json".to_string(), b"{\"shape\":[1]}".to_vec()),
                ("c/0".to_string(), b"CHUNK".to_vec()),
            ])
            .await
            .unwrap();
        // (1) present-but-unreadable, (2) simply not here.
        let faulting = named_refrow(put.object_key.as_str(), true, "unreadable_out");
        let ghost = format!("sha256:{}", "f".repeat(64));
        let absent = named_refrow(&ghost, true, "gone_out");
        let store = FailingManifestStore::wrapping(inner.clone(), put.object_key.as_str());

        let d = enumerate_members(&store, &[faulting.clone(), absent.clone()])
            .await
            .expect_err("neither ref can be enumerated, so there is a diagnosis to give");

        let f = d
            .unenumerable
            .iter()
            .find(|u| u.artifact_id == faulting.artifact_id)
            .expect("the faulting artifact is diagnosed");
        assert_eq!(
            f.presence, "indeterminate",
            "the blob IS there; the read failed. Calling that an absence tells the \
             owner their data is gone when it is not: {f:?}"
        );
        assert!(
            f.cause.contains("Too many open files"),
            "the transport cause survives to the operator: {f:?}"
        );

        let g = d
            .unenumerable
            .iter()
            .find(|u| u.artifact_id == absent.artifact_id)
            .expect("the absent artifact is diagnosed");
        assert_eq!(g.presence, "absent", "{g:?}");
        assert!(
            g.detail.contains("manifest") && g.detail.contains("not in this store"),
            "the presence report's own sentence, verbatim: {g:?}"
        );

        assert_eq!((d.absent(), d.indeterminate()), (1, 1));
        let summary = d.summary();
        assert!(
            summary.contains("nothing") || summary.contains("NOTHING"),
            "the CONSEQUENCE — that no blob was reclaimed — must be stated, not left \
             for the reader to infer from a word like 'failed': {summary}"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// POSITIVE CONTROL for the diagnosis. An enumerable store yields NO diagnosis
    /// and a real member map, so the assertions above are about the unenumerable
    /// case and not about `enumerate_members` answering `Err` for anything handed
    /// to it.
    #[tokio::test]
    async fn control_a_fully_enumerable_store_has_nothing_to_diagnose() {
        let (dir, store) = tmp_store();
        let put = store
            .put_prefix(&[
                ("zarr.json".to_string(), b"{}".to_vec()),
                ("c/0".to_string(), b"CHUNK".to_vec()),
            ])
            .await
            .unwrap();
        let refs = vec![refrow(put.object_key.as_str(), true)];
        let members = enumerate_members(&store, &refs)
            .await
            .expect("a store whose manifests all read has no unenumerable artifacts");
        assert_eq!(
            members[put.object_key.as_str()].len(),
            2,
            "…and it really did enumerate them: {members:?}"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// One manifest, many artifacts. Content-addressed dedup means a single absent
    /// manifest blob can be named by several catalog rows; every one of them is
    /// affected, and the diagnosis says so — while the store is READ exactly once,
    /// because a 2000-row catalog all naming one broken manifest must not become
    /// 2000 failing reads per cycle.
    #[tokio::test]
    async fn one_absent_manifest_shared_by_two_artifacts_names_both_but_is_read_once() {
        let (dir, inner) = tmp_store();
        let store = FailingManifestStore::wrapping(inner, FailingManifestStore::NO_FAULT);
        let shared = format!("sha256:{}", "d".repeat(64));
        let one = named_refrow(&shared, true, "in_project_one");
        let two = named_refrow(&shared, true, "in_project_two");

        let d = enumerate_members(&store, &[one.clone(), two.clone()])
            .await
            .expect_err("the shared manifest is not in the store");
        assert_eq!(
            d.unenumerable.len(),
            2,
            "both catalog rows are affected by the one missing manifest: {d:?}"
        );
        assert_eq!(d.projects().len(), 2, "and both projects are pointed at");
        assert_eq!(
            store.gets(),
            1,
            "one manifest, one read — however many rows name it"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Two affected artifacts in ONE project point the operator at ONE project. The
    /// list is a set of places to look, not a tally of rows — a 2000-artifact
    /// project must not print its id 2000 times.
    #[tokio::test]
    async fn affected_projects_are_distinct() {
        let (dir, store) = tmp_store();
        let p = Uuid::new_v4();
        let a = in_project(Some(p), &format!("sha256:{}", "1".repeat(64)), true, "a");
        let b = in_project(Some(p), &format!("sha256:{}", "2".repeat(64)), true, "b");

        let d = enumerate_members(&store, &[a, b])
            .await
            .expect_err("neither manifest is in the store");
        assert_eq!(d.unenumerable.len(), 2, "both rows are reported: {d:?}");
        assert_eq!(
            d.projects(),
            vec![p],
            "…pointing at their one project, once: {d:?}"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// An artifact with NO project (dataset-scoped) is still named. It has no
    /// per-project report to be sent to, so the message must not fabricate one —
    /// and must not degrade into saying nothing about the artifact either.
    #[tokio::test]
    async fn a_project_less_artifact_is_named_without_a_project_to_point_at() {
        let (dir, store) = tmp_store();
        let orphaned = in_project(None, &format!("sha256:{}", "9".repeat(64)), true, "ds_out");

        let d = enumerate_members(&store, std::slice::from_ref(&orphaned))
            .await
            .expect_err("its manifest is not in the store");
        assert!(d.projects().is_empty(), "there is no project: {d:?}");
        let summary = d.summary();
        assert!(
            summary.contains(&orphaned.artifact_id.to_string()) && summary.contains("ds_out"),
            "it is still named: {summary}"
        );
        assert!(
            !summary.contains("in project") && !summary.contains("bytes-presence"),
            "…without inventing a project or a report that could not list it: {summary}"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// The summary is a DIAGNOSIS, not an inventory. Past a handful of artifacts it
    /// names the first few, says how many more there are, and leaves the full list
    /// to the per-project report — otherwise the 89-artifact incident this comes
    /// from produces one log line nobody reads.
    ///
    /// The population is a FIXED 12 rather than `NAMED_IN_SUMMARY + n`: sizing the
    /// input off the constant under test lets the constant move the goalposts with
    /// it, and a cap raised to 100 passed such a test while naming every artifact
    /// there was.
    #[tokio::test]
    async fn the_summary_is_bounded_and_says_how_many_it_did_not_name() {
        const POPULATION: usize = 12;
        let (dir, store) = tmp_store();
        let refs: Vec<BlobRefRow> = (0..POPULATION)
            .map(|i| {
                named_refrow(
                    &format!("sha256:{}{i:02}", "0".repeat(62)),
                    true,
                    &format!("out_{i}"),
                )
            })
            .collect();

        let d = enumerate_members(&store, &refs)
            .await
            .expect_err("none of them is in the store");
        assert_eq!(d.unenumerable.len(), POPULATION, "all of them are TRACKED");

        let summary = d.summary();
        let named = (0..POPULATION)
            .filter(|i| summary.contains(&format!("out_{i}")))
            .count();
        assert!(
            named < POPULATION,
            "the summary named all {POPULATION} of them — it is an inventory, not a \
             diagnosis, and at 89 artifacts it is a log line nobody reads: {summary}"
        );
        assert!(
            named > 0,
            "…but it must still name SOME of them, or it explains nothing: {summary}"
        );
        assert_eq!(
            named, NAMED_IN_SUMMARY,
            "exactly the cap is named: {summary}"
        );
        assert!(
            summary.contains(&format!("…and {} more", POPULATION - named)),
            "the ones it did not name are still counted: {summary}"
        );
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// NEGATIVE CONTROL, in two halves — without these the assertion above could
    /// hold for reasons that have nothing to do with the fix.
    ///
    /// (a) With a READABLE manifest the same `sweep_refs` call at the same
    ///     `min_age` succeeds AND frees a genuine orphan, so the machinery under
    ///     test demonstrably deletes.
    /// (b) The PRE-FIX keep-set — the manifest key alone, which is precisely what
    ///     `Err(_) => Vec::new()` used to yield — handed to the SAME `gc` deletes
    ///     every member. That is the data loss, reproduced.
    #[tokio::test]
    async fn negative_control_the_sweep_really_does_delete() {
        // (a) readable manifest → orphan freed, members kept.
        let (dir_a, s) = tmp_store();
        let put = s
            .put_prefix(&[
                ("zarr.json".to_string(), b"{\"shape\":[2]}".to_vec()),
                ("c/0".to_string(), b"KEEP-ME".to_vec()),
            ])
            .await
            .unwrap();
        let orphan = s.put(b"nobody references this").await.unwrap();
        let refs = vec![refrow(put.object_key.as_str(), true)];

        let report = sweep_refs(&s, &refs, 0)
            .await
            .expect("a readable manifest sweeps");
        assert_eq!(report.freed, 1, "exactly the orphan is freed: {report:?}");
        assert!(
            !s.exists(&orphan).await.unwrap(),
            "the orphan really is gone"
        );
        for m in &put.members {
            assert!(
                s.exists(&m.blob).await.unwrap(),
                "members of a live artifact survive"
            );
        }

        // (b) the pre-fix keep-set on the very same store + the very same `gc`.
        let mut pre_fix_keep = HashSet::new();
        pre_fix_keep.insert(put.object_key.as_str().to_string());
        let report = s.gc(&pre_fix_keep, 0).await.unwrap();
        assert!(
            report.freed >= put.members.len() as u64,
            "the pre-fix keep-set must be shown to DELETE the members, or the guard \
             above proves nothing: {report:?}"
        );
        for m in &put.members {
            assert!(
                !s.exists(&m.blob).await.unwrap(),
                "control: with an empty member list the members are unlinked"
            );
        }
        let _ = tokio::fs::remove_dir_all(&dir_a).await;
    }

    // ---- the ownership guard (defence in depth) --------------------------------
    //
    // Partitioning by catalog already gives each catalog its own root, so these
    // conditions should be unreachable. They are asserted anyway because the cost
    // of being wrong is unrecoverable: a sweep unlinks the COMPLEMENT of its
    // keep-set, so the one thing it must never do is walk a directory whose
    // contents it cannot attribute to the catalog that produced the keep-set.

    use crate::modules::workstore::partition::{resolve_owned_root, StoreClaim, CLAIM_FILE};

    /// A pool that is never actually connected. Every one of these tests must
    /// fail on OWNERSHIP before any catalog read happens, so if the guard is
    /// removed the test fails on a connection error instead of passing — the
    /// check's POSITION (before `all_blob_refs`) is asserted, not just that it
    /// exists somewhere.
    fn unreachable_pool() -> SqlitePool {
        // SQLite port (record; the jobs `offline_pool` precedent, ITEM-19 #8):
        // a lazy pool pointing at a file whose PARENT DIRECTORY does not exist —
        // every connect fails ("unable to open database file"), nothing is ever
        // created, and the "every query fails, the ownership guard fires first"
        // property is unchanged.
        sqlx::sqlite::SqlitePoolOptions::new()
            // Short, so the CONTROL (which is meant to reach the pool and fail
            // there) costs a fraction of a second rather than the 30s default.
            .acquire_timeout(Duration::from_millis(250))
            .connect_lazy("sqlite:///nonexistent-txr-item20/unreachable.sqlite")
            .expect("a lazy pool never connects")
    }

    async fn store_with_one_orphan(root: &Path) -> (Arc<dyn ObjectStore>, ContentKey) {
        let s = LocalFsStore::new(root);
        let orphan = s.put(b"a blob no catalog here references").await.unwrap();
        (Arc::new(s), orphan)
    }

    /// The claim was valid when the sweeper was built and the root has since been
    /// re-claimed by another catalog. The sweep must abandon and free nothing.
    #[tokio::test]
    async fn a_root_reclaimed_by_another_catalog_stops_the_sweep() {
        let data_root = std::env::temp_dir().join(format!("txr-own-{}", uuid::Uuid::new_v4()));
        let claim = resolve_owned_root(&data_root, "aaaa1111");
        let (store, orphan) = store_with_one_orphan(claim.root()).await;

        // A peer catalog takes the root over.
        std::fs::write(claim.root().join(CLAIM_FILE), "bbbb2222").unwrap();

        let sweeper = GcSweeper::new(unreachable_pool(), store.clone(), claim);
        let err = sweeper
            .sweep()
            .await
            .expect_err("a store this catalog no longer owns must not be swept");
        assert!(
            err.to_string().contains("bbbb2222"),
            "the operator is told who owns it, not just that something failed: {err}"
        );
        assert!(
            store.exists(&orphan).await.unwrap(),
            "nothing may be unlinked from an unattributable store — even an orphan, \
             because to the OWNING catalog it may be live"
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// The marked/refcount sweep the project-delete chokepoint runs is gated the
    /// same way. Content-addressed dedup means a marked hash can be a PEER
    /// catalog's live blob, so "I marked it" is not attribution.
    #[tokio::test]
    async fn the_marked_sweep_is_gated_by_ownership_too() {
        let data_root = std::env::temp_dir().join(format!("txr-ownm-{}", uuid::Uuid::new_v4()));
        let claim = resolve_owned_root(&data_root, "aaaa1111");
        let (store, orphan) = store_with_one_orphan(claim.root()).await;
        std::fs::write(claim.root().join(CLAIM_FILE), "bbbb2222").unwrap();

        let mut manifest = crate::modules::project::GcManifest::default();
        manifest.mark(orphan.as_str().to_string(), "catalog");

        let sweeper = GcSweeper::new(unreachable_pool(), store.clone(), claim);
        let err = sweeper
            .sweep_marked(&manifest)
            .await
            .expect_err("the marked sweep must be gated by ownership too");
        // The message matters: without it this test passes on the DB error from
        // `collect_keep`, which the sweeper would hit ANYWAY — so it would hold
        // just as well with the guard deleted, and prove nothing. (It did: the
        // mutation "sweep_marked skips the ownership guard" survived until this
        // assertion was added.)
        assert!(
            err.to_string().contains("bbbb2222"),
            "the marked sweep must stop on OWNERSHIP, before it ever reads the catalog; \
             it stopped on something else: {err}"
        );
        assert!(
            store.exists(&orphan).await.unwrap(),
            "a marked blob in an unattributable store must survive"
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// A claim over one directory is no licence to unlink another: the root the
    /// store will WALK must be the root the claim attributed.
    #[tokio::test]
    async fn a_claim_over_a_different_root_stops_the_sweep() {
        let data_root = std::env::temp_dir().join(format!("txr-ownx-{}", uuid::Uuid::new_v4()));
        let claim = resolve_owned_root(&data_root, "aaaa1111");
        // A perfectly valid claim — but the store points somewhere else entirely.
        let elsewhere = data_root.join("some-other-store");
        let (store, orphan) = store_with_one_orphan(&elsewhere).await;

        let sweeper = GcSweeper::new(unreachable_pool(), store.clone(), claim);
        let err = sweeper
            .sweep()
            .await
            .expect_err("sweeping a root the claim does not cover must abandon");
        assert!(
            err.to_string().contains("different directory"),
            "the mismatch is named: {err}"
        );
        assert!(store.exists(&orphan).await.unwrap(), "nothing was unlinked");
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// The positive control for all three above: with ownership intact, the same
    /// sweeper gets PAST the guard and on to the catalog read. It fails on the
    /// unreachable database — which is the proof that the guard was not what
    /// stopped it, and therefore that the assertions above are about ownership
    /// rather than about `sweep()` failing for any reason at all.
    #[tokio::test]
    async fn control_an_owned_store_passes_the_guard_and_reaches_the_catalog() {
        let data_root = std::env::temp_dir().join(format!("txr-ownok-{}", uuid::Uuid::new_v4()));
        let claim = resolve_owned_root(&data_root, "aaaa1111");
        let (store, _orphan) = store_with_one_orphan(claim.root()).await;

        let sweeper = GcSweeper::new(unreachable_pool(), store, claim);
        let err = sweeper.sweep().await.expect_err("the pool is unreachable");
        let msg = err.to_string();
        assert!(
            !msg.contains("refusing to sweep"),
            "an OWNED store must clear the ownership guard; it stopped there instead: {msg}"
        );
        let _ = std::fs::remove_dir_all(&data_root);
    }

    /// `adopt_existing` joins an owner; it cannot invent one.
    #[test]
    fn adopt_existing_refuses_an_unclaimed_root() {
        let root = std::env::temp_dir().join(format!("txr-adopt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        StoreClaim::adopt_existing(&root).expect_err("an unclaimed root has no owner to adopt");
        std::fs::write(root.join(CLAIM_FILE), "aaaa1111").unwrap();
        let c = StoreClaim::adopt_existing(&root).expect("a claimed root can be joined");
        assert_eq!(c.key(), "aaaa1111");
        let _ = std::fs::remove_dir_all(&root);
    }
}
