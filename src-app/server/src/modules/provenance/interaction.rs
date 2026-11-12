//! Interaction-chokepoint capture (ITEM-12/14) — the P4-owned, non-sandbox
//! capture source. A selection is stored as a RECIPE (the selection criteria +
//! pinned input content-hash), never a materialized mask (DEC-7). On a
//! state-mutating gesture:
//! mint a run node + an emitted code blob + a `used` edge + a generated recipe
//! artifact (into P1's catalog via the facade).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::{RunNodeDto, UsedEdgeDto};
use super::criteria_script::EmitError;
use super::{action_registry, capture, graph, inputs};

/// The typed selection recipe vocabulary (round-trips through the opaque JSONB
/// recipe column). Storage only — the emitter in `action_registry` is what turns
/// one of these into a re-executable script.
///
/// Every variant and field names a payload SHAPE. Two did not: the label-set
/// variant and its field, and the polygon variant's first field, were named after
/// two CONTRIBUTED datatype ids — in the one place the app declares its own wire.
/// Renamed to what they are — a column NAME to test membership in, and an
/// attestation string pinning a coordinate source — with no alias; see the
/// payload-key block in `action_registry` for both former spellings and for why an
/// alias would be worse than the rename.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SelectionRecipe {
    Polygon { coords_ref: String, polygon: Vec<[f64; 2]> },
    Column { col: String, op: String, val: Value },
    LabelSet { column_ref: String, labels: Vec<String> },
    #[serde(rename = "setop")]
    SetOp { op: String, refs: Vec<String> },
    Freehand { ids: Vec<String> },
}

/// The cap on a capture's human `label` (SECURITY-2 / ERROR-HANDLING-4). The label
/// is stored TWICE per capture (`provenance_run_repro.params` + the generated
/// artifact's `params`), neither content-addressed, so an unbounded one is a
/// per-request growth vector. It is a tag, not a document.
pub const MAX_LABEL_CHARS: usize = 512;

/// The capability a contributed datatype claims to become the datatype stamped on a
/// captured SELECTION artifact (S5).
///
/// A CAPABILITY name, not a datatype id — the vocabulary of the declaration seam
/// itself, which every contributed domain shares. Before this the capture stamped
/// the literal `"cell-set"` on EVERY selection unconditionally, in a server that
/// treats datatypes as processor-declared data everywhere else; a deployment whose
/// axis elements are wells, timepoints or regions had every selection mislabelled
/// with another domain's noun.
pub const SELECTION_DATATYPE_CAPABILITY: &str = "selection-set-target";

/// The datatype a captured selection artifact carries when NO contributed datatype
/// claims [`SELECTION_DATATYPE_CAPABILITY`].
///
/// A core lattice ROOT, so it always resolves: the stored form IS an opaque JSON
/// recipe blob (`storage_layout: "opaque"`), which is exactly what `data/opaque`
/// describes. Deliberately NOT a domain noun — an undeclared deployment gets an
/// honest generic type rather than a confident wrong one.
pub const FALLBACK_SELECTION_DATATYPE: &str = "data/opaque";

/// Resolve the datatype id for a captured selection artifact (S5) — the pure core.
///
/// EXACTLY ONE carrier wins. Zero carriers → the neutral fallback. TWO OR MORE is
/// AMBIGUOUS and also falls back: picking the alphabetically-first would silently
/// stamp one domain's noun on the other domain's selections, which is the defect
/// class S11 records for `manifest_group_spec`. Same "don't guess" rule as
/// `detect_manifest_group`.
pub fn selection_datatype_from_carriers(carriers: &[String]) -> String {
    match carriers {
        [only] => only.clone(),
        _ => FALLBACK_SELECTION_DATATYPE.to_string(),
    }
}

/// [`selection_datatype_from_carriers`] against the live datatype registry. Falls
/// back when the registry is not built (never a request path, but never a panic).
fn selection_artifact_datatype() -> String {
    let carriers = crate::modules::datatype::try_registry()
        .map(|reg| reg.types_with_capability(SELECTION_DATATYPE_CAPABILITY))
        .unwrap_or_default();
    if carriers.len() > 1 {
        tracing::warn!(
            ?carriers,
            capability = SELECTION_DATATYPE_CAPABILITY,
            fallback = FALLBACK_SELECTION_DATATYPE,
            "provenance: more than one datatype claims the selection-artifact capability; \
             refusing to guess which domain a selection belongs to"
        );
    }
    selection_datatype_from_carriers(&carriers)
}

/// The stored selection form: the recipe + the PINNED input content-hash. Never a
/// materialized bitmask (~1 KB, O(1) in N).
pub fn stored_selection(recipe: &Value, input_content_hash: &str) -> Value {
    serde_json::json!({
        "recipe": recipe,
        "input_content_hash": input_content_hash,
    })
}

/// True when `recipe` arrives in the SCRAPPED versioned envelope, which nested the
/// selection under `predicate`. No FLAT recipe carries that key, so it is an
/// unambiguous discriminator — and the predicate DSL it referenced no longer
/// exists in this build, so such a recipe is REFUSED (a clean 400) rather than
/// stored as something this server cannot reproduce.
pub fn is_versioned_recipe(recipe: &Value) -> bool {
    recipe
        .as_object()
        .is_some_and(|o| o.contains_key("predicate"))
}

/// The one refusal for a scrapped-dialect recipe, so every entry point answers the
/// same way.
fn refuse_versioned_recipe() -> AppError {
    AppError::bad_request(
        "PROVENANCE_INVALID_RECIPE",
        "the versioned predicate-DSL recipe envelope is no longer supported; post a \
         flat selection recipe (`kind` + its own fields) or a `subset.filter` \
         `criteria` list",
    )
}

/// The `selection.*` kind for a recipe (pure — no DB).
///
/// A recipe in the scrapped versioned envelope is refused here (400) rather than
/// having a kind guessed for it: the DSL that gave that envelope its meaning is
/// gone, so nothing this build emits could reproduce it.
fn selection_action_kind(recipe: &Value) -> Result<String, AppError> {
    if is_versioned_recipe(recipe) {
        return Err(refuse_versioned_recipe());
    }
    Ok(recipe
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::bad_request(
                "PROVENANCE_INVALID_RECIPE",
                "selection recipe must carry a \"kind\" field",
            )
        })?
        .to_string())
}

/// `POST /provenance/selections` — capture a selection over an input's axis.
/// Derives the `selection.*` action type from the recipe's `kind`.
pub async fn capture_selection(
    pool: &SqlitePool,
    project_id: Uuid,
    user_id: Uuid,
    input_id: Uuid,
    recipe: Value,
    label: Option<String>,
) -> Result<RunNodeDto, AppError> {
    let kind = selection_action_kind(&recipe)?;
    let action_type = format!("selection.{kind}");
    capture_action(pool, project_id, user_id, &action_type, input_id, recipe, label).await
}

/// `POST /provenance/actions` — the generic interaction chokepoint. Only
/// dispatchable `selection.*` actions are captured this round (ITEM-13).
pub async fn capture_action(
    pool: &SqlitePool,
    project_id: Uuid,
    user_id: Uuid,
    action_type: &str,
    input_id: Uuid,
    recipe: Value,
    label: Option<String>,
) -> Result<RunNodeDto, AppError> {
    if !action_registry::is_dispatchable(action_type) {
        return Err(AppError::bad_request(
            "PROVENANCE_ACTION_NOT_DISPATCHABLE",
            format!("action type '{action_type}' is not dispatchable this round"),
        ));
    }

    // 1. The scrapped versioned envelope is refused BEFORE anything is resolved or
    //    written. `capture_selection` already refuses it while deriving the kind;
    //    this covers the generic `POST /provenance/actions` entry point too.
    if is_versioned_recipe(&recipe) {
        return Err(refuse_versioned_recipe());
    }

    // 2. Closure guard: the input must resolve to a known artifact/reference.
    let resolved = inputs::resolve_input(pool, project_id, user_id, input_id).await?;

    // 3. BOUNDED GROWTH (CODING_GUIDELINES §4), read ONCE for all three caps below.
    //    `provenance_code_blobs` / `provenance_run_repro.params` / the generated
    //    recipe artifact all had no byte cap. Every cap is enforced BEFORE the first
    //    write, so an over-cap capture persists nothing at all (no blob, no run row,
    //    no artifact).
    let max_code_bytes = super::settings_cache::get(pool).await.capture_code_max_bytes;

    // 3a. The client `label` rides into `params`, which is written TWICE per capture
    //     (the run row + the generated artifact's `params`) and is minted fresh every
    //     time — no content-addressed dedup. A 1.5 MB label was accepted and stored
    //     1.5 MB × 2 per request (SECURITY-2 / ERROR-HANDLING-4). It is a human tag,
    //     so a short, explicit cap is the honest bound.
    if let Some(len) = label.as_deref().map(|l| l.chars().count()) {
        if len > MAX_LABEL_CHARS {
            return Err(AppError::unprocessable_entity(
                "PROVENANCE_LABEL_TOO_LONG",
                format!(
                    "the selection label is {len} characters, over the {MAX_LABEL_CHARS}-character \
                     limit; nothing was recorded — shorten the label"
                ),
            ));
        }
    }

    // 3b. The SERIALIZED RECIPE is capped alongside the emitted code. The code cap
    //     alone was NOT a bound on what is persisted: for the LEGACY dialect the
    //     emitted script is independent of recipe size (a 1,900,063-byte recipe
    //     emits a 119-byte script), yet the recipe itself is stored THREE times —
    //     `provenance_runs.params`, the generated recipe artifact's bytes, and that
    //     artifact's `params` — none of them deduped per request (SECURITY-2).
    let recipe_bytes_len = serde_json::to_vec(&recipe)
        .map_err(|e| AppError::internal_error(format!("serialize recipe: {e}")))?
        .len() as i64;
    if recipe_bytes_len > max_code_bytes {
        return Err(AppError::unprocessable_entity(
            "PROVENANCE_RECIPE_TOO_LARGE",
            format!(
                "the selection recipe is {recipe_bytes_len} bytes, over the {max_code_bytes}-byte \
                 capture cap (provenance settings `capture_code_max_bytes`); nothing was \
                 recorded — simplify the selection (fewer explicit ids / polygon vertices) \
                 or raise the cap"
            ),
        ));
    }

    // 4. Emit + store the reproducible selection code (deduped by sha256). A recipe
    //    the emitter cannot honestly reproduce is a LOUD 400 — never a placeholder
    //    script whose sha256 would masquerade as the reproducibility guarantee
    //    (filter-provenance ITEM-18).
    let code = action_registry::emit_code(action_type, &recipe).map_err(|err| match err {
        EmitError::NotDispatchable(_) => AppError::bad_request(
            "PROVENANCE_ACTION_NOT_DISPATCHABLE",
            format!("{err}"),
        ),
        EmitError::MalformedRecipe(_) => {
            AppError::bad_request("PROVENANCE_INVALID_RECIPE", format!("{err}"))
        }
    })?;

    // 4b. The EMITTED-CODE cap: no structural bound on the recipe can see how big
    //     the emitted script gets, so the emitted SIZE is the guard. Refused BEFORE
    //     `store_code`.
    if code.len() as i64 > max_code_bytes {
        return Err(AppError::unprocessable_entity(
            "PROVENANCE_RECIPE_TOO_LARGE",
            format!(
                "the emitted selection script is {} bytes, over the {max_code_bytes}-byte \
                 capture cap (provenance settings `capture_code_max_bytes`); nothing was \
                 recorded — simplify the selection (fewer explicit ids / polygon vertices) \
                 or raise the cap",
                code.len()
            ),
        ));
    }
    let code_sha = capture::store_code(pool, &code, "python").await?;

    // 5. The authoritative USED edge (by pinned content-hash).
    let used = vec![UsedEdgeDto {
        slot: "input".to_string(),
        kind: resolved.kind().to_string(),
        ref_id: Some(resolved.id()),
        content_hash: resolved.content_hash().to_string(),
        // An in-app interaction resolves its own input; there is no binding control
        // and therefore no origin to state (ITEM-18).
        bound_by: None,
    }];
    let inputs_json = serde_json::to_value(&used).unwrap_or_else(|_| serde_json::json!([]));

    // 6. **THE TWO CATALOG WRITES ARE ONE TRANSACTION (ERROR-HANDLING-2 / F2-11,
    //    then ROUND-4 R3-01).** The capture spans three stores (the code blob, the
    //    object store, two DB tables). No transaction can span the object store — but
    //    the two DB tables are the same database, and they used to be two independent
    //    pool writes ordered artifact→run with a compensating artifact delete on the
    //    run-insert ERROR arm.
    //
    //    That ordering fixed the original defect (a `recorded` run pointing at a
    //    recipe artifact that was never written — every retry minting another phantom
    //    run) but not its mirror: the compensation only runs when the insert RETURNS
    //    an error. A **dropped future** — a client disconnect, an axum handler
    //    cancellation, a losing `select!` arm — lands between the two commits and
    //    never reaches that arm, leaving a committed cell-set artifact whose `run_id`
    //    names a run that never existed. `artifacts.run_id` has no FK, so nothing
    //    reclaimed it.
    //
    //    Both writes now go through `graph::write_capture_atomically`: either the
    //    artifact AND the run land, or neither does, cancellation included. What can
    //    still survive a mid-flight cancel is a content-addressed orphan (the code
    //    blob and/or the recipe blob) — both keyed by their own sha256, so a retry
    //    re-uses them rather than duplicating, and the workstore GC reclaims an
    //    unreferenced blob.
    let run_id = Uuid::new_v4();
    let params = serde_json::json!({ "recipe": recipe, "label": label });
    let recipe_bytes = serde_json::to_vec(&stored_selection(&recipe, resolved.content_hash()))
        .map_err(|e| AppError::internal_error(format!("serialize recipe: {e}")))?;
    let store = crate::modules::workstore::try_get_object_store().ok_or_else(|| {
        AppError::internal_error("provenance: object store not initialized")
    })?;
    let key = store.put(&recipe_bytes).await?;
    let new_artifact = crate::modules::workstore::catalog::models::NewArtifact {
        project_id: Some(project_id),
        dataset_id: None,
        run_id: Some(run_id),
        output_id: "selection".to_string(),
        // S5: DECLARED, never assumed — see `selection_artifact_datatype`.
        datatype: selection_artifact_datatype(),
        // Real handling: the selection recipe blob was just written at `key`.
        object_key: Some(key.as_str().to_string()),
        is_multifile: false,
        content_hash: key.as_str().to_string(),
        // Server-authored: an opaque selection recipe blob. Declared, not defaulted.
        // ITEM-7 dropped `params`; the recipe it used to duplicate onto the artifact
        // row still lands on the RUN node (`provenance_runs.params`, set below) and
        // in the blob's own bytes, so nothing about the capture is lost — the row
        // simply stops holding a third copy.
        structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/json" }),
        meta: serde_json::json!({ "origin": "selection" }),
        role: "artifact".to_string(),
        stored_bytes: recipe_bytes.len() as i64,
        // The recipe blob IS the artifact's content, so its logical size is its
        // stored size.
        logical_bytes: Some(recipe_bytes.len() as i64),
        created_by: Some(user_id),
        hidden: false,
        representation_of: None,
    };

    // 7. The run node (in-app env pins the emitter version, not a rootfs).
    let new_run = super::repository::NewRun {
        run_id,
        project_id: Some(project_id),
        dataset_id: None,
        kind: action_type.to_string(),
        status: "recorded".to_string(),
        generator_id: "provenance.selection".to_string(),
        generator_version: env!("CARGO_PKG_VERSION").to_string(),
        code_sha256: Some(code_sha),
        env_rootfs_sha256: None,
        lockfile_json: None,
        // Selections are deterministic predicates — seed 0 (no RNG).
        seed: Some(0),
        params,
        inputs_json,
        acting_user: Some(user_id),
        // In-app interaction runs are not re-runnable via the compute path.
        rerun_spec_json: None,
    };
    // One transaction: no compensating delete is needed (and none could have covered
    // the cancellation case) — the transaction rolls both writes back together.
    let (_artifact, row) = graph::write_capture_atomically(pool, &new_artifact, &new_run).await?;

    // 8. Fire the (noop this round) capture notify seam.
    super::seams::capture().on_run_recorded(project_id, run_id);

    Ok(graph::run_to_dto(&row))
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-7: each recipe shape round-trips through the JSONB schema and always
    // carries the pinned input content-hash; no materialized mask is stored.
    #[test]
    fn recipe_shapes_roundtrip_and_pin_hash() {
        let cases = vec![
            SelectionRecipe::Polygon {
                coords_ref: "sha256:emb".into(),
                polygon: vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]],
            },
            SelectionRecipe::Column { col: "leiden".into(), op: "==".into(), val: serde_json::json!("3") },
            SelectionRecipe::LabelSet { column_ref: "grp".into(), labels: vec!["3".into(), "4".into()] },
            SelectionRecipe::SetOp { op: "union".into(), refs: vec!["a".into(), "b".into()] },
            SelectionRecipe::Freehand { ids: vec!["cell_1".into(), "cell_2".into()] },
        ];
        for recipe in cases {
            let v = serde_json::to_value(&recipe).unwrap();
            let back: SelectionRecipe = serde_json::from_value(v.clone()).unwrap();
            assert_eq!(recipe, back, "recipe round-trips through JSONB");

            let stored = stored_selection(&v, "sha256:input");
            assert_eq!(stored["input_content_hash"], "sha256:input", "pins the input hash");
            assert!(stored.get("mask").is_none(), "no materialized mask is stored");
        }
    }

    // ITEM-4: the predicate-DSL recipe envelope was SCRAPPED. A recipe still posted
    // in that shape must be a clean 400 that names the supported dialect — never a
    // panic, and never silently stored as something no emitter in this build can
    // reproduce.
    #[test]
    fn a_scrapped_versioned_recipe_envelope_is_a_clean_400() {
        for envelope in [
            serde_json::json!({
                "kind": "column",
                "dslVersion": "1.1.0",
                "predicate": { "idList": { "ids": [0, 1] } },
            }),
            serde_json::json!({
                "kind": "column",
                "predicate": { "matchesRegex": { "of": { "col": "cell_type" }, "pattern": "^T" } },
            }),
        ] {
            assert!(is_versioned_recipe(&envelope), "the discriminator sees it: {envelope}");
            let err = selection_action_kind(&envelope).expect_err("the scrapped dialect is refused");
            assert_eq!(err.error_code(), "PROVENANCE_INVALID_RECIPE", "{}", err);
            assert_eq!(err.status_code(), 400, "a clean 400, not a 5xx: {}", err);
        }

        // …and a FLAT recipe still resolves its kind (the surviving storage path).
        let flat = serde_json::json!({ "kind": "column", "col": "leiden", "op": "==", "val": "3" });
        assert!(!is_versioned_recipe(&flat));
        assert_eq!(selection_action_kind(&flat).expect("a flat recipe resolves"), "column");
    }

    // S5: the selection artifact's datatype is DECLARED, never assumed. It used to be
    // the literal `"cell-set"` stamped on EVERY capture unconditionally — a domain
    // noun in a server that treats datatypes as processor-declared data everywhere
    // else. RED ON REVERT: restore `datatype: "cell-set".to_string()` and the "no
    // domain noun without a declaration" arm below fails.
    #[test]
    fn the_selection_artifact_datatype_is_declared_never_assumed() {
        // ZERO carriers → the neutral core root, NOT a domain noun.
        assert_eq!(selection_datatype_from_carriers(&[]), FALLBACK_SELECTION_DATATYPE);
        assert!(
            !FALLBACK_SELECTION_DATATYPE.contains("cell"),
            "an undeclared deployment must not be handed one domain's noun"
        );
        // EXACTLY ONE carrier wins — whatever the contributing domain called it.
        for declared in ["cell-set", "well-set", "region-set"] {
            assert_eq!(
                selection_datatype_from_carriers(&[declared.to_string()]),
                declared,
                "the declaring datatype owns the id"
            );
        }
        // TWO carriers is AMBIGUOUS: falling back is the "don't guess" rule — picking
        // the alphabetically-first would stamp one domain's noun on the other's
        // selections (the S11 defect class).
        assert_eq!(
            selection_datatype_from_carriers(&["cell-set".into(), "well-set".into()]),
            FALLBACK_SELECTION_DATATYPE
        );
    }

    // S5 (the DATA half): the shipped single-cell package DECLARES the carrier, so a
    // stock deployment still types its selections `cell-set` — with the id living in
    // the manifest, not in the server.
    #[test]
    fn the_shipped_package_declares_a_selection_datatype_carrier() {
        let text = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../packages/single-cell-types/manifest.yaml"),
        )
        .expect("the shipped single-cell datatype package");
        assert!(
            text.contains(SELECTION_DATATYPE_CAPABILITY),
            "no shipped datatype claims `{SELECTION_DATATYPE_CAPABILITY}`, so every stock \
             deployment silently degrades its selections to `{FALLBACK_SELECTION_DATATYPE}`"
        );
    }

    #[test]
    fn setop_kind_maps_to_registry_action() {
        let v = serde_json::to_value(&SelectionRecipe::SetOp {
            op: "union".into(),
            refs: vec![],
        })
        .unwrap();
        // The wire `kind` is "setop", so the derived action type is
        // "selection.setop" (a dispatchable registry entry).
        assert_eq!(v["kind"], "setop");
        assert!(action_registry::is_dispatchable("selection.setop"));
    }
}
