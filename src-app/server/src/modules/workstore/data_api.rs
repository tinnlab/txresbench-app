//! Data-plane + control-plane handlers (ITEM-7/8/9/10).
//!
//! Control plane = normal typed JSON (`ApiClient`). Data plane = opaque bytes over
//! `application/octet-stream`: the whole object or one member path, optionally a
//! `?range=` span (ITEM-36), STREAMED from the store rather than buffered
//! (ITEM-37). Every handler authorizes through the merged `effective_permission`
//! (authz.rs) — Viewer+ read; a foreign project → 404 (DEC-9: auth on every byte).
//!
//! **A GC sweep cannot truncate a read in flight.** An artifact is immutable, so a
//! streamed read has no mutation to race; the one live race is
//! `GcSweeper::sweep_marked` unlinking a blob mid-stream. It is closed twice over.
//! First by construction: the sweep frees a blob ONLY when its hash is absent from
//! the live keep-set, and a blob reachable by this handler is reachable through a
//! catalog row, which puts it IN that set. Second by POSIX: `get_stream` opens the
//! file EAGERLY, and an unlink after a successful open leaves the inode alive for
//! the open descriptor — the reader still gets every byte it was promised. The only
//! remaining window is an unlink between `stat` and `open`, which fails the open and
//! surfaces as a clean `404` **before** a status line exists, never as a body that
//! stops short of its `Content-Length`.

use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::{ApiResult, AppError};

use super::authz::{require_artifact_read, require_project_edit, require_project_read};
use super::catalog::models::{Artifact, ArtifactFilter};
use super::catalog::repository::CatalogRepository;
use super::consume::{ConsumableArtifact, STATUS_READY};
use super::object_store::{ContentKey, ObjectStore};
use super::presence::{presence_of, BytesPresenceReport};
use super::range::{parse_range, parse_range_param, RangeOutcome, RangeParamError};
use crate::modules::permissions::RequirePermissions;
use crate::modules::project::ProjectsUse;
use crate::modules::sync::{SyncAction, SyncOrigin};

// --------------------------- control plane (JSON) ---------------------------

/// List a project's catalog (filterable), without opening a blob.
pub async fn list_artifacts(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(project_id): Path<Uuid>,
    Query(filter): Query<ArtifactFilter>,
) -> ApiResult<Json<Vec<ListedArtifact>>> {
    require_project_read(&pool, project_id, auth.user.id).await?;
    // Resolve any `subtypes_of`/`capability` filter to a concrete datatype-id set via
    // P2's registry (the registry lookup stays in the handler; the repo stays pure
    // SQL — P2 ITEM-20/22). No such filter → `None` (unfiltered by type).
    let datatype_allow = resolve_datatype_allow(&filter);
    let repo = CatalogRepository::new(pool.clone());
    // Project-scoped artifacts PLUS the project's attached-dataset artifacts, so an
    // imported (dataset-scoped) `single-cell/expression` is pickable as an analysis
    // input (ITEM-23: import artifacts carry `dataset_id`, not `project_id`).
    let mut items = repo
        .list_for_project_scope(project_id, &filter, datatype_allow.as_deref())
        .await
        .map_err(|e| e.to_api_error())?;
    // Hidden artifacts (derived alternate representations, ITEM-20) never surface
    // in the catalog/picker listing — they stay fetchable by id via `get_artifact`.
    items.retain(|a| !a.hidden);
    let listed = derive_listing_provenance(&pool, items)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((StatusCode::OK, Json(listed)))
}

/// A catalog list-row: the artifact PLUS the two DERIVED provenance facts a consumer
/// cannot reconstruct from the row itself — WHICH DATASET it came from (ITEM-22) and
/// WHAT PRODUCED it. The picker groups/labels candidates by the first, so a user with
/// several datasets attached to a project can tell the analysis inputs apart.
/// Both are DERIVED from provenance — NOT denormalized columns (ITEM-21).
/// `Artifact` is flattened (mirrors `dataset::DatasetListItem`) so the wire shape is a
/// plain `Artifact` + these extra fields; existing readers see the same fields.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ListedArtifact {
    #[serde(flatten)]
    pub artifact: Artifact,
    /// EVERY dataset this artifact derives from (a provenance walk), in declared-input
    /// order, deduped. Empty when the lineage resolves to no dataset (a bare project-scoped
    /// seed/output). An artifact produced by INTEGRATING two datasets has two entries.
    ///
    /// This is the authoritative field; the two singular ones below are a convenience that
    /// only speaks when there is nothing to be ambiguous about.
    pub source_dataset_ids: Vec<Uuid>,
    /// The display NAMES matching {@link source_dataset_ids}, same order. An id whose dataset
    /// has since been deleted contributes no name, so this can be SHORTER than the id list —
    /// pair them by looking a name up, never by index.
    pub source_dataset_names: Vec<String>,
    /// The dataset this artifact derives from — **only when there is exactly one**.
    ///
    /// NULL means "not one dataset", which is TWO different situations the field deliberately
    /// does not distinguish: no source at all, or SEVERAL. Both are cases where a consumer
    /// scoping something to a single dataset has no honest answer, and that is the whole point.
    /// It previously reported the FIRST-DECLARED source of a multi-source artifact, so an
    /// integration of Dataset 1 + Dataset 2 read as "Dataset 1" — a confident wrong answer
    /// decided by edge declaration order. A consumer that wants to say something about a
    /// multi-source artifact reads {@link source_dataset_ids} and states its own disposition.
    pub source_dataset_id: Option<Uuid>,
    /// The single source dataset's display NAME, under the same exactly-one rule as
    /// {@link source_dataset_id}; NULL when there is not exactly one, or when that one
    /// dataset has since been deleted.
    pub source_dataset_name: Option<String>,
    /// **WHO PRODUCED THIS ARTIFACT** — the ANALYSIS id recorded by the producing run
    /// (`provenance_run_repro.generator_id`, joined on the row's own `run_id`), which is
    /// the same id an analysis contributes under (`contributes.analyses[].id`).
    ///
    /// The row already carries `run_id`, and a run id alone answers "which execution"
    /// but never "which analysis" — so a consumer asking whether a column is ITS OWN
    /// previous output had nothing to compare against, and every producer looked alike.
    /// That is the whole reason this field exists: a form whose emitted column names are
    /// its own defaults must be able to tell "I made this last time" from "something
    /// else made this", and the difference decides whether a re-run is refused.
    ///
    /// NULL when the artifact names no producing run (an import / upload / seeded row),
    /// or when the producing run recorded no provenance — both are "not attributable",
    /// and a consumer must read them as such rather than as any particular producer.
    /// DERIVED, like the two fields above: it is a join, never a column on `artifacts`.
    pub generator_id: Option<String>,
}

/// Attach each artifact's DERIVED provenance: its source datasetS (ids + names, plus the
/// singular convenience pair that speaks only for a single-source artifact) and the
/// ANALYSIS that produced it. Walks provenance per artifact (`source_datasets_of`), then
/// batch-resolves the distinct dataset names AND the distinct producing runs' generator
/// ids in ONE query each (no N+1 lookup on either). A per-artifact provenance-walk error
/// propagates (a real DB failure must surface, not silently become "no source dataset").
async fn derive_listing_provenance(
    pool: &SqlitePool,
    items: Vec<Artifact>,
) -> Result<Vec<ListedArtifact>, AppError> {
    let prov = crate::modules::provenance::repository::ProvenanceRepository::new(pool.clone());
    let mut source_ids: Vec<Vec<Uuid>> = Vec::with_capacity(items.len());
    for a in &items {
        source_ids.push(prov.source_datasets_of(a.id).await?);
    }
    // Batch-resolve the distinct source-dataset names.
    let distinct: Vec<Uuid> = {
        let mut set = std::collections::HashSet::new();
        source_ids
            .iter()
            .flatten()
            .copied()
            .filter(|id| set.insert(*id))
            .collect()
    };
    let mut names: std::collections::HashMap<Uuid, String> = std::collections::HashMap::new();
    if !distinct.is_empty() {
        let distinct_json = super::catalog::repository::uuid_list_json(&distinct);
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", name FROM datasets WHERE id IN
               (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            distinct_json,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?;
        for r in rows {
            names.insert(r.id, r.name);
        }
    }
    // The producing ANALYSIS per distinct run, in one query. An artifact with no `run_id`
    // asks nothing here; a `run_id` with no recorded run answers nothing, and both land as
    // NULL below — "not attributable", which is a different statement from naming a
    // producer and must not be collapsed into one. A recorded-but-BLANK `generator_id`
    // (the column's own `DEFAULT ''`) names no analysis either, so it is read as absent
    // rather than passed on as the empty string, which no consumer could match anything
    // against.
    let distinct_runs: Vec<Uuid> = {
        let mut set = std::collections::HashSet::new();
        items
            .iter()
            .filter_map(|a| a.run_id)
            .filter(|id| set.insert(*id))
            .collect()
    };
    let mut generators: std::collections::HashMap<Uuid, String> = std::collections::HashMap::new();
    if !distinct_runs.is_empty() {
        let distinct_runs_json = super::catalog::repository::uuid_list_json(&distinct_runs);
        let rows = sqlx::query!(
            r#"SELECT run_id as "run_id: Uuid", generator_id FROM provenance_run_repro WHERE run_id IN
               (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            distinct_runs_json,
        )
        .fetch_all(pool)
        .await
        .map_err(AppError::database_error)?;
        for r in rows {
            if !r.generator_id.trim().is_empty() {
                generators.insert(r.run_id, r.generator_id);
            }
        }
    }
    Ok(items
        .into_iter()
        .zip(source_ids)
        .map(|(artifact, source_dataset_ids)| ListedArtifact {
            // The singular pair speaks ONLY for a single-source artifact: with several sources
            // there is no one dataset this artifact is "of", and naming one of them would be
            // the first-declared-wins guess this shape exists to remove.
            source_dataset_id: match source_dataset_ids.as_slice() {
                [only] => Some(*only),
                _ => None,
            },
            source_dataset_name: match source_dataset_ids.as_slice() {
                [only] => names.get(only).cloned(),
                _ => None,
            },
            source_dataset_names: source_dataset_ids
                .iter()
                .filter_map(|id| names.get(id).cloned())
                .collect(),
            source_dataset_ids,
            generator_id: artifact.run_id.and_then(|id| generators.get(&id).cloned()),
            artifact,
        })
        .collect())
}

/// Expand a `subtypes_of`/`capability` filter into the concrete datatype-id allow-list
/// (P2 registry). `None` when neither is set (no type filter). If a type filter IS set
/// but the registry isn't built (only in a direct-repo test, never at request time),
/// returns an empty set so an unresolvable type filter matches nothing (never over-broad).
fn resolve_datatype_allow(filter: &super::catalog::models::ArtifactFilter) -> Option<Vec<String>> {
    resolve_datatype_allow_with(filter, crate::modules::datatype::try_registry().as_deref())
}

/// The pure core (registry passed in) — unit-testable for both the present + absent
/// registry branches.
fn resolve_datatype_allow_with(
    filter: &super::catalog::models::ArtifactFilter,
    registry: Option<&crate::modules::datatype::DatatypeRegistry>,
) -> Option<Vec<String>> {
    if filter.subtypes_of.is_none() && filter.capability.is_none() {
        return None;
    }
    let Some(reg) = registry else {
        return Some(Vec::new());
    };
    let mut set: Option<Vec<String>> = None;
    if let Some(sup) = &filter.subtypes_of {
        set = Some(reg.descendants_inclusive(sup));
    }
    if let Some(cap) = &filter.capability {
        let cap_set = reg.types_with_capability(cap);
        set = Some(match set {
            Some(s) => s.into_iter().filter(|d| cap_set.contains(d)).collect(),
            None => cap_set,
        });
    }
    set
}

#[cfg(test)]
mod resolve_datatype_allow_tests {
    use super::resolve_datatype_allow_with;
    use crate::modules::datatype::DatatypeRegistry;
    use crate::modules::workstore::catalog::models::ArtifactFilter;

    #[test]
    fn allow_list_branches() {
        // The matrix-family domain types (single-cell/expression, embedding, …) are
        // manifest-contributed now → build the MERGED registry, as boot does.
        let reg = DatatypeRegistry::build_from_embedded().unwrap();
        // No type filter → None (unfiltered by type).
        assert_eq!(
            resolve_datatype_allow_with(&ArtifactFilter::default(), Some(&reg)),
            None
        );

        // subtypes_of=matrix → the matrix family (inclusive).
        let f = ArtifactFilter {
            subtypes_of: Some("matrix".into()),
            ..Default::default()
        };
        let mut got = resolve_datatype_allow_with(&f, Some(&reg)).unwrap();
        got.sort();
        assert!(got.contains(&"single-cell/expression".to_string()));
        assert!(got.contains(&"embedding".to_string()));
        assert!(!got.contains(&"clustering".to_string()));

        // A type filter with NO registry → empty set (matches nothing, never over-broad).
        assert_eq!(resolve_datatype_allow_with(&f, None), Some(Vec::new()));
    }
}

/// **ITEM-50 — how many analyses in this project used this dataset.**
///
/// **A DISCRIMINATED UNION, and a nullable count was rejected — this comment used to
/// describe the rejected design.**
///
/// There are two distinct answers and `0` is only one of them: `Counted { count: 0 }` says
/// *"this project's recorded runs used other datasets"*, while `CannotCompute` says *"this
/// project has no recorded runs, so a count here would be 0 for a reason that has nothing to
/// do with this dataset"*. A client must branch on `kind` before it can reach a number.
///
/// The consumer is a **destructive-action confirmation** (stage 3's detach warning), which is
/// the worst place in the round to blur them: *"0 dependent analyses"* on a dialog that
/// removes something reads as a safety clearance.
///
/// **Why not `Option<usize>`:** it generates `count?: number`, and `count ?? 0` then
/// COMPILES — the cannot-compute state silently becomes zero at the call site, in front of a
/// user about to detach a dataset three analyses depend on. Preserving the null "all the way
/// to the generated TS" made the absence *visible*, not *unignorable*, and only the second
/// one is a guarantee. As a union the collapse does not typecheck, which stage 3's ITEM-39
/// confirmed against the live route.
///
/// It is recorded this way rather than simply corrected because the stale version survived
/// beside the union it was replaced by, and **prose is what a reader reaches for first** —
/// on this branch a doc-comment that outlived its design has been the false premise four
/// times, twice in a producer's own docstrings.
#[derive(Debug, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DependentCount {
    /// A real count. `0` here means "this project's recorded runs used other datasets".
    Counted { count: usize },
    /// **Not a number.** The project has no recorded runs, so every count would be 0 for a
    /// reason that has nothing to do with this dataset.
    CannotCompute { reason: String },
}

/// **ITEM-50's response — a discriminated union, deliberately not a nullable number.**
///
/// `Option<usize>` generates `count?: number` in this repo's TS, and `count ?? 0` then
/// compiles: the cannot-compute state becomes 0 with nothing to stop it. The consumer is a
/// DESTRUCTIVE-ACTION confirmation — stage 3's detach warning — where "0 dependent analyses"
/// reads as a safety clearance in front of a user about to remove a dataset three analyses
/// depend on.
///
/// So the absence is a VARIANT rather than a missing field. A client must branch on `kind`
/// before it can reach a number, which is the same "make the wrong thing inexpressible"
/// move the plan asks for elsewhere ("put the recursion in the TYPE, not in prose").
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct DependentAnalyses {
    pub project_id: Uuid,
    pub dataset_id: Uuid,
    pub dependents: DependentCount,
}

/// `GET /projects/{project_id}/datasets/{dataset_id}/dependent-analyses`
pub async fn get_dependent_analyses(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path((project_id, dataset_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<DependentAnalyses>> {
    require_project_read(&pool, project_id, auth.user.id).await?;
    let count = super::ownership_backfill::dependent_analysis_count(&pool, project_id, dataset_id)
        .await
        .map_err(|e| e.to_api_error())?;
    Ok((
        StatusCode::OK,
        Json(DependentAnalyses {
            project_id,
            dataset_id,
            dependents: match count {
                Some(count) => DependentCount::Counted { count },
                None => DependentCount::CannotCompute {
                    reason: "this project has no recorded runs, so a count of 0 would say \
                             nothing about this dataset"
                        .to_string(),
                },
            },
        }),
    ))
}

/// One artifact's typed metadata.
pub async fn get_artifact(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Artifact>> {
    let repo = CatalogRepository::new(pool.clone());
    let artifact = repo
        .get_any_status(id)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| AppError::not_found("Artifact").to_api_error())?;
    require_artifact_read(&pool, &artifact, auth.user.id).await?;
    Ok((StatusCode::OK, Json(artifact)))
}

/// Delete a project artifact (ITEM-19 entity-lifecycle). Removes the catalog row and emits
/// `sync:artifact` (delete) to the project audience so a result pane BOUND to this artifact
/// self-closes — the LOCAL same-session refetch AND the cross-device SSE path both reconcile
/// the pane set against the catalog. Project-scoped: an id not in this project (or not visible)
/// → 404 (no oracle).
pub async fn delete_artifact(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((project_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let repo = CatalogRepository::new(pool.clone());
    // Existence + project-scope guard: the artifact must belong to THIS project, else
    // 404 (no oracle) — and, critically, this stops an editor of project P from deleting
    // project Q's artifact via `/projects/P/artifacts/{Q-artifact}`.
    let _artifact = repo
        .get_any_status(id)
        .await
        .map_err(|e| e.to_api_error())?
        .filter(|a| a.project_id == Some(project_id))
        .ok_or_else(|| AppError::not_found("Artifact").to_api_error())?;
    // DELETE is a write: gate on EDIT (Owner/Editor), not read — a Viewer-shared
    // collaborator must NOT be able to delete artifacts (403 PROJECT_READ_ONLY).
    // The artifact is project-scoped here (the filter above guarantees it), so the
    // project-edit boundary is the correct authoritative gate.
    require_project_edit(&pool, project_id, auth.user.id).await?;
    if !repo.delete(id).await.map_err(|e| e.to_api_error())? {
        return Err(AppError::not_found("Artifact").to_api_error());
    }
    super::sync::publish_artifact(
        &pool,
        project_id,
        SyncAction::Delete,
        id,
        crate::modules::sync::Actor::user(auth.user.id, origin.0),
    )
    .await;
    Ok((StatusCode::NO_CONTENT, ()))
}

/// One declared AXIS of the project, with its cardinality. The open-axis replacement
/// for the retired `(n_cells, n_genes)` scalar pair: `name` is a DECLARED
/// `AxisSpec.name` (`cells`/`genes`/`region`/`comparison`/`cluster`/…), never an
/// obs/var enum (DEC-6). A `(comparison, gene)` DE table or a `(cluster, cluster)`
/// graph has no obs/var home, so two scalars could never describe one.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct AxisSummary {
    /// **The axis's IDENTITY** — the `content_hash` of the key artifact that IS this
    /// axis (INV-3). This is the field a client keys on; [`AxisSummary::name`] is a
    /// display label and two different axes may legitimately carry the same one.
    ///
    /// Without it on the wire, two same-label axes are indistinguishable to a consumer
    /// and the only way to render them is to fold them back together by name — i.e. to
    /// re-create, in the client, the identity confusion this field exists to remove.
    pub content_hash: String,
    /// The declared axis LABEL, for display. Never a key (INV-3).
    pub name: String,
    /// The number of entries on this axis, as its own key artifact DECLARED it. Always
    /// one artifact's own `structure.n` — never a value computed across artifacts.
    pub length: i64,
    /// The ORDERED KEY SEQUENCE this axis IS, by its digest — the key artifact's own
    /// `structure.key_sequence_digest` (dimension-membership ITEM-31).
    ///
    /// Two identities for one axis, and they are not redundant: `content_hash` identifies
    /// the ARTIFACT (it is what `$scope.axis` carries and what a client keys a pane on),
    /// while this is the identity a PRODUCER can name about itself — a producer cannot name
    /// a `content_hash` (ingest mints it, after the fact, over bytes the producer has not
    /// finished writing), so the only identity a declaration can carry is this one.
    ///
    /// It pins an axis to a SEQUENCE rather than to a length. Two axes of equal `n` whose
    /// keys are in different orders are not the same axis, and any read that addresses one
    /// axis positionally through another is only sound while the digests agree. It rides the
    /// catalog so a client can ask the membership question WITHOUT first fetching every
    /// artifact to find the digest: `ArtifactFilter.on_axis` takes the digest, the client
    /// holds only the `content_hash`, and resolving one to the other out of the artifact
    /// list would mean fetching the very list the filter exists to narrow.
    ///
    /// `None` when the key artifact declares none — an axis whose alignment nothing can join
    /// on, a legitimate state (A3), not an error. A consumer that needs the guarantee must
    /// treat `None` as "cannot be checked", never as "matches".
    pub key_sequence_digest: Option<String>,
}

/// A project's catalog overview: its declared axes (with lengths) + a brief of each
/// artifact.
#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ProjectCatalog {
    pub project_id: Uuid,
    /// Every axis the project has entries on, ordered by the DECLARED axis order of its
    /// artifacts' datatypes (an axis no datatype declares is appended, name-sorted).
    pub axes: Vec<AxisSummary>,
    pub artifacts: Vec<Artifact>,
}

/// The DECLARED axis order across `artifacts`' datatypes: walk each artifact's datatype
/// `axes` in declaration order, de-duplicated, first-seen wins. Registry DATA — the
/// handler names no axis itself. Empty when the registry is unavailable.
fn declared_axis_order(artifacts: &[Artifact]) -> Vec<String> {
    let Some(reg) = crate::modules::datatype::try_registry() else {
        return Vec::new();
    };
    let mut order: Vec<String> = Vec::new();
    for a in artifacts {
        let Some(dt) = reg.get(&a.datatype) else {
            continue;
        };
        for ax in &dt.axes {
            if !order.iter().any(|n| n == &ax.name) {
                order.push(ax.name.clone());
            }
        }
    }
    order
}

/// DERIVE each axis's cardinality from the artifacts that ARE those axes (ITEM-8 /
/// DEC-2 / INV-3).
///
/// This replaced `AxesRepository::axis_lengths`, a `COUNT(*) … GROUP BY axis_name`
/// over `workstore_axis_entry`. That table's primary key WAS the axis name, so it
/// contradicted INV-3 (*an axis IS its key artifact; the NAME is a label*) in the
/// strongest form a schema can, and ITEM-8 dropped it.
///
/// The replacement reads a DECLARATION, never a byte (INV-1): a key artifact's
/// producer-supplied `structure` states the axis it spans (`structure.axis`) and how
/// many entries it has (`structure.n`), which is exactly the pair the retired table
/// stored one row per entry to reconstruct. An artifact that declares neither
/// contributes nothing — it is not a key artifact, and absence is silence rather than
/// a zero-length axis (INV-2: no invented default).
///
/// ## An axis is a KEY ARTIFACT, and it is identified by its hash (INV-3)
///
/// Two things were wrong here and they compounded.
///
/// **It keyed by the LABEL.** A `BTreeMap` keyed on the axis name folded same-label
/// declarations with `max(n)` — name-as-identity, the same defect ITEM-8 removed from the
/// schema, surviving inside the derivation that replaced it. Worse, the fold FABRICATED a
/// number: two genuinely distinct key artifacts (different `content_hash`, different
/// lengths) that happened to share a label were reported as ONE axis whose cardinality
/// was the max of two unrelated values — a figure no producer ever declared.
///
/// **It counted every artifact that MENTIONED an axis.** A metadata column declares
/// `structure.axis` (the axis it is aligned TO) and `structure.n` (its own length); it is
/// not that axis. Under label-folding this was invisible, because every aligned column
/// folded into the label it named. Fix only the grouping and it becomes loud instead: a
/// real import emits dozens of aligned columns, each of which would surface as its own
/// axis.
///
/// So the derivation asks the producer's own declaration for BOTH facts:
///
/// * **Which artifacts are axes** — those whose producer declared `meta.is_axis_index`.
///   That is the server's EXISTING definition of a key artifact, already the predicate
///   `CatalogRepository::find_dataset_axis_index` resolves an axis by. Having the catalog
///   invent a second definition is how the two drift. An artifact that never declares it
///   contributes nothing: absence is silence, not a guess (INV-2).
/// * **Which axis each one IS** — its own `content_hash` (INV-3). Two key artifacts
///   sharing a LABEL are two axes, and the caller can tell them apart because
///   `content_hash` is on the wire. Two rows with the SAME `content_hash` are ONE axis
///   however they are labelled — the same bytes cannot be two axes; when their labels
///   differ (a relabelling) the name-sorted-first is reported, because any of them is
///   equally true and picking deterministically beats picking by iteration order.
///
/// **Nothing is ever folded arithmetically.** Every reported `length` is some single
/// artifact's own declared `n` — no max, no sum, no count — so the wire can carry a
/// producer's disagreement but never a value the server invented.
///
/// Pure over the artifact list, so it is directly unit-testable with no DB.
fn derive_axes(artifacts: &[Artifact]) -> Vec<AxisSummary> {
    // Sort by (label, artifact id) FIRST so the label chosen for a content_hash that
    // carries several is deterministic rather than dependent on catalog ordering.
    let mut declaring: Vec<(&str, i64, &str, Option<&str>)> = artifacts
        .iter()
        // ITEM-18 / DEC-12: a key artifact the conformance gate CONDEMNED does not define
        // an axis. Every value below is read straight out of `structure` — the very
        // declaration the gate proved the bytes disagree with — so a condemned row here
        // would publish a cardinality the project does not have, and it would publish it
        // as an ordinary fact with nothing marking it suspect (an `AxisSummary` carries no
        // status). The row itself stays LISTED in the same response, where its `status`
        // is visible and the owner can act on it; it just stops being load-bearing.
        // `list_dataset_axis_index_candidates` applies the identical rule in SQL for the
        // job-input resolver — this is the same predicate for the read surface.
        .filter(|a| a.status == STATUS_READY)
        .filter(|a| a.meta.get("is_axis_index").and_then(|v| v.as_bool()) == Some(true))
        .filter_map(|a| {
            let axis = a.structure.get("axis").and_then(|v| v.as_str())?;
            let n = a.structure.get("n").and_then(|v| v.as_i64())?;
            let digest = a
                .structure
                .get("key_sequence_digest")
                .and_then(|v| v.as_str())
                .filter(|d| !d.is_empty());
            Some((axis, n, a.content_hash.as_str(), digest))
        })
        .collect();
    declaring.sort_by(|l, r| l.0.cmp(r.0).then_with(|| l.2.cmp(r.2)));

    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    declaring
        .into_iter()
        .filter(|(_, _, hash, _)| seen.insert(hash))
        .map(|(name, length, hash, digest)| AxisSummary {
            content_hash: hash.to_string(),
            name: name.to_string(),
            length,
            key_sequence_digest: digest.map(str::to_string),
        })
        .collect()
}

/// Order the derived axes by the declared datatype axis order, appending any axis no
/// datatype declares in the (name-sorted) order [`derive_axes`] already carries — so the
/// wire order is stable AND meaningful without the handler naming a single axis.
///
/// A declared name can now match SEVERAL axes (distinct key artifacts sharing a label —
/// INV-3), so each declared name drains ALL of its matches, keeping their relative order.
/// Draining only the first, as the pre-INV-3 form did, would have silently pushed the
/// second same-label axis into the "undeclared" tail.
fn order_axes(axes: Vec<AxisSummary>, declared: &[String]) -> Vec<AxisSummary> {
    let mut remaining = axes;
    let mut out: Vec<AxisSummary> = Vec::with_capacity(remaining.len());
    for name in declared {
        let (matching, rest): (Vec<AxisSummary>, Vec<AxisSummary>) =
            remaining.into_iter().partition(|a| &a.name == name);
        out.extend(matching);
        remaining = rest;
    }
    out.extend(remaining);
    out
}

#[cfg(test)]
mod derive_axes_tests {
    use super::{derive_axes, order_axes, AxisSummary};
    use crate::modules::workstore::catalog::models::Artifact;

    /// A KEY ARTIFACT with a DISTINCT content identity per call — the default, because
    /// an axis IS its key artifact and two fixtures that silently shared one hash would
    /// be one axis, quietly making every grouping assertion below vacuous.
    fn artifact(structure: serde_json::Value) -> Artifact {
        artifact_with_hash(
            &format!("sha256:{}", uuid::Uuid::new_v4().simple()),
            structure,
        )
    }

    /// A key artifact with an EXPLICIT content identity, for the cases where sharing one
    /// — or not — is the thing under test.
    fn artifact_with_hash(content_hash: &str, structure: serde_json::Value) -> Artifact {
        keyed(
            content_hash,
            structure,
            serde_json::json!({ "is_axis_index": true }),
        )
    }

    /// An artifact ALIGNED to an axis rather than being one: it names a label and its own
    /// length, and declares no `meta.is_axis_index`. This is what a metadata column is.
    fn aligned(content_hash: &str, structure: serde_json::Value) -> Artifact {
        keyed(content_hash, structure, serde_json::json!({}))
    }

    fn keyed(
        content_hash: &str,
        structure: serde_json::Value,
        meta: serde_json::Value,
    ) -> Artifact {
        Artifact {
            id: uuid::Uuid::new_v4(),
            project_id: Some(uuid::Uuid::new_v4()),
            dataset_id: None,
            run_id: None,
            output_id: "out".into(),
            datatype: "data/opaque".into(),
            object_key: Some(content_hash.into()),
            is_multifile: false,
            content_hash: content_hash.into(),
            structure,
            meta,
            role: "artifact".into(),
            status: "ready".into(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            hidden: false,
            representation_of: None,
        }
    }

    /// `(name, length)` per reported axis — for the cases where identity is not the
    /// subject. A case that IS about identity asserts on `content_hash` directly.
    fn summarize(axes: &[AxisSummary]) -> Vec<(String, i64)> {
        axes.iter().map(|a| (a.name.clone(), a.length)).collect()
    }

    // ITEM-8 / DEC-2: cardinality comes from the KEY ARTIFACT'S OWN DECLARATION
    // (`structure.axis` + `structure.n`), which is what replaced the name-keyed
    // `workstore_axis_entry` COUNT(*). Nothing here opens a byte (INV-1).
    #[test]
    fn cardinality_is_derived_from_the_declaration() {
        let arts = vec![
            artifact(serde_json::json!({ "encoding": "zarr_v3", "axis": "rows", "n": 5 })),
            artifact(serde_json::json!({ "encoding": "zarr_v3", "axis": "columns", "n": 3 })),
        ];
        let axes = derive_axes(&arts);
        assert_eq!(
            summarize(&axes),
            vec![("columns".to_string(), 3), ("rows".to_string(), 5)],
            "each declared axis reports its declared cardinality, name-sorted"
        );
        // Each axis is IDENTIFIED by its key artifact's content hash — the field a
        // client keys on, and the reason two same-label axes stay distinguishable.
        assert_eq!(axes[0].content_hash, arts[1].content_hash);
        assert_eq!(axes[1].content_hash, arts[0].content_hash);
    }

    // ITEM-18 / DEC-12 — the READ half of the conformance gate, at the derivation.
    //
    // `length` here is `structure.n`, read off the very declaration the gate proved the
    // bytes disagree with, and an `AxisSummary` carries NO status field — so a condemned
    // key artifact would publish a project axis cardinality as an ordinary fact, with
    // nothing on the wire marking it suspect. The row stays LISTED in the same
    // `/catalog` response (that is where the owner meets `status: "failed"` and acts);
    // it just stops being load-bearing.
    //
    // POSITIVE + NEGATIVE in one derivation, over the SAME label: a `failed` key
    // artifact and a `ready` one both claiming `rows`, with different lengths. If the
    // filter were absent this would report TWO `rows` axes (INV-3's own rule — two
    // identities, two axes) and the surviving assertion would be about the wrong thing,
    // so the length is asserted too: the number reported must be the good artifact's.
    #[test]
    fn a_condemned_key_artifact_does_not_define_an_axis() {
        let mut condemned = artifact_with_hash(
            "sha256:bad",
            serde_json::json!({ "axis": "rows", "n": 999 }),
        );
        condemned.status = "failed".into();
        let good = artifact_with_hash("sha256:good", serde_json::json!({ "axis": "rows", "n": 7 }));
        let good_hash = good.content_hash.clone();

        let axes = derive_axes(&[condemned, good]);
        assert_eq!(
            summarize(&axes),
            vec![("rows".to_string(), 7)],
            "the condemned key artifact contributes no axis, and does not turn one label \
             into two"
        );
        assert_eq!(
            axes[0].content_hash, good_hash,
            "the surviving axis is the READY artifact's, not whichever sorted first"
        );

        // NEGATIVE CONTROL on the filter itself: flip the same row back to `ready` and
        // it DOES define an axis. Without this the assertion above would also pass on a
        // derivation that had simply stopped reporting `rows` for an unrelated reason.
        let mut revived = artifact_with_hash(
            "sha256:bad",
            serde_json::json!({ "axis": "rows", "n": 999 }),
        );
        revived.status = "ready".into();
        let good = artifact_with_hash("sha256:good", serde_json::json!({ "axis": "rows", "n": 7 }));
        assert_eq!(
            summarize(&derive_axes(&[revived, good])).len(),
            2,
            "status is the ONLY thing that excluded it"
        );
    }

    // **INV-3, the whole point.** Two genuinely distinct key artifacts (different
    // `content_hash`, different declared lengths) that happen to share a LABEL are TWO
    // axes. The previous derivation keyed a map by the name and folded them with
    // `max(n)`, reporting one axis whose cardinality was a number no producer ever
    // declared — name-as-identity, the same defect ITEM-8 removed from the schema,
    // surviving in the derivation that replaced it.
    #[test]
    fn two_key_artifacts_sharing_a_label_are_two_axes() {
        let arts = vec![
            artifact_with_hash("sha256:aaa", serde_json::json!({ "axis": "rows", "n": 4 })),
            artifact_with_hash("sha256:bbb", serde_json::json!({ "axis": "rows", "n": 10 })),
        ];
        let axes = derive_axes(&arts);
        assert_eq!(
            summarize(&axes),
            vec![("rows".to_string(), 4), ("rows".to_string(), 10)],
            "a label collision is not an axis collision"
        );
        assert_eq!(
            axes.iter()
                .map(|a| a.content_hash.as_str())
                .collect::<Vec<_>>(),
            vec!["sha256:aaa", "sha256:bbb"],
            "each carries its OWN key artifact's identity"
        );
        // The specific fabrication that used to happen: neither 10-as-the-only-answer
        // nor any other computed value appears. Every length on the wire is some one
        // artifact's own `n`.
        let declared: std::collections::HashSet<i64> = arts
            .iter()
            .map(|a| a.structure["n"].as_i64().unwrap())
            .collect();
        assert!(
            axes.iter().all(|a| declared.contains(&a.length)),
            "a reported length must be a DECLARED length, never a fold across artifacts"
        );
    }

    // An artifact that is ALIGNED to an axis is not that axis. A metadata column
    // declares `structure.axis` (the label it belongs to) and `structure.n` (its own
    // length) exactly like a key artifact does, and the only thing separating them is
    // the producer SAYING which it is (`meta.is_axis_index`) — the same predicate
    // `find_dataset_axis_index` resolves an axis by.
    //
    // Without this filter the INV-3 grouping fix would trade one wrong answer for
    // another: a real import emits dozens of aligned columns per axis, and each would
    // surface as its own axis. Label-folding hid that; identity-grouping alone would
    // have made it loud.
    #[test]
    fn an_artifact_aligned_to_an_axis_is_not_an_axis() {
        let arts = vec![
            artifact_with_hash("sha256:key", serde_json::json!({ "axis": "rows", "n": 4 })),
            aligned(
                "sha256:col_a",
                serde_json::json!({ "kind": "column", "axis": "rows", "n": 4 }),
            ),
            aligned(
                "sha256:col_b",
                serde_json::json!({ "kind": "column", "axis": "rows", "n": 4 }),
            ),
        ];
        let axes = derive_axes(&arts);
        assert_eq!(
            summarize(&axes),
            vec![("rows".to_string(), 4)],
            "the two aligned columns are not axes: {axes:?}"
        );
        assert_eq!(axes[0].content_hash, "sha256:key");
    }

    // The other half of INV-3: the same bytes cannot be two axes. Two rows carrying the
    // SAME `content_hash` are one axis however they are labelled, and the label reported
    // is the name-sorted-first — deterministic rather than catalog-order-dependent.
    #[test]
    fn one_content_hash_is_one_axis_however_it_is_labelled() {
        let arts = vec![
            artifact_with_hash("sha256:same", serde_json::json!({ "axis": "zeta", "n": 7 })),
            artifact_with_hash(
                "sha256:same",
                serde_json::json!({ "axis": "alpha", "n": 7 }),
            ),
        ];
        let axes = derive_axes(&arts);
        assert_eq!(axes.len(), 1, "one identity, one axis: {axes:?}");
        assert_eq!(axes[0].content_hash, "sha256:same");
        assert_eq!(
            axes[0].name, "alpha",
            "the label is chosen deterministically"
        );
        assert_eq!(axes[0].length, 7);
    }

    // INV-2: an artifact that DECLARES no axis contributes no axis. Absence is
    // silence — never a zero-length axis invented on its behalf.
    #[test]
    fn an_undeclared_axis_is_absent_not_zero() {
        let arts = vec![
            artifact(serde_json::json!({ "encoding": "opaque", "media_type": "text/html" })),
            // A partial declaration is still not a declaration: `axis` without `n`
            // (and `n` without `axis`) states no cardinality.
            artifact(serde_json::json!({ "axis": "rows" })),
            artifact(serde_json::json!({ "n": 9 })),
        ];
        assert!(
            derive_axes(&arts).is_empty(),
            "no artifact declared a complete (axis, n) pair, so there is no axis to report"
        );
    }

    // The declared datatype axis order drives the wire order; an axis no datatype
    // declares is appended in the derivation's own (name-sorted) order. A declared name
    // matching SEVERAL axes (INV-3: same label, different key artifacts) takes them ALL
    // — draining only the first would push the second into the undeclared tail, which
    // is the ordering half of the same name-as-identity mistake.
    #[test]
    fn declared_order_wins_then_name_sorted_remainder() {
        let axis = |hash: &str, name: &str, length: i64| AxisSummary {
            content_hash: hash.into(),
            name: name.into(),
            length,
            key_sequence_digest: None,
        };
        let axes = vec![
            axis("sha256:1", "alpha", 1),
            axis("sha256:2", "rows", 5),
            axis("sha256:3", "rows", 6),
            axis("sha256:4", "columns", 3),
        ];
        let declared = vec!["rows".to_string(), "columns".to_string()];
        let got: Vec<(String, i64)> = summarize(&order_axes(axes, &declared))
            .into_iter()
            .collect();
        assert_eq!(
            got,
            vec![
                ("rows".to_string(), 5),
                ("rows".to_string(), 6),
                ("columns".to_string(), 3),
                ("alpha".to_string(), 1),
            ]
        );
    }
}

pub async fn get_catalog(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<ProjectCatalog>> {
    require_project_read(&pool, project_id, auth.user.id).await?;
    let repo = CatalogRepository::new(pool);
    // Include the project's attached-dataset artifacts (dataset-scoped, `project_id`
    // NULL) alongside project-scoped ones — the workbench derives `producedTypeIds`
    // from this overview, so an imported `single-cell/expression` must appear here or
    // `accepts`-gated analyses (e.g. `cell.filter`) never light up in the launcher.
    let mut artifacts = repo
        .list_for_project_scope(project_id, &ArtifactFilter::default(), None)
        .await
        .map_err(|e| e.to_api_error())?;
    // Hidden artifacts (derived alternate representations, ITEM-20) are excluded
    // from the catalog overview (still fetchable by id via `get_artifact`).
    artifacts.retain(|a| !a.hidden);
    // One entry per distinct KEY ARTIFACT (identified by its `content_hash`, INV-3),
    // carrying that artifact's own declared label + cardinality (ITEM-8 / DEC-2);
    // re-ordered by the DECLARED axis order of the project's artifacts' datatypes.
    let axes = order_axes(derive_axes(&artifacts), &declared_axis_order(&artifacts));
    Ok((
        StatusCode::OK,
        Json(ProjectCatalog {
            project_id,
            axes,
            artifacts,
        }),
    ))
}

/// **The READ-ONLY storage-health report** (see [`super::presence`] for the shape and why
/// it is a report rather than a status transition).
///
/// `status = 'ready'` records that INGEST succeeded, not that the bytes are still in the
/// store, and the two came apart on a live project: 89 `ready` artifacts, none of whose
/// blobs were on disk. Every read answered `404 Blob`, the plots came back empty, and
/// there was no surface that could say why.
///
/// Gated exactly as the catalog it reads — [`require_project_read`], so a foreign project
/// is a `404` and never a report. Same artifact set as `GET /catalog`, EXCEPT that hidden
/// derived representations (ITEM-20) are INCLUDED: a hidden alternate representation whose
/// bytes are gone is a perfectly good explanation for a surface that renders nothing, and
/// hiding it from a health report would hide the answer.
///
/// It never writes: no status, no delete. The only store calls it can make are
/// `exists`/`get` (see `presence_of`), and the integration test asserts on both sides —
/// the rows are still `ready` and the blobs that were present are still present.
pub async fn get_artifact_bytes_presence(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<BytesPresenceReport>> {
    require_project_read(&pool, project_id, auth.user.id).await?;
    let repo = CatalogRepository::new(pool.clone());
    let artifacts = repo
        .list_for_project_scope(project_id, &ArtifactFilter::default(), None)
        .await
        .map_err(|e| e.to_api_error())?;
    let store = super::get_object_store();
    let mut report = BytesPresenceReport::empty(project_id);
    for artifact in &artifacts {
        let presence = presence_of(store.as_ref(), artifact).await;
        report.record(artifact, presence);
    }
    if report.absent > 0 || report.indeterminate > 0 {
        tracing::info!(
            %project_id,
            checked = report.checked,
            absent = report.absent,
            indeterminate = report.indeterminate,
            "workstore: artifacts whose bytes are not in this store"
        );
    }
    Ok((StatusCode::OK, Json(report)))
}

// --------------------------- data plane (bytes) -----------------------------

/// `?range=` — the byte-span query parameter (artifact-model ITEM-36).
///
/// The URL is the cache key. A `Range:` HEADER yields a `206`, which browsers
/// cache inconsistently and most CDNs refuse to store at all; putting the span in
/// the URL makes every chunk an ordinary, independently cacheable `GET` that any
/// later read touching the same chunk reuses.
///
/// Three forms — `a-b` (inclusive), `a-` (to the end), `-n` (the last n bytes) —
/// parsed by [`super::range::parse_range_param`], which documents each and
/// validates hard: a malformed span is a `400`, an out-of-bounds one is a `416`,
/// and neither can degrade into serving the whole blob.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DataRangeQuery {
    /// A byte span: `a-b` (inclusive), `a-` (offset a to the end), or `-n` (the
    /// last n bytes — the form a client uses to read a trailer before it knows
    /// the file's size). Omit for the whole object. Answers `200`, never `206`:
    /// the URL names the exact bytes, so the response is complete FOR THAT URL.
    pub range: Option<String>,
}

/// Build the octet response for `length` bytes at `offset`, STREAMED from the
/// store (artifact-model ITEM-37).
///
/// The body is never resident: `get_stream` hands back a chunked reader and
/// `Body::from_stream` writes it out, so a 134 MB shard costs one 64 KiB buffer
/// per in-flight request instead of 134 MB of heap. Which is the only defensible
/// shape here — under INV-1 the server does not open these bytes for meaning, so
/// there is no reason for it to ever hold them.
///
/// `Content-Length` is always set from the caller's `stat`-derived `length`, so a
/// client can size a buffer and show progress before the first byte lands; this
/// path never falls back to chunked transfer-encoding.
async fn octet_response(
    store: &dyn ObjectStore,
    key: &ContentKey,
    status: StatusCode,
    offset: u64,
    length: u64,
    content_range: Option<String>,
) -> Result<Response, (StatusCode, AppError)> {
    // Resolved EAGERLY: a missing blob fails here, before a status line exists,
    // so it is still a clean 404 rather than a truncated body.
    let stream = store
        .get_stream(key, offset, length)
        .await
        .map_err(|e| e.to_api_error())?;
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length)
        .header(header::CACHE_CONTROL, IMMUTABLE_CACHE);
    if let Some(cr) = content_range {
        builder = builder.header(header::CONTENT_RANGE, cr);
    }
    builder.body(Body::from_stream(stream)).map_err(|e| {
        AppError::internal_error(format!("workstore: byte response build failed: {e}"))
            .to_api_error()
    })
}

/// A `416` for a well-formed span the blob cannot satisfy.
fn unsatisfiable(total: u64) -> Response {
    (
        StatusCode::RANGE_NOT_SATISFIABLE,
        [(header::CONTENT_RANGE, format!("bytes */{total}"))],
    )
        .into_response()
}

/// Serve a resolved blob key, honouring EITHER the `?range=` param or a `Range:`
/// header — never both.
///
/// **Both at once is a `400`, not a precedence rule.** Two sources for one value
/// is exactly the ambiguity INV-2 forbids, and a precedence rule would mean a
/// client whose header and param disagree gets bytes it did not ask for, silently.
///
/// The two paths answer differently ON PURPOSE:
///
/// | request | status |
/// |---|---|
/// | neither | `200`, whole object |
/// | `?range=` satisfiable | **`200`** — the URL names the exact resource, so this is a COMPLETE response for that URL, and therefore cacheable |
/// | `?range=` out of bounds | `416` |
/// | `?range=` malformed | `400` |
/// | `Range:` satisfiable | `206` + `Content-Range` (RFC 9110) |
/// | `Range:` unsatisfiable | `416` |
/// | `Range:` unparsable | `200`, whole object (RFC 9110 §14.2 "ignore") |
///
/// The bare `Range:` header REMAINS supported when no param is present, for three
/// reasons: this surface advertises `Accept-Ranges: bytes`, so dropping it would
/// make that advertisement a lie to every generic HTTP client (`curl -r`, a
/// resumed download, a third-party range-aware reader); it is not the cacheable
/// path, so it cannot reintroduce the `206`-caching problem ITEM-36 solves; and
/// the plan's own rule ("header AND param is a 400") presumes a header ALONE is
/// answerable. What it does not get is the txresbench read path — that speaks `?range=`
/// exclusively, where the whole-blob degradation is unrepresentable.
async fn serve_bytes(
    store: &dyn ObjectStore,
    key: &ContentKey,
    range_param: Option<&str>,
    range_header: Option<&str>,
) -> Result<Response, (StatusCode, AppError)> {
    // Checked BEFORE the store is touched: this is a property of the REQUEST, not
    // of the object, so it must not depend on the blob resolving.
    if range_param.is_some() && range_header.is_some() {
        return Err(AppError::bad_request(
            "AMBIGUOUS_RANGE",
            "send either the `range` query parameter or a `Range:` header, not both",
        )
        .to_api_error());
    }

    let total = store.stat(key).await.map_err(|e| e.to_api_error())?.len;

    if let Some(spec) = range_param {
        return match parse_range_param(spec, total) {
            Ok(span) => {
                octet_response(store, key, StatusCode::OK, span.offset, span.length, None).await
            }
            Err(RangeParamError::Unsatisfiable) => Ok(unsatisfiable(total)),
            Err(RangeParamError::Malformed) => Err(AppError::bad_request(
                "INVALID_RANGE",
                "`range` must be `<a>-<b>`, `<a>-` or `-<n>` with decimal byte offsets",
            )
            .to_api_error()),
        };
    }

    match parse_range(range_header, total) {
        RangeOutcome::Full => octet_response(store, key, StatusCode::OK, 0, total, None).await,
        outcome @ RangeOutcome::Satisfiable { .. } => {
            let (offset, len) = outcome.offset_len().unwrap();
            let content_range = outcome.content_range(total).unwrap();
            octet_response(
                store,
                key,
                StatusCode::PARTIAL_CONTENT,
                offset,
                len,
                Some(content_range),
            )
            .await
        }
        RangeOutcome::Unsatisfiable => Ok(unsatisfiable(total)),
    }
}

/// Load an artifact for the BYTE plane: it must exist, the caller must be allowed to read
/// it, and it must be [`ConsumableArtifact`] — i.e. the post-ingest conformance gate must
/// not have condemned it (ITEM-18 / DEC-12).
///
/// The three checks are in that ORDER for a security reason. A `409
/// ARTIFACT_NOT_CONFORMING` confirms the row exists, so a principal outside the artifact's
/// tenancy scope must meet the scope's own `404` first — checking conformance before
/// authorization would turn this route into a cross-tenant existence oracle.
///
/// The return type is what makes the gate un-forgettable: both byte routes go through this
/// one function, and it hands back a type a non-`ready` row cannot be turned into.
pub(crate) async fn load_readable_artifact(
    pool: &SqlitePool,
    id: Uuid,
    user_id: Uuid,
) -> Result<ConsumableArtifact, (StatusCode, AppError)> {
    let repo = CatalogRepository::new(pool.clone());
    let artifact = repo
        .get_any_status(id)
        .await
        .map_err(|e| e.to_api_error())?
        .ok_or_else(|| AppError::not_found("Artifact").to_api_error())?;
    require_artifact_read(pool, &artifact, user_id).await?;
    ConsumableArtifact::try_new(artifact).map_err(|e| e.to_api_error())
}

/// Tier-1: stream a single-file artifact's bytes (+ Range/206).
/// The cache contract for artifact BYTES (artifact-model ITEM-9).
///
/// Safe to cache forever because an artifact is immutable and content-addressed:
/// the bytes behind a given id can never change, so a revalidation round-trip
/// could only ever confirm what the client already holds. `immutable` tells the
/// browser not to revalidate even on an explicit reload.
///
/// `private` because these bytes are permission-scoped — a shared/CDN cache must
/// never serve one user's artifact to another.
///
/// This applies ONLY to the byte routes. The artifact LIST is deliberately
/// uncached (ITEM-10): rows are mutable and are refreshed by the sync channel, so
/// caching the list would pin a stale catalog in front of a live one.
const IMMUTABLE_CACHE: &str = "private, max-age=31536000, immutable";

#[axum::debug_handler]
pub async fn serve_artifact_data(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(id): Path<Uuid>,
    Query(range): Query<DataRangeQuery>,
    headers: HeaderMap,
) -> Response {
    match serve_data_inner(&pool, id, auth.user.id, &headers, &range, None).await {
        Ok(resp) => resp,
        Err((code, err)) => (code, err).into_response(),
    }
}

/// Tier-1: stream a NAMED member inside a multi-file artifact (a Zarr chunk / a
/// `.bai`) so client decoders range-read chunks.
#[axum::debug_handler]
pub async fn serve_artifact_member(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path((id, member)): Path<(Uuid, String)>,
    Query(range): Query<DataRangeQuery>,
    headers: HeaderMap,
) -> Response {
    match serve_data_inner(&pool, id, auth.user.id, &headers, &range, Some(member)).await {
        Ok(resp) => resp,
        Err((code, err)) => (code, err).into_response(),
    }
}

/// A per-column sparse member address — `<member>/sparse/<C>` (e.g. `values/sparse/42`) — parsed
/// to its column index. A virtual `sparse_csc` dataset serves ONE column per request (§11.1i): a
/// column is a masked CSC slice returned as the `u32 n | u32[n] row | f32[n] value` wire, NOT a
/// dense chunk of the flat/split store. `None` for any other address, which falls through to the
/// ordinary flat/split gathered resolver.
fn parse_sparse_member(path: &str) -> Option<usize> {
    let (_prefix, rest) = path.rsplit_once("sparse/")?;
    // The column index is the whole remainder — a trailing `/...` would be a different address.
    if rest.is_empty() || rest.contains('/') {
        return None;
    }
    rest.parse::<usize>().ok()
}

/// Produce one member of a GATHERED artifact's synthetic zarr store (ITEM-17/19).
///
/// **The store is a GROUP with its array under `values/` (DEC-26)** — the same shape
/// `txr_zarr` emits, measured off `stage1_alignment/sources/level_0_group.zarr` rather than
/// designed. `zarr.json` is the group node carrying the artifact's declaration; the column
/// lives at `values/zarr.json` + `values/c/<n>` (or, for a split string column,
/// `values/{offsets,values}/…`). It used to serve the array AT the root, so a client
/// following `columns[].path` asked for `values/…` and got a 404 while a processor reading
/// `<root>/values/zarr.json` found nothing at all.
///
/// Anything the store does not hold is a 404-shaped refusal rather than an empty body,
/// because a client asking for a member that cannot exist has a bug and an empty 200 hides
/// it — including a chunk index past the end, on the SPLIT path as well as the flat one.
///
/// **`resolve` is called exactly ONCE.** It re-runs every source's digest precheck and
/// re-decodes every source's whole column; the previous shape called it twice for every flat
/// chunk request, on a path with no cache.
async fn serve_gathered_member(
    pool: &SqlitePool,
    artifact: &ConsumableArtifact,
    path: &str,
) -> Result<Vec<u8>, (StatusCode, AppError)> {
    // ITEM-5 — a per-column sparse read forks BEFORE the flat/split resolver: a column of a virtual
    // `sparse_csc` dataset is a masked CSC slice (`indptr[C..C+2]` → filter + rank), served as the
    // sparse wire the viz decodes exactly as a real column, never a dense chunk. `O(nnz in the
    // column)`, one column per request (INV-22/24/25).
    if let Some(col) = parse_sparse_member(path) {
        let store = super::get_object_store();
        return super::gather_exec::resolve_masked_sparse_column(
            pool,
            store.as_ref(),
            artifact.id,
            &artifact.structure,
            col,
        )
        .await
        .map_err(|e| e.to_api_error());
    }
    // Resolved rather than built from `structure` alone, even for `zarr.json`: a fused
    // categorical's LEVELS live on the alignment's group attributes, so the declaration
    // cannot be complete without reading it. Serving the cheap version would hand the client
    // a column of integers with no vocabulary — numbers where labels belong.
    //
    // ONE implementation, shared with stage-time materialisation (ITEM-31): the staging path
    // calls this same `resolve` and the same `member` — deliberately, because two gathers
    // that agree today are two gathers that will disagree later with nothing to say so, and
    // the browser and a processor disagreeing about one column's values is the worst
    // available shape of that.
    let store = super::get_object_store();
    // **`resolve_shared`, not `resolve`.** The metadata walk (which verifies every leaf digest
    // and discovers a deleted source) still runs on every request; only the byte fetch and
    // decode are served from the process cache. Measured before this landed: a whole-column
    // scan of a 500k-row gathered column read 123x the bytes one pass needs, because every
    // chunk request re-ran the entire resolution (`tests/workstore/gather_scale_test.rs`).
    let resolved = super::gather_exec::resolve_shared(
        pool,
        store.as_ref(),
        artifact.id,
        &artifact.structure,
        super::gathered_resolution_cache(),
    )
    .await
    .map_err(|e| e.to_api_error())?;

    match resolved.member(path).map_err(|e| e.to_api_error())? {
        Some(bytes) => Ok(bytes),
        None => {
            // The member list is one entry per CHUNK, so it is truncated: a refusal that
            // pastes ten thousand keys is unreadable, and the first few plus the count say
            // the same thing.
            let all = resolved.member_paths();
            let shown: Vec<&String> = all.iter().take(6).collect();
            Err(AppError::not_found(&format!(
                "a gathered artifact serves {} member(s) — {shown:?}{}; {path:?} is none of \
                 them. A stored artifact answers 404 for a member it does not have, and \
                 serving an empty 200 here would decode as no data rather than as an error",
                all.len(),
                if all.len() > shown.len() { ", …" } else { "" },
            ))
            .to_api_error())
        }
    }
}

/// **ITEM-21 — the chain walk now lives in `gather_exec::plan_chain`.**
///
/// This is where `resolve_gathered_chain` stood: a walk built on the SINGLE-SOURCE recipe
/// (`{source_artifact_id, row_vector_artifact_id}`), left refusing by name
/// (`CHAIN_RESOLUTION_UNPORTED`) after the recipe became a segment model over N datasets, and
/// never called from anywhere. Its shape no longer matched the thing it walked: a row now
/// resolves to `(source, row within that source)`, so composing two levels yields a map into
/// a UNION of leaves rather than one `Vec<u32>` into one, and the per-source LEVEL LOOKUPS
/// would have had to compose too.
///
/// The port is [`super::gather_exec::plan_chain`] plus the bottom-up pass in
/// [`super::gather_exec::resolve`]. `gathered::compose_rows` and the depth/cycle bounds it was
/// written against survive; what did not survive is the assumption that a chain collapses to
/// one vector into one leaf.
/// Whole bytes of one member of a STORED artifact, by artifact id.
///
/// Deliberately NOT authz-gated a second time: the caller already passed
/// `load_readable_artifact` for the GATHERED artifact, and a gathered artifact's sources are
/// part of its definition rather than separately-addressable user input. (When the alignment
/// producer lands, the sources are named by an alignment the same user's analysis created.)
pub(crate) async fn read_member_bytes(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    artifact_id: Uuid,
    member: &str,
) -> Result<Vec<u8>, AppError> {
    let repo = CatalogRepository::new(pool.clone());
    let a = repo.get_any_status(artifact_id).await?.ok_or_else(|| {
        AppError::not_found(&format!(
            "gathered artifact references {artifact_id}, which does not exist — a source \
                 or row vector was deleted out from under it"
        ))
    })?;
    let key_str = a.object_key.as_deref().ok_or_else(|| {
        // Chained resolution IS implemented (ITEM-21) — and it does not come through here.
        // `gather_exec::plan_chain` identifies a gathered source by this very field and
        // resolves it bottom-up, so a gathered artifact reaching this function means some
        // caller asked for the BYTES of a row that has none. That is a bug in the caller,
        // not a missing capability, and saying so is what keeps this from being read as the
        // old wall.
        AppError::internal_error(format!(
            "artifact {artifact_id} has no object_key — it is itself gathered, and a \
             gathered row has no bytes to read. A chained source is resolved by \
             `gather_exec::plan_chain`, which never reaches this function; a caller that \
             does has skipped the chain walk"
        ))
    })?;
    let base = ContentKey::parse(key_str);
    let key = if a.is_multifile {
        store.resolve_member(&base, member).await?
    } else {
        base
    };
    store.get(&key).await
}

/// Serve bytes we produced in memory, honouring the same range semantics as a stored blob.
fn serve_inline_bytes(
    bytes: Vec<u8>,
    range_param: Option<&str>,
    range_header: Option<&str>,
) -> Result<Response, (StatusCode, AppError)> {
    if range_param.is_some() && range_header.is_some() {
        return Err(AppError::bad_request(
            "RANGE_CONFLICT",
            "pass a range in the query OR the Range header, not both",
        )
        .to_api_error());
    }
    // ── AUDIT FINDING 9 — THE RANGE WAS PARSED AND THEN IGNORED ────────────────────
    //
    // This function used the two range inputs only to reject the conflict case and then
    // returned the WHOLE body with a 200. The stored path honours a range and answers 206
    // with a `Content-Range`. So a client issuing the same ranged read against a gathered
    // artifact and a stored one got observably different answers — which is INV-3, the
    // design's central claim, failing on the one axis the claim is about.
    //
    // The range is now honoured through `super::range`'s OWN parsers — the same
    // `parse_range_param` / `parse_range` the stored path uses, rather than a second
    // implementation of the same semantics that would agree today and drift later.
    let total = bytes.len() as u64;
    let slice = |off: u64, len: u64| bytes[off as usize..(off + len) as usize].to_vec();

    // The SAME shapes the stored path answers with, taken from the same parsers:
    //   `?range=`  → 200 with a sliced body (txresbench's own read path)
    //   `Range:`   → 206 + `Content-Range` (a generic HTTP client)
    // Matching them is the whole point — a different status for the same request is exactly
    // the observable difference INV-3 forbids.
    let (body, status, content_range) = if let Some(spec) = range_param {
        match parse_range_param(spec, total) {
            Ok(span) => (slice(span.offset, span.length), StatusCode::OK, None),
            Err(RangeParamError::Unsatisfiable) => return Ok(unsatisfiable(total)),
            Err(RangeParamError::Malformed) => {
                return Err(AppError::bad_request(
                    "INVALID_RANGE",
                    "`range` must be `<a>-<b>`, `<a>-` or `-<n>` with decimal byte offsets",
                )
                .to_api_error())
            }
        }
    } else {
        match parse_range(range_header, total) {
            RangeOutcome::Full => (bytes, StatusCode::OK, None),
            outcome @ RangeOutcome::Satisfiable { .. } => {
                let (offset, len) = outcome.offset_len().expect("satisfiable");
                let cr = outcome.content_range(total).expect("satisfiable");
                (slice(offset, len), StatusCode::PARTIAL_CONTENT, Some(cr))
            }
            RangeOutcome::Unsatisfiable => return Ok(unsatisfiable(total)),
        }
    };

    // `immutable` is valid here for the same reason it is on a stored blob: a gathered
    // artifact's `content_hash` is over its DEFINITION (alignment + sources + selector), so
    // the same URL always produces the same bytes.
    let mut resp = (status, body).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    resp.headers_mut().insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    if let Some(cr) = content_range {
        if let Ok(v) = header::HeaderValue::from_str(&cr) {
            resp.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    Ok(resp)
}

async fn serve_data_inner(
    pool: &SqlitePool,
    id: Uuid,
    user_id: Uuid,
    headers: &HeaderMap,
    range: &DataRangeQuery,
    member: Option<String>,
) -> Result<Response, (StatusCode, AppError)> {
    let artifact = load_readable_artifact(pool, id, user_id).await?;
    let store = super::get_object_store();
    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    // ITEM-17/19 — a GATHERED artifact forks HERE and nowhere above (INV-3). Everything
    // higher up — the route, the authz gate, the client's ZarrStore — is untouched, which is
    // the whole design: virtuality is a serve-time concept and only the server knows.
    if artifact.is_gathered() {
        let path = member.ok_or_else(|| {
            AppError::bad_request(
                "MEMBER_REQUIRED",
                "a gathered artifact is a zarr store; request `zarr.json` or a chunk key",
            )
            .to_api_error()
        })?;
        let bytes = serve_gathered_member(pool, &artifact, &path).await?;
        return serve_inline_bytes(bytes, range.range.as_deref(), range_header.as_deref());
    }

    let key = match member {
        Some(path) => {
            if !artifact.is_multifile {
                return Err(
                    AppError::bad_request("NOT_MULTIFILE", "this artifact has no members")
                        .to_api_error(),
                );
            }
            // ITEM-16: a gathered artifact forks HERE — this is the one place the
            // branch belongs (INV-3), and until ITEM-17/19 land the fork is a refusal
            // rather than a guess.
            store
                .resolve_member(
                    &ContentKey::parse(
                        artifact
                            .stored_key("ITEM-17/19 (the synthetic zarr store + chunk gather)")?,
                    ),
                    &path,
                )
                .await
                .map_err(|e| e.to_api_error())?
        }
        None => {
            if artifact.is_multifile {
                return Err(AppError::bad_request(
                    "MEMBER_REQUIRED",
                    "this is a multi-file artifact; request a member path",
                )
                .to_api_error());
            }
            ContentKey::parse(
                artifact.stored_key("ITEM-17/19 (the synthetic zarr store + chunk gather)")?,
            )
        }
    };
    serve_bytes(
        store.as_ref(),
        &key,
        range.range.as_deref(),
        range_header.as_deref(),
    )
    .await
}

// ───────────────── debug-only seed route (the e2e fixture surface) ─────────────────
//
// ONE `#[cfg(debug_assertions)]` route (compiled OUT of release builds; NOT aide-documented,
// so it never touches the OpenAPI spec / `types.ts` parity gate) that materializes catalog
// rows DIRECTLY — no compute run, no sandbox — for the Playwright e2e suite. Gated by the
// real `projects::use` permission + a project-edit check (identical posture to every mutating
// workstore handler).
//
// It is a GENERIC ENGINE and holds NO fixture vocabulary: every type id, output id, column
// name, storage layout and payload value is supplied by the CALLER in the request `plan`, so
// a fixture's subject-matter lives in the e2e DATA that drives it (`ui/tests/e2e/**/_seed.ts`)
// and never in the server binary. Adding a fixture for a new subject area is a test-side
// edit; this engine does not change. It replaced six hand-written, subject-specific seed
// routes whose payloads (column names, marker-symbol lists, type ids) were compiled into the
// crate.
//
// The request is `multipart/form-data` with two parts:
//   `plan`  — the JSON `SeedPlan` below (required).
//   `input` — raw fixture bytes (optional): what an `{"encoding":"input"}` content resolves
//             to, and what an embedded `driver` script is run over.
//
// A plan may, in order: create a `datasets` row + project link (`dataset`); run one embedded
// driver script over `input` (`driver`); insert artifacts whose bytes are inline JSON /
// little-endian numeric arrays / a multi-member blob / the posted `input` / a file the driver
// wrote (`artifacts`); and insert manifest-DERIVED artifact SETS (`manifest_files` /
// `manifest_items`) whose ids and type ids come from the driver's own manifest — i.e. from
// DATA, not from this file.

/// The staged name of a driver's OWN entry script — the file `python3` is pointed at.
#[cfg(debug_assertions)]
const SEED_DRIVER_ENTRY: &str = "driver.py";

/// One embedded Python driver: the seed's OWN entry script, plus the processor `/code`
/// dir it runs against — **DERIVED, never listed**.
///
/// ## Why there is no file list here any more
/// This used to carry a hand-written `include_str!` list of "the sibling modules the entry
/// imports". A hand list mirrors something, and it falls one ring behind the thing it
/// mirrors: the importer entry named below began `import txr_columns` (and `txr_csc`) at
/// commit `2751dac5` and this table never learned, so the `single-file-import` driver died with
/// `ModuleNotFoundError: No module named 'txr_columns'`. It stayed invisible because its
/// only caller was skipping for an unrelated reason. Adding four more `include_str!` lines
/// reproduces the defect the next time a compute gains a sibling.
///
/// ## What replaced it
/// A driver names ONE processor entry (`code_ref` + its owning `package`) and the staged set
/// is resolved through [`crate::modules::sandbox::processors::resolve_with_package`] — the
/// SAME call [`crate::modules::sandbox::spec::AnalysisSpec::resolve_entry`] makes for a real
/// run. That returns the entry bytes plus `ResolvedProcessor::helpers`: the entry's DECLARED
/// package siblings (its manifest `run.helpers`, S6) and the app's globally-staged
/// `PY_HELPER_FILES`. So the seeder and the runner stage from ONE mechanism instead of
/// agreeing by luck, and a compute that gains a sibling import needs **no edit here** — the
/// only thing that has to learn about it is the manifest / `PY_HELPER_FILES` the runner
/// already reads. `processors::every_shipped_helper_import_is_declared_or_globally_staged`
/// is the unit test that fails when a shipped entry imports something neither declares.
///
/// Two consequences worth stating rather than smuggling:
/// * The bytes are read from the EXTRACTED processors folder at request time, not baked in
///   at build time — the same INV-7 property a real run has (an on-disk processor edit is
///   reflected with no rebuild), and the reason this is not an `include_str!` any more.
/// * The staged set is a compute's whole `/code` dir, entry included, even for a driver
///   that only imports one sibling out of it (`modality-split`). That is deliberate: it is
///   the import environment the package's code was WRITTEN against, and it is a single
///   compute's declared dir — not "the tree, to be safe". The alternative is a per-driver
///   "which of these do I want" knob, which is the hand list again.
#[cfg(debug_assertions)]
struct SeedDriverFiles {
    /// The caller-facing id (a plan's `driver` field).
    id: &'static str,
    /// The driver's OWN entry script — server-owned TEST code (it post-processes a real
    /// converter's outputs into the byte forms the FE reads), so it is embedded here rather
    /// than resolved. Staged as [`SEED_DRIVER_ENTRY`].
    entry: &'static str,
    /// The processor entry whose `/code` dir this driver runs against. Its BASENAME is the
    /// staged name, because a module's import name is part of its own ABI — the driver
    /// spawns / imports it under exactly that name.
    code_ref: &'static str,
    /// The package that owns `code_ref`, passed as the resolver's authoritative hint so two
    /// packages shipping the same entry path can never substitute for each other (M3).
    package: &'static str,
}

#[cfg(debug_assertions)]
const SEED_DRIVERS: &[SeedDriverFiles] = &[
    SeedDriverFiles {
        id: "modality-split",
        entry: include_str!("seed_multimodal.py"),
        // Imports `multimodal`, this entry's DECLARED sibling — so it needs that entry's
        // code dir, and it gets exactly the code dir a real run of that converter gets.
        code_ref: "compute/h5ad_import.py",
        package: "anndata-import",
    },
    SeedDriverFiles {
        id: "single-file-import",
        entry: include_str!("seed_anndata_import.py"),
        // Spawns this entry as a subprocess — the REAL production converter.
        code_ref: "compute/h5ad_import.py",
        package: "anndata-import",
    },
];

/// Which row scope a seeded artifact is attached to — the three shapes the catalog supports.
#[cfg(debug_assertions)]
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedScope {
    /// `project_id` set, `dataset_id` NULL.
    #[default]
    Project,
    /// `dataset_id` set, `project_id` NULL (an imported file IS its own dataset — ITEM-23).
    Dataset,
    /// Both set.
    Both,
}

/// The bytes of one seeded blob. Every variant is a caller-supplied payload; the engine only
/// FRAMES it (little-endian for the numeric variants — exactly the wire framing the FE
/// typed-array readers expect) and never authors content.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "encoding", rename_all = "snake_case")]
pub enum SeedBytes {
    /// Serialized verbatim as JSON.
    Json { value: serde_json::Value },
    /// Dense little-endian `f32`.
    F32 { values: Vec<f32> },
    /// Dense little-endian `u32`.
    U32 { values: Vec<u32> },
    /// Dense little-endian `i64`.
    I64 { values: Vec<i64> },
    /// The request's `input` part, verbatim (how a caller catalogs a real binary fixture).
    Input,
    /// A file the `driver` wrote into its output directory.
    DriverFile { file: String },
    /// A multi-member (`put_prefix`) blob; each member is framed by its own encoding.
    Members { members: Vec<SeedMember> },
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedMember {
    /// The member path inside the multi-file blob.
    pub name: String,
    #[serde(flatten)]
    pub bytes: SeedBytes,
}

/// A `datasets` row to create + link to the project before any artifact is inserted.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedDatasetSpec {
    pub name: String,
    pub datatype: String,
}

/// One artifact to insert. Everything about it — including its `datatype` — is caller data.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedArtifactSpec {
    pub output_id: String,
    pub datatype: String,
    #[serde(default)]
    pub scope: SeedScope,
    /// Producer-declared decode contract for the seeded bytes (ITEM-5). Omitted ⇒
    /// `{"encoding":"opaque"}`. A fixture seeding a Zarr member tree or a CSC trio
    /// declares it here so the client reader can decode what was seeded.
    ///
    /// May embed `{"$manifest": "<key>"}` nodes, resolved against the driver's manifest
    /// so a declaration can carry numbers only the driver knows (e.g. a row count).
    #[serde(default)]
    pub structure: Option<serde_json::Value>,
    /// Producer-declared display meaning for the seeded bytes (ITEM-6). Omitted ⇒
    /// `{"origin":"seed"}`. Same `{"$manifest": …}` resolution as `structure`.
    ///
    /// This is the successor to the plan's former free-form `params` bag: ITEM-7
    /// dropped that column, and `meta` is where a producer — including a fixture
    /// standing in for one — says what its bytes mean.
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
    /// The row's `status`. Omitted ⇒ `ready`, which is what every seeded artifact used to
    /// be with no way to say otherwise.
    ///
    /// **Why this exists (ITEM-30).** `unresolvable` — a gathered artifact whose alignment
    /// can no longer be resolved — had unit coverage and NO end-to-end path: nothing could
    /// put a row into that state, so the surface rendering it could not be exercised
    /// against a real server. The alternative was route-mocking, which this repo forbids
    /// for exactly the reason it would have been wrong here: it proves the component
    /// renders a shape, not that the server ever produces it.
    ///
    /// Deliberately a free string rather than an enum, matching the column: the vocabulary
    /// is enforced in Rust at the CONSUMPTION boundary (`ConsumableArtifact::try_new`), and
    /// a fixture that seeds an unknown status should exercise that refusal rather than be
    /// blocked here from expressing it.
    #[serde(default)]
    pub status: Option<String>,
    pub content: SeedBytes,
}

/// Catalog ONE artifact per entry of a driver-manifest `{ id: file-name }` MAP: the key
/// becomes the `output_id`, the value names the driver-written file holding the bytes.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedManifestFiles {
    /// Manifest key holding the map.
    pub manifest_key: String,
    pub datatype: String,
    #[serde(default)]
    pub scope: SeedScope,
    /// Manifest key holding a SECOND map, `{ output_id → structure }` — the per-artifact
    /// decode contract (ITEM-5), keyed by the SAME `output_id` as `manifest_key`.
    ///
    /// ## Why a manifest KEY and not a plan-authored template
    ///
    /// This set's SIZE and its ids are the driver's data, so a plan cannot spell one
    /// `structure` per member: it does not know how many there are or what they are called
    /// until the driver has run. A single shared template cannot serve either — the whole
    /// point of a per-entity declaration is that it names the entity (`columns[].name`).
    /// So the declaration travels the same way the ids and the file names do: as driver
    /// DATA, resolved here.
    ///
    /// ## Why it matters that it can be declared at all
    ///
    /// Omitting it leaves the set `{"encoding":"opaque"}`, which is a truthful declaration
    /// for a blob whose shape the plan really does not know — but it is NOT a truthful one
    /// for a set of per-entity COLUMNS. An opaque artifact declares no axis and no members,
    /// and every axis-scoped resolver in the workbench (`axisSource.ts::siblingsOnAxis` →
    /// `axisColumnRows`) selects on exactly those two declarations. A seed that catalogs
    /// real per-entity columns without them produces a dataset whose axis carries nothing:
    /// the criteria builder offers no column, every `$data` slice reading the axis resolves
    /// empty, and the surface renders "No data yet" with nothing failing anywhere. That is
    /// the shape a REAL import does not have — `txr_columns.write_metadata_column` writes
    /// `structure.axis` + `structure.columns` on every column it emits — so without this
    /// key the seed cannot stand in for the producer it is imitating.
    ///
    /// FAIL-CLOSED: naming a key that is not a map, or one whose map is missing an entry
    /// for an `output_id` in this set, is a REFUSED plan — never a silent fall back to
    /// `opaque`, which is the exact failure this key exists to make impossible.
    #[serde(default)]
    pub structure_key: Option<String>,
    /// Manifest key holding `{ output_id → meta }` — the per-artifact DISPLAY declaration
    /// (ITEM-6), keyed like `structure_key`. Same fail-closed lookup. It is what gives each
    /// member a producer NAME (`meta.name`), which is what an artifact-ref picker labels its
    /// options with (`axisSource.ts::candidateLabel`); without it a set of N real columns
    /// offers N options that all read as the same string.
    #[serde(default)]
    pub meta_key: Option<String>,
}

/// Catalog ONE artifact per entry of a driver-manifest LIST of objects. The entry's own
/// fields supply the id fragment and the type id (so BOTH come from the driver's DATA), and
/// the entry serialized is the artifact's opaque provenance payload.
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedManifestItems {
    /// Manifest key holding the list.
    pub manifest_key: String,
    /// Field of each item whose value is appended to `output_id_prefix`.
    pub name_field: String,
    /// Field of each item whose value is the artifact's `datatype`.
    pub datatype_field: String,
    #[serde(default)]
    pub output_id_prefix: String,
    #[serde(default)]
    pub scope: SeedScope,
}

/// A producing RUN for a seeded plan — the fixture's way of saying "this artifact came
/// from this analysis".
#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedRunSpec {
    /// The ANALYSIS id this run records — what `ListedArtifact::generator_id` reports, and
    /// what a `contributes.analyses[].id` matches. A blank one is refused rather than
    /// stored: `provenance_run_repro.generator_id` defaults to `''`, and the derive path
    /// reads blank as "not attributable", so a fixture seeding one would silently express
    /// the very absence it was trying to fill.
    pub generator_id: String,
    /// The run's terminal status. Omitted ⇒ `completed`.
    #[serde(default)]
    pub status: Option<String>,
}

#[cfg(debug_assertions)]
#[derive(Debug, Clone, Deserialize)]
pub struct SeedPlan {
    #[serde(default)]
    pub dataset: Option<SeedDatasetSpec>,
    /// Record a producing RUN, and stamp every artifact of this plan with its `run_id`.
    ///
    /// **Why the run and not a `generator_id` field on the artifact.** `generator_id` is
    /// DERIVED — a join from `artifacts.run_id` to `provenance_run_repro.generator_id`
    /// (`attach_derived_provenance`) — so an artifact-level field could only be honoured by
    /// writing a provenance row that no real run wrote, or by adding a column that
    /// contradicts the join. Expressing the RUN is the shape a real producer actually has:
    /// one run node, one `generator_id`, every output of that run pointing at it.
    ///
    /// **Why it exists (the same reason `status` does).** The `job.result` resolver narrows
    /// by producer, and the seed path set `run_id: None` unconditionally — so a slice that
    /// narrows correctly matched nothing and resolved empty before reaching a read. That
    /// narrowing closes a real shadowing defect and must not be dropped, which left the
    /// resolver's contract testable only at unit level. **A seed that cannot express a
    /// state means the state has no end-to-end test.**
    ///
    /// The run is inserted through `ProvenanceRepository::insert_run_in_tx`, i.e. the same
    /// statement a real run uses, INSIDE the plan's transaction — so a refused plan leaves
    /// no orphan run node, and a fixture cannot mint a row shape production never writes.
    #[serde(default)]
    pub run: Option<SeedRunSpec>,
    /// Run this embedded driver (see `SEED_DRIVERS`) over `input` before cataloging.
    #[serde(default)]
    pub driver: Option<String>,
    #[serde(default)]
    pub artifacts: Vec<SeedArtifactSpec>,
    #[serde(default)]
    pub manifest_files: Vec<SeedManifestFiles>,
    #[serde(default)]
    pub manifest_items: Vec<SeedManifestItems>,
    /// TEST SEAM. Abort the plan AFTER every blob has been stored and every row inserted,
    /// but BEFORE the commit — the only way to reach a phase-2/3 fault from a request.
    ///
    /// Every fault a plan can otherwise provoke is caller-data and is caught during the
    /// pure resolution phase, before the first write; the transaction and the compensating
    /// blob free exist for the faults that are NOT plan-reachable (a DB error, a full
    /// disk). Without this seam those two guarantees would be untestable, and an
    /// "everything rolled back" assertion would only ever be observing "nothing was
    /// written in the first place". It rides on a route that is already compiled OUT of
    /// release builds in its entirety, so it adds no production surface.
    #[serde(default)]
    pub _debug_fail_after_write: bool,
}

#[cfg(debug_assertions)]
#[derive(Debug, Serialize)]
pub struct SeededArtifact {
    pub output_id: String,
    pub datatype: String,
    pub id: Uuid,
}

#[cfg(debug_assertions)]
#[derive(Debug, Serialize)]
pub struct SeedResponse {
    pub dataset_id: Option<Uuid>,
    /// In plan order: `artifacts`, then `manifest_items`, then `manifest_files`.
    pub artifacts: Vec<SeededArtifact>,
    /// The driver's `manifest.json` verbatim (`null` when no driver ran). The caller reads
    /// whatever fields the driver declared out of DATA, not out of a typed Rust struct.
    pub manifest: serde_json::Value,
}

/// Removes its directory on every exit path (success / error / early return) — CODING
/// GUIDELINES §5 prefers a RAII guard over per-branch cleanup.
#[cfg(debug_assertions)]
struct SeedScratch(std::path::PathBuf);

#[cfg(debug_assertions)]
impl Drop for SeedScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(debug_assertions)]
fn seed_bad_request(code: &str, msg: impl Into<String>) -> (StatusCode, AppError) {
    (StatusCode::BAD_REQUEST, AppError::bad_request(code, msg))
}

#[cfg(debug_assertions)]
fn seed_internal(msg: impl Into<String>) -> (StatusCode, AppError) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        AppError::internal_error(msg),
    )
}

/// The manifest keys a plan may reference, for the error message when it references one that
/// is not there. `(no driver ran)` when the plan declared no `driver` at all — the common
/// cause of an unresolvable reference.
#[cfg(debug_assertions)]
fn manifest_key_hint(manifest: &serde_json::Value) -> String {
    match manifest.as_object() {
        Some(map) if !map.is_empty() => map.keys().cloned().collect::<Vec<_>>().join(", "),
        Some(_) => "(the driver manifest is empty)".to_string(),
        None => "(no driver ran, so there is no manifest)".to_string(),
    }
}

/// Resolve `{"$manifest": "<key>"}` nodes against the driver manifest, recursively. Any other
/// node passes through untouched.
///
/// Fails CLOSED: an unresolvable key is a 400 naming the key and listing the ones the manifest
/// does carry. It used to resolve to `null`, so a typo silently produced `shape: null` — the
/// sibling `manifest_key` lookups in `seed_inner` have always errored loudly on a missing key,
/// and this now matches them (CODING GUIDELINES §6: never silently swallow).
#[cfg(debug_assertions)]
fn resolve_manifest_refs(
    value: &serde_json::Value,
    manifest: &serde_json::Value,
) -> Result<serde_json::Value, (StatusCode, AppError)> {
    match value {
        serde_json::Value::Object(map) => {
            if map.len() == 1 {
                if let Some(serde_json::Value::String(key)) = map.get("$manifest") {
                    return manifest.get(key).cloned().ok_or_else(|| {
                        seed_bad_request(
                            "SEED_UNKNOWN_MANIFEST_KEY",
                            format!(
                                "plan references `{{\"$manifest\": \"{key}\"}}` but the driver \
                                 manifest has no key `{key}`; available: {}",
                                manifest_key_hint(manifest)
                            ),
                        )
                    });
                }
            }
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), resolve_manifest_refs(v, manifest)?);
            }
            Ok(serde_json::Value::Object(out))
        }
        serde_json::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for v in items {
                out.push(resolve_manifest_refs(v, manifest)?);
            }
            Ok(serde_json::Value::Array(out))
        }
        other => Ok(other.clone()),
    }
}

/// One per-entry producer declaration for a manifest-derived artifact set: `manifest[key]`
/// is a `{ output_id → declaration }` MAP and this reads the entry for `output_id`.
///
/// `None` in ⇒ `None` out (the set declared nothing, which stays the `opaque` default). A key
/// that IS named is resolved strictly: not-a-map and missing-entry are both refusals, because
/// the alternative — falling back to `opaque` — is indistinguishable from never having asked,
/// and an artifact silently declaring no axis is precisely the failure that motivated the key
/// (see [`SeedManifestFiles::structure_key`]). `{"$manifest": …}` nodes resolve inside the
/// declaration exactly as they do for the explicit `artifacts` list, so the two paths cannot
/// interpret a driver's manifest differently.
#[cfg(debug_assertions)]
fn manifest_declaration(
    manifest: &serde_json::Value,
    key: Option<&String>,
    output_id: &str,
    what: &str,
) -> Result<Option<serde_json::Value>, (StatusCode, AppError)> {
    let Some(key) = key else { return Ok(None) };
    let map = manifest
        .get(key.as_str())
        .and_then(|v| v.as_object())
        .ok_or_else(|| {
            seed_bad_request(
                "SEED_MANIFEST_KEY",
                format!(
                    "driver manifest has no MAP at `{key}` (the per-artifact {what} \
                     declarations this set asked for)"
                ),
            )
        })?;
    let declared = map.get(output_id).ok_or_else(|| {
        seed_bad_request(
            "SEED_MANIFEST_FIELD",
            format!(
                "driver manifest `{key}` carries no {what} for `{output_id}` — a set that \
                 asks for per-artifact declarations must carry one for every member, since \
                 the alternative is an artifact that declares nothing"
            ),
        )
    })?;
    Ok(Some(resolve_manifest_refs(declared, manifest)?))
}

/// Whether a caller-supplied driver-output file NAME stays inside the driver's own output
/// directory: a non-empty plain file name — no path separator, no `..` segment, no drive
/// prefix. Pure, so the confinement rule is directly unit-testable.
#[cfg(debug_assertions)]
fn is_confined_driver_file(file: &str) -> bool {
    !file.is_empty()
        && !file.contains('/')
        && !file.contains('\\')
        && !file.contains("..")
        && !file.contains(':')
}

/// Read one driver-written file. The name is caller data, so it is confined to a plain file
/// name inside the driver's own output directory.
///
/// The confinement check runs FIRST, unconditionally: a traversing name is rejected on its own
/// merits whether or not a driver ran, so it can never be reported as merely "no driver".
#[cfg(debug_assertions)]
fn read_driver_file(
    out_dir: Option<&std::path::Path>,
    file: &str,
) -> Result<Vec<u8>, (StatusCode, AppError)> {
    if !is_confined_driver_file(file) {
        return Err(seed_bad_request(
            "SEED_BAD_DRIVER_FILE",
            format!(
                "driver file `{file}` must be a plain file name inside the driver output directory"
            ),
        ));
    }
    let out_dir = out_dir.ok_or_else(|| {
        seed_bad_request(
            "SEED_NO_DRIVER",
            format!("content references driver file `{file}` but the plan declared no `driver`"),
        )
    })?;
    std::fs::read(out_dir.join(file))
        .map_err(|e| seed_internal(format!("seed: read driver output `{file}`: {e}")))
}

#[cfg(debug_assertions)]
enum SeedBlob {
    Single(Vec<u8>),
    Multi(Vec<(String, Vec<u8>)>),
}

#[cfg(debug_assertions)]
fn render_seed_bytes(
    content: &SeedBytes,
    input: &[u8],
    out_dir: Option<&std::path::Path>,
) -> Result<SeedBlob, (StatusCode, AppError)> {
    let single = |bytes: Vec<u8>| Ok(SeedBlob::Single(bytes));
    match content {
        // A caller-supplied JSON value; a fixed in-memory tree, so a serialize failure is a
        // genuine internal fault rather than a silently-empty blob (CODING GUIDELINES §6).
        SeedBytes::Json { value } => single(
            serde_json::to_vec(value)
                .map_err(|e| seed_internal(format!("seed: serialize content: {e}")))?,
        ),
        SeedBytes::F32 { values } => single(values.iter().flat_map(|v| v.to_le_bytes()).collect()),
        SeedBytes::U32 { values } => single(values.iter().flat_map(|v| v.to_le_bytes()).collect()),
        SeedBytes::I64 { values } => single(values.iter().flat_map(|v| v.to_le_bytes()).collect()),
        SeedBytes::Input => {
            if input.is_empty() {
                return Err(seed_bad_request(
                    "SEED_NO_INPUT",
                    "content asks for the `input` part but the request carried none (or it was empty)",
                ));
            }
            single(input.to_vec())
        }
        SeedBytes::DriverFile { file } => single(read_driver_file(out_dir, file)?),
        SeedBytes::Members { members } => {
            let mut rendered = Vec::with_capacity(members.len());
            for member in members {
                match render_seed_bytes(&member.bytes, input, out_dir)? {
                    SeedBlob::Single(bytes) => rendered.push((member.name.clone(), bytes)),
                    SeedBlob::Multi(_) => {
                        return Err(seed_bad_request(
                            "SEED_NESTED_MEMBERS",
                            format!(
                                "member `{}` cannot itself be a multi-member blob",
                                member.name
                            ),
                        ))
                    }
                }
            }
            Ok(SeedBlob::Multi(rendered))
        }
    }
}

/// One artifact the plan resolved to: fully RENDERED (bytes in memory, every
/// caller-data guard already passed) but not yet stored or inserted. Building the whole
/// `Vec<PendingSeed>` before the first side effect is what makes a refused plan a no-op —
/// the same "resolve everything, then write" shape `ingest::ingest_run_outputs` uses.
#[cfg(debug_assertions)]
struct PendingSeed {
    output_id: String,
    datatype: String,
    scope: SeedScope,
    // ITEM-30 — the DECLARED row status. `None` ⇒ `ready`, the only status a seed could
    // previously produce. Carried through so a fixture can put a row into `unresolvable`
    // and exercise the surface that renders it against a real server, rather than
    // route-mocking a shape the server might never emit.
    status: Option<String>,
    // The DECLARED decode contract for the seeded bytes (artifact-model ITEM-5). The
    // plan supplies it because the plan supplies the bytes: a fixture framing a Zarr
    // column or a CSC trio has to be able to SAY so, or the client reader — which
    // dispatches on exactly this (ITEM-25) — cannot read what the e2e seeded. `None` ⇒
    // opaque, which is the truthful declaration for a fixture that is just a JSON/f32 blob.
    structure: Option<serde_json::Value>,
    // The DECLARED meaning (ITEM-6) — the successor to the plan's former free-form
    // `params` bag, which ITEM-7 dropped. `None` ⇒ `{"origin":"seed"}`.
    meta: Option<serde_json::Value>,
    blob: SeedBlob,
}

/// The scope guard, hoisted out of the insert so it runs during plan RESOLUTION (before
/// any write) rather than mid-loop. `has_dataset` is `plan.dataset.is_some()` — the same
/// predicate as "the dataset row was created", since the row is created iff the plan
/// declares one.
#[cfg(debug_assertions)]
fn validate_seed_scope(
    scope: SeedScope,
    has_dataset: bool,
    output_id: &str,
) -> Result<(), (StatusCode, AppError)> {
    if matches!(scope, SeedScope::Dataset | SeedScope::Both) && !has_dataset {
        return Err(seed_bad_request(
            "SEED_NO_DATASET",
            format!("artifact `{output_id}` asks for a dataset scope but the plan declared no `dataset`"),
        ));
    }
    Ok(())
}

/// Store one pending artifact's bytes, recording EVERY blob key the write touched into
/// `wrote` so an abort can compensate-free them. A multi-file put touches its member
/// blobs AND the manifest blob — all of them are recorded, or a rolled-back multi-file
/// seed would leak its members.
#[cfg(debug_assertions)]
async fn store_seed_blob(
    store: &dyn ObjectStore,
    blob: &SeedBlob,
    wrote: &mut Vec<String>,
) -> Result<(String, i64, bool), (StatusCode, AppError)> {
    match blob {
        SeedBlob::Single(bytes) => {
            let size = bytes.len() as i64;
            let key = store.put(bytes).await.map_err(|e| e.to_api_error())?;
            wrote.push(key.as_str().to_string());
            Ok((key.as_str().to_string(), size, false))
        }
        SeedBlob::Multi(members) => {
            let size = members.iter().map(|(_, b)| b.len() as i64).sum();
            let put = store
                .put_prefix(members)
                .await
                .map_err(|e| e.to_api_error())?;
            wrote.push(put.object_key.as_str().to_string());
            for m in &put.members {
                wrote.push(m.blob.as_str().to_string());
            }
            Ok((put.object_key.as_str().to_string(), size, true))
        }
    }
}

/// Compensate-free the blobs an ABORTED seed wrote, through the SAME refcount-gated
/// sweep the project-delete chokepoint uses (`gc::GcSweeper::sweep_marked`): a marked
/// hash is freed only when NO live artifact row references it. That gate is what makes
/// this safe under content-addressed dedup — if the aborted plan happened to write bytes
/// an existing artifact already stores, the shared blob is KEPT rather than deleted out
/// from under it. Best-effort: a failure here leaves an orphan the standing GC sweep
/// reclaims, and must not mask the seed's own error.
#[cfg(debug_assertions)]
async fn rollback_seed_blobs(
    pool: &SqlitePool,
    store: std::sync::Arc<dyn ObjectStore>,
    wrote: &[String],
) {
    if wrote.is_empty() {
        return;
    }
    let mut manifest = crate::modules::project::GcManifest::default();
    for hash in wrote {
        manifest.mark(hash.clone(), "catalog");
    }
    // No boot-installed ownership claim ⇒ nothing here is attributable to this
    // catalog ⇒ free nothing; the standing sweep reclaims the orphans later.
    let Some(claim) = super::try_get_store_claim() else {
        tracing::warn!(
            marked = wrote.len(),
            "seed: aborted plan left orphan blobs; no store ownership claim is installed, so \
             nothing is compensate-freed here"
        );
        return;
    };
    let sweeper = super::gc::GcSweeper::new(pool.clone(), store, claim);
    match sweeper.sweep_marked(&manifest).await {
        Ok(report) => tracing::debug!(
            marked = wrote.len(),
            freed = report.freed,
            "seed: aborted plan rolled back; compensate-freed its blobs"
        ),
        Err(e) => tracing::warn!(
            error = %e,
            "seed: aborted plan left orphan blobs; the standing GC sweep will reclaim them"
        ),
    }
}

/// Phases 2 + 3 — the ONLY side effects of a seed. Blobs land first (content-addressed,
/// idempotent), then EVERY row lands in ONE transaction: the dataset row, its project
/// link, and every artifact. Mirrors `ingest::ingest_run_outputs`. Returns the created
/// dataset id + the seeded artifact list; on ANY error the transaction is dropped
/// (rolled back) and the caller compensate-frees `wrote`.
#[cfg(debug_assertions)]
async fn apply_seed(
    pool: &SqlitePool,
    store: &dyn ObjectStore,
    project_id: Uuid,
    user_id: Uuid,
    dataset: Option<&SeedDatasetSpec>,
    run: Option<&SeedRunSpec>,
    pending: &[PendingSeed],
    fail_after_write: bool,
    wrote: &mut Vec<String>,
) -> Result<(Option<Uuid>, Vec<SeededArtifact>), (StatusCode, AppError)> {
    use super::catalog::models::NewArtifact;

    // ── phase 2: blobs. Orphans are possible ONLY if a later step fails, and those are
    // compensate-freed by the caller (plus the standing GC sweep as the backstop).
    let mut stored: Vec<(String, i64, bool)> = Vec::with_capacity(pending.len());
    for p in pending {
        stored.push(store_seed_blob(store, &p.blob, wrote).await?);
    }

    // A2: resolve the owner's personal account BEFORE opening the tx (AUD-7 —
    // `ensure_personal_account_for` acquires its own connection + inner tx, which
    // must not nest inside the outer tx). Only needed when a dataset is seeded.
    let dataset_account_id = if dataset.is_some() {
        Some(
            crate::modules::account::scope::ensure_personal_account_for(pool, user_id)
                .await
                .map_err(|e| e.to_api_error())?,
        )
    } else {
        None
    };

    // ── phase 3: ONE transaction for every row.
    // SQLite port (record): `BEGIN IMMEDIATE` — the write-lock doctrine of the
    // ITEM-17/18/19 mutations; a deferred `BEGIN` would upgrade to the write
    // lock lazily at the first write, which is exactly the upgrade that can
    // deadlock two writers (the DEC-25 ABBA analysis). The seed writes begin
    // here, so the lock is taken up front.
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| AppError::database_error(e).to_api_error())?;

    let mut dataset_id: Option<Uuid> = None;
    if let Some(spec) = dataset {
        let id = Uuid::new_v4();
        // A2: stamp the owner's personal account (resolved above, before the tx).
        let account_id = dataset_account_id.expect("resolved when dataset.is_some()");
        sqlx::query!(
            r#"INSERT INTO datasets (id, name, owner_id, account_id, datatype) VALUES ($1, $2, $3, $4, $5)"#,
            id,
            spec.name,
            user_id,
            account_id,
            spec.datatype,
        )
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::database_error(e).to_api_error())?;
        sqlx::query!(
            r#"INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)"#,
            project_id,
            id,
        )
        .execute(&mut *tx)
        .await
        .map_err(|e| AppError::database_error(e).to_api_error())?;
        dataset_id = Some(id);
    }

    let mut seeded = Vec::with_capacity(pending.len());
    for (p, (object_key, stored_bytes, is_multifile)) in pending.iter().zip(stored) {
        // The producing RUN, when the plan declared one — inserted in THIS transaction through
        // the provenance repository's own statement, so a refused plan leaves no orphan run node
        // and no fixture writes a row shape a real run would not have written.
        let run_id: Option<Uuid> = match run {
            None => None,
            Some(spec) => {
                let generator_id = spec.generator_id.trim();
                if generator_id.is_empty() {
                    return Err(seed_bad_request(
                        "SEED_RUN_GENERATOR",
                        "a seeded run must name a `generator_id`: the column defaults to the \
                     empty string and the derive path reads blank as \"not attributable\", so \
                     seeding one would express the very absence it was meant to fill",
                    ));
                }
                let id = Uuid::new_v4();
                crate::modules::provenance::repository::ProvenanceRepository::insert_run_in_tx(
                    &mut tx,
                    &crate::modules::provenance::repository::NewRun {
                        run_id: id,
                        project_id: Some(project_id),
                        dataset_id: None,
                        kind: "compute".to_string(),
                        status: spec
                            .status
                            .clone()
                            .unwrap_or_else(|| "completed".to_string()),
                        generator_id: generator_id.to_string(),
                        generator_version: env!("CARGO_PKG_VERSION").to_string(),
                        code_sha256: None,
                        env_rootfs_sha256: None,
                        lockfile_json: None,
                        seed: None,
                        params: serde_json::json!({}),
                        inputs_json: serde_json::json!([]),
                        acting_user: Some(user_id),
                        rerun_spec_json: None,
                    },
                )
                .await
                .map_err(|e| e.to_api_error())?;
                Some(id)
            }
        };

        let (scoped_project, scoped_dataset) = match p.scope {
            SeedScope::Project => (Some(project_id), None),
            SeedScope::Dataset => (None, dataset_id),
            SeedScope::Both => (Some(project_id), dataset_id),
        };
        // ITEM-30: the row's status, applied in the SAME transaction as the insert so a
        // seeded fixture is never briefly visible as `ready` before becoming what the plan
        // asked for. `NewArtifact` carries no status (the repository decides it), so this is
        // an update rather than a field — and it runs only when the plan asked, leaving the
        // default path byte-identical.
        let want_status = p.status.clone();
        let art = CatalogRepository::insert_artifact_in_tx(
            &mut tx,
            &NewArtifact {
                project_id: scoped_project,
                dataset_id: scoped_dataset,
                // Stamped from the plan's run when it declared one; `None` otherwise, which
                // is what every seeded row was before and still is by default.
                run_id,
                output_id: p.output_id.clone(),
                datatype: p.datatype.clone(),
                // Real handling: the debug seeder always writes bytes, so it always
                // has a key. `Some` states that rather than leaving it inferred.
                object_key: Some(object_key.clone()),
                is_multifile,
                content_hash: object_key,
                // The plan's declaration when it made one; otherwise `opaque`, which is
                // what the server actually knows about bytes it was handed (INV-2 — a
                // declaration, not a default that hides an absent one).
                structure: p.structure.clone().unwrap_or_else(
                    || serde_json::json!({ "encoding": "opaque", "origin": "seed" }),
                ),
                meta: p
                    .meta
                    .clone()
                    .unwrap_or_else(|| serde_json::json!({ "origin": "seed" })),
                // The debug seed engine writes ordinary, first-class artifacts.
                role: crate::modules::sandbox::outputs::ROLE_ARTIFACT.to_string(),
                stored_bytes,
                // The seeder writes real bytes, so the two coincide.
                logical_bytes: Some(stored_bytes),
                created_by: Some(user_id),
                hidden: false,
                representation_of: None,
            },
        )
        .await
        .map_err(|e| e.to_api_error())?;
        if let Some(status) = want_status {
            sqlx::query("UPDATE artifacts SET status = $1 WHERE id = $2")
                .bind(&status)
                .bind(art.id)
                .execute(&mut *tx)
                .await
                .map_err(|e| AppError::database_error(e).to_api_error())?;
        }
        seeded.push(SeededArtifact {
            output_id: p.output_id.clone(),
            datatype: p.datatype.clone(),
            id: art.id,
        });
    }

    // The test seam (see `SeedPlan::_debug_fail_after_write`): every blob is stored and
    // every row is inserted at this point, so aborting HERE is the maximal phase-2/3
    // fault — it is what makes the transaction and the compensating blob free observable.
    if fail_after_write {
        return Err(seed_internal(
            "seed: `_debug_fail_after_write` — injected post-write fault (test seam)",
        ));
    }

    tx.commit()
        .await
        .map_err(|e| AppError::database_error(e).to_api_error())?;
    Ok((dataset_id, seeded))
}

#[cfg(debug_assertions)]
pub async fn seed_debug(
    auth: RequirePermissions<(ProjectsUse,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(project_id): Path<Uuid>,
    multipart: axum::extract::Multipart,
) -> Response {
    match seed_inner(&pool, project_id, auth.user.id, multipart).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err((code, err)) => (code, err).into_response(),
    }
}

#[cfg(debug_assertions)]
async fn seed_inner(
    pool: &SqlitePool,
    project_id: Uuid,
    user_id: Uuid,
    mut multipart: axum::extract::Multipart,
) -> Result<SeedResponse, (StatusCode, AppError)> {
    require_project_edit(pool, project_id, user_id).await?;

    // ── the request: a `plan` JSON part + an optional raw `input` part ──────────────────
    let mut plan_json: Option<String> = None;
    let mut input: Vec<u8> = Vec::new();
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        seed_bad_request(
            "SEED_BAD_MULTIPART",
            format!("malformed multipart body: {e}"),
        )
    })? {
        match field.name().unwrap_or_default() {
            "plan" => {
                plan_json = Some(field.text().await.map_err(|e| {
                    seed_bad_request(
                        "SEED_BAD_MULTIPART",
                        format!("reading the `plan` part: {e}"),
                    )
                })?)
            }
            "input" => {
                input = field
                    .bytes()
                    .await
                    .map_err(|e| {
                        seed_bad_request(
                            "SEED_BAD_MULTIPART",
                            format!("reading the `input` part: {e}"),
                        )
                    })?
                    .to_vec()
            }
            // Unknown parts are ignored on purpose: a caller may attach provenance fields.
            _ => {}
        }
    }
    let plan_json = plan_json
        .ok_or_else(|| seed_bad_request("SEED_NO_PLAN", "the request must carry a `plan` part"))?;
    let plan: SeedPlan = serde_json::from_str(&plan_json)
        .map_err(|e| seed_bad_request("SEED_BAD_PLAN", format!("malformed seed plan: {e}")))?;

    // ── optionally run the embedded driver over `input` ─────────────────────────────────
    // The scratch dir is removed by `SeedScratch`'s Drop on EVERY exit path below.
    let mut scratch: Option<SeedScratch> = None;
    let mut manifest = serde_json::Value::Null;
    if let Some(driver_id) = plan.driver.as_deref() {
        let driver = SEED_DRIVERS
            .iter()
            .find(|d| d.id == driver_id)
            .ok_or_else(|| {
                seed_bad_request(
                    "SEED_UNKNOWN_DRIVER",
                    format!(
                        "unknown driver `{driver_id}`; known: {}",
                        SEED_DRIVERS
                            .iter()
                            .map(|d| d.id)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                )
            })?;
        if input.is_empty() {
            return Err(seed_bad_request(
                "SEED_NO_INPUT",
                format!(
                    "driver `{driver_id}` needs the request's `input` part, which was empty/absent"
                ),
            ));
        }
        let work = std::env::temp_dir().join(format!("txr-seed-{}", Uuid::new_v4()));
        let out_dir = work.join("out");
        std::fs::create_dir_all(&out_dir)
            .map_err(|e| seed_internal(format!("seed: create scratch dir: {e}")))?;
        let guard = SeedScratch(work.clone());

        // The driver's OWN entry (server-owned test code)…
        std::fs::write(work.join(SEED_DRIVER_ENTRY), driver.entry.as_bytes()).map_err(|e| {
            seed_internal(format!(
                "seed: stage driver entry `{SEED_DRIVER_ENTRY}`: {e}"
            ))
        })?;
        // …and the processor `/code` dir it runs against, DERIVED through the SAME resolver
        // a real run uses (see `SeedDriverFiles`), so this can never fall a ring behind a
        // compute that gains a sibling import.
        let resolved = crate::modules::sandbox::processors::resolve_with_package(
            driver.code_ref,
            Some(driver.package),
        )
        .map_err(|e| {
            seed_internal(format!(
                "seed: driver `{}` cannot resolve processor entry {:?} in package {:?}: {e}",
                driver.id, driver.code_ref, driver.package
            ))
        })?;
        let entry_name = std::path::Path::new(driver.code_ref)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| {
                seed_internal(format!(
                    "seed: driver `{}` code_ref {:?} has no file name",
                    driver.id, driver.code_ref
                ))
            })?;
        // No extra name guard is invented here, because none of these names is caller data:
        // the entry name is this table's own `code_ref` basename, and every helper name is
        // either a `PY_HELPER_FILES` literal or the `file_name()` of a manifest-declared,
        // containment-guarded relative path (`processors::read_bytes`). That is the same
        // provenance `jobs::runner` writes into a real `/code` with.
        for (name, bytes) in std::iter::once((entry_name, resolved.script.as_bytes())).chain(
            resolved
                .helpers
                .iter()
                .map(|(n, b)| (n.as_str(), b.as_slice())),
        ) {
            std::fs::write(work.join(name), bytes)
                .map_err(|e| seed_internal(format!("seed: stage driver file `{name}`: {e}")))?;
        }
        std::fs::write(work.join("input.bin"), &input)
            .map_err(|e| seed_internal(format!("seed: stage driver input: {e}")))?;

        // Run on the HOST `python3` (Option-B — the drivers are dependency-light readers, so
        // they run without the compute sandbox and cannot hit a TileDB `bad_alloc`). Fail
        // LOUD on any error: a silent skip is not a pass, and the e2e helper asserts `ok()`.
        let output = tokio::process::Command::new("python3")
            .current_dir(&work)
            .arg(SEED_DRIVER_ENTRY)
            .arg("input.bin")
            .arg("out")
            .output()
            .await
            .map_err(|e| {
                seed_internal(format!(
                    "seed: failed to spawn `python3` (driver `{driver_id}` needs the host \
                     scientific-python stack): {e}"
                ))
            })?;
        if !output.status.success() {
            return Err(seed_internal(format!(
                "seed: driver `{driver_id}` failed (exit {:?}): {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(2000)
                    .collect::<String>()
            )));
        }
        manifest = serde_json::from_slice(&read_driver_file(Some(&out_dir), "manifest.json")?)
            .map_err(|e| seed_internal(format!("seed: malformed driver manifest: {e}")))?;
        scratch = Some(guard);
    }
    let out_dir = scratch.as_ref().map(|s| s.0.join("out"));
    let out_dir = out_dir.as_deref();

    // ── PHASE 1 (pure): resolve the WHOLE plan before the first side effect ─────────────
    //
    // Every caller-data guard the engine has — scope-needs-a-dataset, the content
    // encodings (`input`/`driver_file`/nested `members`), the `{"$manifest": …}`
    // references and the manifest key/field lookups — runs HERE, over the whole plan,
    // writing nothing. So a refused plan cannot have stored a blob or inserted a row:
    // a refusal is a true no-op, not a prefix of the plan. (Phases 2/3 below are the
    // only side effects, and they are transactional + compensating.)
    let has_dataset = plan.dataset.is_some();
    let mut pending: Vec<PendingSeed> = Vec::new();

    // The explicitly-listed artifacts.
    for spec in &plan.artifacts {
        validate_seed_scope(spec.scope, has_dataset, &spec.output_id)?;
        pending.push(PendingSeed {
            output_id: spec.output_id.clone(),
            datatype: spec.datatype.clone(),
            scope: spec.scope,
            // ITEM-30 — the explicit `artifacts` list is the only site a plan can name a
            // status; the manifest-driven sets below seed ordinary ready rows.
            status: spec.status.clone(),
            // Both declarations go through `{"$manifest": …}` resolution, so a fixture
            // can declare a row count only the driver knows.
            structure: spec
                .structure
                .as_ref()
                .map(|v| resolve_manifest_refs(v, &manifest))
                .transpose()?,
            meta: spec
                .meta
                .as_ref()
                .map(|v| resolve_manifest_refs(v, &manifest))
                .transpose()?,
            blob: render_seed_bytes(&spec.content, &input, out_dir)?,
        });
    }

    // ── manifest-DERIVED sets: ids + type ids come from the driver's own manifest ───────
    for set in &plan.manifest_items {
        let items = manifest
            .get(&set.manifest_key)
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                seed_bad_request(
                    "SEED_MANIFEST_KEY",
                    format!("driver manifest has no LIST at `{}`", set.manifest_key),
                )
            })?
            .clone();
        for item in &items {
            let name = item
                .get(&set.name_field)
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    seed_bad_request(
                        "SEED_MANIFEST_FIELD",
                        format!(
                            "manifest `{}` item has no string `{}`",
                            set.manifest_key, set.name_field
                        ),
                    )
                })?;
            let datatype = item
                .get(&set.datatype_field)
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    seed_bad_request(
                        "SEED_MANIFEST_FIELD",
                        format!(
                            "manifest `{}` item has no string `{}`",
                            set.manifest_key, set.datatype_field
                        ),
                    )
                })?;
            let output_id = format!("{}{name}", set.output_id_prefix);
            validate_seed_scope(set.scope, has_dataset, &output_id)?;
            let payload = serde_json::to_vec(item)
                .map_err(|e| seed_internal(format!("seed: serialize manifest item: {e}")))?;
            pending.push(PendingSeed {
                output_id,
                datatype: datatype.to_string(),
                scope: set.scope,
                status: None,
                // The manifest-driven sets frame driver-written blobs, which are opaque
                // JSON/bytes; a Zarr/CSC fixture uses the explicit `artifacts` list.
                structure: None,
                meta: None,
                blob: SeedBlob::Single(payload),
            });
        }
    }

    for set in &plan.manifest_files {
        let files = manifest
            .get(&set.manifest_key)
            .and_then(|v| v.as_object())
            .ok_or_else(|| {
                seed_bad_request(
                    "SEED_MANIFEST_KEY",
                    format!("driver manifest has no MAP at `{}`", set.manifest_key),
                )
            })?
            .clone();
        for (output_id, file) in &files {
            let file = file.as_str().ok_or_else(|| {
                seed_bad_request(
                    "SEED_MANIFEST_FIELD",
                    format!(
                        "manifest `{}`[{output_id}] is not a file-name string",
                        set.manifest_key
                    ),
                )
            })?;
            validate_seed_scope(set.scope, has_dataset, output_id)?;
            let bytes = read_driver_file(out_dir, file)?;
            pending.push(PendingSeed {
                output_id: output_id.clone(),
                datatype: set.datatype.clone(),
                scope: set.scope,
                status: None,
                // The engine still declares NOTHING on the plan's behalf — but the plan can
                // now point at the driver's own per-entry declarations, which is the only
                // place a per-entity `structure`/`meta` can come from for a set whose size
                // and ids are the driver's data. Absent ⇒ `opaque`, exactly as before.
                structure: manifest_declaration(
                    &manifest,
                    set.structure_key.as_ref(),
                    output_id,
                    "structure",
                )?,
                meta: manifest_declaration(&manifest, set.meta_key.as_ref(), output_id, "meta")?,
                blob: SeedBlob::Single(bytes),
            });
        }
    }

    // ── PHASES 2 + 3: the only side effects. Blobs, then ONE transaction for every row.
    // If either half fails, the transaction never commits AND the blobs this request
    // physically created are compensate-freed — so the plan is applied whole or not at all.
    let store = super::get_object_store();
    let mut wrote: Vec<String> = Vec::new();
    let applied = apply_seed(
        pool,
        store.as_ref(),
        project_id,
        user_id,
        plan.dataset.as_ref(),
        plan.run.as_ref(),
        &pending,
        plan._debug_fail_after_write,
        &mut wrote,
    )
    .await;
    let (dataset_id, seeded) = match applied {
        Ok(v) => v,
        Err(e) => {
            rollback_seed_blobs(pool, store, &wrote).await;
            return Err(e);
        }
    };

    Ok(SeedResponse {
        dataset_id,
        artifacts: seeded,
        manifest,
    })
}

/// The seed engine's two pure caller-data guards. These reach the guarded branches DIRECTLY —
/// the HTTP-level tests in `tests/workstore/seed_debug_test.rs` cover the same rules through the
/// route, but a `driver_file` reference can only reach `read_driver_file`'s filesystem read with
/// a real driver output directory, which needs the host scientific-python stack. These do it with
/// a `tempdir`, so the WITH-driver arm of the confinement rule is exercised on every `cargo test`.
#[cfg(all(test, debug_assertions))]
mod seed_guard_tests {
    use super::{
        is_confined_driver_file, read_driver_file, resolve_manifest_refs, SeedScratch, SEED_DRIVERS,
    };
    use serde_json::json;

    /// Every `.py` module name that EXISTS anywhere in the extracted processor tree, so an
    /// `import X` of one of them is distinguishable from an `import numpy`. Derived by
    /// walking the folder — nothing is typed, so a module that lands tomorrow is in the
    /// scanned set the day it lands (the same reason the driver table stopped listing files).
    fn tree_modules(dir: &std::path::Path) -> std::collections::BTreeSet<String> {
        fn walk(d: &std::path::Path, out: &mut std::collections::BTreeSet<String>) {
            let Ok(rd) = std::fs::read_dir(d) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().and_then(|s| s.to_str()) == Some("py") {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        out.insert(stem.to_string());
                    }
                }
            }
        }
        let mut out = std::collections::BTreeSet::new();
        walk(dir, &mut out);
        out
    }

    /// The shapes a python file reaches for another module by: an import, or — for the
    /// driver that runs the converter as a SUBPROCESS — a quoted file name.
    fn reaches_for(script: &str, module: &str) -> bool {
        script.contains(&format!("import {module}"))
            || script.contains(&format!("from {module} "))
            || script.contains(&format!("\"{module}.py\""))
    }

    /// **The regression pin for `ModuleNotFoundError: No module named 'txr_columns'`.**
    ///
    /// The driver table used to hand-list the sibling modules to stage beside each seed
    /// driver, and that list fell one ring behind `compute/h5ad_import.py`, which had begun
    /// importing `txr_columns` / `txr_csc`. Nothing in THIS test names a module: the set of
    /// modules that exist is walked off the extracted tree, and the set that gets staged is
    /// whatever [`super::SeedDriverFiles`] derives from
    /// [`crate::modules::sandbox::processors::resolve_with_package`] — the same resolver
    /// `jobs::runner` stages a real `/code` from.
    ///
    /// So it fails when a driver's scripts reach for a tree module the derived set does not
    /// carry, and it needs NO edit when a compute correctly gains a sibling import. Its
    /// counterpart one layer down is
    /// `sandbox::processors::every_shipped_helper_import_is_declared_or_globally_staged`,
    /// which is what keeps that derived set complete in the first place.
    #[test]
    fn every_seed_driver_stages_the_code_dir_its_scripts_import() {
        use crate::modules::extensions::{embedded, ExtensionRegistry};
        use crate::modules::sandbox::processors::{declared_run_in, resolve_in_with};

        let dir = embedded::ensure_extracted().expect("the processor seed extracts");
        let reg = ExtensionRegistry::build_from_dir(&dir).expect("the shipped registry builds");
        let modules = tree_modules(&dir);
        // NEGATIVE CONTROL on the scan's own vocabulary: a scan that sees nothing passes
        // everything, so pin that the walk actually found the tree it is supposed to read.
        assert!(
            modules.len() > 5,
            "the tree-module walk found {} module(s) under {dir:?} — it is not reading the \
             extracted processor tree, so every assertion below is vacuous",
            modules.len()
        );

        for d in SEED_DRIVERS {
            // Resolve EXACTLY as the staging site does (via the explicit-registry seam, so a
            // `--lib` binary with no process-wide registry still observes the real
            // declarations rather than silently dropping the declared siblings).
            let declared = declared_run_in(&reg, d.code_ref, Some(d.package));
            let resolved = resolve_in_with(&dir, d.code_ref, Some(d.package), &declared)
                .unwrap_or_else(|e| {
                    panic!(
                        "seed driver `{}` names code_ref {:?} in package {:?}, which does not \
                         resolve: {e}",
                        d.id, d.code_ref, d.package
                    )
                });
            let entry_name = std::path::Path::new(d.code_ref)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_else(|| panic!("driver `{}` code_ref has no file name", d.id));
            let staged: std::collections::BTreeSet<&str> = std::iter::once(entry_name)
                .chain(resolved.helpers.iter().map(|(n, _)| n.as_str()))
                .collect();

            // Both halves of what runs: the driver's own script, and the processor entry it
            // spawns/imports out of that staged dir.
            for (what, script) in [("driver", d.entry), ("entry", resolved.script.as_ref())] {
                for module in &modules {
                    if !reaches_for(script, module) {
                        continue;
                    }
                    assert!(
                        staged.contains(format!("{module}.py").as_str()),
                        "seed driver `{}`: its {what} script reaches for `{module}`, which is \
                         a real module in the processor tree but is NOT in the staged set \
                         {staged:?} — it would die with ModuleNotFoundError, exactly as the \
                         hand-written file list this derivation replaced did",
                        d.id
                    );
                }
            }
        }
    }

    /// The DRIVER half of seed atomicity. A driver's output never needs rolling back
    /// because it never lands anywhere durable: it is confined to a per-request scratch
    /// directory that `SeedScratch`'s `Drop` removes on EVERY exit path — success, 400,
    /// 500 or panic-unwind alike. Proven here on the guard itself: everything the driver
    /// could have written (its staged sources, its `input.bin`, its whole `out/` tree) is
    /// gone once the guard drops, so an aborted seed leaves nothing behind for a later
    /// request to observe.
    #[test]
    fn seed_scratch_drop_removes_the_whole_driver_output_tree() {
        let root = std::env::temp_dir().join(format!("txr-seed-scratch-{}", uuid::Uuid::new_v4()));
        let out = root.join("out");
        std::fs::create_dir_all(out.join("nested")).expect("scratch");
        // Exactly the shape a real driver run leaves behind.
        std::fs::write(root.join("driver.py"), b"# staged source").expect("staged source");
        std::fs::write(root.join("input.bin"), b"fixture").expect("staged input");
        std::fs::write(out.join("manifest.json"), b"{}").expect("manifest");
        std::fs::write(out.join("nested/embedding.f32"), b"\x00\x01").expect("nested output");
        assert!(
            out.join("nested/embedding.f32").exists(),
            "the driver output is really there"
        );

        // Positive control on the guard: the tree survives while the guard is alive...
        let guard = SeedScratch(root.clone());
        assert!(root.exists(), "the scratch tree lives as long as its guard");
        drop(guard);

        // ...and NOTHING survives the drop — not the out dir, not the staged input.
        assert!(
            !root.exists(),
            "SeedScratch::drop removes the whole scratch tree"
        );
        assert!(!out.join("manifest.json").exists());
        assert!(!root.join("input.bin").exists());
    }

    #[test]
    fn confinement_rejects_every_escape_shape_and_admits_plain_names() {
        for bad in [
            "",
            "..",
            "../passwd",
            "../../etc/passwd",
            "..\\..\\windows\\system32",
            "sub/dir.json",
            "/etc/passwd",
            "out\\file.f32",
            "C:file.json",
            "obs.json/../../../etc/passwd",
        ] {
            assert!(
                !is_confined_driver_file(bad),
                "`{bad}` must NOT be confined"
            );
        }
        // Every name the embedded drivers actually write.
        for ok in [
            "manifest.json",
            "obs.json",
            "container.json",
            "embedding.f32",
            "col_pct_mito.f32",
        ] {
            assert!(is_confined_driver_file(ok), "`{ok}` must be confined");
        }
    }

    /// With a REAL driver output directory present, a traversing name is refused BEFORE any
    /// filesystem read — the file outside the directory exists and is readable, and is still
    /// not returned. (A `SEED_NO_DRIVER` short-circuit cannot be what produces this error: the
    /// out_dir is `Some`.)
    #[test]
    fn read_driver_file_confines_to_the_output_dir_even_when_a_driver_ran() {
        let root = std::env::temp_dir().join(format!("txr-seed-guard-{}", uuid::Uuid::new_v4()));
        let out = root.join("out");
        std::fs::create_dir_all(&out).expect("scratch");
        std::fs::write(out.join("obs.json"), b"inside").expect("inside file");
        std::fs::write(root.join("secret.txt"), b"outside").expect("outside file");

        // A plain name inside the directory reads.
        assert_eq!(
            read_driver_file(Some(&out), "obs.json").expect("plain name reads"),
            b"inside"
        );

        // The escape targets a file that genuinely exists one level up.
        assert!(root.join("secret.txt").exists());
        let err = read_driver_file(Some(&out), "../secret.txt").expect_err("traversal must fail");
        assert_eq!(err.0.as_u16(), 400);
        assert_eq!(err.1.error_code(), "SEED_BAD_DRIVER_FILE");
        let err = read_driver_file(Some(&out), "/etc/passwd").expect_err("absolute must fail");
        assert_eq!(err.1.error_code(), "SEED_BAD_DRIVER_FILE");

        // The no-driver arm is a DIFFERENT, distinguishable error for a benign name...
        let err = read_driver_file(None, "obs.json").expect_err("no driver must fail");
        assert_eq!(err.1.error_code(), "SEED_NO_DRIVER");
        // ...and a traversing name is still the confinement error without a driver.
        let err = read_driver_file(None, "../secret.txt").expect_err("traversal must fail");
        assert_eq!(err.1.error_code(), "SEED_BAD_DRIVER_FILE");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_refs_resolve_nested_and_fail_closed_on_an_unknown_key() {
        let manifest =
            json!({ "n_cells": 120, "embedding_cols": 2, "modalities": ["rna", "prot"] });

        // Resolves at any depth; non-`$manifest` nodes pass through untouched.
        let got = resolve_manifest_refs(
            &json!({ "cells": { "$manifest": "n_cells" }, "keep": "literal",
                     "nested": [{ "cols": { "$manifest": "embedding_cols" } }] }),
            &manifest,
        )
        .expect("known keys resolve");
        assert_eq!(
            got,
            json!({ "cells": 120, "keep": "literal", "nested": [{ "cols": 2 }] })
        );

        // A two-key object is NOT a reference — it recurses as an ordinary object.
        let got = resolve_manifest_refs(&json!({ "$manifest": "n_cells", "other": 1 }), &manifest)
            .expect("not a reference node");
        assert_eq!(got, json!({ "$manifest": "n_cells", "other": 1 }));

        // An unknown key is a 400 that NAMES the key and lists the available ones — it must
        // NOT resolve to `null`.
        let err = resolve_manifest_refs(&json!({ "cells": { "$manifest": "n_cels" } }), &manifest)
            .expect_err("a typo'd key must fail closed");
        assert_eq!(err.0.as_u16(), 400);
        assert_eq!(err.1.error_code(), "SEED_UNKNOWN_MANIFEST_KEY");
        let msg = format!("{}", err.1);
        assert!(msg.contains("n_cels"), "names the missing key: {msg}");
        assert!(msg.contains("n_cells"), "lists the available keys: {msg}");

        // With no driver at all the manifest is `null`; the error says so rather than
        // silently producing a null shape.
        let err =
            resolve_manifest_refs(&json!({ "$manifest": "n_cells" }), &serde_json::Value::Null)
                .expect_err("no manifest must fail closed");
        assert_eq!(err.1.error_code(), "SEED_UNKNOWN_MANIFEST_KEY");
        assert!(format!("{}", err.1).contains("no driver ran"));
    }
}
