//! Catalog wire + DB types (ITEM-2). The host-owned `artifacts` row: one per
//! produced typed artifact. `datatype` is a plain string opaque to the host
//! (validated against P2's registry — NOT an enum/FK; DEC-3).
//!
//! **artifact-model ITEM-7** dropped four columns from this row —
//! `shape`, `params`, `covered_axes`, `storage_layout` — leaving the two
//! producer DECLARATIONS (`structure` = how to decode, `meta` = what it means)
//! as the artifact's entire self-description. The four were the host's own
//! reading of the artifact: `shape` was INFERRED from the bytes at ingest
//! (deleted by ITEM-15 under INV-1), `params` was a bag the server SYNTHESIZED
//! by merging three manifest fields, `covered_axes` was written `{}` by every
//! producer that ever wrote it, and `storage_layout` duplicated on the row a
//! layout the datatype already declares. Each one was the server holding an
//! opinion about bytes it does not open.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use txresbench_core::AppError;

/// A cataloged typed artifact.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Artifact {
    pub id: Uuid,
    /// Project tenancy scope (the P11 workbench path). NULL for a dataset-scoped
    /// artifact (ITEM-23): an artifact is scoped to a project OR a dataset (owner).
    pub project_id: Option<Uuid>,
    /// Dataset (owner) tenancy scope (the datasets-management processing path).
    /// NULL for a project-scoped artifact. Exactly one of `project_id`/`dataset_id`
    /// is set on a live artifact (ITEM-23).
    pub dataset_id: Option<Uuid>,
    /// The producing run; null for source/upload artifacts.
    pub run_id: Option<Uuid>,
    /// The manifest slot name, e.g. `expression`/`alignment`.
    pub output_id: String,
    /// Opaque to the host; validated against P2's registry.
    pub datatype: String,
    /// The data blob key (single-file) or the manifest blob key (multi-file) —
    /// or `None` when this artifact has NO STORED BYTES (ITEM-16).
    ///
    /// `None` is not "unknown" and not "empty": it means the row is GATHERED, and
    /// `structure.gathered_from` carries the recipe that produces the bytes on
    /// demand. The `artifacts_bytes_or_recipe` CHECK constraint enforces that
    /// exactly one of the two is present, so a reader may treat `None` as a
    /// GUARANTEE that the recipe is there rather than as a case to guess about.
    ///
    /// Every consumer of this field must decide what a gathered artifact means for
    /// it. There is deliberately no `unwrap_or_default()` anywhere: an empty object
    /// key is a valid-looking address that resolves to nothing, which is the
    /// antipattern `202608040002_artifact_model_drop.sql` removed from four other
    /// columns. Sites that cannot yet serve a gathered artifact return a named
    /// refusal citing the ITEM that owes the real behaviour.
    pub object_key: Option<String>,
    /// Whether `object_key` points at a manifest (members resolved through it).
    pub is_multifile: bool,
    /// Merkle/manifest content identity.
    pub content_hash: String,
    /// Producer-declared: how to decode the bytes. The server stores and serves
    /// this; it never interprets it. No default — an artifact whose producer
    /// declared no structure is an error at ingest, not an empty object.
    pub structure: serde_json::Value,
    /// Producer-declared: what the artifact means, for display. Same contract.
    pub meta: serde_json::Value,
    /// Producer-declared TIER (DEC-8): `artifact` = promotable/exportable,
    /// `intermediate` = viz-only. A first-class column for the same reason `hidden`
    /// is one — it is a property the SERVER acts on (the promote gate), not display
    /// data. It is deliberately NOT re-derived from `meta`: `meta` is the producer's
    /// declaration carried verbatim, and reading operational meaning out of it would
    /// restate in another column exactly what dropping `params` (ITEM-7) removed.
    /// Never empty, and NOT because a blank is normalized here: a blank or omitted
    /// `role` is REFUSED upstream by `sandbox::outputs::deserialize_declared_role`,
    /// and this struct carries no `#[serde(default)]`. The former `role_or_default`
    /// mapped blank → `artifact` — blank ⇒ the PROMOTABLE tier — and was deleted
    /// rather than fixed, so absence cannot resolve to a privilege (INV-2).
    pub role: String,
    /// `pending|ready|failed`. `failed` is also what the post-ingest conformance
    /// gate (ITEM-18 / DEC-12) writes when an artifact's bytes disagree with its
    /// declared `structure`.
    pub status: String,
    /// Bytes written to the OBJECT STORE — 0 for a gathered artifact, which owns no
    /// blob, and that 0 is the correct storage answer. The only reader that wants this
    /// is the provenance export (its size cap and `fetch.txt`). It is emphatically NOT
    /// a display size: see [`Self::logical_bytes`].
    pub stored_bytes: i64,
    /// The size the data REPRESENTS when materialised — the number a user reads as
    /// "Size", and the only one that belongs in a byte total on screen. Equals
    /// `stored_bytes` for an artifact that owns a blob; `rows × element width` for a
    /// gathered one.
    ///
    /// `None` means genuinely UNKNOWN, not zero. It is an `Option` so that every
    /// consumer — and, through the generated TypeScript, every UI consumer — has to
    /// decide what to show when there is no answer. Rendering `0 Bytes` for a
    /// 500,000-row gathered column is the defect this type prevents.
    pub logical_bytes: Option<i64>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Excluded from catalog/picker LISTINGS (still fetchable by id) — set on
    /// derived alternate-representation artifacts (ITEM-20).
    pub hidden: bool,
    /// The source artifact this row is an alternate encoding of (ITEM-20); NULL
    /// for a first-class artifact.
    pub representation_of: Option<Uuid>,
}

impl Artifact {
    /// Does this artifact carry a GATHER RECIPE instead of stored bytes (ITEM-16)?
    ///
    /// The `artifacts_bytes_or_recipe` CHECK constraint makes `object_key IS NULL` and
    /// `structure ? 'gathered_from'` equivalent at the database level, so this reads the
    /// cheaper of the two and callers may rely on the recipe being present when it is true.
    pub fn is_gathered(&self) -> bool {
        self.object_key.is_none()
    }

    /// The stored-bytes address, or a NAMED REFUSAL when this artifact is gathered.
    ///
    /// Every path that needs real bytes calls this instead of reaching into `object_key`,
    /// which is why there is no `unwrap_or_default()` anywhere in the tree: an empty object
    /// key is a valid-looking address that resolves to nothing, and that is the antipattern
    /// `202608040002_artifact_model_drop.sql` removed from four other columns.
    ///
    /// `owed_by` names the ITEM that owes the real behaviour for this path, so a refusal
    /// that reaches a user or a log says which unfinished work it is waiting on rather than
    /// "not supported". The refusals are the honest map of how much of the gathered-serve
    /// path exists; they are replaced one at a time as their ITEMs land, and until then a
    /// path that cannot serve a gathered artifact says so loudly instead of guessing.
    pub fn stored_key(&self, owed_by: &str) -> Result<&str, AppError> {
        self.object_key.as_deref().ok_or_else(|| {
            AppError::bad_request(
                "ARTIFACT_IS_GATHERED",
                format!(
                    "artifact {} has no stored bytes: it is GATHERED through an alignment \
                     (`structure.gathered_from`), and this path needs a blob. Real handling \
                     for a gathered artifact here is owed by {owed_by}.",
                    self.id
                ),
            )
        })
    }
}

/// The values needed to insert (or idempotently re-insert) an artifact row.
#[derive(Debug, Clone)]
pub struct NewArtifact {
    /// Project scope (workbench) — NULL when `dataset_id` is set (ITEM-23).
    pub project_id: Option<Uuid>,
    /// Dataset (owner) scope (processing) — NULL when `project_id` is set (ITEM-23).
    pub dataset_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub output_id: String,
    pub datatype: String,
    /// `None` for a GATHERED artifact, which has no stored bytes (ITEM-16); the
    /// recipe rides `structure.gathered_from`. See `Artifact::object_key`.
    pub object_key: Option<String>,
    pub is_multifile: bool,
    pub content_hash: String,
    /// Producer-declared decode contract; required (no default).
    pub structure: serde_json::Value,
    /// Producer-declared display meaning; required (no default).
    pub meta: serde_json::Value,
    /// The DECLARED tier (DEC-8), carried verbatim from the manifest entry's `role`;
    /// required (no default), like `structure`/`meta`. It is never blank and never
    /// inferred: a manifest that omits `role`, or supplies a blank one, does not
    /// deserialize — because `artifact` is the promotable tier and defaulting to it
    /// would make silence the privileged answer (INV-2).
    pub role: String,
    /// Bytes handed to the object store. `0` for a gathered artifact (no blob).
    pub stored_bytes: i64,
    /// The size the data represents; `None` where no element width is derivable.
    /// A producer that stores real bytes passes `Some(stored_bytes)` — for a blob the
    /// two quantities coincide. See [`Artifact::logical_bytes`].
    pub logical_bytes: Option<i64>,
    pub created_by: Option<Uuid>,
    /// ITEM-20: hide this artifact from the catalog list (still fetchable by id).
    pub hidden: bool,
    /// ITEM-20: this artifact is a hidden REPRESENTATION of another (self-FK). A
    /// forward-slice writer; producers currently pass `None`.
    pub representation_of: Option<Uuid>,
}

/// Filters for the catalog list endpoint (all optional).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct ArtifactFilter {
    pub datatype: Option<String>,
    pub run_id: Option<Uuid>,
    pub output_id: Option<String>,
    /// Match any artifact whose datatype `is_a` this supertype (the Galaxy lattice
    /// rule) — resolved to a concrete id set via P2's registry in the handler. Drives
    /// the Tier-2 artifact-ref picker (P2 ITEM-20/22).
    #[serde(default)]
    pub subtypes_of: Option<String>,
    /// Match any artifact whose datatype advertises this capability (via P2's registry).
    #[serde(default)]
    pub capability: Option<String>,
    /// Match any artifact DECLARING A MEMBERSHIP on this axis — the axis's identity, i.e.
    /// its key artifact's `key_sequence_digest` (dimension-membership ITEM-29).
    ///
    /// INV-2's *"an indexed catalog match"*: the pane resolves its anchor to one or more axis
    /// identities and narrows the candidate set to the artifacts that declare something about
    /// that axis, using the GIN index `202608040004` builds for exactly this containment.
    ///
    /// It NARROWS the candidate set; it does not decide the offer. Which candidate is offered
    /// stays the client's A1/A2/A3/A4 judgment over identity, absence and intersection — a
    /// judgment SQL cannot express and, pushed into SQL, would sit somewhere no unit test can
    /// reach. The two are not redundant: this filter can only test declared containment.
    ///
    /// The value is an OPAQUE digest string, matched whole. It is never parsed, split or
    /// pattern-matched (INV-4).
    #[serde(default)]
    pub on_axis: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire_row() -> serde_json::Value {
        serde_json::json!({
            "id": "11111111-1111-1111-1111-111111111111",
            "project_id": "22222222-2222-2222-2222-222222222222",
            "dataset_id": null,
            "run_id": null,
            "output_id": "expression",
            "datatype": "single-cell/expression",
            "object_key": "sha256:abc",
            "is_multifile": true,
            "content_hash": "sha256:abc",
            // Producer-declared, required (no default) — an artifact whose producer
            // declared no structure is an error at ingest, not an empty object.
            "structure": {"encoding": "opaque", "media_type": "application/octet-stream"},
            "meta": {},
            "role": "artifact",
            "status": "ready",
            "stored_bytes": 42,
            "created_by": null,
            "created_at": "2026-07-16T00:00:00Z",
            "updated_at": "2026-07-16T00:00:00Z",
            "hidden": false,
            "representation_of": null
        })
    }

    #[test]
    fn artifact_serde_roundtrips_all_columns() {
        // The wire row maps every SURVIVING column — the nullable run_id/created_by,
        // the is_multifile flag, the status vocabulary, and the two producer
        // declarations — a drift-guard on the catalog projection (ITEM-2).
        let a: Artifact = serde_json::from_value(wire_row()).expect("deserialize artifact row");
        assert_eq!(a.run_id, None, "source artifact has null run_id");
        assert!(!a.hidden, "a first-class artifact is not hidden");
        assert_eq!(
            a.representation_of, None,
            "a first-class artifact represents nothing"
        );
        // ITEM-23: project-scoped row → project_id Some, dataset_id None.
        assert!(
            a.project_id.is_some(),
            "project-scoped artifact carries a project_id"
        );
        assert_eq!(
            a.dataset_id, None,
            "a project-scoped artifact has no dataset scope"
        );
        assert!(a.is_multifile);
        assert_eq!(a.status, "ready");
        // The DEC-8 tier is a first-class column again (it briefly lived in the dropped
        // `params` bag, taking the promote gate down with it). It carries NO serde
        // default, so a row that omits it fails to deserialize rather than silently
        // becoming the empty string.
        assert_eq!(a.role, "artifact");
        let mut without_role = wire_row();
        without_role.as_object_mut().unwrap().remove("role");
        let err = serde_json::from_value::<Artifact>(without_role)
            .expect_err("`role` carries no serde default");
        assert!(err.to_string().contains("missing field `role`"), "{err}");
        // ITEM-5/6: the two declaration columns are part of the projection this test
        // guards, so they are asserted here rather than only being present in the input.
        assert_eq!(a.structure["encoding"], "opaque");
        assert!(a.meta.is_object(), "meta round-trips as a JSON object");
        // Re-serialize keeps the same shape.
        let back = serde_json::to_value(&a).unwrap();
        assert_eq!(back["object_key"], "sha256:abc");
        assert_eq!(back["stored_bytes"], 42);
    }

    // ITEM-7 (INVERSE pin — it holds the REMOVAL). The four columns the artifact
    // model dropped must not reappear on the wire. Written as an absence check over
    // the SERIALIZED row rather than over the struct source, so a re-introduction via
    // a `#[serde(flatten)]` extras bag or a hand-written serializer is caught too.
    #[test]
    fn the_four_dropped_columns_are_gone_from_the_wire() {
        let a: Artifact = serde_json::from_value(wire_row()).expect("deserialize artifact row");
        let wire = serde_json::to_value(&a).expect("serialize artifact row");
        let obj = wire
            .as_object()
            .expect("the artifact row serializes as a JSON object");
        // POSITIVE CONTROL: the surviving declarations really are on this wire, so the
        // absence assertions below cannot pass because serialization produced nothing.
        assert!(
            obj.contains_key("structure") && obj.contains_key("meta"),
            "the producer declarations vanished — the absence checks below are vacuous"
        );
        for dropped in ["shape", "params", "covered_axes", "storage_layout"] {
            assert!(
                !obj.contains_key(dropped),
                "`{dropped}` came back to the artifact row. ITEM-7 dropped it: the \
                 producer declares `structure` (how to decode) and `meta` (what it \
                 means), and the server holds no opinion of its own about the bytes."
            );
        }
    }
}
