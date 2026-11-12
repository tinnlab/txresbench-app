//! Provenance persistence (ITEM-2/3/4). sqlx COMPILE-TIME `query_as!`/`query!`
//! macros (canonical pattern — `dataset/repository.rs`): `timestamptz` needs the
//! `col as "col: DateTime<Utc>"` override (nullable → `col as "col?: T"`), `jsonb`
//! needs `col as "col: serde_json::Value"`.
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver):
//! `uuid` columns are 16-byte BLOBs read through sqlx's sqlite `Uuid` mapping,
//! `jsonb` columns are JSON TEXT and `timestamptz` columns are canonical
//! RFC3339-UTC TEXT (DEC-8's map), so the `<ident: Type>` overrides the PG
//! macro inference cannot produce are written out explicitly wherever the DB
//! type differs from the Rust type. The `now()` →
//! `strftime('%Y-%m-%dT%H:%M:%fZ','now')` clock (lexicographic ==
//! chronological on the canonical form), the `= ANY(uuid[])` → JSON1
//! membership rewrite (see [`uuid_list_json`]) and the
//! `DISTINCT ON` → window-function rewrite (DEC-12) are documented at their
//! sites.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;
use txresbench_core::AppError;

/// A content-addressed code blob row (ITEM-2).
#[derive(Debug, Clone)]
pub struct CodeBlob {
    pub sha256: String,
    pub language: String,
    pub source: String,
    pub byte_len: i64,
    pub created_at: DateTime<Utc>,
}

/// The run-node + reproducibility sidecar row (ITEM-3).
#[derive(Debug, Clone)]
pub struct RunReproRow {
    pub run_id: Uuid,
    /// Project (workbench) tenancy scope. NULL for a dataset-scoped run node (an
    /// owner-processing compute run, or a `kind='promote'` node) — ITEM-7/Task-B.
    pub project_id: Option<Uuid>,
    /// Dataset (owner) tenancy scope. NULL for a project-scoped run node. Exactly
    /// one of `project_id`/`dataset_id` is set on a live run node (ITEM-7/Task-B).
    pub dataset_id: Option<Uuid>,
    pub kind: String,
    pub status: String,
    pub generator_id: String,
    pub generator_version: String,
    pub code_sha256: Option<String>,
    pub env_rootfs_sha256: Option<String>,
    pub lockfile_json: Option<serde_json::Value>,
    pub seed: Option<i64>,
    pub params: serde_json::Value,
    pub inputs_json: serde_json::Value,
    /// **ITEM-6** — the full re-run spec (the original `AnalysisSpec` JSON) stashed
    /// for a COMPUTE run; `None` for an in-app interaction/promote run. Projected
    /// onto the wire DTO (`RunNodeDto.rerun_spec`, DEC-1 = BOTH) so a reviewer can
    /// inspect the replay envelope, and read by `graph::run_readiness` for the
    /// params-fidelity flag — both off THIS row, so neither costs a query.
    pub rerun_spec_json: Option<serde_json::Value>,
    pub acting_user: Option<Uuid>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub captured_at: DateTime<Utc>,
}

/// The values needed to insert a run node.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub run_id: Uuid,
    /// Project (workbench) scope — NULL when `dataset_id` is set (ITEM-7/Task-B).
    pub project_id: Option<Uuid>,
    /// Dataset (owner processing / promote) scope — NULL when `project_id` is set.
    pub dataset_id: Option<Uuid>,
    pub kind: String,
    pub status: String,
    pub generator_id: String,
    pub generator_version: String,
    pub code_sha256: Option<String>,
    pub env_rootfs_sha256: Option<String>,
    pub lockfile_json: Option<serde_json::Value>,
    pub seed: Option<i64>,
    pub params: serde_json::Value,
    pub inputs_json: serde_json::Value,
    pub acting_user: Option<Uuid>,
    /// The full re-run spec (the original `AnalysisSpec` JSON) for a COMPUTE run,
    /// so the verify path can re-execute it byte-faithfully (DEC-2). `None` for
    /// in-app interaction runs (not re-runnable via the compute path).
    pub rerun_spec_json: Option<serde_json::Value>,
}

/// A reference-resource root row (ITEM-4).
#[derive(Debug, Clone)]
pub struct ReferenceRow {
    pub id: Uuid,
    pub project_id: Option<Uuid>,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub accession: Option<String>,
    pub doi: Option<String>,
    pub content_hash: String,
    pub created_at: DateTime<Utc>,
}

/// The values needed to insert a reference resource.
#[derive(Debug, Clone)]
pub struct NewReference {
    pub project_id: Option<Uuid>,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub accession: Option<String>,
    pub doi: Option<String>,
    pub content_hash: String,
}

/// A re-run verification record row (ITEM-4/23).
#[derive(Debug, Clone)]
pub struct VerificationRow {
    pub id: Uuid,
    pub target_run_id: Uuid,
    pub project_id: Uuid,
    pub status: String,
    pub tolerance_mode: String,
    pub diff_report: serde_json::Value,
    pub rootfs_digest: Option<String>,
    pub cert_json: Option<serde_json::Value>,
    pub verified_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// The terminal result of a verification, applied by `update_verification_result`.
#[derive(Debug, Clone)]
pub struct VerificationResult {
    pub status: String,
    pub diff_report: serde_json::Value,
    pub rootfs_digest: Option<String>,
    pub cert_json: Option<serde_json::Value>,
}

pub struct ProvenanceRepository {
    pool: SqlitePool,
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume (the `= ANY(uuid[])` port — DEC-12/PROV-sqlite-store-4):
/// a JSON array of 32-char lowercase hex strings, compared against a 16-byte
/// BLOB column through `unhex()` —
/// `col IN (SELECT unhex(j.value) FROM json_each($1) AS j)`. This is the
/// ITEM-15 `txresbench-file` / ITEM-21 `dataset` convention (their
/// `uuid_list_json`), kept local because the app's modules are single-driver
/// (DEC-1) and beside the ONE `= ANY` site in this module it serves no other
/// surface.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

/// Append `id` unless already present. The lineage walk yields datasets in DECLARED edge
/// order and the SAME dataset can be reached by several edges (a run using both a dataset
/// edge and an artifact rooted in it); order is meaningful to the caller, so this preserves
/// first-seen position rather than sorting into a `HashSet`.
fn push_unique(out: &mut Vec<Uuid>, id: Uuid) {
    if !out.contains(&id) {
        out.push(id);
    }
}

impl ProvenanceRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // ----------------------------- code blobs (ITEM-2) -----------------------

    /// Insert a code blob, deduped by sha256 (`ON CONFLICT DO NOTHING`).
    pub async fn insert_code_blob(
        &self,
        sha256: &str,
        language: &str,
        source: &str,
        byte_len: i64,
    ) -> Result<(), AppError> {
        sqlx::query!(
            r#"INSERT INTO provenance_code_blobs (sha256, language, source, byte_len)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (sha256) DO NOTHING"#,
            sha256,
            language,
            source,
            byte_len,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    pub async fn get_code(&self, sha256: &str) -> Result<Option<CodeBlob>, AppError> {
        sqlx::query_as!(
            CodeBlob,
            r#"SELECT sha256, language, source, byte_len,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_code_blobs WHERE sha256 = $1"#,
            sha256,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // ----------------------------- run sidecar (ITEM-3) ----------------------

    pub async fn insert_run(&self, r: &NewRun) -> Result<RunReproRow, AppError> {
        Self::insert_run_with(&self.pool, r).await
    }

    /// The same insert, inside the CALLER's transaction.
    ///
    /// Exists so a writer that must not leave an orphan run node on rollback — the debug
    /// seeder, whose whole discipline is that a refused plan is a no-op — can record a run
    /// through this repository rather than issuing its own `INSERT`. There is exactly ONE
    /// statement below and both entry points share it: a second copy of that column list is
    /// how a fixture comes to write a row shape no real run writes.
    pub async fn insert_run_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        r: &NewRun,
    ) -> Result<RunReproRow, AppError> {
        Self::insert_run_with(&mut **tx, r).await
    }

    async fn insert_run_with<'e, E>(ex: E, r: &NewRun) -> Result<RunReproRow, AppError>
    where
        E: sqlx::Executor<'e, Database = Sqlite>,
    {
        sqlx::query_as!(
            RunReproRow,
            r#"INSERT INTO provenance_run_repro
                 (run_id, project_id, dataset_id, kind, status, generator_id, generator_version,
                  code_sha256, env_rootfs_sha256, lockfile_json, seed, params,
                  inputs_json, acting_user, rerun_spec_json)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
               RETURNING run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                         code_sha256, env_rootfs_sha256,
                         lockfile_json as "lockfile_json?: serde_json::Value",
                         seed,
                         params as "params: serde_json::Value",
                         inputs_json as "inputs_json: serde_json::Value",
                         rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                         acting_user as "acting_user: Uuid",
                         started_at as "started_at?: DateTime<Utc>",
                         finished_at as "finished_at?: DateTime<Utc>",
                         captured_at as "captured_at: DateTime<Utc>""#,
            r.run_id,
            r.project_id,
            r.dataset_id,
            r.kind,
            r.status,
            r.generator_id,
            r.generator_version,
            r.code_sha256,
            r.env_rootfs_sha256,
            r.lockfile_json,
            r.seed,
            r.params,
            r.inputs_json,
            r.acting_user,
            r.rerun_spec_json,
        )
        .fetch_one(ex)
        .await
        .map_err(AppError::database_error)
    }

    /// The full re-run spec (`AnalysisSpec` JSON) for a recorded COMPUTE run, or
    /// `None` if the run recorded none (an in-app interaction run — not
    /// re-runnable via the compute path). Read only by the verify path.
    pub async fn get_rerun_spec(
        &self,
        run_id: Uuid,
    ) -> Result<Option<serde_json::Value>, AppError> {
        let row = sqlx::query!(
            r#"SELECT rerun_spec_json as "rerun_spec_json?: serde_json::Value"
               FROM provenance_run_repro WHERE run_id = $1"#,
            run_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.and_then(|r| r.rerun_spec_json))
    }

    pub async fn get_run(&self, run_id: Uuid) -> Result<Option<RunReproRow>, AppError> {
        sqlx::query_as!(
            RunReproRow,
            r#"SELECT run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user as "acting_user: Uuid",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE run_id = $1"#,
            run_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Derive EVERY source dataset an artifact came from, from provenance (ITEM-21 — the
    /// derive-from-provenance decision; NO denormalized `source_dataset_id` column).
    ///
    /// ## Why a SET and not one dataset
    ///
    /// This used to be `source_dataset_of -> Option<Uuid>`, and it answered an integration of
    /// two datasets with the FIRST-DECLARED one — confidently, with nothing anywhere signalling
    /// that a second source existed. A position in `inputs_json` is not an identity: declaration
    /// order is an artifact of how a run recorded its edges, so "the first" carries no claim
    /// about which dataset the artifact is really OF. An artifact produced by merging Dataset 1
    /// and Dataset 2 is of BOTH, and the honest shape says so rather than picking a winner.
    ///
    /// Callers that need one dataset must now say what they do when there are several
    /// (`ListedArtifact` reports the singular field only when the set has exactly one member;
    /// the axis-scoping walk intersects sets instead of comparing scalars).
    ///
    /// ## Rules
    ///  - a dataset-scoped artifact (an ingested/uploaded file) IS its own dataset → `[dataset_id]`;
    ///  - a workbench run output is project-scoped (`dataset_id` NULL — a workbench run carries the
    ///    PROJECT scope, per `jobs_dataset_scope`), so it inherits the datasets of its run's USED
    ///    inputs: a `dataset` edge's `ref_id` IS a dataset id (terminal); an `artifact`/`upload`
    ///    edge's `ref_id` is an input artifact → walk UP to ITS datasets; a `reference`/host-path
    ///    edge resolves to no dataset (skipped).
    ///
    /// ORDER + DEDUP: results are in DECLARED edge order (the run's PRIMARY/matrix input is
    /// declared first), depth-first, so a single-source lineage yields exactly the one dataset the
    /// old scalar returned — the ordering rule is preserved, it just no longer TRUNCATES. One
    /// dataset reached by several edges appears once.
    ///
    /// The traversal is bounded by a visited-set (cycle-safe; each artifact resolved once) plus a
    /// recursion-DEPTH cap. Empty when nothing in the lineage is dataset-scoped.
    ///
    /// ITEM-22: surfaced in the artifact-list catalog response (`data_api::list_artifacts` →
    /// `derive_listing_provenance`) so the artifact-ref picker groups/labels candidates by their
    /// source datasets. The derivation is authoritative (provenance), not a denormalized column.
    pub async fn source_datasets_of(&self, artifact_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
        let mut out: Vec<Uuid> = Vec::new();
        self.source_dataset_walk(artifact_id, &mut seen, &mut out, 0)
            .await?;
        Ok(out)
    }

    /// Depth-first, declared-order ACCUMULATING helper for {@link source_datasets_of}. Boxed
    /// because it recurses across an `.await` (async recursion needs an explicit `Box::pin`).
    ///
    /// It appends to `out` and never early-returns on a hit: stopping at the first resolving edge
    /// is exactly the truncation this function exists not to do.
    fn source_dataset_walk<'a>(
        &'a self,
        artifact_id: Uuid,
        seen: &'a mut std::collections::HashSet<Uuid>,
        out: &'a mut Vec<Uuid>,
        depth: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
        #[derive(serde::Deserialize)]
        struct EdgeLite {
            kind: String,
            ref_id: Option<Uuid>,
        }
        Box::pin(async move {
            if depth > 256 {
                return Ok(()); // pathological-depth backstop (cycles already handled by `seen`)
            }
            if !seen.insert(artifact_id) {
                return Ok(());
            }
            // 1. The artifact's own dataset scope wins (an ingested/uploaded file).
            let art = sqlx::query!(
                r#"SELECT dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid" FROM artifacts WHERE id = $1"#,
                artifact_id
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(AppError::database_error)?;
            let Some(art) = art else { return Ok(()) };
            if let Some(ds) = art.dataset_id {
                push_unique(out, ds);
                return Ok(());
            }
            let Some(run_id) = art.run_id else { return Ok(()) };
            // 2. Walk the run's USED edges toward datasets, IN DECLARED ORDER — ALL of them.
            let row = sqlx::query!(
                r#"SELECT inputs_json as "inputs_json: serde_json::Value"
                   FROM provenance_run_repro WHERE run_id = $1"#,
                run_id
            )
            .fetch_optional(&self.pool)
            .await
            .map_err(AppError::database_error)?;
            let Some(row) = row else { return Ok(()) };
            // Propagate a schema mismatch instead of `unwrap_or_default()` → a real parse error must
            // surface, not silently become an empty edge list (a false "no source dataset").
            let edges: Vec<EdgeLite> = serde_json::from_value(row.inputs_json).map_err(|e| {
                AppError::internal_error(format!("provenance inputs_json parse failed for run {run_id}: {e}"))
            })?;
            for e in edges {
                let Some(rid) = e.ref_id else { continue };
                match e.kind.as_str() {
                    // terminal: ref_id IS a dataset id. Every dataset edge is a real source.
                    "dataset" => push_unique(out, rid),
                    // walk UP to the input artifact and take ITS datasets too.
                    "artifact" | "upload" => {
                        self.source_dataset_walk(rid, seen, out, depth + 1).await?
                    }
                    _ => {} // reference / host_path → not a dataset
                }
            }
            Ok(())
        })
    }

    /// Every run node for a project, newest-first (used by the graph facade).
    pub async fn runs_for_project(&self, project_id: Uuid) -> Result<Vec<RunReproRow>, AppError> {
        sqlx::query_as!(
            RunReproRow,
            r#"SELECT run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user as "acting_user: Uuid",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE project_id = $1
               ORDER BY captured_at DESC"#,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every run node scoped to a DATASET (owner-processing + the `kind='promote'`
    /// node that produces it), newest-first. The dataset-scoped counterpart to
    /// `runs_for_project` — a processing pipeline on a dataset shares its
    /// `dataset_id`, so this is that pipeline's run set (ITEM-20/21).
    pub async fn runs_for_dataset(&self, dataset_id: Uuid) -> Result<Vec<RunReproRow>, AppError> {
        sqlx::query_as!(
            RunReproRow,
            r#"SELECT run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user as "acting_user: Uuid",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE dataset_id = $1
               ORDER BY captured_at DESC"#,
            dataset_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every `kind='promote'` run node acted by a user (bounded by the user's own
    /// promote activity) — used by the forward walk to discover datasets promoted
    /// from a chain's artifacts and cross the promote boundary forward (ITEM-21).
    pub async fn promote_runs_for_user(&self, user_id: Uuid) -> Result<Vec<RunReproRow>, AppError> {
        sqlx::query_as!(
            RunReproRow,
            r#"SELECT run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user as "acting_user: Uuid",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro
               WHERE kind = 'promote' AND acting_user = $1
               ORDER BY captured_at DESC"#,
            user_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The producing `kind='promote'` run for a promoted dataset (the run whose
    /// `dataset_id` is this dataset and which crosses the promote boundary). `None`
    /// for an uploaded dataset (a true root). Used to key a dataset graph node's
    /// producing run (ITEM-20).
    pub async fn promote_run_for_dataset(
        &self,
        dataset_id: Uuid,
    ) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query!(
            r#"SELECT run_id as "run_id: Uuid" FROM provenance_run_repro
               WHERE dataset_id = $1 AND kind = 'promote'
               ORDER BY captured_at ASC
               LIMIT 1"#,
            dataset_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.map(|r| r.run_id))
    }

    /// Resolve a txresbench-file `files.id` to the dataset it belongs to + that dataset's
    /// merkle `content_hash` (the provenance link key for a `dataset` used-edge,
    /// ITEM-20). A file linked to no dataset yields `None`.
    pub async fn dataset_scope_for_file(
        &self,
        file_id: Uuid,
    ) -> Result<Option<(Uuid, Option<String>)>, AppError> {
        // A file can be linked to more than one dataset (M:N), so the `LIMIT 1`
        // needs a deterministic `ORDER BY` — otherwise which dataset's scope wins
        // is nondeterministic across runs. Earliest-created (then id) wins, stable.
        let row = sqlx::query!(
            r#"SELECT d.id as "dataset_id!: Uuid", d.content_hash
               FROM dataset_files df JOIN datasets d ON d.id = df.dataset_id
               WHERE df.file_id = $1
               ORDER BY d.created_at ASC, d.id ASC
               LIMIT 1"#,
            file_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.map(|r| (r.dataset_id, r.content_hash)))
    }

    /// The dataset ids attached to a project (M:N `project_datasets`, ITEM-3) — the
    /// project's datasets that seed the project-graph walk's dataset nodes (ITEM-20).
    pub async fn dataset_ids_for_project(&self, project_id: Uuid) -> Result<Vec<Uuid>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT dataset_id as "dataset_id: Uuid" FROM project_datasets WHERE project_id = $1"#,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.dataset_id).collect())
    }

    /// Every artifact scoped to a DATASET (the dataset-scoped processing lineage's
    /// outputs), newest-first — the `list_by_project` counterpart for the dataset
    /// (owner) tenancy scope (ITEM-20/23). Returns the full workstore `Artifact`
    /// (the export needs `object_key`/`stored_bytes`/`is_multifile` to stage bytes).
    pub async fn artifacts_for_dataset(
        &self,
        dataset_id: Uuid,
    ) -> Result<Vec<crate::modules::workstore::catalog::models::Artifact>, AppError> {
        sqlx::query_as!(
            crate::modules::workstore::catalog::models::Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts WHERE dataset_id = $1
               ORDER BY created_at DESC"#,
            dataset_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// A page of run nodes for a project (paginated trust view, DEC-11).
    pub async fn list_runs(
        &self,
        project_id: Uuid,
        page: i64,
        per_page: i64,
    ) -> Result<(Vec<RunReproRow>, i64), AppError> {
        let offset = (page - 1).max(0) * per_page;
        let rows = sqlx::query_as!(
            RunReproRow,
            r#"SELECT run_id as "run_id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", kind, status, generator_id, generator_version,
                      code_sha256, env_rootfs_sha256,
                      lockfile_json as "lockfile_json?: serde_json::Value",
                      seed,
                      params as "params: serde_json::Value",
                      inputs_json as "inputs_json: serde_json::Value",
                      rerun_spec_json as "rerun_spec_json?: serde_json::Value",
                      acting_user as "acting_user: Uuid",
                      started_at as "started_at?: DateTime<Utc>",
                      finished_at as "finished_at?: DateTime<Utc>",
                      captured_at as "captured_at: DateTime<Utc>"
               FROM provenance_run_repro WHERE project_id = $1
               ORDER BY captured_at DESC
               LIMIT $2 OFFSET $3"#,
            project_id,
            per_page,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let total = sqlx::query!(
            r#"SELECT count(*) as "count!" FROM provenance_run_repro WHERE project_id = $1"#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?
        .count;

        Ok((rows, total))
    }

    // -------------------------- reference resources (ITEM-4) -----------------

    /// Find an existing reference resource in the SAME scope as `project_id`
    /// (NULL-safe: a `None` scope matches only a global `project_id IS NULL` row)
    /// by content hash — the dedup guard for repeated identical uploads (ITEM-5).
    pub async fn find_reference_in_scope(
        &self,
        project_id: Option<Uuid>,
        content_hash: &str,
    ) -> Result<Option<ReferenceRow>, AppError> {
        sqlx::query_as!(
            ReferenceRow,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE content_hash = $1 AND project_id IS NOT DISTINCT FROM $2
               LIMIT 1"#,
            content_hash,
            project_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn insert_reference(&self, r: &NewReference) -> Result<ReferenceRow, AppError> {
        // ITEM-5 dedup: a repeated upload of the same blob must not accumulate
        // duplicate rows in the same scope. Fast path returns the existing row;
        // the `ON CONFLICT DO NOTHING` + re-select is the race backstop (two
        // concurrent identical uploads both miss the SELECT — §4: the unique
        // index `provenance_reference_dedup` makes the loser's INSERT a no-op).
        if let Some(existing) = self.find_reference_in_scope(r.project_id, &r.content_hash).await? {
            return Ok(existing);
        }
        let new_reference_id = Uuid::new_v4();
        let inserted = sqlx::query_as!(
            ReferenceRow,
            r#"INSERT INTO provenance_reference_resources
                 (id, project_id, kind, name, version, accession, doi, content_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT DO NOTHING
               RETURNING id as "id: Uuid", project_id as "project_id: Uuid", kind, name, version, accession, doi, content_hash,
                         created_at as "created_at: DateTime<Utc>""#,
            // (DEC-12: the PG chain's `DEFAULT gen_random_uuid()` has no SQLite
            // form — the ITEM-11 sqlite chain port records NO id default, so the
            // id is an app-side bind; RETURNING it is the same value.)
            new_reference_id,
            r.project_id,
            r.kind,
            r.name,
            r.version,
            r.accession,
            r.doi,
            r.content_hash,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        match inserted {
            Some(row) => Ok(row),
            // Lost the race: the concurrent insert won — return its row.
            None => self
                .find_reference_in_scope(r.project_id, &r.content_hash)
                .await?
                .ok_or_else(|| {
                    AppError::database_error(sqlx::Error::RowNotFound)
                }),
        }
    }

    /// Find a reference resource by id (valid for the project or global).
    pub async fn find_reference_by_id(
        &self,
        project_id: Uuid,
        id: Uuid,
    ) -> Result<Option<ReferenceRow>, AppError> {
        sqlx::query_as!(
            ReferenceRow,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)"#,
            id,
            project_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn list_references(&self, project_id: Uuid) -> Result<Vec<ReferenceRow>, AppError> {
        sqlx::query_as!(
            ReferenceRow,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", kind, name, version, accession, doi, content_hash,
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_reference_resources
               WHERE project_id = $1 OR project_id IS NULL
               ORDER BY created_at DESC"#,
            project_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // --------------------------- verifications (ITEM-4/5/9/23) ---------------

    /// Insert a `pending` verification and return the created row. `id` is
    /// caller-minted so the POST handler can return it before the detached
    /// re-run task runs.
    ///
    /// The inserted status is BOUND from [`super::verify::status::PENDING`] rather than
    /// spelled as a SQL literal — that vocabulary is the module's single source of truth
    /// for the status set (its DEC-4), and this is the insert that mints the first one
    /// (#295). Same value, one fewer scattered literal.
    pub async fn insert_verification(
        &self,
        id: Uuid,
        target_run_id: Uuid,
        project_id: Uuid,
        tolerance_mode: &str,
    ) -> Result<VerificationRow, AppError> {
        sqlx::query_as!(
            VerificationRow,
            r#"INSERT INTO provenance_verifications
                 (id, target_run_id, project_id, status, tolerance_mode)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                         diff_report as "diff_report: serde_json::Value",
                         rootfs_digest,
                         cert_json as "cert_json?: serde_json::Value",
                         verified_at as "verified_at?: DateTime<Utc>",
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            target_run_id,
            project_id,
            super::verify::status::PENDING,
            tolerance_mode,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Apply the terminal result of a re-run (status/diff/cert/rootfs +
    /// `verified_at = now()`). Returns the updated row.
    pub async fn update_verification_result(
        &self,
        id: Uuid,
        r: &VerificationResult,
    ) -> Result<VerificationRow, AppError> {
        sqlx::query_as!(
            VerificationRow,
            r#"UPDATE provenance_verifications SET
                    status = $2,
                    diff_report = $3,
                    rootfs_digest = $4,
                    cert_json = $5,
                    -- (DEC-8: the canonical RFC3339-UTC clock; lexicographic ==
                    -- chronological on both sides — the ITEM-19/20/21 form.)
                    verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1
               RETURNING id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                         diff_report as "diff_report: serde_json::Value",
                         rootfs_digest,
                         cert_json as "cert_json?: serde_json::Value",
                         verified_at as "verified_at?: DateTime<Utc>",
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            r.status,
            r.diff_report,
            r.rootfs_digest,
            r.cert_json,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    pub async fn get_verification(
        &self,
        id: Uuid,
    ) -> Result<Option<VerificationRow>, AppError> {
        sqlx::query_as!(
            VerificationRow,
            r#"SELECT id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// A page of verifications for a project, optionally filtered to one target run,
    /// newest-first. `per_page` is clamped by the caller (default 50, cap 500) —
    /// the bounded-list rule (§4).
    pub async fn list_verifications(
        &self,
        project_id: Uuid,
        target_run_id: Option<Uuid>,
        page: i64,
        per_page: i64,
    ) -> Result<Vec<VerificationRow>, AppError> {
        let offset = (page - 1).max(0) * per_page;
        sqlx::query_as!(
            VerificationRow,
            r#"SELECT id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications
               -- (DEC-12: the `$2::uuid` cast has no SQLite form — the
               -- Option<Uuid> bind is typed; `$2 IS NULL` keeps the caller's
               -- "filter off" arm, NULL-affinity is not an issue for uuid binds.)
               WHERE project_id = $1 AND ($2 IS NULL OR target_run_id = $2)
               ORDER BY created_at DESC
               LIMIT $3 OFFSET $4"#,
            project_id,
            target_run_id,
            per_page,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The latest TERMINAL verification for each of `run_ids`, in ONE query
    /// (no N+1 — used by the export bundle). Keyed by `target_run_id`.
    pub async fn latest_verifications_for_runs(
        &self,
        run_ids: &[Uuid],
    ) -> Result<HashMap<Uuid, VerificationRow>, AppError> {
        if run_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json_run_ids = uuid_list_json(run_ids);
        let rows = sqlx::query_as!(
            VerificationRow,
            r#"SELECT id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM (
                   -- (DEC-12: `DISTINCT ON (target_run_id)` has no SQLite form; the
                   -- window `ROW_NUMBER()` + `rn = 1` is its equivalent — same
                   -- one-row-per-run choice (newest `created_at`), same
                   -- exclusion of `pending`, and the caller consumes the rows as a
                   -- HashMap keyed by `target_run_id`, so the outer ordering is
                   -- irrelevant. The `= ANY(uuid[])` batch became JSON1
                   -- membership over [`uuid_list_json`] — the ITEM-15/21 form.)
                   SELECT id, target_run_id, project_id, status, tolerance_mode,
                          diff_report, rootfs_digest, cert_json, verified_at, created_at,
                          ROW_NUMBER() OVER (PARTITION BY target_run_id
                                             ORDER BY created_at DESC) AS rn
                     FROM provenance_verifications
                    WHERE target_run_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)
                      AND status <> 'pending'
               )
               WHERE rn = 1"#,
            json_run_ids,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| (r.target_run_id, r)).collect())
    }

    /// Boot reclamation: resolve any `pending` verification orphaned by a prior
    /// process (its detached task died with the server) to `error`, so a
    /// crash/restart never leaves a verification hung `pending` forever. Mirrors
    /// the jobs module's orphaned-`running` reset. Returns the count.
    pub async fn reset_pending_verifications(&self) -> Result<u64, AppError> {
        let res = sqlx::query!(
            r#"UPDATE provenance_verifications
               SET status = 'error',
                   -- (DEC-8: the `::jsonb` cast has no SQLite form — the column
                   -- holds JSON TEXT, so the literal is written directly.)
                   diff_report = '{"error":"interrupted by a server restart"}',
                   verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE status = 'pending'"#,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// The most recent TERMINAL verification for a run (used by the export bundle
    /// to fold the reproducibility claim). A `pending` row is excluded.
    pub async fn latest_verification_for_run(
        &self,
        target_run_id: Uuid,
    ) -> Result<Option<VerificationRow>, AppError> {
        sqlx::query_as!(
            VerificationRow,
            r#"SELECT id as "id: Uuid", target_run_id as "target_run_id: Uuid", project_id as "project_id: Uuid", status, tolerance_mode,
                      diff_report as "diff_report: serde_json::Value",
                      rootfs_digest,
                      cert_json as "cert_json?: serde_json::Value",
                      verified_at as "verified_at?: DateTime<Utc>",
                      created_at as "created_at: DateTime<Utc>"
               FROM provenance_verifications
               WHERE target_run_id = $1 AND status <> 'pending'
               ORDER BY created_at DESC
               LIMIT 1"#,
            target_run_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every DISTINCT non-null `env_rootfs_sha256` any extant run pins — the
    /// `referenced` set the rootfs cache GC keeps in preference to an unreferenced
    /// digest (#154). Deployment-wide, not project-scoped: the cache is a single
    /// shared directory, so a digest referenced by ANY project's run must count.
    /// Deleting a run drops its reference here automatically, which is what makes
    /// the next GC pass able to reclaim it.
    pub async fn distinct_env_rootfs_digests(&self) -> Result<Vec<String>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT DISTINCT env_rootfs_sha256 as "env_rootfs_sha256!"
               FROM provenance_run_repro
               WHERE env_rootfs_sha256 IS NOT NULL"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.env_rootfs_sha256).collect())
    }

    // --------------------------- cascade helpers (ITEM-26) -------------------

    /// Distinct non-null `code_sha256` refs the project's runs point at — collected
    /// BEFORE the run rows are deleted so the delete-time `GcManifest` can mark
    /// them for post-commit refcount GC.
    pub async fn code_sha_refs_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<Vec<String>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT DISTINCT code_sha256 as "code_sha256!"
               FROM provenance_run_repro
               WHERE project_id = $1 AND code_sha256 IS NOT NULL"#,
            project_id,
        )
        .fetch_all(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| r.code_sha256).collect())
    }

    /// Delete every run node for a project, inside the caller's tx. Returns the count.
    pub async fn delete_runs_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<u64, AppError> {
        let res = sqlx::query!(
            "DELETE FROM provenance_run_repro WHERE project_id = $1",
            project_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// Delete every verification record for a project, inside the caller's tx
    /// (ITEM-16). The `project_id` FK also cascades on a real project delete; this
    /// explicit path runs in the project-extension cascade (before the project row is
    /// removed) and returns the count.
    pub async fn delete_verifications_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<u64, AppError> {
        let res = sqlx::query!(
            "DELETE FROM provenance_verifications WHERE project_id = $1",
            project_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// Delete every reference resource for a project, inside the caller's tx. Only
    /// project-scoped rows (never the global `project_id IS NULL` refs).
    pub async fn delete_references_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<u64, AppError> {
        let res = sqlx::query!(
            "DELETE FROM provenance_reference_resources WHERE project_id = $1",
            project_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }
}
