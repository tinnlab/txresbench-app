//! **ITEM-40 — refusing to detach a dataset a virtual dataset is built from.**
//!
//! Detaching a dataset from a project is a list operation, and for an ordinary dataset that is
//! all it is: the derived artifacts are orphaned but preserved, still valid data, and
//! re-attaching restores them (ITEM-39 warns and allows, deliberately). **A dataset named as a
//! SOURCE by an alignment is different in kind**, and the asymmetry is the whole point:
//!
//! > A derived artifact's data is still valid after detach — only its reachability changes.
//! > A virtual dataset's data does not exist without its sources.
//!
//! The first is a VISIBILITY question. The second is a CORRECTNESS one — a gathered artifact has
//! no blob of its own (`structure.gathered_from` is a recipe, not storage), so removing a source
//! makes every artifact derived from it unreadable. That is why the owner chose *refuse*, and
//! why this is a GATE rather than a warning.
//!
//! Before this, `ProjectRepository::detach_dataset` was a bare
//! `DELETE FROM project_datasets` with **no dependency check of any kind**.
//!
//! ── WHY "CANNOT DETERMINE" REFUSES HERE, AND ALLOWS NOWHERE ELSE ─────────────────────────────
//!
//! `AlignmentSource::dataset_id` is a `String` (the producer relays it; see
//! `alignment.rs`), so answering "does this alignment depend on dataset D?" means RESOLVING that
//! string. Three outcomes, and the third is the one that gets simplified away:
//!
//! | | verdict |
//! |---|---|
//! | a source names D — by id OR by name | **refuse** — the dependency is real |
//! | the alignment's declaration cannot be PARSED | **refuse** — its sources cannot be enumerated, so D cannot be ruled out |
//! | every source is readable and none names D | allow |
//!
//! ── A CORRECTION THE POSITIVE CONTROL FORCED, recorded rather than quietly applied ──────────
//!
//! DEC-24 said *"an id that does not resolve against the datasets table is cannot-determine, and
//! cannot-determine must REFUSE"*. Implemented literally, that refuses EVERY detach in any
//! project holding one alignment with one unreadable source — which the positive control caught
//! immediately: the unrelated dataset was blocked by the fixture's second source `"ds-b"`.
//! **A refusal that refuses everything passes the dependency assertion and breaks the behaviour it guards.**
//!
//! The error was in the question. "Does this source RESOLVE?" is not what the gate needs to
//! know; "could this source BE the dataset being detached?" is. That IS decidable: the dataset
//! being detached has an id and a name, and both are compared. A source naming neither cannot be
//! it, whatever else is wrong with the alignment — an unhealthy alignment is a data-quality
//! problem, not this detach's business.
//!
//! What genuinely cannot be determined is narrower and stays refused: an alignment whose
//! DECLARATION will not parse, whose sources therefore cannot be enumerated at all.
//!
//! **Both id and name are compared, and the name match is not redundancy.** The relay is real
//! now, but this branch has already measured a producer recording a MOUNT NAME where a dataset id
//! belonged. Matching on the name too means an alignment that records D under a legacy or
//! relayed spelling still blocks the detach. It can over-refuse (names are not unique); it cannot
//! under-refuse, and on a gate over destructive work that is the direction to err in.
//!
//! **This is the OPPOSITE default from ITEM-39's dependent count, and that is deliberate.**
//! There, cannot-determine must not be rendered as `0` — a warning that invents a number
//! misleads. Here, cannot-determine must not be rendered as "no dependents" — a gate that
//! invents permission destroys work. Same three states, opposite safe answers, because one
//! surface is a *warning before a permitted action* and this one is a *gate on a destructive
//! one*. A warning that overstates costs a user a moment; a gate that under-refuses costs them
//! an hour of compute that cannot be recovered.
//!
//! **Do not "simplify" the unresolved arm into a permissive default.** It is the arm that makes
//! this a safety property rather than a lookup.
//!
//! ── CHAINS ARE WALKED (INV-13) — AND THE PREMISE THAT SAID THEY NEEDN'T BE WAS FALSE ─────────
//!
//! INV-13 describes a TRANSITIVE refusal: detaching `D` must also refuse when `D → V1 → V2`,
//! naming every dependent in the chain. This module used to defer that walk, on a MEASUREMENT:
//!
//! > *Measured (DRIFT-stage3-1.45): nothing mints a `datasets` row for a gathered artifact. The
//! > three `INSERT INTO datasets` sites are ingest and upload […] So there is no `V1` that a
//! > second alignment could name as a source.*
//!
//! **That premise was true when it was written and false within the hour.**
//! `virtual_dataset.rs::create_for_run` is a FOURTH `INSERT INTO datasets` site — the
//! virtual-dataset creator, committed ~45 minutes later. From that commit a chain was
//! constructible at the data layer and nothing refused it: the guard would let a user detach a
//! source out from under a virtual dataset that another virtual dataset was built on, and the
//! serve path (which DOES resolve chains, `gather_exec::plan_chain`) would then fail on a read
//! the user was told was safe.
//!
//! **The class, which outlives this incident: a guard that defers work on a measured premise,
//! with no executable check that the premise still holds.** The measurement was correct and the
//! reasoning from it was correct; what was missing was anything that would FAIL when the world
//! moved. A comment cannot notice a new INSERT. So the walk below is written, and the premise it
//! replaces is enforced as STATE rather than prose: migration `202608040008` adds
//! `datasets_integrate_declares_alignment`, a CHECK that every `source = 'integrate'` row carries
//! `metadata.alignment.artifact_id` — the edge this walk traverses. A fifth site that mints a
//! virtual dataset without that edge cannot commit its row, so it cannot become invisible to this
//! guard the way the fourth one did. The constraint has its own test —
//! `tests/workstore/detach_chain_test.rs::the_database_refuses_an_integrate_dataset_with_no_alignment_edge`.
//!
//! ── WHAT THE WALK TRAVERSES ──────────────────────────────────────────────────────────────────
//!
//! Two different edges, and conflating them is how this gets written wrong:
//!
//! * **alignment → source dataset** — `meta.sources[].dataset_id`, read via [`AlignmentPlan`].
//!   This is the edge the one-level check already followed.
//! * **alignment → the dataset it PRODUCED** — `datasets.metadata.alignment.artifact_id`, written
//!   by the creator. This is the edge that makes `V1` an identity a second alignment can name,
//!   and it is the one that did not exist when the deferral was written.
//!
//! The walk is a fixpoint over the project's alignment rows: start from `D`'s identity, and every
//! time an alignment names an identity in the set, it is a blocker AND the dataset it produced
//! joins the set. It terminates because the row set is finite and each round consumes at least
//! one row — a real bound, not the depth limit + visited set that the deferral rightly objected
//! could never fail. All of it runs over ONE catalog query and ONE datasets query; the walk adds
//! no per-level round trip.

use crate::modules::workstore::alignment::AlignmentPlan;
use crate::modules::workstore::mask;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

/// The STRUCTURAL signature of an alignment, used instead of its datatype id.
///
/// Selecting `WHERE datatype = 'dataset-alignment'` would work and was the first cut. It puts a
/// DOMAIN datatype id in app-builtin server code, which the no-domain guard refuses and which
/// this tree argues against on its own terms: the domain lattice is DATA, and the app carries
/// none of it.
///
/// The signature below is the same discriminant the artifact model already prefers — DEC-8's
/// *"the recipe IS the discriminant"*, which chose a resolution recipe over a `storage_kind`
/// flag for exactly this reason. An alignment is the artifact that DECLARES per-source rows in
/// `meta.sources[]` and a `segments` extent in `structure`; nothing else in the catalog does.
/// A false positive costs one failed parse (which refuses, safely); a false negative would be a
/// missed dependency, which is why the predicate is anchored on both halves rather than on
/// `meta.sources` alone.
const ALIGNMENT_SIGNATURE: &str =
    "json_type(meta, '$.sources') = 'array' AND json_type(structure, '$.extents.segments') IS NOT NULL";

/// Why one alignment blocks the detach. Two reasons, never merged: they have different remedies
/// and a surface that renders them identically sends the user to fix the wrong thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// A source of this alignment resolves to exactly the dataset being detached.
    DependsOn,
    /// This alignment's DECLARATION cannot be parsed, so its sources cannot be enumerated and
    /// the dataset being detached cannot be ruled out. Refused, not allowed — see the module
    /// docs. This is the narrow, genuinely-undeterminable case; a source that merely fails to
    /// resolve is NOT this, because it can still be compared against the dataset's id and name.
    Undeclared,
}

/// One alignment standing in the way, named so the user knows what to remove first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocker {
    pub artifact_id: Uuid,
    /// The producer's own name for the output — readable, and never a UUID.
    pub output_id: String,
    pub reason: Reason,
}

/// The verdict. `Allowed` carries nothing: there is no count to report and inventing one would
/// be the fabricated-number failure ITEM-39 exists to avoid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetachVerdict {
    Allowed,
    Refused(Vec<Blocker>),
}

impl DetachVerdict {
    /// The sentence the API returns. Names every blocker — *"name the virtual dataset(s) that
    /// depend on it so the user knows what to remove first"* — rather than reporting a count,
    /// because a count is not actionable and the set here is small by construction.
    pub fn message(&self) -> Option<String> {
        let blockers = match self {
            DetachVerdict::Allowed => return None,
            DetachVerdict::Refused(b) => b,
        };
        let named: Vec<String> = blockers
            .iter()
            .map(|b| match &b.reason {
                Reason::DependsOn => format!("{} (built from this dataset)", b.output_id),
                Reason::Undeclared => format!(
                    "{} (its alignment declaration cannot be read, so the datasets it was built \
                     from cannot be listed and this one cannot be ruled out)",
                    b.output_id
                ),
            })
            .collect();
        Some(format!(
            "This dataset cannot be removed from the project: {} integrated dataset(s) are built \
             from it and would become unreadable — {}. An integrated dataset has no data of its \
             own; it is assembled from its sources on every read. Remove those first, or keep \
             this dataset attached.",
            blockers.len(),
            named.join("; ")
        ))
    }
}

/// The identity of one dataset as an alignment source may spell it: its id, and its name.
///
/// Both are carried for the reason the module docs give for the one-level check — a producer has
/// been measured recording a mount NAME where a dataset id belonged — and the walk must not lose
/// that on the second level, where the identity is a virtual dataset's generated
/// `"Integrated: …"` name.
#[derive(Debug, Clone)]
struct Identity {
    id: Uuid,
    name: Option<String>,
}

impl Identity {
    /// Could `source` — an `AlignmentSource::dataset_id`, which is a relayed `String` — BE this
    /// dataset? Not "does it resolve"; see the module docs for why that is the wrong question.
    fn named_by(&self, source: &str) -> bool {
        match Uuid::parse_str(source) {
            // A well-formed id is answered by the id alone, so a coincidental name collision can
            // never overrule it.
            Ok(parsed) => parsed == self.id,
            Err(_) => self.name.as_deref() == Some(source),
        }
    }
}

/// May `dataset_id` be detached from `project_id`?
///
/// Reads the project's alignment artifacts as METADATA — `meta.sources[]` via
/// [`AlignmentPlan`] — and opens **no artifact bytes**. The set is small by construction (one
/// row per integrated dataset in the project), and it is selected by an indexed
/// `(project_id, datatype)` predicate rather than by scanning the catalog: a check whose cost
/// grew with the project's whole artifact count is one somebody would later optimise away.
pub async fn detach_verdict(
    pool: &SqlitePool,
    project_id: Uuid,
    dataset_id: Uuid,
) -> Result<DetachVerdict, AppError> {
    // Not `query!`: the signature is a constant predicate spliced into the WHERE clause, and the
    // compile-time macro takes a literal. It carries no caller input — `project_id` is still
    // bound — so there is no injection surface.
    //
    // SQLite port (record; PROV-sqlite-store-4 / DEC-12): `jsonb_typeof(x -> 'k')` is
    // `json_type(x, '$.k')`, and the `?` key-existence operator is the chain's
    // `json_type(x, '$.k') IS NOT NULL` convention (the `jsonb_exists` →
    // `json_type(..., path) IS NOT NULL` rule, migration 202608040010's port note).
    let sql = format!(
        "SELECT id, output_id, structure, meta FROM artifacts \
         WHERE project_id = $1 AND {ALIGNMENT_SIGNATURE}"
    );
    let rows = sqlx::query_as::<_, (Uuid, String, Value, Value)>(&sql)
        .bind(project_id)
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?;

    // The dataset's own identity, read ONCE. Both spellings are compared — see the module docs
    // for why the name is not redundancy.
    let dataset_name: Option<String> =
        sqlx::query_scalar!("SELECT name FROM datasets WHERE id = $1", dataset_id)
            .fetch_optional(pool)
            .await
            .map_err(AppError::database_error)?;

    // ── the second edge: which dataset did each of these alignments PRODUCE? ─────────────────
    //
    // One query for the whole project, not one per level: the walk below is a fixpoint over an
    // in-memory row set, so a chain of any length still costs exactly these two reads.
    //
    // `metadata.alignment.artifact_id` is written by `virtual_dataset::create_for_run` and is
    // CHECK-enforced on every `integrate` row (migration `202608040008`), so an alignment that
    // produced a virtual dataset is guaranteed reachable from here — that guarantee is what
    // replaces the prose premise this walk was once deferred on.
    let alignment_ids: Vec<Uuid> = rows.iter().map(|(id, ..)| *id).collect();
    // SQLite port (record): the `-> 'alignment' ->> 'artifact_id'` path is
    // `json_extract(metadata, '$.alignment.artifact_id')` (the chain's JSON1
    // convention), and the `= ANY($1)` TEXT-array membership is `IN (SELECT
    // value FROM json_each($1))` — the values are the producers' HYPHENATED
    // uuid strings (both sides written by `Uuid::to_string`), so the JSON text
    // list carries them verbatim (never the 32-hex `uuid_list_json` form).
    let produced: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id, name, json_extract(metadata, '$.alignment.artifact_id') \
         FROM datasets \
         WHERE source = 'integrate' AND json_extract(metadata, '$.alignment.artifact_id') \
               IN (SELECT j.value FROM json_each($1) AS j)",
    )
    .bind(
        serde_json::to_string(
            &alignment_ids
                .iter()
                .map(Uuid::to_string)
                .collect::<Vec<_>>(),
        )
        .expect("Vec<String> is JSON-serializable"),
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    // ── the FILTER edge (#163) ───────────────────────────────────────────────────────────────
    //
    // A `source = 'filter'` virtual dataset reads ONE source dataset through a VD-owned per-row
    // MASK, whose `meta.sources[]` records that source (`mask::mask_meta` — the channel its own
    // docs designate for THIS guard, and the cascade scopes deletion by). A filter VD has NO
    // alignment row, so the alignment fixpoint below never sees it: this is the new topology #163
    // found detachable out from under a filter VD, leaving its mask + gathered columns reading
    // through a gone source. The mask is reached through its `dataset_id` (the VD), which is
    // attached to the project via `project_datasets` — the mask's own `project_id` is NULL
    // (`bind_mask_to_dataset`), so it cannot be selected by project directly.
    let filter_rows: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT d.id, d.name, a.meta \
         FROM datasets d \
         JOIN project_datasets pd ON pd.dataset_id = d.id \
         JOIN artifacts a ON a.dataset_id = d.id AND a.role = $2 \
         WHERE d.source = 'filter' AND pd.project_id = $1",
    )
    .bind(project_id)
    .bind(mask::MASK_ROLE)
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;
    // `(vd id, vd name, the source dataset ids the mask records)`. A filter has exactly one, but
    // the mask's array shape matches the alignment's, so this walks either with one reading.
    let mut pending_filters: Vec<(Uuid, String, Vec<String>)> = filter_rows
        .into_iter()
        .map(|(id, name, meta)| (id, name, mask::mask_source_dataset_ids(&meta)))
        .collect();

    // Parse every declaration ONCE. An unparseable one is a blocker immediately (see the module
    // docs: its sources cannot be enumerated, so the dataset cannot be ruled out) and is not
    // carried into the fixpoint — the verdict is already a refusal, so what it might have
    // produced changes nothing.
    let mut blockers = Vec::new();
    let mut pending: Vec<(Uuid, String, AlignmentPlan)> = Vec::new();
    for (artifact_id, output_id, structure, meta) in &rows {
        match AlignmentPlan::parse(structure, meta) {
            Ok(plan) => pending.push((*artifact_id, output_id.clone(), plan)),
            Err(_) => blockers.push(Blocker {
                artifact_id: *artifact_id,
                output_id: output_id.clone(),
                reason: Reason::Undeclared,
            }),
        }
    }

    // ── the fixpoint (INV-13) ────────────────────────────────────────────────────────────────
    //
    // `frontier` is the set of identities whose detachment/disappearance breaks something.
    // It starts as `{D}` and grows by one virtual dataset per blocking alignment. The loop
    // terminates because `pending` strictly shrinks on every round that does any work — a bound
    // that comes from the data, not from a depth counter that could never trip.
    let mut frontier: Vec<Identity> = vec![Identity {
        id: dataset_id,
        name: dataset_name,
    }];
    loop {
        // Identities discovered blocked THIS round, applied to the frontier at its end so both
        // edges see a consistent frontier within one round and cross-edge chains converge across
        // rounds (a filter over an integration, or vice versa).
        let mut added: Vec<Identity> = Vec::new();
        let mut progressed = false;

        // ── the alignment edge ───────────────────────────────────────────────────────────────
        let mut newly_blocked: Vec<(Uuid, String)> = Vec::new();
        pending.retain(|(artifact_id, output_id, plan)| {
            let names_it = plan
                .sources
                .iter()
                .any(|source| frontier.iter().any(|d| d.named_by(&source.dataset_id)));
            if names_it {
                newly_blocked.push((*artifact_id, output_id.clone()));
            }
            !names_it
        });
        for (artifact_id, output_id) in &newly_blocked {
            progressed = true;
            blockers.push(Blocker {
                artifact_id: *artifact_id,
                output_id: output_id.clone(),
                reason: Reason::DependsOn,
            });
            // …and whatever this alignment produced is now equally unreachable, so the NEXT
            // round refuses on its behalf too. An alignment that produced nothing (still
            // running, or failed) simply contributes no identity.
            for (vd_id, vd_name, owner) in &produced {
                if owner == &artifact_id.to_string() {
                    added.push(Identity {
                        id: *vd_id,
                        name: Some(vd_name.clone()),
                    });
                }
            }
        }

        // ── the filter edge (#163) ───────────────────────────────────────────────────────────
        // A filter VD whose mask records a frontier identity as its source is blocked, and the VD
        // ITSELF joins the frontier — so a filter over a filter, or an integration over a filter,
        // is refused transitively, exactly as the alignment leg is (INV-13).
        pending_filters.retain(|(vd_id, vd_name, sources)| {
            let names_it = sources
                .iter()
                .any(|s| frontier.iter().any(|d| d.named_by(s)));
            if names_it {
                progressed = true;
                blockers.push(Blocker {
                    artifact_id: *vd_id,
                    output_id: vd_name.clone(),
                    reason: Reason::DependsOn,
                });
                added.push(Identity {
                    id: *vd_id,
                    name: Some(vd_name.clone()),
                });
            }
            !names_it
        });

        if !progressed {
            break;
        }
        frontier.extend(added);
    }

    if blockers.is_empty() {
        Ok(DetachVerdict::Allowed)
    } else {
        Ok(DetachVerdict::Refused(blockers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocker(reason: Reason) -> Blocker {
        Blocker {
            artifact_id: Uuid::nil(),
            output_id: "integrated_result".into(),
            reason,
        }
    }

    #[test]
    fn allowed_carries_no_message() {
        assert_eq!(DetachVerdict::Allowed.message(), None);
    }

    #[test]
    fn the_refusal_names_the_dependent_and_says_why_it_would_break() {
        let m = DetachVerdict::Refused(vec![blocker(Reason::DependsOn)])
            .message()
            .unwrap();
        assert!(
            m.contains("integrated_result"),
            "must NAME what depends on it: {m}"
        );
        assert!(
            m.contains("unreadable"),
            "must say what detaching would DO: {m}"
        );
        // The user-facing name is "integrated dataset"; "virtual" is internal vocabulary.
        assert!(
            !m.to_lowercase().contains("virtual"),
            "leaked internal vocabulary: {m}"
        );
    }

    #[test]
    fn an_undeclared_alignment_reads_as_cannot_rule_out_rather_than_as_a_dependency() {
        // The two reasons must not collapse into one sentence: their remedies differ — remove
        // the integrated dataset, versus repair an alignment whose declaration will not parse.
        let m = DetachVerdict::Refused(vec![blocker(Reason::Undeclared)])
            .message()
            .unwrap();
        assert!(m.contains("cannot be read"), "{m}");
        assert!(m.contains("ruled out"), "{m}");
        assert!(
            !m.contains("built from this dataset"),
            "reason collapsed into the other: {m}"
        );
    }
}
