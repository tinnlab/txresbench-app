//! **The virtual-dataset MASK — its role, its source-recording meta, and the identity rule.**
//!
//! Stage A owns the mask's *representation*, not its serve path (that is Stage B). A mask is
//! a per-source packed boolean row selection (DEC-1/DEC-11: one bit per source row in that
//! source's OWN order, `true` = kept) stored as ONE artifact OWNED by the virtual dataset:
//!
//! * `role = 'mask'` — a first-class tier alongside `artifact`/`intermediate`; it is
//!   auto-excluded from the USABLE population (`usable_artifacts` selects `role='artifact'`),
//!   so a mask never appears as a first-class artifact a user can act on.
//! * `hidden = true` — never listed (§3.4); the user sees kept rows in output order, never
//!   the boolean.
//! * `dataset_id = <the virtual dataset>` — ownership. Exactly ONE per VD, enforced by the
//!   partial unique index `artifacts_one_mask_per_dataset (dataset_id) WHERE role='mask'`
//!   (mirrors `datasets_one_per_alignment_run`). The `ON DELETE CASCADE` on `dataset_id`
//!   means deleting the VD removes its mask.
//!
//! The mask carries REAL bytes (`object_key IS NOT NULL`, no `gathered_from`), so it is a
//! stored artifact under `artifacts_bytes_or_recipe` — the gathered COLUMNS reference it via
//! [`super::gathered::GatheredFrom::mask_artifact_id`], the mask itself is not gathered.

use serde_json::{json, Value};

/// The `mask` role (DEC-3). Its DB spelling is the literal `'mask'` used by the partial
/// unique index and the `usable_artifacts` exclusion; this constant is the single Rust home
/// so no writer hardcodes the string.
pub const MASK_ROLE: &str = "mask";

/// Build the mask artifact's `meta`, RECORDING the source dataset it filters.
///
/// §3.4 / ITEM-1: the mask MUST record its source `dataset_id` in `meta.sources[]`, mirroring
/// how the alignment records `meta.sources[].dataset_id`. This is the channel the finalize
/// sink (ITEM-13, Stage E) reads to LINK the created VD to the dataset it filters — the same
/// shape `create_for_run` reads for the integration path — the detach guard reads to protect
/// it, and the cascade scopes deletion by. Without it the VD's source is unknowable.
///
/// A filter has exactly ONE source; the array shape matches the alignment's `sources[]` so a
/// reader walks both with one code path.
pub fn mask_meta(source_dataset_id: &str) -> Value {
    json!({ "sources": [ { "dataset_id": source_dataset_id } ] })
}

/// Read the source dataset ids a mask records back out of its `meta` (the inverse of
/// [`mask_meta`]). Empty when the meta carries no `sources[]` — a mask that recorded no
/// source is malformed, which a reader treats as "source unknowable" rather than guessing.
pub fn mask_source_dataset_ids(meta: &Value) -> Vec<String> {
    meta.get("sources")
        .and_then(Value::as_array)
        .map(|xs| {
            xs.iter()
                .filter_map(|s| s.get("dataset_id").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// **INV-11 / §11.1b — absence encodes identity; an all-ones mask is NEVER materialised.**
///
/// A virtual dataset with no mask artifact means "keep everything", and the identity read is
/// byte-equivalent to the general path. So the producer/sink decision of whether to WRITE a
/// mask at all is: materialise ONLY when the selection drops at least one row. Given a
/// per-source keep vector, returns:
///
/// * `None` — every row is kept (all-ones). Do NOT write a mask artifact; the VD's source is
///   linked another way and the read is identity.
/// * `Some(keep)` — at least one row dropped; the selection is the mask's content.
///
/// An EMPTY selection (zero source rows) also returns `None`: there is nothing to keep or
/// drop, so there is no mask to materialise — a zero-row source is a user error surfaced at
/// run time, not a mask of length zero.
pub fn selection_to_mask(keep: &[bool]) -> Option<&[bool]> {
    if keep.is_empty() || keep.iter().all(|&b| b) {
        None
    } else {
        Some(keep)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The mask records the SOURCE dataset it filters (ITEM-1, §3.4).**
    ///
    /// The finalize sink (ITEM-13) links the created VD to its source through
    /// `meta.sources[].dataset_id` — the same channel the integration path reads. A mask that
    /// recorded no source leaves the VD's source unknowable, so this pins the round-trip.
    ///
    /// nc: make `mask_meta` emit `{}` (or drop `dataset_id`) and this goes red — the sink
    /// would then have no source to scope the VD, the detach guard nothing to protect, and the
    /// cascade nothing to bound deletion by.
    #[test]
    fn a_mask_records_its_source_dataset_id() {
        let meta = mask_meta("ds-source-42");
        assert_eq!(
            mask_source_dataset_ids(&meta),
            vec!["ds-source-42".to_string()],
            "the mask's meta.sources[] must carry the source dataset_id it filters"
        );
    }

    /// A mask whose meta carries no `sources[]` reports NO source rather than a wrong one.
    #[test]
    fn a_mask_with_no_sources_meta_reports_no_source() {
        assert!(mask_source_dataset_ids(&json!({})).is_empty());
        assert!(mask_source_dataset_ids(&json!({ "sources": [] })).is_empty());
    }

    /// **INV-11 — an all-ones mask is never materialised; absence encodes identity.**
    ///
    /// nc: make `selection_to_mask` return `Some` for an all-true vector and this goes red —
    /// the sink would then write a mask of all ones, which the identity read must never carry
    /// (a VD with a full-keep mask is not byte-equivalent to one with no mask by construction —
    /// it would force the gather path where the passthrough is correct).
    #[test]
    fn an_all_ones_selection_is_not_materialised() {
        assert!(
            selection_to_mask(&[true, true, true]).is_none(),
            "keeping every row is identity — no mask is written"
        );
        assert!(
            selection_to_mask(&[]).is_none(),
            "an empty selection materialises no mask"
        );
    }

    /// A selection that drops at least one row IS materialised, verbatim.
    #[test]
    fn a_dropping_selection_is_materialised() {
        let keep = [true, false, true, true];
        assert_eq!(
            selection_to_mask(&keep),
            Some(&keep[..]),
            "a selection that drops a row is the mask's content, unchanged"
        );
    }
}
