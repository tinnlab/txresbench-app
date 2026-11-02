//! Catalog persistence (ITEM-2). sqlx COMPILE-TIME macros (canonical pattern —
//! `dataset/repository.rs`): `timestamptz` needs `col as "col: DateTime<Utc>"`,
//! `jsonb` needs `col as "col: serde_json::Value"` (see `jobs/repository.rs`).
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver; the
//! port rules are PROV-sqlite-store-4 / DEC-12). The deliberate substitutions:
//! the nil-uuid `'00000000-…'::uuid` literals become 16-byte-zero BLOB literals
//! (`X'0000…'` — the same spelling the ported chain's `artifacts_natural_key`
//! index uses), `now()` becomes the canonical RFC3339 `strftime` clock, the
//! jsonb containment/`jsonb_set`/`jsonb_path_query_array` predicates become
//! JSON1 (`json_type`, `json_set` + `json_quote`, `json_each`), and the
//! `datatype = ANY($n)` TEXT-array membership becomes `IN (SELECT value FROM
//! json_each($n))` (sqlx-sqlite binds no `Vec<T>`; DEC-8 TEXT-JSON transport).
//! The `LATERAL` join in `object_keys_for_project_in_tx` becomes a `json_tree`
//! walk (SQLite has no LATERAL — DEC-12's derived-table rule).

use chrono::{DateTime, Utc};
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;
use ziee_core::AppError;

use super::models::{Artifact, ArtifactFilter, NewArtifact};

pub struct CatalogRepository {
    pool: SqlitePool,
}

/// Serialize a `String` batch into the JSON-text form the SQLite membership
/// predicates consume (`json_each($n)` — DEC-8 TEXT-JSON array transport;
/// sqlx-sqlite has no `Vec<T>` bind).
pub(crate) fn text_list_json(xs: &[String]) -> String {
    serde_json::to_string(xs).expect("Vec<String> is JSON-serializable")
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume (`IN (SELECT unhex(j.value) FROM json_each($1) AS j)` —
/// the ITEM-15/19 convention; a TEXT-vs-BLOB `=` would never match).
pub(crate) fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("Vec<String> is JSON-serializable")
}

/// One live blob reference for the GC keep-set (ITEM-14).
///
/// It carries the artifact's IDENTITY, not just the key it points at, because the
/// sweep has to be able to say WHICH artifact it could not enumerate. A keep-set
/// built from `(object_key, is_multifile)` alone can only report an opaque
/// `sha256:…`, which is why the sweep's failure used to read "sweep failed; will
/// retry" — true, and useless to the person whose artifacts have no bytes. The
/// identity here is the same identity
/// [`ArtifactBytesRow`](crate::modules::workstore::presence::ArtifactBytesRow)
/// reports, so the two surfaces name the same thing the same way.
#[derive(Debug, Clone)]
pub struct BlobRefRow {
    pub artifact_id: Uuid,
    /// The owning project, so a diagnosis can point at that project's
    /// `GET /projects/{id}/artifacts/bytes-presence`. Nullable in the schema
    /// (dataset-scoped artifacts have no project).
    pub project_id: Option<Uuid>,
    /// The producer's own id for this output — how a person recognises it.
    pub output_id: String,
    pub object_key: String,
    pub is_multifile: bool,
}

const ARTIFACT_COLS: &str = r#"id, project_id, dataset_id, run_id, output_id, datatype,
    object_key, is_multifile, content_hash,
    structure as "structure: serde_json::Value",
    meta as "meta: serde_json::Value",
    role, status, stored_bytes, logical_bytes, created_by,
    created_at as "created_at: DateTime<Utc>",
    updated_at as "updated_at: DateTime<Utc>",
    hidden, representation_of"#;

impl CatalogRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Insert (or idempotently re-insert on the `(project_id, run_id, output_id)`
    /// natural key) one artifact row with `status = 'ready'`. Returns the row.
    ///
    /// **The id is bound app-side** (the first column, `$1`): the SQLite chain
    /// has no SQL uuid generator (the PG baseline's `DEFAULT gen_random_uuid()`
    /// is gone — the ITEM-17-recorded default gap, this module's instance of
    /// DEC-12's "gen_random_uuid() → Rust `Uuid::new_v4()` bind" rule).
    pub async fn insert_artifact(&self, a: &NewArtifact) -> Result<Artifact, AppError> {
        Self::insert_artifact_tx(&self.pool, a).await
    }

    /// The pool-or-tx variant is folded via a plain executor-generic helper below;
    /// callers inside the ingest transaction use `insert_artifact_in_tx`.
    async fn insert_artifact_tx(pool: &SqlitePool, a: &NewArtifact) -> Result<Artifact, AppError> {
        let new_artifact_id = Uuid::new_v4();
        sqlx::query_as!(
            Artifact,
            r#"INSERT INTO artifacts
                 (id, project_id, dataset_id, run_id, output_id, datatype, object_key,
                  is_multifile, content_hash, structure, meta, role, status,
                  stored_bytes, logical_bytes, created_by, hidden, representation_of)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ready',$13,$14,$15,$16,$17)
               ON CONFLICT (COALESCE(project_id, X'00000000000000000000000000000000'),
                            COALESCE(dataset_id, X'00000000000000000000000000000000'),
                            COALESCE(run_id, X'00000000000000000000000000000000'), output_id)
               DO UPDATE SET datatype = EXCLUDED.datatype,
                             object_key = EXCLUDED.object_key,
                             is_multifile = EXCLUDED.is_multifile,
                             content_hash = EXCLUDED.content_hash,
                             structure = EXCLUDED.structure,
                             meta = EXCLUDED.meta,
                             role = EXCLUDED.role,
                             status = 'ready',
                             stored_bytes = EXCLUDED.stored_bytes,
                             logical_bytes = EXCLUDED.logical_bytes,
                             hidden = EXCLUDED.hidden,
                             representation_of = EXCLUDED.representation_of,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                         object_key, is_multifile as "is_multifile: bool", content_hash,
                         structure as "structure: serde_json::Value",
                         meta as "meta: serde_json::Value",
                         role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>",
                         hidden as "hidden: bool", representation_of as "representation_of: Uuid""#,

            new_artifact_id,
            a.project_id,
            a.dataset_id,
            a.run_id,
            a.output_id,
            a.datatype,
            a.object_key,
            a.is_multifile,
            a.content_hash,
            a.structure,
            a.meta,
            a.role,
            a.stored_bytes,
            a.logical_bytes,
            a.created_by,
            a.hidden,
            a.representation_of,
        )
        .fetch_one(pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Insert inside a caller-owned transaction (the atomic ingest path, ITEM-5).
    pub async fn insert_artifact_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        a: &NewArtifact,
    ) -> Result<Artifact, AppError> {
        let new_artifact_id = Uuid::new_v4();
        sqlx::query_as!(
            Artifact,
            r#"INSERT INTO artifacts
                 (id, project_id, dataset_id, run_id, output_id, datatype, object_key,
                  is_multifile, content_hash, structure, meta, role, status,
                  stored_bytes, logical_bytes, created_by, hidden, representation_of)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ready',$13,$14,$15,$16,$17)
               ON CONFLICT (COALESCE(project_id, X'00000000000000000000000000000000'),
                            COALESCE(dataset_id, X'00000000000000000000000000000000'),
                            COALESCE(run_id, X'00000000000000000000000000000000'), output_id)
               DO UPDATE SET datatype = EXCLUDED.datatype,
                             object_key = EXCLUDED.object_key,
                             is_multifile = EXCLUDED.is_multifile,
                             content_hash = EXCLUDED.content_hash,
                             structure = EXCLUDED.structure,
                             meta = EXCLUDED.meta,
                             role = EXCLUDED.role,
                             status = 'ready',
                             stored_bytes = EXCLUDED.stored_bytes,
                             logical_bytes = EXCLUDED.logical_bytes,
                             hidden = EXCLUDED.hidden,
                             representation_of = EXCLUDED.representation_of,
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               RETURNING id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                         object_key, is_multifile as "is_multifile: bool", content_hash,
                         structure as "structure: serde_json::Value",
                         meta as "meta: serde_json::Value",
                         role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>",
                         hidden as "hidden: bool", representation_of as "representation_of: Uuid""#,

            new_artifact_id,
            a.project_id,
            a.dataset_id,
            a.run_id,
            a.output_id,
            a.datatype,
            a.object_key,
            a.is_multifile,
            a.content_hash,
            a.structure,
            a.meta,
            a.role,
            a.stored_bytes,
            a.logical_bytes,
            a.created_by,
            a.hidden,
            a.representation_of,
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(AppError::database_error)
    }

    /// One artifact row, **whatever its status** — `pending`, `ready`, or the `failed`
    /// the post-ingest conformance gate writes (ITEM-18 / DEC-12).
    ///
    /// The name says `any_status` because most callers must NOT have one. It used to be
    /// `get`, and every consumer in the tree — the byte routes, job-input staging,
    /// promote, the provenance input resolver — called it and used the row without ever
    /// looking at `status`, which is how the gate came to have a write with no read.
    ///
    /// A caller that intends to SERVE the bytes, STAGE them into a job, or PROMOTE them
    /// must turn the row into a
    /// [`ConsumableArtifact`](crate::modules::workstore::consume::ConsumableArtifact),
    /// which a non-`ready` row cannot become. This accessor is for the callers that
    /// legitimately want the row in any state: the metadata read (`GET /artifacts/{id}` —
    /// how an owner SEES a condemnation), DELETE (the owner's remedy; filtering here
    /// would strand the row and its blob forever), and provenance RECORDING (a lineage
    /// record must say truthfully what a run consumed).
    pub async fn get_any_status(&self, id: Uuid) -> Result<Option<Artifact>, AppError> {
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// List a project's artifacts, optionally filtered by datatype/run_id/output_id.
    /// `datatype_allow` is the concrete datatype-id set the CALLER resolved from a
    /// `subtypes_of`/`capability` filter via P2's registry (`NULL`/`None` = no such
    /// filter); when `Some`, only artifacts whose datatype is in the set are returned.
    /// Keeping the registry lookup in the handler leaves this repo pure SQL (P2 ITEM-22).
    pub async fn list_by_project(
        &self,
        project_id: Uuid,
        filter: &ArtifactFilter,
        datatype_allow: Option<&[String]>,
    ) -> Result<Vec<Artifact>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let datatype_bind = filter.datatype.as_deref();
        let output_id_bind = filter.output_id.as_deref();
        let datatype_allow_bind = datatype_allow.map(text_list_json);
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts
               WHERE project_id = $1
                 AND ($2 IS NULL OR datatype = $2)
                 AND ($3 IS NULL OR run_id = $3)
                 AND ($4 IS NULL OR output_id = $4)
                 AND ($5 IS NULL OR datatype IN (SELECT j.value FROM json_each($5) AS j))
               ORDER BY created_at DESC"#,
            project_id,
            datatype_bind,
            filter.run_id,
            output_id_bind,
            datatype_allow_bind,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// List a project's WORKBENCH-scoped artifacts: those directly project-scoped
    /// (`project_id = $1`) PLUS those belonging to the project's ATTACHED datasets
    /// (`project_datasets`). An IMPORTED dataset's artifacts are dataset-scoped
    /// (`project_id` is NULL, `dataset_id` set — ITEM-23), so `list_by_project`
    /// (project-scoped only) never surfaces them. The workbench catalog + artifact
    /// picker must include them or an `accepts`-gated analysis (e.g. `cell.filter`
    /// accepting `single-cell/expression`) never lights up and can't resolve its
    /// input. Filters mirror `list_by_project`. A single OR-WHERE returns each row
    /// once (no UNION/dedup needed). Provenance's graph seeds attached datasets on a
    /// separate frontier, so it deliberately keeps `list_by_project` (project-only)
    /// to avoid double-counting — this method is the workbench data-plane's alone.
    pub async fn list_for_project_scope(
        &self,
        project_id: Uuid,
        filter: &ArtifactFilter,
        datatype_allow: Option<&[String]>,
    ) -> Result<Vec<Artifact>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let datatype_bind = filter.datatype.as_deref();
        let output_id_bind = filter.output_id.as_deref();
        let datatype_allow_bind = datatype_allow.map(text_list_json);
        let on_axis_bind = filter.on_axis.as_deref();
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts
               -- ITEM-49 — THE LISTING USES THE SAME SCOPE RULE AS THE AUTHZ GATE.
               --
               -- `authz::artifact_scope` resolves a row carrying BOTH columns to
               -- `Project(p)` — the project takes precedence — so `require_artifact_read`
               -- gates such a row by its project. The listing's second disjunct did not
               -- agree: it matched on `dataset_id` alone, so once the ownership backfill
               -- filled that column on project-produced rows, an artifact of project P
               -- appeared in project Q's catalog whenever the dataset was attached to both.
               -- Measured, not theorised: `dual_scope_visibility_test` observed exactly that
               -- (1 where 0 was expected) before this clause.
               --
               -- The byte plane was never exposed — `artifact_scope` denied it — so what
               -- widened was metadata: the existence, `output_id`, datatype and declared
               -- structure of another project's derived work. That is still a disclosure,
               -- and it arrives as a side effect of a column being filled.
               --
               -- `project_id IS NULL` restores the pre-backfill set exactly: a row is listed
               -- in the project that PRODUCED it, or — when it is dataset-scoped and has no
               -- producing project — in every project the dataset is attached to. Whether a
               -- project-produced artifact SHOULD follow its dataset into other projects is
               -- a product decision (it is one line here); it must not be taken by accident.
               WHERE (project_id = $1
                      OR (project_id IS NULL AND dataset_id IN (
                          SELECT pd.dataset_id FROM project_datasets pd WHERE pd.project_id = $1)))
                 AND ($2 IS NULL OR datatype = $2)
                 AND ($3 IS NULL OR run_id = $3)
                 AND ($4 IS NULL OR output_id = $4)
                 AND ($5 IS NULL OR datatype IN (SELECT j.value FROM json_each($5) AS j))
                 -- ITEM-30 — the MEMBERSHIP narrowing (INV-2). The PG arm was
                 -- containment against the GIN `jsonb_path_query_array` expression
                 -- index `202608040004`; the SQLite chain carries NO such index
                 -- (202608280001's port note: JSON1 has no GIN and `json_each`
                 -- cannot appear in an index expression), so the predicate here is
                 -- the ported form — `EXISTS (SELECT 1 FROM json_each(...))` over
                 -- the scope-narrowed rows (bounded), spelled with the exact
                 -- `json_type(..., path) IS NOT NULL` treatment for the two
                 -- absence arms so PG `-> IS NULL` semantics (a JSON-null value is
                 -- a PRESENT key) survive.
                 --
                 -- No identity judgment in SQL, no ordering, no `LIMIT 1`: which candidate is
                 -- OFFERED is decided in TypeScript, where it is unit-testable without a
                 -- database. This narrows the set and decides nothing — the same division
                 -- `list_dataset_axis_index_candidates` draws, and for the same reason its
                 -- doc records.
                 --
                 -- THREE ARMS, and the last two are what make the filter a strict SUPERSET of
                 -- what the client offers (INV-2, TEST-47). A pure containment test would be a
                 -- SUBSET: every artifact in every project today declares the legacy scalar and
                 -- no `memberships` array at all, so containment alone would return nothing and
                 -- the pane would silently lose every offer it has — with no error anywhere,
                 -- which is the exact failure that test exists to catch.
                 --
                 --   1. declares a membership on this axis — the array arm;
                 --   2. declares the LEGACY SCALAR for this axis — which IS a membership
                 --      (ITEM-2 reads it as `kind: full`), just in the older spelling;
                 --   3. declares NEITHER — A3, unknown alignment, which is OFFERED and must
                 --      therefore survive the narrowing.
                 --
                 -- What it drops is A2 and A4: rows that positively declare a DIFFERENT axis.
                 -- On a multi-dataset project that is the bulk of the catalog, which is where
                 -- the narrowing is worth having.
                 --
                 -- NO `status` clause, deliberately. `list_for_project_scope` does not filter on
                 -- status today and the client's offering predicate does not either, so adding
                 -- one HERE would make the server narrower than the client in precisely the way
                 -- INV-2 forbids. Staged/condemned artifacts are refused at CONSUMPTION
                 -- (`ConsumableArtifact`), which is enforcement; this is narrowing.
                 AND ($6 IS NULL OR (
                        EXISTS (
                          SELECT 1 FROM json_each(COALESCE(
                                     json_extract(structure, '$.memberships'), '[]')) AS j
                          WHERE json_extract(j.value, '$.aligned_to') = $6)
                        OR json_extract(structure, '$.aligned_to') = $6
                        OR (json_type(structure, '$.memberships') IS NULL
                            AND json_type(structure, '$.aligned_to') IS NULL)))
               ORDER BY created_at DESC"#,
            project_id,
            datatype_bind,
            filter.run_id,
            output_id_bind,
            datatype_allow_bind,
            on_axis_bind,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Every `ready` KEY-ARTIFACT row of a dataset carrying the axis LABEL `axis` —
    /// the CANDIDATE set [`resolve_axis_key_artifact`] then decides over. Pure SQL:
    /// which candidate (if any) IS the axis is an identity question, answered in Rust
    /// where it is unit-testable without a database.
    ///
    /// The match is over the producer's own DECLARATIONS, both stored verbatim
    /// (ITEM-5/6) and neither synthesized here:
    ///   * `meta.is_axis_index = true` — the producer SAYS this artifact is a key
    ///     artifact. That is a declaration, not a naming convention.
    ///   * `structure.axis = $axis` — the axis it is the key for, matched as the
    ///     LABEL it is.
    ///
    /// **artifact-model ITEM-8 changed how the label enters.** The lookup used to be
    /// BUILT from the axis name — `output_id = format!("{axis}_index")` — which made
    /// the name a KEY into the catalog namespace: two spellings of one entity set
    /// (`rows` vs `row`) addressed two different artifacts, an id the producer chose
    /// for readability became a wire contract nobody could rename, and an artifact
    /// that WAS an axis under any other `output_id` was unfindable.
    ///
    /// The `datatype_allow` set is the caller-resolved metadata-column family
    /// (registry-derived from the `metadata-column-family` capability, DEC-12) bound
    /// as the JSON1 membership `datatype IN (SELECT value FROM json_each($n))`
    /// (the SQLite port of `datatype = ANY($n)`) — the repo stays pure SQL with
    /// NO datatype-id literal, and a contributed subtype resolves for free.
    ///
    /// `ORDER BY id` is for a DETERMINISTIC candidate order, not a preference: no
    /// ordering of this list may decide which axis the caller gets (that was the bug —
    /// see [`resolve_axis_key_artifact`]).
    ///
    /// `AND status = 'ready'` is the ITEM-18 / DEC-12 read half expressed in SQL, and it
    /// belongs at CANDIDATE SELECTION rather than only at consumption: a condemned key
    /// artifact left in the candidate set would not merely be staged, it would make the
    /// label AMBIGUOUS against the good one and take the whole axis down with it. The
    /// consumption-side guard
    /// ([`ConsumableArtifact`](crate::modules::workstore::consume::ConsumableArtifact),
    /// applied in `sandbox::inputs::stage_artifact`) still runs underneath — this is
    /// selection, that is enforcement.
    pub async fn list_dataset_axis_index_candidates(
        &self,
        dataset_id: Uuid,
        axis: &str,
        datatype_allow: &[String],
    ) -> Result<Vec<Artifact>, AppError> {
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let datatype_allow_json = text_list_json(datatype_allow);
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts
               WHERE dataset_id = $1
                 AND datatype IN (SELECT j.value FROM json_each($2) AS j)
                 AND json_type(meta, '$.is_axis_index') = 'true'
                 AND json_extract(structure, '$.axis') = $3
                 AND status = 'ready'
               ORDER BY id"#,
            dataset_id,
            datatype_allow_json,
            axis,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Resolve a dataset's per-axis KEY artifact — the artifact that IS the axis
    /// (INV-3), scoped to `dataset_id` and labelled `axis`.
    ///
    /// [`list_dataset_axis_index_candidates`] selects by label; identity decides. See
    /// [`resolve_axis_key_artifact`] for what "decides" means and why a `LIMIT 1` here
    /// was the defect.
    ///
    /// `Ok(None)` when the import has not (yet) emitted a key artifact for that axis
    /// (or the allow-set is empty) — the caller surfaces that as a run-time
    /// input-resolution failure, never a guess. `Err(AXIS_AMBIGUOUS)` when the label
    /// names more than one axis.
    pub async fn find_dataset_axis_index(
        &self,
        dataset_id: Uuid,
        axis: &str,
        datatype_allow: &[String],
    ) -> Result<Option<Artifact>, AppError> {
        let candidates = self
            .list_dataset_axis_index_candidates(dataset_id, axis, datatype_allow)
            .await?;
        Ok(resolve_axis_key_artifact(dataset_id, axis, candidates)?)
    }

    pub async fn list_by_run(
        &self,
        project_id: Uuid,
        run_id: Uuid,
    ) -> Result<Vec<Artifact>, AppError> {
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id, datatype,
                      object_key, is_multifile as "is_multifile: bool", content_hash,
                      structure as "structure: serde_json::Value",
                      meta as "meta: serde_json::Value",
                      role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>",
                      hidden as "hidden: bool", representation_of as "representation_of: Uuid"
               FROM artifacts WHERE project_id = $1 AND run_id = $2
               ORDER BY created_at DESC"#,
            project_id,
            run_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// **Every USABLE artifact of a dataset — the source columns a filter VD gathers through
    /// its mask (ITEM-13, §11.3).**
    ///
    /// The filter sink mints a virtual dataset over ONE source and must gather that source's
    /// columns (the sparse expression matrix + each metadata column) into recipe rows bound to
    /// the VD. The population is `usable_artifacts` (`status='ready' AND NOT hidden AND
    /// role='artifact'`) — exactly the columns a user can act on, which is what the VD must
    /// re-expose. A source's own mask/gathered-intermediate rows are excluded by that view
    /// (`role <> 'artifact'` / `hidden`), so a filter OVER a filter VD gathers its exposed
    /// columns and not its plumbing.
    pub async fn list_usable_by_dataset(
        &self,
        dataset_id: Uuid,
    ) -> Result<Vec<Artifact>, AppError> {
        // A VIEW makes sqlx infer every column nullable, so each NOT-NULL field of `Artifact` is
        // forced with `!` (the jsonb/timestamptz casts keep their type override too).
        sqlx::query_as!(
            Artifact,
            r#"SELECT id as "id!: Uuid", project_id as "project_id: Uuid", dataset_id as "dataset_id: Uuid", run_id as "run_id: Uuid", output_id as "output_id!",
                      datatype as "datatype!", object_key, is_multifile as "is_multifile!: bool",
                      content_hash as "content_hash!",
                      structure as "structure!: serde_json::Value",
                      meta as "meta!: serde_json::Value",
                      role as "role!", status as "status!", stored_bytes as "stored_bytes!",
                      logical_bytes, created_by as "created_by: Uuid",
                      created_at as "created_at!: DateTime<Utc>",
                      updated_at as "updated_at!: DateTime<Utc>",
                      hidden as "hidden!: bool", representation_of as "representation_of: Uuid"
               FROM usable_artifacts WHERE dataset_id = $1
               ORDER BY created_at ASC"#,
            dataset_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// **Re-bind a run-produced keep-mask artifact to the virtual dataset it selects rows for
    /// (ITEM-13, §11.3 / DEC-6).**
    ///
    /// A filter run emits its per-row boolean keep-mask as an ordinary `role='artifact'`
    /// output in the RUN's scope. The finalize sink mints the filter VD and hands the mask to it
    /// here: `dataset_id = <VD>` (ownership — the `ON DELETE CASCADE` on `dataset_id` is what makes
    /// deleting the VD remove its mask), `role = 'mask'` + `hidden = true` (so it leaves the USABLE
    /// population and the listing — §3.4, a mask is never a first-class artifact), `project_id = NULL`
    /// (owned by the VD, reached through `project_datasets`, not project-scoped), and
    /// `meta = mask_meta(source)` so it RECORDS the source dataset it filters (the channel the detach
    /// guard protects by and the cascade scopes deletion by — `mask::mask_meta`).
    ///
    /// `WHERE object_key IS NOT NULL` — a mask carries REAL bytes (`artifacts_bytes_or_recipe`), so
    /// this refuses to stamp `role='mask'` onto a gathered row by mistake. `Ok(false)` = no row
    /// matched. Idempotent on the boot re-finalize: the sink's existing-VD short-circuit runs before
    /// this, so it stamps once; a second stamp of the SAME row is a no-op against the
    /// `artifacts_one_mask_per_dataset` index (same row, same `dataset_id`).
    pub async fn bind_mask_to_dataset(
        &self,
        mask_id: Uuid,
        dataset_id: Uuid,
        source_dataset_id: &str,
    ) -> Result<bool, AppError> {
        let meta = super::super::mask::mask_meta(source_dataset_id);
        let res = sqlx::query!(
            "UPDATE artifacts \
                SET dataset_id = $2, project_id = NULL, role = $3, hidden = true, \
                    meta = $4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = $1 AND object_key IS NOT NULL",
            mask_id,
            dataset_id,
            super::super::mask::MASK_ROLE,
            meta,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Set one artifact's status. `Ok(false)` = no row matched.
    ///
    /// The boolean is not cosmetic: the conformance gate writes `failed` here, and a
    /// condemnation that matched no row is a condemnation that was NOT enforced. Reporting
    /// that as success let the gate's own log claim an artifact had been marked failed
    /// when nothing had been written (see `jobs::conformance::VerdictApplication`).
    pub async fn set_status(&self, id: Uuid, status: &str) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE artifacts SET status = $2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1",
            id,
            status,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Move a GATHERED artifact into `unresolvable` — ITEM-30's DETECTOR (blind audit
    /// finding 13).
    ///
    /// Narrower than [`set_status`] in two ways the caller must not have to remember, because
    /// the caller is a serve-path error branch and that is the worst place to hold a rule:
    ///
    /// * **`object_key IS NULL`** — only a gathered row CAN be unresolvable. The status means
    ///   "this artifact's declaration is fine and its SOURCES are gone"; a stored row has no
    ///   sources, so marking one would be a claim about something that cannot happen to it.
    ///   A wrong `artifact_id` reaching here therefore writes nothing instead of condemning a
    ///   healthy blob-backed artifact.
    /// * **`status <> 'unresolvable'`** — idempotent, so a column read by ten panes writes
    ///   once and the returned bool means "this call is what moved it", not "it is in that
    ///   state". That distinction is what makes the log line honest.
    ///
    /// Deliberately does NOT move a row back out: re-resolution is not this path's business,
    /// and a detector that silently un-condemned would hide a flapping source.
    /// `unresolved_source` names WHAT went missing, and it is not optional: `consume`'s
    /// refusal reads `meta.unresolved_source` and, absent it, renders *"(the invalidation did
    /// not record which source)"*. Writing the status without it would install a state whose
    /// own message apologises for having no content — a placeholder read as a fact. The field
    /// had readers and no writer for the same reason the STATUS did.
    pub async fn mark_unresolvable(
        &self,
        id: Uuid,
        unresolved_source: &str,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE artifacts \
                SET status = $2, \
                    meta = json_set(COALESCE(meta, '{}'), '$.unresolved_source', \
                                    json_quote($3)), \
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
             WHERE id = $1 AND object_key IS NULL AND status <> $2",
            id,
            super::super::consume::STATUS_UNRESOLVABLE,
            unresolved_source,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Delete one artifact row (the blob is reclaimed later by the GC sweep only
    /// if no other row references it — never eagerly, DEC-13).
    pub async fn delete(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM artifacts WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Every artifact's `(object_key, is_multifile)` for a project, inside the
    /// caller's tx — collected BEFORE the rows are deleted so the delete-time
    /// `GcManifest` can mark the project's blobs (ITEM-14 collect).
    pub async fn object_keys_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<Vec<BlobRefRow>, AppError> {
        // ITEM-28 — a GATHERED artifact names no blob of its own, but the blobs its
        // alignment REACHES are exactly what must survive the sweep. Resolving that is a
        // pure METADATA walk: the DEC-8 recipe names the alignment artifact and, per source
        // dataset, the artifact contributing its bytes — so no object-store read, and no
        // decoder, is needed to know what to keep. **That survived the recipe rewrite
        // unchanged in kind**: only the JSON path moved, from the superseded
        // `source_artifact_id` / `row_vector_artifact_id` pair to `alignment_artifact_id`
        // plus `sources[].artifact_id`.
        //
        // A RECURSIVE CTE rather than a loop, because composition means a source can be
        // several hops away and a one-level walk would keep the nearest and silently collect
        // the rest — passing a direct-reachability test while destroying the data. The walk
        // follows BOTH edges (source and row vector); a row vector is as load-bearing as the
        // values, since a gather without it returns nothing.
        //
        // `UNION` (not `UNION ALL`) terminates a cycle by construction: a repeated id is not
        // re-expanded. Cycles should be unconstructible, but GC is the one place where
        // looping forever is worse than the thing it guards against.
        //
        // Both edges are walked for the same reason as before: the ALIGNMENT is as
        // load-bearing as the sources, since a gather without it resolves to nothing, and
        // collecting either half leaves a column that reads short with no error.
        // SQLite port (record — DEC-12's LATERAL rewrite): SQLite has no
        // `LATERAL` and no `jsonb_path_query_array`; the three ref sources
        // (alignment, mask, each `sources[].artifact_id`) are THREE terms of
        // the recursive member, all `json_extract`/`json_each` JSON1 (measured:
        // `json_tree`'s path/value columns quote keys version-dependently, so
        // path-matching the recipe is not portable — the chain's JSON1 rule is
        // the stable instrument). `UNION` (not `UNION ALL`) terminates a cycle
        // by construction: a repeated id is not re-expanded. The
        // `? 'gathered_from'` check is spelled `json_type(..., path) IS NOT
        // NULL` (migration 202608040010's `jsonb_exists` rule); the refs are
        // the producers' hyphenated uuid strings, so
        // `unhex(replace(...,'-',''))` restores the 16-byte BLOB form
        // `reach(id)` joins against (the TEXT-vs-BLOB `=` would never match —
        // ITEM-15/19's membership note).
        let rows = sqlx::query!(
            r#"WITH RECURSIVE reach(id) AS (
                   SELECT id FROM artifacts WHERE project_id = $1
                 UNION
                   SELECT unhex(replace(json_extract(a.structure,
                              '$.gathered_from.alignment_artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_extract(a.structure,
                              '$.gathered_from.alignment_artifact_id') IS NOT NULL
                 UNION
                   -- The MASK is as load-bearing as the alignment (ITEM-1/ITEM-2): a
                   -- masked gather without it resolves to nothing, so its blob must be
                   -- kept while any column reads through it. Null for the integration
                   -- (no-mask) and identity cases; the IS NOT NULL guard drops those.
                   SELECT unhex(replace(json_extract(a.structure,
                              '$.gathered_from.mask_artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_extract(a.structure,
                              '$.gathered_from.mask_artifact_id') IS NOT NULL
                 UNION
                   SELECT unhex(replace(json_extract(jt.value, '$.artifact_id'), '-', ''))
                   FROM reach r
                   JOIN artifacts a ON a.id = r.id
                   JOIN json_each(COALESCE(
                            json_extract(a.structure, '$.gathered_from.sources'), '[]')) AS jt
                   WHERE a.object_key IS NULL
                     AND json_type(a.structure, '$.gathered_from') IS NOT NULL
                     AND json_type(jt.value, '$.artifact_id') = 'text'
               )
               SELECT a.id as "id: Uuid", a.project_id as "project_id: Uuid", a.output_id, a.object_key, a.is_multifile as "is_multifile: bool"
               FROM artifacts a JOIN reach r ON a.id = r.id"#,
            project_id,
        )
        .fetch_all(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            // OPENED for the control run: a gathered row contributes no blob of its own;
            // its reachable sources were expanded by the CTE above.
            .filter_map(|r| {
                r.object_key.map(|object_key| BlobRefRow {
                    artifact_id: r.id,
                    project_id: r.project_id,
                    output_id: r.output_id,
                    object_key,
                    is_multifile: r.is_multifile,
                })
            })
            .collect::<Vec<_>>())
    }

    /// Delete every artifact row for a project, inside the caller's tx (ITEM-12
    /// cascade). Returns the count removed.
    pub async fn delete_for_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        project_id: Uuid,
    ) -> Result<u64, AppError> {
        let res = sqlx::query!("DELETE FROM artifacts WHERE project_id = $1", project_id)
            .execute(&mut **tx)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// Deep-copy a project's artifact rows into `dst`, RE-REFERENCING the same
    /// immutable blobs by key (DEC-14 — no byte copy). Returns the count copied.
    pub async fn copy_to_project_in_tx(
        tx: &mut Transaction<'_, Sqlite>,
        src_project_id: Uuid,
        dst_project_id: Uuid,
    ) -> Result<u64, AppError> {
        let res = sqlx::query!(
            r#"INSERT INTO artifacts
                 (project_id, run_id, output_id, datatype, object_key,
                  is_multifile, content_hash, structure, meta, role, status,
                  stored_bytes, logical_bytes, created_by)
               SELECT $2, run_id, output_id, datatype, object_key,
                      is_multifile, content_hash, structure, meta, role, status,
                      stored_bytes, logical_bytes, created_by
               FROM artifacts WHERE project_id = $1"#,
            src_project_id,
            dst_project_id,
        )
        .execute(&mut **tx)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected())
    }

    /// Every live artifact's object_key (+ whether it's a multi-file manifest),
    /// for the GC keep-set union (ITEM-14).
    ///
    /// **Deliberately unfiltered by `status`, and it must stay that way.** This is a
    /// KEEP-set, so the predicate is "a row references this blob", not "a consumer may
    /// read it". Excluding the rows the conformance gate condemned (ITEM-18 / DEC-12)
    /// would delete the blobs of artifacts still listed in the catalog, leaving rows
    /// pointing at nothing — and the owner's remedy for a condemned artifact is to
    /// inspect and DELETE the row, which is what actually releases the blob on the next
    /// sweep. Same reasoning for `object_keys_for_project_in_tx` (the delete-cascade
    /// collect) and `footprint` (disk used is disk used, whatever the status).
    pub async fn all_blob_refs(&self) -> Result<Vec<BlobRefRow>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", project_id as "project_id: Uuid", output_id, object_key, is_multifile as "is_multifile: bool" FROM artifacts"#
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows
            .into_iter()
            // ITEM-16 / ITEM-28 — a GATHERED artifact names no blob of its own, so it
            // contributes no blob ref HERE and is skipped.
            //
            // **This function previously REFUSED such a row**, on the reasoning that
            // filtering it would let the sweep collect the blobs its alignment reads
            // through. That reasoning is correct for a PROJECT-SCOPED keep-set and wrong for
            // this one, and the difference is the whole of it: this query is
            // `SELECT … FROM artifacts` with no `WHERE`, so every source artifact of every
            // alignment is ALREADY in this set, contributing its own key from its own row.
            // Skipping a blob-less row removes nothing from the keep-set.
            //
            // The cost of the refusal was not theoretical. `gc.rs:413/483` are the global
            // sweep and the project reclaim; `lifecycle.rs` logs and swallows their error.
            // So a single gathered artifact anywhere in the deployment stopped ALL blob
            // reclamation, silently and permanently — disk growing with nothing in the logs
            // that reads as a failure. Found by a blind audit; the tests could not see it
            // because nothing in the server can create a gathered artifact yet.
            .filter_map(|r| {
                let object_key = r.object_key?;
                Some(BlobRefRow {
                    artifact_id: r.id,
                    project_id: r.project_id,
                    output_id: r.output_id,
                    object_key,
                    is_multifile: r.is_multifile,
                })
            })
            .collect::<Vec<_>>())
    }

    /// What a project HOLDS: the count and combined size of its **usable** artifacts —
    /// the `usable_artifacts` view (`status='ready' AND NOT hidden AND role='artifact'`),
    /// which is the ONE definition of that population and the same one the per-dataset
    /// artifact summary reads.
    ///
    /// The population is not incidental here, it is the function's meaning. This total
    /// is read by `collect_summary`, which renders it as `"N results / X GB"`, and
    /// *result* is a claim about what the user can act on — so the query has to be about
    /// the same thing the word is. It previously counted every row with no `WHERE` at
    /// all, on the reasoning that "disk used is disk used, whatever the status" (the
    /// stance `all_blob_refs` states, correctly, for a blob keep-set). That reasoning is
    /// right for a keep-set and wrong here: a project holding three failed uploads
    /// advertised "3 results" and a byte total nothing in the app could show you, and
    /// the same artifacts counted one way on the project tag and another on the dataset
    /// summary, which now reads the identical population through the identical view.
    ///
    /// If a genuine DISK reading is ever needed, it is a different function with a
    /// different name and a label that says "stored" — not a quiet edit to this one.
    ///
    /// **Not currently on screen.** `WorkstoreProjectExtension::collect_summary` is this
    /// function's only caller, and the registry aggregate that would serve it
    /// (`ProjectExtensionRegistry::collect_summary`) has no route — see the note there.
    /// The divergence this fixes was therefore latent rather than visible, and the fix is
    /// worth having anyway: the label is what the surface WILL say when it is mounted,
    /// and a definition that only two of three surfaces share is the state that produced
    /// the defect.
    pub async fn footprint(&self, project_id: Uuid) -> Result<(i64, i64), AppError> {
        let row = sqlx::query!(
            // LOGICAL, not stored. The label this feeds says "3.4 GB" next to a result
            // count — a size-of-the-data question, so it sums the size-of-the-data
            // column. Summing `stored_bytes` here counted a gathered artifact as 0 and
            // understated the project by however much data it actually holds.
            //
            // `sum` already ignores NULLs, so a row whose logical size is UNKNOWN
            // contributes nothing rather than a fabricated 0 — the same understatement
            // in kind, but confined to rows where no width is derivable at all, and it
            // is the only arithmetic a scalar total can honestly do. A surface that
            // needs to distinguish "small" from "unknown" has to carry the unknown
            // COUNT, and this signature deliberately does not pretend to.
            //
            // SQLite port (record): the `::bigint` cast is gone; the expression column
            // carries the typed override instead — the sqlite macro infers the NULL
            // affinity of a `COALESCE(..., 0)` literal (the ITEM-18 `one: i64` class),
            // and `sum()` over the INTEGER column is i64-faithful (the DEC-8 map).
            r#"SELECT count(*) as "count!",
                      coalesce(sum(logical_bytes), 0) as "bytes!: i64"
               FROM usable_artifacts WHERE project_id = $1"#,
            project_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok((row.count, row.bytes))
    }
}

/// Decide WHICH of a label's candidate key artifacts is the axis — by IDENTITY (INV-3).
///
/// > *An axis IS its key artifact; identity is that artifact's `content_hash`. The axis
/// > NAME is a label, never a key.*
///
/// The label is a legitimate SELECTOR — it is what a user picks off a datatype's declared
/// axes, and what a job spec can carry before the import that mints the key artifact has
/// even run — but it does not IDENTIFY. So this function keys on `content_hash` and
/// nothing else, and the three cases are:
///
/// * **no candidate** → `Ok(None)`. Absence is absence; the caller reports an unresolved
///   input rather than inventing one (INV-2).
/// * **one identity** → that axis. Several rows may share it (the same bytes re-ingested
///   under another `output_id` / run): the same `content_hash` cannot be two axes, so any
///   of those rows serves and the first in the caller's deterministic order is taken.
/// * **more than one identity** → `Err(AXIS_AMBIGUOUS)`. Two DIFFERENT key artifacts wear
///   one label, and nothing here can know which the caller meant.
///
/// **The third case is the whole point.** This used to be `ORDER BY created_at DESC LIMIT
/// 1` in SQL, described as "newest wins so a re-import supersedes". Where the two rows are
/// the same bytes that is a no-op, and where they are NOT it silently picks one of two
/// distinct entity sets — so an annotation table got aligned against whichever entity axis
/// happened to be imported last, and the misalignment is invisible: every row lands, every
/// count is plausible, and the values are attached to the wrong entries. Recency is not
/// identity. A label that names two axes is a question this layer cannot answer, and
/// answering it anyway is worse than refusing.
///
/// ## What is NOT done here, deliberately
///
/// A key artifact also declares `structure.key_sequence_digest` (ITEM-19) — the producer's
/// identity for the axis, over its ordered keys, which unlike `content_hash` survives a
/// re-encoding (a shard-geometry or codec change re-mints the merkle root for the same
/// the same keys in the same order). Treating an equal digest as proof that two rows are ONE
/// axis would resolve exactly that case instead of refusing it.
///
/// It is not done because it would make identity a matter of PRODUCER DECLARATION: two
/// genuinely different key artifacts declaring one digest would be merged, and this side
/// of the boundary cannot check the claim — recomputing a digest from stored bytes to
/// judge whether two artifacts agree is opening bytes for meaning, which INV-1 forbids the
/// server to do. The digest is checked where it can be checked, by the framework-owned
/// gate that runs over the emitted bytes; the server keys on the identity INGEST minted,
/// which is what INV-3 says identity is. Consequence, stated rather than hidden: a
/// re-import whose encoding changed presents as two axes and is refused until the caller
/// says which — loudly wrong beats quietly wrong.
pub fn resolve_axis_key_artifact(
    dataset_id: Uuid,
    axis: &str,
    candidates: Vec<Artifact>,
) -> Result<Option<Artifact>, AppError> {
    let mut identities: Vec<&str> = candidates.iter().map(|a| a.content_hash.as_str()).collect();
    identities.sort_unstable();
    identities.dedup();

    if identities.len() > 1 {
        // Name the identities AND the rows carrying them: "this label is ambiguous" is
        // not actionable, "these two artifacts both claim it" is.
        let detail = candidates
            .iter()
            .map(|a| format!("{} ({}, {})", a.content_hash, a.output_id, a.id))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(AppError::unprocessable_entity(
            "AXIS_AMBIGUOUS",
            format!(
                "dataset {dataset_id} holds {} distinct key artifacts labelled {axis:?}, \
                 so the label does not identify an axis: {detail}. An axis IS its key \
                 artifact and its identity is that artifact's content hash; picking one \
                 of these would align the input against an entity set nobody chose.",
                identities.len()
            ),
        ));
    }
    Ok(candidates.into_iter().next())
}

// `ARTIFACT_COLS` documents the shared projection; the macros inline it literally
// (sqlx needs a string literal, not a const) — kept as living documentation.
#[allow(dead_code)]
const _: &str = ARTIFACT_COLS;

#[cfg(test)]
mod resolve_axis_key_artifact_tests {
    use super::{resolve_axis_key_artifact, Artifact, Utc, Uuid};

    fn key_artifact(output_id: &str, content_hash: &str) -> Artifact {
        Artifact {
            id: Uuid::new_v4(),
            project_id: None,
            dataset_id: Some(Uuid::nil()),
            run_id: None,
            output_id: output_id.into(),
            datatype: "metadata-column".into(),
            object_key: Some(format!("manifest:{content_hash}")),
            is_multifile: true,
            content_hash: content_hash.into(),
            structure: serde_json::json!({ "encoding": "zarr_v3", "axis": "rows", "n": 4 }),
            meta: serde_json::json!({ "is_axis_index": true }),
            role: "artifact".into(),
            status: "ready".into(),
            stored_bytes: 0,
            logical_bytes: None,
            created_by: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            hidden: false,
            representation_of: None,
        }
    }

    #[test]
    fn no_candidate_resolves_to_nothing() {
        let got = resolve_axis_key_artifact(Uuid::nil(), "rows", vec![]).expect("not an error");
        assert!(
            got.is_none(),
            "absence is absence, never an invented axis (INV-2)"
        );
    }

    #[test]
    fn one_key_artifact_resolves_to_itself() {
        let one = key_artifact("rows_index", "sha256:aaa");
        let id = one.id;
        let got = resolve_axis_key_artifact(Uuid::nil(), "rows", vec![one])
            .expect("not an error")
            .expect("resolved");
        assert_eq!(got.id, id);
    }

    // The same BYTES cannot be two axes, however many catalog rows reference them — a
    // re-import that produced an identical index, or the same artifact re-registered
    // under another `output_id`. One identity ⇒ one axis ⇒ resolvable.
    #[test]
    fn several_rows_sharing_one_identity_are_one_axis() {
        let rows = vec![
            key_artifact("rows_index", "sha256:same"),
            key_artifact("cells_index_v2", "sha256:same"),
        ];
        let first = rows[0].id;
        let got = resolve_axis_key_artifact(Uuid::nil(), "rows", rows)
            .expect("one identity is not ambiguous")
            .expect("resolved");
        assert_eq!(
            got.id, first,
            "any row of the identity class serves; the caller's deterministic order picks"
        );
    }

    // **The defect this function exists to remove.** Two DISTINCT key artifacts wearing
    // one label used to be settled by `ORDER BY created_at DESC LIMIT 1` — the newest
    // won, silently, and an annotation table was aligned against whichever entity axis was
    // imported last. There is no correct pick here, so there is no pick.
    #[test]
    fn two_distinct_key_artifacts_sharing_a_label_are_refused_not_ranked() {
        let rows = vec![
            key_artifact("rows_index", "sha256:aaa"),
            key_artifact("cells_index_reimport", "sha256:bbb"),
        ];
        let err = resolve_axis_key_artifact(Uuid::nil(), "rows", rows)
            .expect_err("a label naming two axes must not resolve to either of them");
        assert_eq!(err.error_code(), "AXIS_AMBIGUOUS");
        assert_eq!(err.status_code(), 422);
        // Both identities are named — an operator has to be able to tell WHICH two.
        let msg = err.to_string();
        assert!(
            msg.contains("sha256:aaa") && msg.contains("sha256:bbb"),
            "{msg}"
        );
    }

    // …and the refusal is about IDENTITY, not about row count: the ambiguity survives
    // any ordering of the candidates, which is what makes it a refusal rather than a
    // differently-spelled preference.
    #[test]
    fn the_refusal_does_not_depend_on_candidate_order() {
        let a = key_artifact("first", "sha256:aaa");
        let b = key_artifact("second", "sha256:bbb");
        for rows in [vec![a.clone(), b.clone()], vec![b, a]] {
            assert_eq!(
                resolve_axis_key_artifact(Uuid::nil(), "rows", rows)
                    .expect_err("ambiguous either way")
                    .error_code(),
                "AXIS_AMBIGUOUS"
            );
        }
    }
}
