//! **ITEM-45 — the artifact→dataset backfill, and its dry-run, as ONE code path.**
//!
//! `artifacts.project_id` and `artifacts.dataset_id` are XOR today, so an output computed
//! *about* dataset D inside project P is stored as `project_id = P, dataset_id = NULL` and
//! **nothing records which dataset it is about**. This derives that association from the
//! producing run's inputs and, when it is unambiguous, writes it.
//!
//! ## The dry-run is this function with `write = false`
//!
//! Not a sibling query, and the distinction is load-bearing rather than stylistic. A dry-run
//! implemented separately is a dry-run **of something other than the migration**: the two can
//! agree with each other for a year and diverge the moment one is edited, and the report the
//! owner approves would describe code that never runs. This branch has already paid for that
//! shape twice across a producer/consumer seam, and a migration on live rows is the one place
//! where discovering it afterwards is not recoverable.
//!
//! So there is one `select`, one derivation, one classification, one report — and a single
//! `if write` guarding the `UPDATE`. Its negative control mutates the DERIVATION and requires
//! the dry-run's report to change with it; a separate-query implementation would keep
//! reporting the old outcome at exit 0.
//!
//! ## The three outcomes, and why only one of them assigns (INV-14)
//!
//! | the run has | do |
//! |---|---|
//! | exactly one dataset input | assign it |
//! | zero dataset inputs | leave NULL, report as unassigned |
//! | more than one | leave NULL, report as **ambiguous** |
//!
//! **Never force-assign.** An invented association is worse than a visible gap: a wrong
//! `dataset_id` is indistinguishable from a right one at every later read, and
//! `artifacts.dataset_id` is `ON DELETE CASCADE`, so a fabricated association also decides
//! which rows a dataset delete destroys. The ambiguous case is exactly what a VIRTUAL dataset
//! later resolves — inventing a winner now would record a false fact and foreclose that.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::AppError;

/// What the backfill decided for one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Exactly one dataset input — the only outcome that writes.
    Assign(Uuid),
    /// The run named no dataset input at all (or the row names no run).
    UnassignedNoInput,
    /// The assignment is derivable but would COLLIDE on `artifacts_natural_key`.
    ///
    /// The index is `(COALESCE(project_id,0), COALESCE(dataset_id,0), COALESCE(run_id,0),
    /// output_id)` — verified against the live schema, not read off the plan — so filling
    /// `dataset_id` MOVES a row to a different slot, and a slot that is already occupied
    /// makes the UPDATE fail. Checked here so it is a reported outcome rather than a
    /// unique-violation discovered mid-backfill on live rows.
    CollisionRefused {
        would_assign: Uuid,
        occupied_by: Uuid,
    },
    /// The run DID name inputs, and none of them resolves to a dataset — typically because
    /// the input artifacts have since been deleted.
    ///
    /// **This bucket exists because the live dry-run surfaced it.** Before it, these rows
    /// were reported as "the run named no dataset input", which sends the reader looking for
    /// a provenance gap that is not there: the provenance is intact and points at artifacts
    /// that are gone. Two different facts, one recommending "the recorder missed something"
    /// and the other "the source rows were deleted" — the same `failed`-vs-`unresolvable`
    /// distinction this branch has now paid for three times.
    UnassignedInputsUnresolvable {
        edges: usize,
        missing_artifacts: usize,
    },
    /// Several distinct dataset inputs. Left NULL deliberately.
    UnassignedAmbiguous(Vec<Uuid>),
}

impl Decision {
    pub fn bucket(&self) -> &'static str {
        match self {
            Decision::Assign(_) => "assigned",
            Decision::UnassignedNoInput => "unassigned-no-input",
            Decision::UnassignedInputsUnresolvable { .. } => "unassigned-inputs-unresolvable",
            Decision::CollisionRefused { .. } => "refused-natural-key-collision",
            Decision::UnassignedAmbiguous(_) => "unassigned-ambiguous",
        }
    }
}

/// One row's outcome, in the form the report prints.
#[derive(Debug, Clone)]
pub struct RowOutcome {
    pub artifact_id: Uuid,
    pub datatype: String,
    pub output_id: String,
    pub project_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub decision: Decision,
    /// **Diagnostic only, never applied.** The producing run's OWN dataset scope, when it has
    /// one. A row can be unassignable from its inputs while its run was scoped to a dataset,
    /// and the difference is worth seeing before deciding whether the derivation rule should
    /// widen — but widening it here, silently, would be exactly the invented association
    /// INV-14 forbids. Recorded so the owner can see the size of that choice; not acted on.
    pub run_scope_dataset: Option<Uuid>,
}

/// The whole run's outcome.
#[derive(Debug, Clone, Default)]
pub struct BackfillReport {
    pub rows: Vec<RowOutcome>,
    pub assigned: usize,
    pub unassigned_no_input: usize,
    pub unassigned_inputs_unresolvable: usize,
    pub collision_refused: usize,
    pub unassigned_ambiguous: usize,
    /// Rows actually UPDATEd. Always 0 for a dry run; `<= assigned` for a write (a row another
    /// process assigned first is skipped by the guarded `WHERE`).
    pub written: usize,
    pub write_enabled: bool,
    /// Per-datatype counts of the rows considered, so the report can be checked against the
    /// expectation the owner measured (13 `metadata-column` + 6 `report/qc`) rather than
    /// against a total that could be right for the wrong reasons.
    pub by_datatype: BTreeMap<String, usize>,
}

impl BackfillReport {
    /// The human-readable report. Printed by the dry-run AND by the real run — a report only
    /// the dry-run produces is a report of something other than what happened.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "artifact→dataset backfill ({})\n",
            if self.write_enabled {
                "WRITE"
            } else {
                "DRY RUN — no rows will be modified"
            }
        ));
        out.push_str(&format!(
            "  considered           : {} row(s) with a NULL dataset_id\n",
            self.rows.len()
        ));
        for (dt, n) in &self.by_datatype {
            out.push_str(&format!("      {dt:<24} {n}\n"));
        }
        out.push_str(&format!("  assigned             : {}\n", self.assigned));
        out.push_str(&format!(
            "  unassigned (no input): {}\n",
            self.unassigned_no_input
        ));
        out.push_str(&format!(
            "  unassigned (inputs unresolvable): {}\n",
            self.unassigned_inputs_unresolvable
        ));
        out.push_str(&format!(
            "  unassigned (ambiguous): {}\n",
            self.unassigned_ambiguous
        ));
        out.push_str(&format!(
            "  refused (natural-key collision): {}\n",
            self.collision_refused
        ));
        out.push_str(&format!("  rows written         : {}\n", self.written));
        // ITEM-44(b) — `artifacts.dataset_id` is ON DELETE CASCADE (verified against the live
        // schema), so every assignment WIDENS what a dataset delete destroys. These rows were
        // previously immune because they were project-scoped. Stated as a number the reader
        // sees, not as a comment in a migration nobody re-reads.
        out.push_str(&format!(
            "\n  ⚠ CASCADE WIDENING: {} row(s) become subject to `ON DELETE CASCADE` on their\n\
             \x20   assigned dataset. They were previously immune (project-scoped). Deleting\n\
             \x20   that dataset will now destroy them.\n",
            self.assigned
        ));
        out.push_str("\n  per-row:\n");
        for r in &self.rows {
            let detail = match &r.decision {
                Decision::Assign(d) => format!("→ dataset {d}"),
                Decision::UnassignedNoInput => "→ (left NULL: run recorded no inputs)".into(),
                Decision::CollisionRefused {
                    would_assign,
                    occupied_by,
                } => format!(
                    "→ (REFUSED: dataset {would_assign} is derivable, but that natural-key \
                     slot is already held by artifact {occupied_by})"
                ),
                Decision::UnassignedInputsUnresolvable {
                    edges,
                    missing_artifacts,
                } => format!(
                    "→ (left NULL: {edges} input edge(s), none resolving to a dataset; \
                     {missing_artifacts} of them name an artifact no longer in the catalog)"
                ),
                Decision::UnassignedAmbiguous(ds) => format!(
                    "→ (left NULL: {} dataset inputs {:?})",
                    ds.len(),
                    ds.iter().map(|d| d.to_string()).collect::<Vec<_>>()
                ),
            };
            out.push_str(&format!(
                "    {} {:<18} {:<28} run={} {}{}\n",
                r.artifact_id,
                r.datatype,
                r.output_id,
                r.run_id
                    .map(|r| r.to_string())
                    .unwrap_or_else(|| "-".into()),
                detail,
                match r.run_scope_dataset {
                    Some(d) if !matches!(r.decision, Decision::Assign(_)) =>
                        format!("  [run's own scope: dataset {d} — NOT applied]"),
                    _ => String::new(),
                }
            ));
        }
        out
    }
}

/// The distinct dataset ids a run's inputs name.
///
/// Two routes, and both are the run's own record rather than a guess:
/// * a **direct** `kind: "dataset"` edge carries the dataset id in `ref_id`;
/// * an **artifact** edge names an artifact, whose own `dataset_id` (when it has one) is the
///   dataset that artifact is about.
///
/// The union is de-duplicated, so a run that used three artifacts OF ONE dataset is
/// unambiguous — which is the common shape and the one a naive "count the inputs" rule gets
/// wrong in the direction of leaving assignable rows behind.
pub struct InputDerivation {
    pub datasets: BTreeSet<Uuid>,
    /// Input edges the run recorded (any kind).
    pub edges: usize,
    /// Referenced artifacts that are no longer in the catalog.
    pub missing_artifacts: usize,
}

async fn dataset_inputs_of_run(
    pool: &PgPool,
    inputs_json: &Value,
) -> Result<InputDerivation, AppError> {
    let mut direct: BTreeSet<Uuid> = BTreeSet::new();
    let mut artifact_refs: Vec<Uuid> = Vec::new();
    let mut edges = 0usize;

    for edge in inputs_json.as_array().into_iter().flatten() {
        edges += 1;
        let kind = edge.get("kind").and_then(Value::as_str).unwrap_or_default();
        let Some(ref_id) = edge
            .get("ref_id")
            .and_then(Value::as_str)
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        match kind {
            "dataset" => {
                direct.insert(ref_id);
            }
            "artifact" | "upload" => artifact_refs.push(ref_id),
            _ => {}
        }
    }

    let mut missing_artifacts = 0usize;
    if !artifact_refs.is_empty() {
        let rows = sqlx::query!(
            "SELECT id, dataset_id FROM artifacts WHERE id = ANY($1)",
            &artifact_refs,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?;
        let present: BTreeSet<Uuid> = rows.iter().map(|r| r.id).collect();
        for r in &rows {
            if let Some(d) = r.dataset_id {
                direct.insert(d);
            }
        }
        missing_artifacts = artifact_refs
            .iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|id| !present.contains(id))
            .count();
    }
    Ok(InputDerivation {
        datasets: direct,
        edges,
        missing_artifacts,
    })
}

/// **The backfill.** `write = false` is the dry run; everything else is identical.
pub async fn run_backfill(pool: &PgPool, write: bool) -> Result<BackfillReport, AppError> {
    let candidates = sqlx::query!(
        r#"SELECT a.id, a.datatype, a.output_id, a.project_id, a.run_id,
                  r.inputs_json as "inputs_json?: Value",
                  r.dataset_id  as "run_scope_dataset?: Uuid"
           FROM artifacts a
           LEFT JOIN provenance_run_repro r ON r.run_id = a.run_id
           WHERE a.dataset_id IS NULL
           ORDER BY a.datatype, a.output_id, a.id"#,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let mut report = BackfillReport {
        write_enabled: write,
        ..Default::default()
    };

    for c in candidates {
        *report.by_datatype.entry(c.datatype.clone()).or_insert(0) += 1;

        let inputs = c.inputs_json.unwrap_or_else(|| serde_json::json!([]));
        let derived = dataset_inputs_of_run(pool, &inputs).await?;

        let mut decision = match derived.datasets.len() {
            1 => Decision::Assign(*derived.datasets.iter().next().expect("one")),
            0 if derived.edges == 0 => Decision::UnassignedNoInput,
            0 => Decision::UnassignedInputsUnresolvable {
                edges: derived.edges,
                missing_artifacts: derived.missing_artifacts,
            },
            _ => Decision::UnassignedAmbiguous(derived.datasets.iter().copied().collect()),
        };

        // ITEM-44(a) — the natural-key precheck, BEFORE the UPDATE and therefore also before
        // the dry-run reports an assignment it could not actually make.
        if let Decision::Assign(dataset_id) = decision {
            let occupied = sqlx::query_scalar!(
                r#"SELECT id FROM artifacts
                   WHERE id <> $1
                     AND COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
                         = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
                     AND COALESCE(dataset_id, '00000000-0000-0000-0000-000000000000'::uuid) = $3
                     AND COALESCE(run_id, '00000000-0000-0000-0000-000000000000'::uuid)
                         = COALESCE($4, '00000000-0000-0000-0000-000000000000'::uuid)
                     AND output_id = $5
                   LIMIT 1"#,
                c.id,
                c.project_id,
                dataset_id,
                c.run_id,
                c.output_id,
            )
            .fetch_optional(pool)
            .await
            .map_err(AppError::database_error)?;
            if let Some(occupied_by) = occupied {
                decision = Decision::CollisionRefused {
                    would_assign: dataset_id,
                    occupied_by,
                };
            }
        }

        match &decision {
            Decision::Assign(dataset_id) => {
                report.assigned += 1;
                if write {
                    // Guarded, so the backfill is idempotent and re-runnable: a row another
                    // pass (or another operator) already assigned is not re-written, and a
                    // second run of this function reports the same decisions with `written`
                    // at 0. Never widens — it only ever fills a NULL.
                    let done = sqlx::query!(
                        "UPDATE artifacts SET dataset_id = $1, updated_at = now()
                         WHERE id = $2 AND dataset_id IS NULL",
                        dataset_id,
                        c.id,
                    )
                    .execute(pool)
                    .await
                    .map_err(AppError::database_error)?;
                    report.written += done.rows_affected() as usize;
                }
            }
            Decision::UnassignedNoInput => report.unassigned_no_input += 1,
            Decision::UnassignedInputsUnresolvable { .. } => {
                report.unassigned_inputs_unresolvable += 1
            }
            Decision::CollisionRefused { .. } => report.collision_refused += 1,
            Decision::UnassignedAmbiguous(_) => report.unassigned_ambiguous += 1,
        }

        report.rows.push(RowOutcome {
            artifact_id: c.id,
            datatype: c.datatype,
            output_id: c.output_id,
            project_id: c.project_id,
            run_id: c.run_id,
            decision,
            run_scope_dataset: c.run_scope_dataset,
        });
    }

    Ok(report)
}

/// **ITEM-50 — the dependent count**, and its ability to say it cannot answer.
///
/// Stage 3's detach warning needs *"N analyses in this project used this dataset"*. The count
/// is derived from the same relation the backfill uses — the runs whose inputs name the
/// dataset — restricted to runs scoped to the project.
///
/// `None` means **cannot compute**, and it is a real answer rather than a defensive default:
/// a fabricated or always-zero count is worse than no warning, because a user acts on it. The
/// caller must render "cannot determine", never `0`.
pub async fn dependent_analysis_count(
    pool: &PgPool,
    project_id: Uuid,
    dataset_id: Uuid,
) -> Result<Option<usize>, AppError> {
    // "Cannot compute" is the honest answer when the project has no recorded runs at all:
    // every count would be 0, and 0 there means "nothing is recorded", not "nothing uses it".
    let recorded = sqlx::query_scalar!(
        "SELECT count(*) FROM provenance_run_repro WHERE project_id = $1",
        project_id,
    )
    .fetch_one(pool)
    .await
    .map_err(AppError::database_error)?
    .unwrap_or(0);
    if recorded == 0 {
        return Ok(None);
    }

    let runs = sqlx::query!(
        r#"SELECT run_id, inputs_json as "inputs_json: Value"
           FROM provenance_run_repro WHERE project_id = $1"#,
        project_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let mut n = 0usize;
    for r in runs {
        if dataset_inputs_of_run(pool, &r.inputs_json)
            .await?
            .datasets
            .contains(&dataset_id)
        {
            n += 1;
        }
    }
    Ok(Some(n))
}
