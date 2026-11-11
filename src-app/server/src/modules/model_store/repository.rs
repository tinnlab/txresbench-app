//! Model-store persistence — the repository over the two module-owned tables
//! (PLAN ITEM-2, PROV-MS-11): `txr_model_sets` (the user-named save sets,
//! DEC-10) and `txr_models` (the saved-model rows — references to immutable
//! content-addressed trees, DEC-3). One typed `ModelStoreRepository` for the
//! richer items (save flow, inventory routes, import/export) mirroring the
//! `execution_engine` `TxrRepository` shape; every SQL lives here.
//!
//! ### SQLite port conventions (CONS-MS-4 / PROV-sqlite-store-4 type map)
//!
//! Every query is a compile-time sqlx macro, never dynamic text: `uuid`
//! columns are 16-byte BLOBs (`id as "id: Uuid"`, `Uuid::new_v4()` binds — no
//! SQL default), `DateTime<Utc>` is RFC3339 TEXT (`created_at` written by the
//! SQLite `strftime(...,'now')` default and returned through `RETURNING`,
//! plus `updated_at` set on rename), JSON columns are TEXT decoded as
//! `serde_json::Value` and parsed into the wire types by the route/store layer
//! (`"group"` is double-quoted — GROUP is a SQLite keyword, the
//! `txr_run_methods` precedent), INTEGER columns decode as `i64` (spelled
//! `bool` in the macro override — sqlite decodes `!= 0`), REAL as `f64`.
//!
//! ### The filters (PROV-MS-2's list)
//!
//! `set_id` equality, `q` as a case-insensitive substring over the model's
//! `name` AND `method_id` — the port rule's `instr(lower(x), lower($1)) > 0`
//! folding (no ILIKE in SQLite; ASCII-only, documented limitation) — and
//! `provenance` equality; each is an optional bind (NULL = unset filter).
//! The list answers `created_at DESC, id DESC` (the newest save first).
//!
//! ### `SET_NAME_TAKEN` (DEC-10)
//!
//! Case-insensitive detection is the column's NOCASE collation: the look-up
//! `set_name_taken` compares `name = $1` under it, and the `COLLATE NOCASE
//! UNIQUE` index is the enforcement. The lost-race backstop maps the same
//! constraint violation to the same conflict (the project-repository 2067/
//! 1555 extended-code precedent) — the route layer surfaces 409
//! `SET_NAME_TAKEN` either way.
//!
//! ### The caller-side join (DEC-10's seam rule)
//!
//! Row shapes are the table columns only: `ModelSummary.set_name` /
//! `SetSummary`'s per-set counts are projections the route layer composes
//! (`list_sets` returns the counts with the rows), the set-name resolution is
//! one `list_sets` map at ITEM-5 — the join happens at the caller (the
//! engine's DEC-10 is the named precedent; the store never joins a run row
//! into a model row either).

use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;
use ziee_core::AppError;

/// One `txr_model_sets` row, decoded with the SQLite type map (PROV-MS-11).
#[derive(Debug, Clone, FromRow)]
pub struct SetRow {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub source_run_id: Option<Uuid>,
    pub source_label: Option<String>,
    pub keep_training_files: bool,
    pub training_dir: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

/// The sets list row — `SetSummary`'s aggregate projections ride on the row
/// (`model_count` = the set's model rows, `total_size_bytes` = their summed
/// tree sizes; a set with no models counts 0 — the left-join + COALESCE).
#[derive(Debug, Clone, FromRow)]
pub struct SetListRow {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub source_run_id: Option<Uuid>,
    pub source_label: Option<String>,
    pub keep_training_files: bool,
    pub training_dir: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
    pub model_count: i64,
    pub total_size_bytes: i64,
}

/// One `txr_models` row, decoded with the SQLite type map (PROV-MS-11). The
/// JSON columns stay `serde_json::Value` here — the typed wire shapes
/// (`MarkerFacts`, `RequiredMarkers`, …) are ITEM-6/ITEM-7's domain and the
/// row is stored verbatim (INV-2: the store never rewrites a recorded fact).
#[derive(Debug, Clone, FromRow)]
pub struct ModelRow {
    pub id: Uuid,
    pub set_id: Option<Uuid>,
    pub name: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    pub task: Option<String>,
    pub provenance: String,
    pub imported_from: Option<String>,
    pub pretrained_catalogue_id: Option<String>,
    pub pretrained_catalogue_version: Option<String>,
    pub licence: Option<String>,
    pub tree_sha256: String,
    pub dir: String,
    pub size_bytes: i64,
    pub contract: String,
    pub env_base_digest: Option<String>,
    pub env_layer_digest: Option<String>,
    pub trained_on_patients: Option<i64>,
    pub trained_at: Option<DateTime<Utc>>,
    pub decision_day: f64,
    pub endpoint: String,
    pub horizon: f64,
    pub features: Json,
    pub required_markers: Option<Json>,
    pub marker_facts: Json,
    pub covariates: Json,
    pub embeds_training_data: bool,
    pub own_auc: Option<f64>,
    pub own_c: Option<f64>,
    pub created_at: DateTime<Utc>,
}

/// The columns the save flow supplies (everything except `id`/`created_at`,
/// which the store owns: `Uuid::new_v4()` + the `strftime` default).
/// `provenance` holds [`crate::modules::model_store::types::ModelProvenance`]`::as_str()`
/// (the stored and wire spellings are one). `size_bytes` / `trained_on_patients`
/// / `own_auc` / `own_c` are the ENGINE's recorded values (GAP-B/C — null
/// until the run record carries them, DEC-18).
#[derive(Debug, Clone)]
pub struct NewModel {
    pub set_id: Option<Uuid>,
    pub name: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    pub task: Option<String>,
    pub provenance: String,
    pub imported_from: Option<String>,
    pub pretrained_catalogue_id: Option<String>,
    pub pretrained_catalogue_version: Option<String>,
    pub licence: Option<String>,
    pub tree_sha256: String,
    pub dir: String,
    pub size_bytes: i64,
    pub contract: String,
    pub env_base_digest: Option<String>,
    pub env_layer_digest: Option<String>,
    pub trained_on_patients: Option<i64>,
    pub trained_at: Option<DateTime<Utc>>,
    pub decision_day: f64,
    pub endpoint: String,
    pub horizon: f64,
    pub features: Json,
    pub required_markers: Option<Json>,
    pub marker_facts: Json,
    pub covariates: Json,
    pub embeds_training_data: bool,
    pub own_auc: Option<f64>,
    pub own_c: Option<f64>,
}

/// The repository. Pool-bound (CONS-MS-1/2): takes the process pool; the
/// routes receive the same pool as the framework's `axum::Extension`.
pub struct ModelStoreRepository {
    pool: SqlitePool,
}

/// One `txr_example_set` row as stored (qa-fixes3 ITEM-3): the state string +
/// the run/set ids. The state-vocabulary mapping (`ExampleSetState`) is the
/// example module's, so the row stays a raw projection and a foreign state
/// string is a corrupt row there (the engine's enum_from_wire discipline).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExampleStateRow {
    pub state: String,
    pub run_id: Option<Uuid>,
    pub set_id: Option<Uuid>,
    pub error: Option<String>,
}

impl ModelStoreRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    // ────────────────────────────── sets (DEC-10) ──────────────────────────────

    /// Insert a set. `SET_NAME_TAKEN` (case-insensitive, the NOCASE column
    /// collation) is a domain conflict — 409 with the machine code — never a
    /// database error; the unique index is the backstop against the check-
    /// then-insert race (single-user app, but the constraint is the authority).
    pub async fn insert_set(
        &self,
        name: &str,
        source_run_id: Option<Uuid>,
        source_label: Option<&str>,
        keep_training_files: bool,
        training_dir: Option<&str>,
    ) -> Result<SetRow, AppError> {
        if self.set_name_taken(name).await? {
            return Err(set_name_conflict(name));
        }
        // The id is a bind local (the macro's argument list would drop the
        // temporary before the executor borrows it — the engine's rule).
        let id = Uuid::new_v4();
        sqlx::query_as!(
            SetRow,
            r#"INSERT INTO txr_model_sets
                 (id, name, source_run_id, source_label, keep_training_files, training_dir)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id as "id: Uuid", name,
                         created_at as "created_at: DateTime<Utc>",
                         source_run_id as "source_run_id?: Uuid", source_label,
                         keep_training_files as "keep_training_files: bool", training_dir,
                         updated_at as "updated_at?: DateTime<Utc>""#,
            id,
            name,
            source_run_id,
            source_label,
            keep_training_files,
            training_dir,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(|err| map_set_name_conflict(err, name))
    }

    /// One set, iff it exists (404 `SET_NOT_FOUND` at the routes).
    pub async fn get_set(&self, id: Uuid) -> Result<Option<SetRow>, AppError> {
        sqlx::query_as!(
            SetRow,
            r#"SELECT id as "id: Uuid", name, created_at as "created_at: DateTime<Utc>",
                      source_run_id as "source_run_id?: Uuid", source_label,
                      keep_training_files as "keep_training_files: bool", training_dir,
                      updated_at as "updated_at?: DateTime<Utc>"
               FROM txr_model_sets WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    // ─────────────────────── the example-set state (ITEM-3) ───────────────────────

    /// The single example-set creation row (None before the first example
    /// request; the row is created by [`Self::upsert_example_state`]).
    pub async fn example_state(&self) -> Result<Option<ExampleStateRow>, AppError> {
        sqlx::query_as!(
            ExampleStateRow,
            r#"SELECT state, run_id as "run_id?: Uuid", set_id as "set_id?: Uuid", error
               FROM txr_example_set WHERE id = 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Insert or replace the single example-set row (id = 1; the column's
    /// `CHECK (id = 1)` makes a second row a constraint violation, never a
    /// silent twin). `updated_at` is set by the UPSERT, so a stale row is
    /// never read after a transition.
    pub async fn upsert_example_state(&self, row: &ExampleStateRow) -> Result<(), AppError> {
        sqlx::query(
            r#"INSERT INTO txr_example_set (id, state, run_id, set_id, error)
               VALUES (1, $1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET
                 state = excluded.state,
                 run_id = excluded.run_id,
                 set_id = excluded.set_id,
                 error = excluded.error,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
        )
        .bind(&row.state)
        .bind(row.run_id)
        .bind(row.set_id)
        .bind(&row.error)
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// The inventory list (J's sets) with each set's model count + summed tree
    /// size — one statement, no per-set fan-out, newest set first.
    pub async fn list_sets(&self) -> Result<Vec<SetListRow>, AppError> {
        sqlx::query_as!(
            SetListRow,
            r#"SELECT s.id as "id: Uuid", s.name,
                      s.created_at as "created_at: DateTime<Utc>",
                      s.source_run_id as "source_run_id?: Uuid", s.source_label,
                      s.keep_training_files as "keep_training_files: bool", s.training_dir,
                      s.updated_at as "updated_at?: DateTime<Utc>",
                      COUNT(m.id) as "model_count!: i64",
                      COALESCE(SUM(m.size_bytes), 0) as "total_size_bytes!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               GROUP BY s.id
               ORDER BY s.created_at DESC, s.id DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Rename a set; `true` when a row was renamed (false → 404). The rename
    /// touches `updated_at`, and the NOCASE UNIQUE index is the
    /// `SET_NAME_TAKEN` enforcement (a rename to the set's OWN current name —
    /// including a case-only spelling — is a no-op success, never a conflict).
    pub async fn rename_set(&self, id: Uuid, name: &str) -> Result<bool, AppError> {
        let res = sqlx::query!(
            r#"UPDATE txr_model_sets SET
                 name = $2,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $1"#,
            id,
            name,
        )
        .execute(&self.pool)
        .await
        .map_err(|err| map_set_name_conflict(err, name))?;
        Ok(res.rows_affected() > 0)
    }

    /// Delete a set; `true` when a row was deleted. The `txr_models` FK
    /// cascades the set's model rows (DEC-10/D14); the tree-dir pruning of
    /// the now-unreferenced trees is the store layer's refcount walk
    /// (`count_refs`), and `keep_files=true` is the route layer's
    /// rows-only choice.
    pub async fn delete_set(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM txr_model_sets WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// DEC-10's case-insensitive detection: is `name` used by a set? The
    /// comparison runs under the column's NOCASE collation (the UNIQUE
    /// constraint's own semantics — one window, one answer).
    pub async fn set_name_taken(&self, name: &str) -> Result<bool, AppError> {
        let taken = sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM txr_model_sets WHERE name = $1) as "taken!: bool""#,
            name,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(taken)
    }

    // ─────────────────────────────── models (DEC-3) ───────────────────────────────

    /// Insert a model row. The row is a reference: the tree itself is the
    /// store layer's copy (ITEM-3), this records where it lives + who made it.
    pub async fn insert_model(&self, m: &NewModel) -> Result<ModelRow, AppError> {
        // The String/JSON cells bind as owned values (the engine's bind-locals
        // rule: a macro-argument temporary must not outlive the query's
        // borrow). The engine's own fields (size_bytes, trained_on_patients,
        // own_auc, own_c) copy in as-is — null until the run record carries
        // them (DEC-18).
        let name = m.name.clone();
        let method_id = m.method_id.clone();
        let method_version = m.method_version.clone();
        let group = m.group.clone();
        let group_label = m.group_label.clone();
        let task = m.task.clone();
        let provenance = m.provenance.clone();
        let imported_from = m.imported_from.clone();
        let pretrained_catalogue_id = m.pretrained_catalogue_id.clone();
        let pretrained_catalogue_version = m.pretrained_catalogue_version.clone();
        let licence = m.licence.clone();
        let tree_sha256 = m.tree_sha256.clone();
        let dir = m.dir.clone();
        let contract = m.contract.clone();
        let env_base_digest = m.env_base_digest.clone();
        let env_layer_digest = m.env_layer_digest.clone();
        let endpoint = m.endpoint.clone();
        let features = m.features.clone();
        let required_markers = m.required_markers.clone();
        let marker_facts = m.marker_facts.clone();
        let covariates = m.covariates.clone();
        // The id is a bind local (see `insert_set`).
        let id = Uuid::new_v4();
        sqlx::query_as!(
            ModelRow,
            r#"INSERT INTO txr_models
                 (id, set_id, name, method_id, method_version, "group", group_label,
                  task, provenance, imported_from, pretrained_catalogue_id,
                  pretrained_catalogue_version, licence, tree_sha256, dir, size_bytes,
                  contract, env_base_digest, env_layer_digest, trained_on_patients,
                  trained_at, decision_day, endpoint, horizon, features,
                  required_markers, marker_facts, covariates, embeds_training_data,
                  own_auc, own_c)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
                       $27, $28, $29, $30, $31)
               RETURNING id as "id: Uuid", set_id as "set_id?: Uuid", name, method_id,
                         method_version, "group", group_label, task, provenance,
                         imported_from, pretrained_catalogue_id,
                         pretrained_catalogue_version, licence, tree_sha256, dir,
                         size_bytes, contract, env_base_digest, env_layer_digest,
                         trained_on_patients, trained_at as "trained_at?: DateTime<Utc>",
                         decision_day, endpoint, horizon,
                         features as "features: serde_json::Value",
                         required_markers as "required_markers?: serde_json::Value",
                         marker_facts as "marker_facts: serde_json::Value",
                         covariates as "covariates: serde_json::Value",
                         embeds_training_data as "embeds_training_data: bool",
                         own_auc, own_c,
                         created_at as "created_at: DateTime<Utc>""#,
            id,
            m.set_id,
            name,
            method_id,
            method_version,
            group,
            group_label,
            task,
            provenance,
            imported_from,
            pretrained_catalogue_id,
            pretrained_catalogue_version,
            licence,
            tree_sha256,
            dir,
            m.size_bytes,
            contract,
            env_base_digest,
            env_layer_digest,
            m.trained_on_patients,
            m.trained_at,
            m.decision_day,
            endpoint,
            m.horizon,
            features,
            required_markers,
            marker_facts,
            covariates,
            m.embeds_training_data,
            m.own_auc,
            m.own_c,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// One model row, iff it exists (404 `MODEL_NOT_FOUND` at the routes).
    pub async fn get_model(&self, id: Uuid) -> Result<Option<ModelRow>, AppError> {
        sqlx::query_as!(
            ModelRow,
            r#"SELECT id as "id: Uuid", set_id as "set_id?: Uuid", name, method_id,
                      method_version, "group", group_label, task, provenance,
                      imported_from, pretrained_catalogue_id,
                      pretrained_catalogue_version, licence, tree_sha256, dir,
                      size_bytes, contract, env_base_digest, env_layer_digest,
                      trained_on_patients, trained_at as "trained_at?: DateTime<Utc>",
                      decision_day, endpoint, horizon,
                      features as "features: serde_json::Value",
                      required_markers as "required_markers?: serde_json::Value",
                      marker_facts as "marker_facts: serde_json::Value",
                      covariates as "covariates: serde_json::Value",
                      embeds_training_data as "embeds_training_data: bool",
                      own_auc, own_c, created_at as "created_at: DateTime<Utc>"
               FROM txr_models WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// The inventory list (J's model lines, I's per-run rows) with PROV-MS-2's
    /// three optional filters — `set_id` equality, `q` substring on the
    /// display name OR the method id, `provenance` equality — newest save
    /// first. Each filter is a typed `Option` bind (NULL = unset).
    pub async fn list_models(
        &self,
        set_id: Option<Uuid>,
        q: Option<&str>,
        provenance: Option<&str>,
    ) -> Result<Vec<ModelRow>, AppError> {
        sqlx::query_as!(
            ModelRow,
            r#"SELECT id as "id: Uuid", set_id as "set_id?: Uuid", name, method_id,
                      method_version, "group", group_label, task, provenance,
                      imported_from, pretrained_catalogue_id,
                      pretrained_catalogue_version, licence, tree_sha256, dir,
                      size_bytes, contract, env_base_digest, env_layer_digest,
                      trained_on_patients, trained_at as "trained_at?: DateTime<Utc>",
                      decision_day, endpoint, horizon,
                      features as "features: serde_json::Value",
                      required_markers as "required_markers?: serde_json::Value",
                      marker_facts as "marker_facts: serde_json::Value",
                      covariates as "covariates: serde_json::Value",
                      embeds_training_data as "embeds_training_data: bool",
                      own_auc, own_c, created_at as "created_at: DateTime<Utc>"
               FROM txr_models
               WHERE ($1 IS NULL OR set_id = $1)
                 AND ($2 IS NULL
                      OR instr(lower(name), lower($2)) > 0
                      OR instr(lower(method_id), lower($2)) > 0)
                 AND ($3 IS NULL OR provenance = $3)
               ORDER BY created_at DESC, id DESC"#,
            set_id,
            q,
            provenance,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Rename a model's display label (no uniqueness — a label is not an
    /// identity); `true` when a row was renamed (false → 404).
    pub async fn rename_model(&self, id: Uuid, name: &str) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE txr_models SET name = $2 WHERE id = $1",
            id,
            name,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// Delete a model row; `true` when a row was deleted. Rows only — the
    /// tree dir's prune-when-last-ref is the store layer's refcount walk.
    pub async fn delete_model(&self, id: Uuid) -> Result<bool, AppError> {
        let res = sqlx::query!("DELETE FROM txr_models WHERE id = $1", id)
            .execute(&self.pool)
            .await
            .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }

    /// DEC-3's refcount: the number of rows sharing a tree (saved into a
    /// second set, imported twice). The prune rule compares this to zero
    /// after a delete — a non-positive result means the tree's last reference
    /// is gone and the dir goes with it. `COUNT(*)` is always one non-null
    /// row; an absent digest simply counts zero.
    pub async fn count_refs(&self, tree_sha256: &str) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "refs!: i64" FROM txr_models WHERE tree_sha256 = $1"#,
            tree_sha256,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.refs)
    }

    /// One set WITH its aggregates (the save response's set summary — the
    /// created set may already hold earlier rows when the save grew an
    /// existing set, so the response's counts are the whole set's, never the
    /// save's). The single-row variant of [`list_sets`]'s projection.
    pub async fn get_set_with_counts(&self, id: Uuid) -> Result<Option<SetListRow>, AppError> {
        sqlx::query_as!(
            SetListRow,
            r#"SELECT s.id as "id: Uuid", s.name,
                      s.created_at as "created_at: DateTime<Utc>",
                      s.source_run_id as "source_run_id?: Uuid", s.source_label,
                      s.keep_training_files as "keep_training_files: bool", s.training_dir,
                      s.updated_at as "updated_at?: DateTime<Utc>",
                      COUNT(m.id) as "model_count!: i64",
                      COALESCE(SUM(m.size_bytes), 0) as "total_size_bytes!: i64"
               FROM txr_model_sets s
               LEFT JOIN txr_models m ON m.set_id = s.id
               WHERE s.id = $1
               GROUP BY s.id"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Is a model row with EXACTLY this (set, tree, method) already present?
    /// The `UNIQUE(tree_sha256, method_id, set_id)` constraint's own predicate
    /// — the idempotence check of the save/import flows (re-saving / re-
    /// importing the same tree+method into the same set is the SAME model:
    /// rows-only once, per DEC-3's row-is-a-reference rule). A NULL set_id is
    /// NOT part of the uniqueness (SQLite treats NULLs as distinct), so a
    /// standalone model is never deduped — the check is set-scoped.
    pub async fn model_ref_exists(
        &self,
        set_id: Option<Uuid>,
        tree_sha256: &str,
        method_id: &str,
    ) -> Result<bool, AppError> {
        let exists = sqlx::query_scalar!(
            r#"SELECT EXISTS (
                    SELECT 1 FROM txr_models
                    WHERE tree_sha256 = $1 AND method_id = $2
                      AND ((set_id = $3) OR (set_id IS NULL AND $3 IS NULL))
               ) as "exists!: bool""#,
            tree_sha256,
            method_id,
            set_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(exists)
    }

    /// The one row of a (set, tree, method) triple — the idempotence reuse
    /// answer (`model_ref_exists`'s row half). Only ever used with a set id.
    pub async fn get_model_by_ref(
        &self,
        set_id: Option<Uuid>,
        tree_sha256: &str,
        method_id: &str,
    ) -> Result<Option<ModelRow>, AppError> {
        sqlx::query_as!(
            ModelRow,
            r#"SELECT id as "id: Uuid", set_id as "set_id?: Uuid", name, method_id,
                      method_version, "group", group_label, task, provenance,
                      imported_from, pretrained_catalogue_id,
                      pretrained_catalogue_version, licence, tree_sha256, dir,
                      size_bytes, contract, env_base_digest, env_layer_digest,
                      trained_on_patients, trained_at as "trained_at?: DateTime<Utc>",
                      decision_day, endpoint, horizon,
                      features as "features: serde_json::Value",
                      required_markers as "required_markers?: serde_json::Value",
                      marker_facts as "marker_facts: serde_json::Value",
                      covariates as "covariates: serde_json::Value",
                      embeds_training_data as "embeds_training_data: bool",
                      own_auc, own_c, created_at as "created_at: DateTime<Utc>"
               FROM txr_models
               WHERE tree_sha256 = $1 AND method_id = $2
                 AND ((set_id = $3) OR (set_id IS NULL AND $3 IS NULL))"#,
            tree_sha256,
            method_id,
            set_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)
    }

    /// Record the set's training facts AFTER the tree/training copies landed
    /// (the save/import flows do not know the set's id before the row exists,
    /// and an existing set may gain the training files on a later save).
    /// `keep` + `training_dir` are the row's truth — an import/save that kept
    /// training files sets both, a merge that did not touch them changes
    /// neither.
    pub async fn set_training_facts(
        &self,
        id: Uuid,
        keep: bool,
        training_dir: Option<&str>,
    ) -> Result<bool, AppError> {
        let res = sqlx::query!(
            "UPDATE txr_model_sets SET keep_training_files = $2, training_dir = $3 WHERE id = $1",
            id,
            keep,
            training_dir,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(res.rows_affected() > 0)
    }
}

/// The domain conflict (DEC-10): a set name is taken case-insensitively.
/// 409 `SET_NAME_TAKEN` — the project-repository precedent for a unique
/// violation that is a domain answer, not a database fault.
fn set_name_conflict(name: &str) -> AppError {
    AppError::conflict_code(
        "SET_NAME_TAKEN",
        format!(
            "a set named \"{name}\" already exists (set names are case-insensitive)"
        ),
    )
}

/// Map the lost-race violation of the NOCASE UNIQUE index to the SAME domain
/// conflict the pre-check returns (the check-then-insert window is irrelevant
/// in a single-user app, but the constraint is the authority — the
/// project-repository 2067/1555 extended-code mapping is the framework's own
/// precedent). Anything else stays a database error.
fn map_set_name_conflict(err: sqlx::Error, name: &str) -> AppError {
    if let sqlx::Error::Database(db) = &err {
        if matches!(db.code().as_deref(), Some("2067") | Some("1555")) {
            return set_name_conflict(name);
        }
    }
    AppError::database_error(err)
}

#[cfg(test)]
mod tests {
    //! TEST-MS-03 — the repository round trips on a real SQLite FILE (the
    //! type map's BLOB/RFC3339/JSON/INTEGER/REAL decodes), the
    //! case-insensitive `SET_NAME_TAKEN`, the refcount helper and the FK
    //! cascade. No route, no tree bytes — this is the persistence contract
    //! the richer items build on.

    use chrono::{DateTime, Utc};
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::SqlitePool;
    use uuid::Uuid;

    use super::*;

    /// A file-backed pool with the module's two migrations applied, foreign
    /// keys ON (the runtime pool's DEC-7 pragma profile — the cascade under
    /// test IS the FK's) and the WAL/other pragmas left at their defaults
    /// (the DDL + type map, not the pool tuning, is what this test covers).
    /// The file lives under `$TMPDIR` (never /tmp — the owner's working-file
    /// rule; the test harnesses set it for the build).
    async fn test_pool() -> (SqlitePool, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "model-store-repository-test-{}.sqlite",
            Uuid::new_v4()
        ));
        // `create_if_missing`: the file DB is created fresh per test (the
        // framework's embedded-db idiom — `SqliteConnectOptions` defaults to
        // create=false, so a new path would fail with code 14).
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("test sqlite file connects");
        sqlx::migrate!("./src/modules/model_store/migrations")
            .run(&pool)
            .await
            .expect("module migrations apply to the test file");
        (pool, path)
    }

    /// A synthetic produced-model record: opaque bytes are never opened, so
    /// the fixture is a plausible run seam value — patient ids S0000.. and
    /// markers M1/M2, never real data (the node's fixture rule).
    fn new_model(set_id: Option<Uuid>, tree_sha256: &str, method_id: &str) -> NewModel {
        NewModel {
            set_id,
            name: format!("{method_id} trained model"),
            method_id: method_id.to_string(),
            method_version: "1.2.0".to_string(),
            group: "landmark".to_string(),
            group_label: "Landmark stats".to_string(),
            task: Some("pfs".to_string()),
            provenance: "run".to_string(),
            imported_from: None,
            pretrained_catalogue_id: None,
            pretrained_catalogue_version: None,
            licence: None,
            tree_sha256: tree_sha256.to_string(),
            dir: format!("/data/models/trees/{tree_sha256}"),
            size_bytes: 4096,
            contract: "2.0".to_string(),
            env_base_digest: Some("sha256:base0000".to_string()),
            env_layer_digest: Some("sha256:layer000".to_string()),
            trained_on_patients: Some(151),
            trained_at: Some(
                "2026-10-19T14:30:00+00:00"
                    .parse::<DateTime<Utc>>()
                    .expect("fixture timestamp parses"),
            ),
            decision_day: 56.0,
            endpoint: "pfs".to_string(),
            horizon: 238.0,
            features: json!(["M1", "M2"]),
            required_markers: Some(json!({"markers": [{"name": "M1", "id_system": "LOINC", "id": "2857-1"}], "match": "all", "min_fraction": 1.0, "list_source": "catalogue"})),
            marker_facts: json!({"kind": "single", "count": 2, "min_draws": 3, "needs_baseline": true, "uses_history": "landmark", "needs_detection_call": false, "marker_groups_required": []}),
            covariates: json!({"catalogue": "optional", "used": true}),
            embeds_training_data: false,
            own_auc: Some(0.66),
            own_c: Some(0.63),
        }
    }

    /// TEST-MS-03 half 1 — the type map round trip: insert/list/detail/rename
    /// on both tables, with every PROV-sqlite-store-4 decode asserted (Uuid
    /// BLOB, RFC3339 TEXT, JSON TEXT columns parsing back, bool INTEGER).
    #[tokio::test]
    async fn set_and_model_crud_round_trips_with_the_type_map() {
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        // Sets: insert with the run provenance fields, read back with the
        // strftime default created_at + the json-free column set.
        let source_run = Uuid::new_v4();
        let set = repo
            .insert_set(
                "CRC cohort, day 56",
                Some(source_run),
                Some("patients.csv"),
                true,
                Some("/data/models/training/set1"),
            )
            .await
            .expect("set insert");
        assert!(!set.name.is_empty());
        assert_eq!(set.source_run_id, Some(source_run));
        assert_eq!(set.source_label.as_deref(), Some("patients.csv"));
        assert!(set.keep_training_files);
        assert_eq!(set.training_dir.as_deref(), Some("/data/models/training/set1"));
        assert!(set.updated_at.is_none(), "a fresh set has no rename time");

        let got = repo.get_set(set.id).await.expect("set get").expect("set row");
        assert_eq!(got.id, set.id);
        assert_eq!(got.name, set.name);
        assert_eq!(got.created_at, set.created_at);

        // The list row carries the aggregate projections: one set, zero models.
        let sets = repo.list_sets().await.expect("sets list");
        assert_eq!(sets.len(), 1);
        assert_eq!(sets[0].id, set.id);
        assert_eq!(sets[0].model_count, 0);
        assert_eq!(sets[0].total_size_bytes, 0);

        // Rename works + stamps updated_at; the wire decode is DateTime<Utc>.
        assert!(repo
            .rename_set(set.id, "CRC cohort, day 84")
            .await
            .expect("set rename"));
        let renamed = repo.get_set(set.id).await.expect("get").expect("row");
        assert_eq!(renamed.name, "CRC cohort, day 84");
        assert!(renamed.updated_at.is_some());

        // A missing id is None (the 404 at the routes), not an error.
        assert!(repo.get_set(Uuid::new_v4()).await.expect("get").is_none());
        assert!(!repo
            .rename_set(Uuid::new_v4(), "nowhere")
            .await
            .expect("rename missing"));

        // Models: insert a set-bound + a standalone row; every recorded field
        // (the dir / tree_sha256 / env digests byte round trip) survives.
        let standalone = repo
            .insert_model(&new_model(None, &"a".repeat(64), "landmark-cox"))
            .await
            .expect("standalone model insert");
        let in_set = repo
            .insert_model(&new_model(Some(set.id), &"b".repeat(64), "dynforest"))
            .await
            .expect("set-bound model insert");
        assert!(standalone.set_id.is_none());
        assert_eq!(in_set.set_id, Some(set.id));

        let detail = repo
            .get_model(in_set.id)
            .await
            .expect("model get")
            .expect("model row");
        assert_eq!(detail.id, in_set.id);
        assert_eq!(detail.name, in_set.name);
        assert_eq!(detail.method_id, "dynforest");
        assert_eq!(detail.method_version, "1.2.0");
        assert_eq!(detail.group, "landmark");
        assert_eq!(detail.group_label, "Landmark stats");
        assert_eq!(detail.task.as_deref(), Some("pfs"));
        assert_eq!(detail.provenance, "run");
        assert_eq!(detail.tree_sha256, "b".repeat(64));
        assert_eq!(detail.dir, format!("/data/models/trees/{}", "b".repeat(64)));
        assert_eq!(detail.size_bytes, 4096);
        assert_eq!(detail.contract, "2.0");
        assert_eq!(detail.env_base_digest.as_deref(), Some("sha256:base0000"));
        assert_eq!(detail.env_layer_digest.as_deref(), Some("sha256:layer000"));
        assert_eq!(detail.trained_on_patients, Some(151));
        assert_eq!(detail.decision_day, 56.0);
        assert_eq!(detail.endpoint, "pfs");
        assert_eq!(detail.horizon, 238.0);
        assert_eq!(detail.features, json!(["M1", "M2"]));
        assert!(
            detail
                .required_markers
                .as_ref()
                .expect("requirements JSON")
                .get("match")
                .is_some(),
            "the required_markers JSON round-trips"
        );
        assert_eq!(detail.marker_facts["count"], 2);
        assert_eq!(detail.covariates["used"], true);
        assert!(!detail.embeds_training_data);
        assert_eq!(detail.own_auc, Some(0.66));
        assert_eq!(detail.own_c, Some(0.63));
        assert!(
            detail.trained_at.is_some(),
            "the RFC3339 TEXT decodes as DateTime<Utc>"
        );

        // Rename/delete a model row: 204/404 semantics via bool.
        assert!(repo
            .rename_model(detail.id, "l2-boosted-forest")
            .await
            .expect("model rename"));
        assert_eq!(
            repo.get_model(detail.id).await.expect("get").expect("row").name,
            "l2-boosted-forest"
        );
        assert!(!repo
            .rename_model(Uuid::new_v4(), "x")
            .await
            .expect("rename missing"));
        assert!(repo.delete_model(detail.id).await.expect("model delete"));
        assert!(repo.get_model(detail.id).await.expect("get").is_none());
        assert!(!repo
            .delete_model(detail.id)
            .await
            .expect("delete missing returns false"));

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// TEST-MS-03 half 2 — `SET_NAME_TAKEN` fires case-insensitively: the
    /// NOCASE column collation is the detection window, on insert AND on
    /// rename, as the domain 409 (never a database error).
    #[tokio::test]
    async fn set_name_taken_is_case_insensitive() {
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        repo.insert_set("CRC cohort", None, None, false, None)
            .await
            .expect("first set");
        assert!(
            repo.set_name_taken("CRC cohort").await.expect("detect exact"),
            "the exact spelling is detected"
        );
        assert!(
            repo.set_name_taken("crc cohort").await.expect("detect folded"),
            "NOCASE folds the spelling to the same name"
        );
        assert!(!repo
            .set_name_taken("breast panel")
            .await
            .expect("detect absent"));

        let err = repo
            .insert_set("crc cohort", None, None, false, None)
            .await
            .expect_err("the folded spelling must be refused");
        assert_eq!(err.status_code(), 409);
        assert_eq!(err.error_code(), "SET_NAME_TAKEN");

        // The same conflict through the rename arm: the unique index is the
        // authority (the insert pre-check does not run here).
        let other = repo
            .insert_set("Breast panel", None, None, false, None)
            .await
            .expect("second set");
        let err = repo
            .rename_set(other.id, "CRC COHORT")
            .await
            .expect_err("rename onto a taken name");
        assert_eq!(err.error_code(), "SET_NAME_TAKEN");

        // A rename to the row's OWN current name (case-only spelling) is a
        // no-op success, never a self-conflict.
        assert!(repo
            .rename_set(other.id, "breast panel")
            .await
            .expect("same-name rename succeeds"));

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// TEST-MS-03 half 3 — the refcount helper: rows sharing a tree count as
    /// one tree's references, and deletion lowers the count per row (the
    /// store layer's prune rule reads zero as "the last reference is gone").
    #[tokio::test]
    async fn count_refs_reports_rows_sharing_a_tree() {
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        let set_a = repo
            .insert_set("set A", None, None, false, None)
            .await
            .expect("set A");
        let set_b = repo
            .insert_set("set B", None, None, false, None)
            .await
            .expect("set B");
        let tree = "c".repeat(64);
        let m1 = repo
            .insert_model(&new_model(Some(set_a.id), &tree, "dynforest"))
            .await
            .expect("m1");
        let m2 = repo
            .insert_model(&new_model(Some(set_b.id), &tree, "dynforest"))
            .await
            .expect("m2 — same tree, second set");
        assert_eq!(repo.count_refs(&tree).await.expect("refs"), 2);

        assert!(repo.delete_model(m1.id).await.expect("delete m1"));
        assert_eq!(repo.count_refs(&tree).await.expect("refs"), 1);
        assert!(repo.delete_model(m2.id).await.expect("delete m2"));
        assert_eq!(repo.count_refs(&tree).await.expect("refs"), 0);
        assert_eq!(
            repo.count_refs(&"f".repeat(64)).await.expect("unknown refs"),
            0,
            "a digest never referenced counts zero"
        );

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// TEST-MS-03 half 4 — the FK cascade with foreign_keys ON: deleting a
    /// set removes its model rows, while standalone rows (and other sets')
    /// rows survive; the J-board "Deleting a model removes its file" prune is
    /// then the refcount walk's business, not a row-level trigger.
    #[tokio::test]
    async fn set_delete_cascades_its_models() {
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        let set = repo
            .insert_set("cascade me", None, None, false, None)
            .await
            .expect("set");
        let in_set_1 = repo
            .insert_model(&new_model(Some(set.id), &"d".repeat(64), "dynforest"))
            .await
            .expect("in-set 1");
        let in_set_2 = repo
            .insert_model(&new_model(Some(set.id), &"e".repeat(64), "landmark-cox"))
            .await
            .expect("in-set 2");
        let standalone = repo
            .insert_model(&new_model(None, &"f".repeat(64), "glmnet-cph"))
            .await
            .expect("standalone");

        assert!(repo.delete_set(set.id).await.expect("delete set"));
        assert!(repo.get_set(set.id).await.expect("get").is_none());
        assert!(repo
            .get_model(in_set_1.id)
            .await
            .expect("get")
            .is_none(), "the cascade removed the set's models");
        assert!(repo
            .get_model(in_set_2.id)
            .await
            .expect("get")
            .is_none());
        assert!(
            repo.get_model(standalone.id).await.expect("get").is_some(),
            "a standalone row is not part of any set's cascade"
        );

        // The aggregate projections agree: zero sets, one model left.
        let sets = repo.list_sets().await.expect("sets");
        assert!(sets.is_empty());
        let models = repo
            .list_models(None, None, None)
            .await
            .expect("models");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, standalone.id);

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }

    /// TEST-MS-03 half 5 — the list filters (PROV-MS-2): set_id equality, the
    /// `instr(lower(...))` substring over name AND method id, provenance
    /// equality; each optional, all composable, newest first.
    #[tokio::test]
    async fn list_models_applies_the_three_filters() {
        let (pool, path) = test_pool().await;
        let repo = ModelStoreRepository::new(pool.clone());

        let set = repo
            .insert_set("filters", None, None, false, None)
            .await
            .expect("set");
        let m_in_run = repo
            .insert_model(&new_model(Some(set.id), &"a".repeat(64), "dynforest"))
            .await
            .expect("run model");
        let mut imported = new_model(None, &"b".repeat(64), "glmnet-cph");
        imported.provenance = "imported".to_string();
        imported.name = "From a colleague: breast panel".to_string();
        let m_imported = repo
            .insert_model(&imported)
            .await
            .expect("imported model");

        // No filters → both, newest first (created_at DESC).
        let all = repo.list_models(None, None, None).await.expect("all");
        assert_eq!(all.len(), 2);

        // set_id filter.
        let in_set = repo
            .list_models(Some(set.id), None, None)
            .await
            .expect("by set");
        assert_eq!(in_set.len(), 1);
        assert_eq!(in_set[0].id, m_in_run.id);

        // q: substring on the display name (the J search box), case-insensitive.
        let by_name = repo
            .list_models(None, Some("BREAST"), None)
            .await
            .expect("by q name");
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].id, m_imported.id);

        // q: substring on the method id.
        let by_method = repo
            .list_models(None, Some("GLMNET"), None)
            .await
            .expect("by q method");
        assert_eq!(by_method.len(), 1);
        assert_eq!(by_method[0].id, m_imported.id);

        // provenance filter.
        let imported_only = repo
            .list_models(None, None, Some("imported"))
            .await
            .expect("by provenance");
        assert_eq!(imported_only.len(), 1);
        assert_eq!(imported_only[0].id, m_imported.id);

        // Composed: set + provenance that matches nothing.
        let none = repo
            .list_models(Some(set.id), None, Some("imported"))
            .await
            .expect("composed");
        assert!(none.is_empty());

        pool.close().await;
        let _ = std::fs::remove_file(&path);
    }
}
